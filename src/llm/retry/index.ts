/**
 * Public surface for the `src/llm/retry` slice (ADR-0214).
 *
 * Re-exports the router port + Codex-spec implementation + default factory.
 * Consumers route a classified `LLMErrorKind` to a closed `RecoveryAction`
 * envelope. Default-OFF: the legacy `RetryingLLM` / `FallbackLLM` decorators
 * (src/agent/retry.ts, src/llm/fallback.ts) remain byte-identical for callers
 * that do not adopt the router.
 *
 * NOTE on barrel export shape: types and values are both exported flat for
 * call-site brevity. The slice has no cross-slice imports beyond `@/shared`
 * (LLMErrorKind + assertNever) — the architecture scanner should be content.
 */

export { codexSpecRoute, codexSpecRouterEmittedActions } from "./codex-spec-router"
// DOF-30 — single-authority decorator predicates derived from `codexSpecRoute`.
// `RetryingLLM` (src/agent/retry.ts) and `FallbackLLM` (src/llm/fallback.ts)
// consume these instead of carrying their own hardcoded kind sets.
export {
  isFallbackKind,
  type RetryDisposition,
  retryDispositionForKind,
} from "./decorator-policy"
export type { RecoveryAction } from "./port"
// ADR-0237 — layer-owned arm `tooManyFailedAttempts` (default-OFF decorator).
export type { FailureCounterHandle, LLMRetryKnobs } from "./too-many-failed-attempts"
export {
  DEFAULT_MAX_CONSECUTIVE_FAILURES,
  withFailureCounter,
} from "./too-many-failed-attempts"
