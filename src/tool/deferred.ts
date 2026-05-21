import { QuantaError } from "@/shared"
import type { DeferredHandle, DeferredToolResult, ToolResult } from "./types"

/**
 * (absorb #1) Deferred-tool-result seam. A tool that declares
 * `supportsDeferredResults` may return a provisional placeholder plus a
 * {@link DeferredHandle}; the final {@link ToolResult} is produced out of band
 * and parked here until a poller resolves it.
 *
 * This is the TYPED SEAM ONLY — there is deliberately no async scheduler wired
 * into the agent loop. The registry is a pure in-memory store + poller so the
 * contract can be exercised in isolation and a real scheduler can adopt it
 * later without changing the type surface.
 */

/** Raised when a deferred operation references an id the registry never issued
 *  (or already evicted). Distinct code so callers can branch on it. */
export class UnknownDeferredHandleError extends QuantaError {
  constructor(id: string) {
    super("deferred_unknown_handle", `no deferred result registered for handle "${id}"`)
  }
}

/** Pure in-memory registry/poller stub for deferred tool results. */
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
