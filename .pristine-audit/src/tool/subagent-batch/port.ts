/**
 * RFC-02 / ADR-0436 — `spawn_batch` closed-port surface.
 *
 * SLICE FENCE: this file (and the whole `@/tool/subagent-batch` slice) MUST NOT
 * import `@/agent`. The recursive agent-loop runner is *injected* as
 * {@link BatchSubagentRunner} (a duck-typed mirror of the `@/subagent`
 * contract). The composition root in `@/agent/tier1/subagent-batch` satisfies
 * the port at wire time by forking `runAgent` (depth+1). Mirrors the
 * `subagent-bg` slice's `port.ts` mirror discipline (RFC §3.5).
 *
 * Everything non-deterministic (clock, file reads) is injected so the hellgate
 * suite runs with no LLM, no disk, no real timers.
 */

/** Per-request token/turn ceiling threaded into a forked child loop. Mirrors
 *  `@/subagent` `TaskBudget` (the producer contract) — duck-typed so the slice
 *  does not import `@/agent`/`@/subagent` core. */
export interface BatchTaskBudget {
  readonly maxTurns?: number
  readonly maxTokens?: number
}

/** A single child request handed to the injected runner. Narrow mirror of the
 *  producer's `SubagentRequest` — only the fields `spawn_batch` sets. */
export interface BatchSubagentRequest {
  readonly prompt: string
  /** Recursion depth of this child (parent depth + 1). */
  readonly depth: number
  /** Per-item abort signal. The runner MUST chain this into the child loop's
   *  signal so a per-item timeout / batch cancellation unwinds the child. */
  readonly signal?: AbortSignal
  readonly budget?: BatchTaskBudget
}

/** Result of a single child run. Narrow mirror of the producer's
 *  `SubagentResult`. */
export interface BatchSubagentResult {
  readonly ok: boolean
  /** Final assistant text the child produced. */
  readonly finalText: string
  readonly turns: number
}

/** The injected agent-loop bridge. The composition root provides a forked
 *  `runAgent`. Everything in this slice depends only on this signature. */
export type BatchSubagentRunner = (req: BatchSubagentRequest) => Promise<BatchSubagentResult>

/** Injected file reader for `items_path`. Narrow port so the slice never
 *  imports `node:fs` directly (test fakes inject in-memory content). The host
 *  adapter wraps `fs.promises.readFile(path, "utf8")`. */
export type ReadFilePort = (path: string) => Promise<string>

/** Injected monotonic clock (epoch ms). Determinism seam for `durationMs` and
 *  the per-item timeout race (mirrors the mailbox/scheduler `now` seam). */
export type BatchClock = () => number

/** Per-item structured result. Order in the aggregate is ALWAYS input index
 *  order (deterministic), never completion order. */
export interface BatchItemResult {
  readonly index: number
  /** `id_field` value (object items) or `String(index)`. */
  readonly id: string
  readonly status: "ok" | "error"
  /** status:"ok" — worker finalText (or serialized parsed object). */
  readonly output?: string
  /** Present when `output_schema` was supplied and parsing succeeded. */
  readonly parsed?: Record<string, unknown>
  /** status:"error" — reason
   *  (template-missing / timeout / worker-failed / schema-violation / cancelled). */
  readonly error?: string
  readonly turns: number
}

/** Aggregate summary returned alongside the per-item array. */
export interface BatchSummary {
  readonly total: number
  readonly ok: number
  readonly failed: number
  readonly cancelled: number
  readonly durationMs: number
}

/** The full structured payload `spawn_batch` returns on `result.structured`. */
export interface BatchRunResult {
  readonly items: readonly BatchItemResult[]
  readonly summary: BatchSummary
}

/** Closed-port clamp band for the per-item worker timeout. Structurally
 *  identical to `task-tools` `TaskOutputTimeoutPolicy` but kept SEPARATE so the
 *  slice stays self-contained (no cross-slice type import). */
export interface BatchTimeoutPolicy {
  readonly minMs: number
  readonly maxMs: number
  readonly defaultMs: number
}

/** Capability A (multi-agent DAG) — a node the batch derives from one item +
 *  its declared `dependencies`. `state` starts `pending` for every item; the
 *  dispatch loop transitions it to `completed`/`failed` as workers settle. The
 *  shape MIRRORS `@/subagent/coordination#TaskNode` (the fence forbids `@/tool`
 *  → `@/subagent`, so the host adapts the real gate behind {@link BatchDagGateFactory}). */
