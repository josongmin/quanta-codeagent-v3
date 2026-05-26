/**
 * ADR-0328 — `src/llm/image-sanitization-retry/` barrel.
 *
 * Sibling slice to `src/llm/spinner-stall/` (same convention): closed-port
 * decorator + types. Wires ADR-0323 (`HistorySanitizationPort`) at the
 * Anthropic adapter's `LLMError("invalid_image", ...)` boundary. Default-OFF
 * at the slice level (callers MUST explicitly invoke `withImageSanitizationRetry`);
 * AgentConfig wiring is a separate decision (see ADR-0328 §Wire).
 *
 * No re-export from the parent `src/llm/index.ts` barrel — consumers import
 * from this slice path directly, mirroring the spinner-stall sibling.
 */

export type { ImageSanitizationRetryOptions } from "./types"
export { DEFAULT_MAX_ATTEMPTS, DEFAULT_PLACEHOLDER } from "./types"
export { withImageSanitizationRetry } from "./wrapping"
