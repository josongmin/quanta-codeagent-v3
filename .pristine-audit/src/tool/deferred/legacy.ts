import { QuantaError } from "@/shared"
import type { DeferredHandle, DeferredToolResult, ToolResult } from "../types"

/**
 * LEGACY (pre-ADR-0286) typed seam — kept for back-compat with the original
 * `DeferredResultRegistry` exported from `@/tool` since the first deferred-
 * results absorb landed. This is a PURE in-memory parking lot: `register`
 * issues an id + optional hint, `resolve` moves it to a `resolved` bucket,
 * `poll` returns a discriminated `DeferredToolResult`. There is deliberately
 * no executor, no abort, no timeout — the legacy contract is "tool yields a
 * placeholder + handle; an external poller resolves it later".
 *
 * The PRODUCTION registry (ADR-0286) lives in `default-registry.ts` and
 * implements the closed `DeferredResultRegistry` port from `./port.ts`: it
 * owns its own AbortController + microtask worker and tracks 5 lifecycle
 * states (`pending`/`running`/`completed`/`failed`/`cancelled`). The two
 * coexist by design — the legacy seam is the "external poller" pattern; the
 * new seam is the "registry-managed work" pattern.
 *
 * Naming note: the LEGACY class keeps the historical name
 * `DeferredResultRegistry` (still re-exported from `@/tool/index.ts` so every
 * existing caller is byte-identical). The new port is also named
 * `DeferredResultRegistry` but is reachable ONLY via `@/tool/deferred/port`
 * (not the barrel), and the new concrete impl is named
 * `DefaultDeferredResultRegistry` — so the two never collide in a single
 * import scope.
 */

/** Raised when a deferred operation references an id the registry never issued
 *  (or already evicted). Distinct code so callers can branch on it. */
export class UnknownDeferredHandleError extends QuantaError {
  constructor(id: string) {
    super("deferred_unknown_handle", `no deferred result registered for handle "${id}"`)
  }
}

/** Pure in-memory registry/poller stub for deferred tool results (legacy). */
export class DeferredResultRegistry {
  #pending = new Map<string, DeferredHandle>()
  #resolved = new Map<string, ToolResult>()
  #seq = 0

  /** Register a new deferred operation, returning the handle a tool embeds in
   *  its `{type:"deferred"}` event / `ToolResult.deferred`. `hint` is an
   *  optional human-facing pending message. */
  register(hint?: string): DeferredHandle {
    this.#seq += 1
    const id = `deferred-${this.#seq}`
    const handle: DeferredHandle = hint !== undefined ? { id, hint } : { id }
    this.#pending.set(id, handle)
    return handle
  }

  /** Resolve a pending handle with its final result. Idempotent only in that a
   *  second resolve overwrites; resolving an unknown id throws. */
  resolve(handle: DeferredHandle, result: ToolResult): void {
    if (!this.#pending.has(handle.id) && !this.#resolved.has(handle.id)) {
      throw new UnknownDeferredHandleError(handle.id)
    }
    this.#pending.delete(handle.id)
    this.#resolved.set(handle.id, result)
  }

  /** Poll the current state of a handle. Returns a discriminated
   *  {@link DeferredToolResult}; throws on an unknown id. */
  poll(handle: DeferredHandle): DeferredToolResult {
    const resolved = this.#resolved.get(handle.id)
    if (resolved !== undefined) return { state: "resolved", handle, result: resolved }
    const pending = this.#pending.get(handle.id)
    if (pending !== undefined) return { state: "pending", handle: pending }
    throw new UnknownDeferredHandleError(handle.id)
  }

  /** Drop a resolved handle from the store once a caller has consumed it. */
  evict(handle: DeferredHandle): void {
    this.#pending.delete(handle.id)
    this.#resolved.delete(handle.id)
  }
}
