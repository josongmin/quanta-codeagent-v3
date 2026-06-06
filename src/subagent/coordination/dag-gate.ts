/**
 * Multi-agent coordination — Capability A: DAG dispatch GATE (effectful seam).
 *
 * Plan: docs/plans/multiagent-coordination.md §2.A "Wiring".
 *
 * This is the bounded side-effecting layer that drives the PURE `dag.ts` core
 * over the existing parallel batch runner. It exposes a runner WRAPPER: the
 * `subagent-batch` slice fans out all items concurrently (bounded by its worker
 * semaphore); this wrapper makes each wrapped child's run BLOCK until the DAG
 * core reports its node ready, and RELEASE its dependents (via `onComplete`) as
 * children finish. Net effect: dispatch order respects the dependency edges
 * while still using the existing pool — no edit to the sealed slice.
 *
 * Liveness (plan §5): a child that FAILS marks its node `failed`, so dependents
 * become `blocked` (never ready) and their gate resolves `"blocked"` — the
 * wrapped runner returns a typed dead-branch result rather than hanging forever.
 * A cyclic / dangling graph is REJECTED by `createDagGate` before any dispatch.
 *
 * NO new timers, NO clock, NO `Date.now`/`Math.random`. The only async is plain
 * promise plumbing (a per-node deferred resolved when readiness changes).
 *
 * Slice fence (`src/subagent/**`): imports only `./dag` (sibling) — pure.
 */

import { blockedTasks, detectCycle, onComplete, readyTasks, type TaskNode } from "./dag"

/** Why a gate awaiter resolved. `ready` ⇒ the node's deps are all completed and
 *  it may dispatch. `blocked` ⇒ a (transitive) dep failed/cancelled — a dead
 *  branch; the caller must NOT dispatch and should surface the dead branch. */
export type GateOutcome = "ready" | "blocked"

/** A live DAG scheduler over a fixed node set. NO-THROW after a successful
 *  `createDagGate`. */
export interface DagGate {
  /** Resolve when `id` becomes ready (all deps completed) or is determined
   *  blocked (a dep failed/cancelled). Unknown id ⇒ resolves `"blocked"`
   *  immediately (it can never be dispatched). */
  awaitReady(id: string): Promise<GateOutcome>
  /** Mark `id` completed and release any newly-ready dependents' awaiters. */
  markComplete(id: string): void
  /** Mark `id` failed (or cancelled) — its dependents become blocked; their
   *  awaiters resolve `"blocked"`. */
  markFailed(id: string, state?: "failed" | "cancelled"): void
  /** Current ready set (deterministic order) — the initial dispatch frontier. */
  ready(): readonly TaskNode[]
  /** Current blocked (dead-branch) set — what the leader sees instead of a hang. */
  blocked(): readonly TaskNode[]
}

/** Typed construction result: a validated gate, or a rejection carrying the
 *  offending path (cycle / unknown-dep / duplicate id). */
export type CreateGateResult =
  | { readonly ok: true; readonly gate: DagGate }
  | { readonly ok: false; readonly reason: "cycle" | "invalid"; readonly cycle: readonly string[] }

interface Waiter {
  readonly id: string
  readonly resolve: (o: GateOutcome) => void
}

/**
 * Build a live DAG gate from a node set. Rejects a cyclic / dangling / duplicate
 * graph BEFORE returning a gate (plan §5 — never dispatch a bad graph). PURE
 * except for the internal mutable node set + waiter list (no I/O, no clock).
 */
