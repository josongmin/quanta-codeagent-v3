/**
 * `tools/dev/gate-dag` — the ready-set scheduler for top-level gates.
 *
 * # What it replaces
 *
 * `stepGatePlan` in `verification-tier.ts` awaits every gate in manifest order,
 * whether or not one depends on the previous. The shard runner spent a lot of
 * effort on intra-suite parallelism; none of it applies to the top level, where
 * `typecheck`, `lint`, `lint-debt`, the catalog gates and the suite run strictly
 * one after another. The total is the SUM of the gates, not the critical path
 * through them.
 *
 * Dependency is also under-expressed: a gate has at most one `consumes: string`,
 * so "wait for A and B" cannot be said at all, and "these two both write the
 * checkout, never run them together" cannot be said either. `--keep-going` did
 * not parallelise anything — it only kept running the same serial list after a
 * failure.
 *
 * # Why the scheduler is pure
 *
 * A scheduler that spawns is a scheduler you can only test by spawning. This one
 * takes a frozen gate snapshot and a `run` callback, so its ordering,
 * resource-exclusion and failure-propagation behaviour are assertable against a
 * fake clock in milliseconds, and the real runner supplies the bounded child
 * lifecycle. Cycles and dangling producers are rejected by
 * `gate-manifest-contract.ts` BEFORE anything is dispatched — this module
 * assumes a validated manifest and says so.
 *
 * # Concurrency is capped low on purpose
 *
 * Every gate here drives a real toolchain: a type checker, a linter, a language
 * server, a full test suite. Two of those on a 16-core box already contend, and
 * the repo carries a measured scar about contention producing a differently
 * timed wrong answer rather than a slower right one. The default is 2, and a
 * caller that knows the host is idle can raise it.
 */

/** What the scheduler needs to know about a gate. A superset of `TierGate`. */
export interface DagGate {
  readonly id: string
  /** Producers whose ARTIFACT this gate reads. A failed producer poisons it. */
  readonly consumes?: readonly string[]
  /** Ordering-only edges: this gate must not START before these finish. */
  readonly dependsOn?: readonly string[]
  /**
   * Exclusive resources this gate holds while running. Two gates sharing any
   * resource never overlap. Empty means "compatible with anything".
   */
  readonly resources?: readonly string[]
}

export type DagGateOutcome =
  | "passed"
  | "failed"
  /** A producer this gate consumes failed, so its input is not trustworthy. */
  | "skipped-input"
  /** Fail-fast stopped dispatch before this gate started. */
  | "not-run"

export interface DagGateResult {
  readonly id: string
  readonly outcome: DagGateOutcome
  readonly elapsedMs: number
  readonly reason?: string
  /** When it started and ended, on the injected clock. Lets a caller compute the
   *  critical path and the queue wait without re-timing anything. */
  readonly startedMs: number
  readonly endedMs: number
}

export interface DagRunAttempt {
  readonly ok: boolean
  readonly elapsedMs?: number
}

export interface GateDagOptions<T extends DagGate> {
  readonly gates: readonly T[]
  /** Stop dispatching new gates after the first primary failure. */
  readonly failFast: boolean
  /** Maximum gates in flight. Clamped to at least 1. */
  readonly concurrency?: number
  readonly run: (gate: T) => DagRunAttempt | Promise<DagRunAttempt>
  /** Injected so tests can assert timing without waiting. */
  readonly now?: () => number
}

const edgesOf = (gate: DagGate): readonly string[] => [
  ...(gate.dependsOn ?? []),
  ...(gate.consumes ?? []),
]

/**
 * Longest dependency chain, in gates.
 *
 * The lower bound on how many sequential steps any scheduler can achieve, so a
 * caller can say "this took 6 waves and the graph only forces 3" without
 * guessing. Assumes an acyclic graph; the contract validator rejects cycles
 * before this is reached, and a cycle here would simply stop descending.
 */
export const criticalPathLength = (gates: readonly DagGate[]): number => {
  const byId = new Map(gates.map((gate) => [gate.id, gate]))
  const depth = new Map<string, number>()
  const visit = (id: string, seen: ReadonlySet<string>): number => {
    const cached = depth.get(id)
    if (cached !== undefined) return cached
    if (seen.has(id)) return 0
    const gate = byId.get(id)
    if (gate === undefined) return 0
    const next = new Set([...seen, id])
    const parents = edgesOf(gate).filter((edge) => byId.has(edge))
    const value = 1 + Math.max(0, ...parents.map((edge) => visit(edge, next)))
    depth.set(id, value)
    return value
  }
  return Math.max(0, ...gates.map((gate) => visit(gate.id, new Set())))
}

