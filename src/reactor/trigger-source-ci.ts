/**
 * ADR-0132 Stage 1 (Phase A) — CI completion trigger source.
 *
 * Polls `gh pr checks --json` for the configured PR. Emits a
 * {@link ProactiveTrigger} of reason `ci_completion` ONLY when:
 *
 *  1. `gh` exited 0 (otherwise the run is observability-only — see
 *     [[no-heuristics-only-validated]]; a non-zero exit is NOT a "completion"
 *     signal, it is a "we don't know" signal).
 *  2. At least one check entry's `status === "COMPLETED"` AND we have NOT
 *     seen this run-id before (per-source watermark, in-memory; the cron
 *     watcher will hand a persistent watermark down via {@link
 *     CiTriggerOpts.seenRunsStore} once it exists).
 *
 * The trigger's `simulatedMessage` summarizes the rollup state ("CI on PR
 * #123 finished with 2 failures"), and `evidence` carries the PR URL so the
 * agent can drill in.
 *
 * Closed ports: `GhCliPort` (subprocess), `ClockPort` (deterministic time).
 * Tests pass a fake `GhCliPort` that returns canned JSON.
 */

import type { ClockPort, ProactiveTrigger, TriggerSourcePort } from "./types"

/** Minimal interface over a `gh` subprocess. Mirrors `GitRunner` shape (one
 *  method, args + cwd + signal). Production binds a `Bun.spawn` wrapper in
 *  the composition root; tests pass canned JSON. */
export interface GhCliPort {
  run(args: readonly string[], cwd: string, signal?: AbortSignal): Promise<GhCliResult>
}

