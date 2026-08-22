import type { ToolResult } from "../types"
import type { DeferredHandle, Status } from "./types"

/**
 * ADR-0286 — the closed PRODUCTION port for a deferred-result registry.
 *
 * `register(work)` accepts an async function that takes the per-handle
 * AbortSignal (so the worker can cancel its own I/O cooperatively) and
 * returns a `ToolResult`. The registry schedules the worker on a microtask
 * (no separate thread / pool) and returns a `DeferredHandle` immediately —
 * the caller (an async tool) yields the handle inside `ToolResult.deferred`
 * and the dispatch wire surfaces it to the LLM in the new "deferred" format.
 *
 * The 5-state `Status` lifecycle is OWNED by the registry; callers branch on
 * the closed `Status.kind` union (a 6th state would be a compile error at
 * every exhaustive switch). `await(handle, timeoutMs?)` returns the final
 * `Status` once the handle leaves `pending`/`running` — or the synthetic
 * `failed` status with `{ kind: "await-timeout", timeoutMs }` reason when
 * the optional deadline elapses (the worker keeps running). `cancel()`
 * aborts the per-handle AbortController; the worker observes the abort and
 * the handle moves to `cancelled`. `list()` returns a snapshot of every
 * live handle in registration order (NOT a live view — re-call to refresh).
 *
 * NOTE on naming: the LEGACY class in `./legacy.ts` is also named
 * `DeferredResultRegistry` (it predates the port). The port is reachable
 * ONLY via `@/tool/deferred/port`; the barrel re-exports the LEGACY class
 * under the historic name (so every existing caller is byte-identical).
 * The new concrete impl is `DefaultDeferredResultRegistry`
 * (`./default-registry`).
 */

/** Per-handle worker. Receives the registry's AbortSignal for the handle so
 *  cooperative cancellation (`cancel(handle)`) can flow into long-running I/O
 *  (`fetch`, child_process, ReadableStream, etc.). MUST return a `ToolResult`
 *  on success; throws are caught + classified as `worker-threw`. */
export type DeferredWork = (signal: AbortSignal) => Promise<ToolResult>

/** ADR-0286 closed registry port. */
export interface DeferredResultRegistry {
  /** Register an async work function. Returns immediately with a handle; the
   *  worker is scheduled on the microtask queue. */
  register(work: DeferredWork): DeferredHandle
  /** Synchronous lifecycle probe — returns the current `Status` snapshot. An
   *  unknown handle returns `{ kind: "failed", error: { kind: "unknown-handle", id } }`
   *  so callers can branch uniformly without try/catch. */
  poll(handle: DeferredHandle): Status
  /** Async settle. Resolves with the FINAL `Status` (one of `completed`,
   *  `failed`, `cancelled`) once the handle leaves `pending`/`running`.
   *  When `timeoutMs` is supplied AND elapses first, resolves with a
   *  SYNTHETIC `{ kind: "failed", error: { kind: "await-timeout", timeoutMs } }`
   *  — the underlying worker keeps running and a subsequent `await(handle)`
   *  (no timeout) will pick up the eventual real status. */
  await(handle: DeferredHandle, timeoutMs?: number): Promise<Status>
  /** Cooperative cancel. Aborts the per-handle AbortController; if the worker
   *  honors the signal the handle moves to `cancelled` shortly after. If the
   *  worker ignores the signal, the eventual completion overwrites the
   *  `cancelled` status (the spec invariant tested in hellgate). */
  cancel(handle: DeferredHandle): void
  /** Snapshot of every live handle in registration order. NOT a live view. */
  list(): readonly DeferredHandle[]
}