const conflicts = (gate: DagGate, running: readonly DagGate[]): boolean => {
  const mine = new Set(gate.resources ?? [])
  if (mine.size === 0) return false
  return running.some((peer) => (peer.resources ?? []).some((resource) => mine.has(resource)))
}

/**
 * Run the graph, respecting dependencies, resource exclusion and fail-fast.
 *
 * Returns results in MANIFEST order rather than completion order, so a receipt
 * comparing two runs is comparing the same list.
 */
export const runGateDag = async <T extends DagGate>(
  options: GateDagOptions<T>,
): Promise<readonly DagGateResult[]> => {
  const now = options.now ?? ((): number => Date.now())
  const concurrency = Math.max(1, options.concurrency ?? 2)
  const gates = options.gates
  const byId = new Map(gates.map((gate) => [gate.id, gate]))

  const results = new Map<string, DagGateResult>()
  const poisoned = new Set<string>()
  const running = new Map<string, { readonly gate: T; readonly promise: Promise<void> }>()
  let stopped = false

  const finish = (gate: T, result: DagGateResult): void => {
    results.set(gate.id, result)
  }

  /** A gate whose every edge has a terminal result. */
  const ready = (gate: T): boolean =>
    !results.has(gate.id) &&
    !running.has(gate.id) &&
    edgesOf(gate).every((edge) => !byId.has(edge) || results.has(edge))

  const startOne = (gate: T): void => {
    // An input this gate CONSUMES failed: its artifact is stale or absent, so a
    // verdict over it would be the stale-input false green this mechanism exists
    // to stop. Ordering-only `dependsOn` edges do not poison.
    const badInput = (gate.consumes ?? []).find((producer) => poisoned.has(producer))
    if (badInput !== undefined) {
      poisoned.add(gate.id)
      const at = now()
      finish(gate, {
        id: gate.id,
        outcome: "skipped-input",
        elapsedMs: 0,
        reason: `producer ${badInput} failed`,
        startedMs: at,
        endedMs: at,
      })
      return
    }
    const startedMs = now()
    const promise = (async (): Promise<void> => {
      const attempt = await options.run(gate)
      const endedMs = now()
      if (!attempt.ok) {
        poisoned.add(gate.id)
        if (options.failFast) stopped = true
      }
      finish(gate, {
        id: gate.id,
        outcome: attempt.ok ? "passed" : "failed",
        elapsedMs: attempt.elapsedMs ?? Math.max(0, endedMs - startedMs),
        startedMs,
        endedMs,
      })
    })().finally(() => {
      running.delete(gate.id)
    })
    running.set(gate.id, { gate, promise })
  }

  while (results.size + running.size < gates.length || running.size > 0) {
    if (!stopped) {
      for (const gate of gates) {
        if (running.size >= concurrency) break
        if (!ready(gate)) continue
        if (
          conflicts(
            gate,
            [...running.values()].map((entry) => entry.gate),
          )
        )
          continue
        startOne(gate)
      }
    }
    if (running.size === 0) break
    await Promise.race([...running.values()].map((entry) => entry.promise))
  }

  const at = now()
  for (const gate of gates) {
    if (results.has(gate.id)) continue
    const badInput = (gate.consumes ?? []).find((producer) => poisoned.has(producer))
    finish(gate, {
      id: gate.id,
      outcome: badInput === undefined ? "not-run" : "skipped-input",
      elapsedMs: 0,
      reason: badInput === undefined ? "fail-fast" : `producer ${badInput} failed`,
      startedMs: at,
      endedMs: at,
    })
  }

  return gates.map((gate) => {
    const result = results.get(gate.id)
    if (result === undefined) throw new Error(`gate-dag: no result for ${gate.id}`)
    return result
  })
}

/**
 * Wall time of the whole run versus the sum of its gates.
 *
 * Reported rather than asserted: how much a DAG buys depends entirely on the
 * graph, and a number that says "saved 0" over a fully-serial manifest is a
 * useful fact, not a failure.
 */
export const dagSpan = (
  results: readonly DagGateResult[],
): { readonly wallMs: number; readonly serialMs: number } => {
  const executed = results.filter((row) => row.outcome === "passed" || row.outcome === "failed")
  if (executed.length === 0) return { wallMs: 0, serialMs: 0 }
  const start = Math.min(...executed.map((row) => row.startedMs))
  const end = Math.max(...executed.map((row) => row.endedMs))
  return {
    wallMs: end - start,
    serialMs: executed.reduce((sum, row) => sum + row.elapsedMs, 0),
  }
}