export interface BatchDagNode {
  readonly id: string
  readonly dependsOn: readonly string[]
  readonly state: "pending" | "in_progress" | "completed" | "failed" | "cancelled"
}

/** The per-batch DAG gate the dispatch loop consults. `awaitReady` blocks an
 *  item until ALL its deps completed (`"ready"`) or a dep failed/cancelled
 *  (`"blocked"` — a dead branch, NOT dispatched). `markComplete`/`markFailed`
 *  release the item's dependents. NO-THROW. */
export interface BatchDagGate {
  awaitReady(id: string): Promise<"ready" | "blocked">
  markComplete(id: string): void
  markFailed(id: string): void
}

/** Injected factory the composition root wires to `@/subagent/coordination`.
 *  Given the per-call node set it returns a live gate, OR a typed rejection for
 *  a cyclic / dangling / duplicate graph (the tool then refuses the batch rather
 *  than dispatching a bad graph). Absent ⇒ no DAG ordering (byte-identical flat
 *  fan-out — Capability A is host-gated by `QUANTA_TEAM_DAG`). */
export type BatchDagGateFactory = (
  nodes: readonly BatchDagNode[],
) =>
  | { readonly ok: true; readonly gate: BatchDagGate }
  | { readonly ok: false; readonly reason: string }

/**
 * Deps assembled by the composition root and threaded into `spawnBatchTool`.
 * ALL non-deterministic sources are injected.
 */
export interface SubagentBatchDeps {
  /** Capability A — when present AND the items declare `dependencies`, the
   *  dispatch loop orders fan-out by the DAG (deps-first). Absent ⇒ flat. */
  readonly dagGateFactory?: BatchDagGateFactory
  /** The forked-agent-loop bridge. */
  readonly runner: BatchSubagentRunner
  /** Injected file reader for `items_path`. Absent ⇒ `items_path` is rejected
   *  with `ok:false` (no silent disk access). */
  readonly readFile?: ReadFilePort
  /** Injected clock. The composition root supplies `Date.now`; the pure slice
   *  modules never call a real clock. */
  readonly clock: BatchClock
  /** Hard ceiling on the number of items a single batch may fan out. Explicit
   *  injected cap (NOT an inlined heuristic). */
  readonly maxItems: number
  /** Upper bound on concurrent in-flight workers, regardless of the caller's
   *  `max_concurrency`. Effective concurrency is
   *  `min(input.max_concurrency ?? schedulerCap, schedulerCap)`. */
  readonly schedulerCap: number
  /** Recursion depth of THIS (parent) agent. Children run at `depth+1`.
   *  Absent ⇒ 0 (root). */
  readonly parentDepth?: number
  /** Per-item hang-timeout policy band. Caller's `per_item_timeout_ms` is
   *  clamped into `[minMs,maxMs]`; omitted ⇒ `defaultMs`. */
  readonly timeoutPolicy: BatchTimeoutPolicy
}

/** Default per-item timeout policy. 1ms floor; 30-min ceiling (Codex
 *  `max_runtime_seconds` default = 1800s); 30-min default when omitted so a
 *  worker that never reports does not hang the batch forever. Explicit
 *  constants, not magic at the call site. */
export const DEFAULT_BATCH_TIMEOUT_POLICY: BatchTimeoutPolicy = {
  minMs: 1,
  maxMs: 1_800_000,
  defaultMs: 1_800_000,
}

/** Default hard cap on total items. Aligned with `TaskRegistry`'s settled-LRU
 *  size (256) so the two safety ceilings agree. Override via config. */
export const DEFAULT_MAX_BATCH_ITEMS = 256

/** Pure, total clamp of `requested` into `[minMs, maxMs]`; omitted ⇒
 *  `defaultMs`. Degenerate `minMs > maxMs` collapses to `maxMs` (ceiling
 *  wins — never above the hard ceiling). Mirrors `clampTaskOutputTimeout`. */
export const clampBatchTimeout = (
  policy: BatchTimeoutPolicy,
  requested: number | undefined,
): number => Math.min(Math.max(requested ?? policy.defaultMs, policy.minMs), policy.maxMs)