export interface GhCliResult {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

/**
 * Constructor opts. `prRef` is the PR identifier `gh` accepts: a number, a
 * URL, or the `<owner>/<repo>#<n>` form. We don't parse it — `gh` does.
 *
 * `seenRunsStore` is optional in-memory dedup (a Set-like). Tests pass a
 * fresh `new Set()`; the cron watcher SHOULD pass a persistent store so a
 * restart doesn't re-fire every completed run. Default is an empty Set —
 * fresh process re-fires once per run, by design (we'd rather double-fire
 * than miss).
 */
export interface CiTriggerOpts {
  readonly ghCliPort: GhCliPort
  readonly clockPort: ClockPort
  readonly repoCwd: string
  readonly prRef: string
  readonly seenRunsStore?: SeenRunsStore
}

/** Set-like contract — only the two verbs we need. */
export interface SeenRunsStore {
  has(runId: string): boolean
  add(runId: string): void
}

/** Snapshot-capable seen-runs store. The watcher script uses this to persist
 *  dedup state across restarts without reaching into trigger-source internals. */
export interface SnapshotSeenRunsStore extends SeenRunsStore {
  snapshot(): readonly string[]
}

/**
 * `gh pr checks --json` element shape. We only consume the fields we read;
 * extra fields are tolerated (gh's JSON is a superset of this contract).
 */
interface GhCheckRow {
  readonly name?: string
  readonly status?: string
  readonly conclusion?: string
  readonly link?: string
  readonly bucket?: string
}

/**
 * `gh pr view --json url,number` element shape — for the URL anchor.
 */
interface GhPrViewRow {
  readonly url?: string
  readonly number?: number
}

const JSON_FIELDS_CHECKS = "name,status,conclusion,link,bucket"
const JSON_FIELDS_VIEW = "url,number"

/**
 * Build a {@link TriggerSourcePort} that polls CI completion for one PR.
 * Pure construction — no IO at build time. Each `poll()` runs ONE `gh`
 * subprocess (checks) plus, on first sighting, ONE more for the PR url.
 */
export const createCiTriggerSource = (opts: CiTriggerOpts): TriggerSourcePort => {
  const seen: SeenRunsStore = opts.seenRunsStore ?? createInMemorySeenRuns()
  let cachedUrl: string | undefined

  const fetchPrUrl = async (signal: AbortSignal | undefined): Promise<string | undefined> => {
    if (cachedUrl !== undefined) return cachedUrl
    const res = await safeRun(
      opts.ghCliPort,
      ["pr", "view", opts.prRef, "--json", JSON_FIELDS_VIEW],
      opts.repoCwd,
      signal,
    )
    if (res === undefined || res.exitCode !== 0) return undefined
    const parsed = safeJsonObject<GhPrViewRow>(res.stdout)
    if (parsed === undefined) return undefined
    const url = parsed.url
    if (typeof url !== "string" || url.length === 0) return undefined
    cachedUrl = url
    return url
  }

  return {
    async poll(pollOpts): Promise<readonly ProactiveTrigger[]> {
      const signal = pollOpts?.signal
      if (signal?.aborted) return []

      const checksRes = await safeRun(
        opts.ghCliPort,
        ["pr", "checks", opts.prRef, "--json", JSON_FIELDS_CHECKS],
        opts.repoCwd,
        signal,
      )
      if (checksRes === undefined) return [] // network failure / spawn failure
      if (checksRes.exitCode !== 0) return [] // gh signaled "I don't know"
      if (signal?.aborted) return []

      const rows = safeJsonArray<GhCheckRow>(checksRes.stdout)
      if (rows === undefined || rows.length === 0) return []

      // Build a stable run-id from the row tuple so dedup is deterministic
      // and content-addressed (no run.id field in `gh pr checks` JSON; the
      // link is the de-facto unique identifier per completed run).
      const completed: Array<{ row: GhCheckRow; runId: string }> = []
      for (const row of rows) {
        if ((row.status ?? "").toUpperCase() !== "COMPLETED") continue
        const runId = stableRunId(row)
        if (seen.has(runId)) continue
        completed.push({ row, runId })
      }
      if (completed.length === 0) return []

      const url = (await fetchPrUrl(signal)) ?? `gh://pr/${opts.prRef}`
      if (signal?.aborted) return []
      for (const item of completed) seen.add(item.runId)
      const at = opts.clockPort.now()
      const summary = summarizeRollup(completed.map((item) => item.row))

      return [
        Object.freeze({
          reason: "ci_completion" as const,
          evidence: Object.freeze({ kind: "url" as const, value: url }),
          simulatedMessage: `CI completed on PR ${opts.prRef}: ${summary} (at ${at})`,
          abortSignal: new AbortController().signal,
        }),
      ]
    },
  }
}

/**
 * Default in-memory dedup. Bounded at 1024 entries (insertion order eviction
 * via a Map) so a long-running watcher cannot accumulate unbounded memory
 * even if the consumer never restarts. 1024 ≈ ~year of typical CI volume.
 */
const SEEN_RUNS_CAP = 1024
export const createInMemorySeenRuns = (seed: readonly string[] = []): SnapshotSeenRunsStore => {
  const m = new Map<string, true>()
  const add = (id: string): void => {
    if (m.has(id)) return
    if (m.size >= SEEN_RUNS_CAP) {
      const oldest = m.keys().next().value
      if (oldest !== undefined) m.delete(oldest)
    }
    m.set(id, true)
  }
  for (const id of seed) add(id)
  return {
    has: (id) => m.has(id),
    add,
    snapshot: () => [...m.keys()],
  }
}

const stableRunId = (row: GhCheckRow): string => {
  // Prefer `link` (immutable per run). Fall back to name+conclusion+bucket
  // tuple so a row WITHOUT a link still dedupes within one process run.
  if (typeof row.link === "string" && row.link.length > 0) return row.link
  return `${row.name ?? ""}|${row.conclusion ?? ""}|${row.bucket ?? ""}`
}

const summarizeRollup = (rows: readonly GhCheckRow[]): string => {
  let passed = 0
  let failed = 0
  let other = 0
  for (const r of rows) {
    const c = (r.conclusion ?? "").toUpperCase()
    if (c === "SUCCESS" || c === "NEUTRAL") passed++
    else if (c === "FAILURE" || c === "CANCELLED" || c === "TIMED_OUT") failed++
    else other++
  }
  const parts: string[] = []
  if (passed > 0) parts.push(`${passed} passed`)
  if (failed > 0) parts.push(`${failed} failed`)
  if (other > 0) parts.push(`${other} other`)
  return parts.length > 0 ? parts.join(", ") : "no rollup"
}

/** Wrap a `gh` invocation so spawn / IO errors collapse to `undefined`. The
 *  caller treats `undefined` and `exitCode !== 0` the same way (no trigger),
 *  but keeping them distinct in the helper keeps the test surface clean. */
const safeRun = async (
  port: GhCliPort,
  args: readonly string[],
  cwd: string,
  signal: AbortSignal | undefined,
): Promise<GhCliResult | undefined> => {
  try {
    return await port.run(args, cwd, signal)
  } catch {
    return undefined
  }
}

const safeJsonArray = <T>(raw: string): readonly T[] | undefined => {
  try {
    const v = JSON.parse(raw) as unknown
    return Array.isArray(v) ? (v as readonly T[]) : undefined
  } catch {
    return undefined
  }
}

const safeJsonObject = <T>(raw: string): T | undefined => {
  try {
    const v = JSON.parse(raw) as unknown
    if (v === null || typeof v !== "object" || Array.isArray(v)) return undefined
    return v as T
  } catch {
    return undefined
  }
}
