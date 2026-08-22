/**
 * Turn-exit guard chain barrel. Public surface is intentionally narrow:
 *   - `buildGuardChain` — composer (default-OFF byte-identical when empty)
 *   - `runGuardChain` — pure iterator
 *   - `TurnGuard` / `TurnGuardContext` / `TurnGuardResult` — types for tests
 *   - `isFinishAttempt` / `metaUser` — shared loop primitives (re-export so
 *     loop.ts keeps its existing call sites byte-identical)
 *
 * The two adapter factories (`createVerifyGuard` / `createCloseoutGuard`) are
 * exported for tests; production callers go through `buildGuardChain`.
 */

export { buildGuardChain } from "./build"
export {
  guardBlocked,
  runGuardChain,
  type TurnGuard,
  type TurnGuardContext,
  type TurnGuardResult,
} from "./chain"
export { createCloseoutGuard } from "./closeout-guard"
export { isFinishAttempt, metaUser } from "./shared"
export { createVerifyGuard } from "./verify-guard"