export const createDagGate = (initial: readonly TaskNode[]): CreateGateResult => {
  const check = detectCycle(initial)
  if (!check.ok) {
    return { ok: false, reason: "cycle", cycle: check.cycle }
  }

  let nodes: readonly TaskNode[] = initial.map((n) => ({ ...n }))
  const waiters: Waiter[] = []

  const idSet = (list: readonly TaskNode[]): Set<string> => new Set(list.map((n) => n.id))

  /** After a state change, resolve any waiters whose node is now ready/blocked.
   *  A waiter resolves `"blocked"` when its node is transitively dead
   *  (`blockedTasks`), DIRECTLY terminal-failure (the node ITSELF is
   *  `failed`/`cancelled` — `blockedTasks` only returns PENDING nodes, so a
   *  direct `markFailed(id)` on a node that has its own waiter would otherwise
   *  never resolve), or absent from the graph. */
  const flush = (): void => {
    if (waiters.length === 0) return
    const readyIds = idSet(readyTasks(nodes))
    const blockedIds = idSet(blockedTasks(nodes))
    const byId = new Map(nodes.map((n) => [n.id, n]))
    /** The settled outcome for a waiter, or null when it must keep waiting. */
    const outcomeFor = (id: string): GateOutcome | null => {
      if (readyIds.has(id)) return "ready"
      const node = byId.get(id)
      const dead = node !== undefined && (node.state === "failed" || node.state === "cancelled")
      return blockedIds.has(id) || dead || node === undefined ? "blocked" : null
    }
    // Drain in a stable pass; keep pending waiters.
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i]
      if (w === undefined) continue
      const outcome = outcomeFor(w.id)
      if (outcome !== null) {
        waiters.splice(i, 1)
        w.resolve(outcome)
      }
    }
  }

  const awaitReady = (id: string): Promise<GateOutcome> => {
    const present = nodes.some((n) => n.id === id)
    if (!present) return Promise.resolve("blocked")
    if (idSet(readyTasks(nodes)).has(id)) return Promise.resolve("ready")
    if (idSet(blockedTasks(nodes)).has(id)) return Promise.resolve("blocked")
    return new Promise<GateOutcome>((resolve) => {
      waiters.push({ id, resolve })
    })
  }

  const markComplete = (id: string): void => {
    const r = onComplete(nodes, id)
    nodes = r.nodes
    flush()
  }

  const markFailed = (id: string, state: "failed" | "cancelled" = "failed"): void => {
    nodes = nodes.map((n) => {
      if (n.id !== id) return n
      // Mirror `onComplete`'s terminal-state guard (dag.ts): a node that already
      // reached a TERMINAL state must not be flipped. Without this, a
      // `markComplete(id)` followed by a later `markFailed(id)` retroactively
      // turns a `completed` node `failed` while its dependents — already released
      // by the completion — stay released, leaving the graph inconsistent (a
      // `failed` node whose dependents ran). Only a non-terminal node transitions.
      if (n.state === "completed" || n.state === "failed" || n.state === "cancelled") return n
      return { id: n.id, dependsOn: n.dependsOn, state }
    })
    flush()
  }

  return {
    ok: true,
    gate: {
      awaitReady,
      markComplete,
      markFailed,
      ready: () => readyTasks(nodes),
      blocked: () => blockedTasks(nodes),
    },
  }
}

/** A narrow mirror of the batch runner contract (it is duck-typed in the
 *  `@/tool/subagent-batch` slice; `@/subagent` may not import it). */
export interface DagRunnerRequest {
  readonly prompt: string
  readonly depth: number
  readonly signal?: AbortSignal
  readonly budget?: { readonly maxTurns?: number; readonly maxTokens?: number }
}
export interface DagRunnerResult {
  readonly ok: boolean
  readonly finalText: string
  readonly turns: number
}
export type DagRunner = (req: DagRunnerRequest) => Promise<DagRunnerResult>

/** Sentinel a blocked child returns instead of dispatching (dead branch). */
export const DAG_BLOCKED_TEXT = "dag: dependency failed — task blocked, not dispatched"

/**
 * Wrap a runner so each call is gated by the DAG: it blocks until the request's
 * node is ready (via `idOf`), runs the inner runner, then marks the node
 * completed (ok) or failed (not-ok / threw) so dependents release or block.
 *
 * `idOf` extracts the node id from a request (the composition root encodes the
 * id in the prompt; tests inject directly). A request whose id is NOT in the
 * graph runs UNGATED (the gate only orders nodes it knows about) — so a batch
 * that mixes DAG and non-DAG items degrades gracefully.
 */
export const wrapRunnerWithDagGate = (
  inner: DagRunner,
  gate: DagGate,
  idOf: (req: DagRunnerRequest) => string | undefined,
): DagRunner => {
  return async (req: DagRunnerRequest): Promise<DagRunnerResult> => {
    const id = idOf(req)
    if (id === undefined) return inner(req)
    const outcome = await gate.awaitReady(id)
    if (outcome === "blocked") {
      // Dead branch — do NOT dispatch. Surface a typed failed result so the
      // batch records it (and this node's own dependents block in turn).
      gate.markFailed(id)
      return { ok: false, finalText: DAG_BLOCKED_TEXT, turns: 0 }
    }
    try {
      const r = await inner(req)
      if (r.ok) gate.markComplete(id)
      else gate.markFailed(id)
      return r
    } catch (e) {
      gate.markFailed(id)
      throw e
    }
  }
}
