/**
 * `@/retrieval/auto-hook` public types — ADR-0273.
 *
 * Two primitives:
 *   - `UnregisterAll`  — disposal handle returned by `installAll(invalidator)`.
 *                        Calling it removes every hook the registrar previously
 *                        registered on that invalidator's callback list, in
 *                        registration order.
 *   - `AutoHookError`  — closed 3-arm union of the error shapes the registrar
 *                        produces when a hook target is malformed (null /
 *                        non-conforming / install-without-target).
 *
 * Both primitives are leaf — they depend on nothing in `@/retrieval` proper.
 * The duck-typed `CacheLike` / `StoreLike` shapes that the default registrar
 * accepts live in `./port.ts` so a single import path carries the contract.
 */

/**
 * Disposal handle returned by `AutoHookRegistrar.installAll(invalidator)`.
 *
 * Calling it MUST:
 *   - remove every callback the registrar attached to that invalidator's
 *     registry, in registration order;
 *   - leave hooks that were registered before `installAll` was called
 *     untouched (the registrar only owns its own attachments);
 *   - be idempotent — a second call is a no-op (no double-unregister, no
 *     throw).
 *
 * The function is `void`-returning by contract — callers should not pattern
 * on a return value. Errors during cleanup are isolated (one failing
 * unregister never blocks the rest) and surfaced via the registrar's
 * `onUnregisterError` option (default: `console.warn`).
 */
export type UnregisterAll = () => void

/**
 * Closed 3-arm union for `AutoHookRegistrar` error shapes. Exhaustive
 * `switch` coverage is enforced by HELL-AH-11.
 *
 * Arms:
 *   - `null-target`        — `registerCacheHook(null)` / `registerStoreHook(null)`
 *                            was called. The registrar warns and continues
 *                            (no throw) so an upstream optional-injection
 *                            site can safely pass through.
 *   - `missing-method`     — the target is non-null but does not expose
 *                            the required duck-typed method (`invalidate`
 *                            for cache, `delete` for store). The `method`
 *                            field carries the missing identifier so the
 *                            warn log is self-explanatory.
 *   - `install-without-target` — `installAll(invalidator)` was called
 *                            without any prior `registerCacheHook` /
 *                            `registerStoreHook` call. The handle returned
 *                            is still a valid `UnregisterAll` no-op, but
 *                            the registrar emits a one-shot warn so a
 *                            mis-composed root surfaces fast.
 */
export type AutoHookError =
  | { kind: "null-target"; which: "cache" | "store" }
  | { kind: "missing-method"; which: "cache" | "store"; method: string }
  | { kind: "install-without-target" }
