import type { ToolResult } from "../types"

/**
 * ADR-0286 — types for the PRODUCTION deferred-result registry.
 *
 * Distinct from the legacy `DeferredHandle` (`@/tool/types#DeferredHandle`),
 * which is the inline marker a `ToolResult.deferred` carries. The legacy
 * shape is `{id, hint?}` (no createdAt) — it predates the production
 * registry and stays as-is for byte-identity at every existing call site.
 * The production handle adds a monotone wall-clock for LRU eviction +
 * deterministic ordering in `list()`.
 *
 * The closed 5-arm `Status` union is the discriminated lifecycle a handle
 * walks through (`pending → running → completed | failed | cancelled`). The
 * closed 5-arm `DeferredError` union is the typed reason surface for the
 * `failed` and `cancelled` arms. Adding a 6th lifecycle state OR a 6th
 * error kind requires extending both the producer (`default-registry.ts`)
 * and every exhaustive `switch (s.kind)` consumer — `tsc` will catch the
 * drift at compile time.
 */

/** ADR-0286 production handle. `createdAt` is a monotone-ish wall-clock
 *  (`Date.now()`) the registry uses for LRU eviction ordering — it is NEVER
 *  part of the dispatch surface. */
export interface DeferredHandle {
  /** Stable id the registry keys on. Unique within a registry instance. */
  readonly id: string
  /** Wall-clock at registration; used for LRU eviction ordering. */
  readonly createdAt: number
}

/** ADR-0286 closed 5-arm lifecycle. Discriminant is `kind`. */
export type Status =
  | { readonly kind: "pending" }
  | { readonly kind: "running" }
  | { readonly kind: "completed"; readonly result: ToolResult }
  | { readonly kind: "failed"; readonly error: DeferredError }
  | { readonly kind: "cancelled"; readonly error: DeferredError }

/** ADR-0286 closed 5-arm error reason. Discriminant is `kind`.
 *
 * - `unknown-handle`: poll/await/cancel against an id the registry never
 *   issued (or evicted via LRU).
 * - `worker-threw`: the registered async work function threw — message is
 *   the captured error text.
 * - `cancelled`: cancel() was called while the handle was pending/running.
 * - `await-timeout`: await(handle, timeoutMs) hit the deadline before the
 *   worker completed (the worker keeps running per the spec — timeout is
 *   only the await contract).
 * - `handle-evicted`: the registry hit its LRU cap and the OLDEST
 *   non-pending entry was dropped (callers polling that id afterwards see
 *   a `failed` status with this reason).
 */
export type DeferredError =
  | { readonly kind: "unknown-handle"; readonly id: string }
  | { readonly kind: "worker-threw"; readonly message: string }
  | { readonly kind: "cancelled" }
  | { readonly kind: "await-timeout"; readonly timeoutMs: number }
  | { readonly kind: "handle-evicted"; readonly id: string }

/** Closed-union literal anchor (drift-anchor for `tsc`). Adding a 6th
 *  `Status.kind` requires extending this tuple AND the union above — both
 *  edits are caught by the in-file `satisfies` below. */
export const ALL_DEFERRED_STATUS_KINDS = [
  "pending",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const satisfies ReadonlyArray<Status["kind"]>

/** Closed-union literal anchor for `DeferredError.kind`. Same drift posture. */
export const ALL_DEFERRED_ERROR_KINDS = [
  "unknown-handle",
  "worker-threw",
  "cancelled",
  "await-timeout",
  "handle-evicted",
] as const satisfies ReadonlyArray<DeferredError["kind"]>
