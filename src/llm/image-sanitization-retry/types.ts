/**
 * ADR-0328 — image sanitization retry wrap (production-wire of ADR-0323).
 *
 * Type surface for `withImageSanitizationRetry`. The wrap layer is a
 * sibling to `withFailureCounter` / `withSandboxLlmErrorEmit`: a closed-port
 * decorator that takes an inner {@link LLMPort} + the ADR-0323
 * {@link HistorySanitizationPort} and, when the inner stream throws an
 * `LLMError("invalid_image", ...)`, calls
 * `port.replaceLastTurnImages("invalid_image", placeholder)` and re-streams
 * up to {@link ImageSanitizationRetryOptions.maxAttempts} times.
 *
 * Codex parent (`codex-rs/core/src/session/turn.rs:363-381`):
 *
 *     Err(CodexErr::InvalidImageRequest()) => {
 *         if state.history.replace_last_turn_images("Invalid image") {
 *             continue;  // history mutate ⇒ re-sample
 *         }
 *         // ... else emit Error event + break
 *     }
 *
 * # Closed knob set (exactOptional)
 *
 * Mirrors {@link LLMRetryKnobs} convention — omitted fields must be absent
 * (NEVER `undefined`-set). Adding a knob requires a new ADR.
 */

/** Default cap when `maxAttempts` is omitted. Codex parity: a SINGLE
 *  sanitize-and-retry per turn (the Codex `continue` re-enters the request
 *  loop, but the same poisoned image cannot fail a second time after it has
 *  been replaced with a text placeholder — so one attempt is exhaustive).
 *  Hellgate pins this default. */
export const DEFAULT_MAX_ATTEMPTS = 1

/** Default placeholder text. Codex parity: the literal string
 *  `"Invalid image"` (`codex-rs/core/src/session/turn.rs:368`). Kept as a
 *  default so callers do NOT have to remember the exact phrase to maintain
 *  Codex byte-parity with the sanitized history. */
export const DEFAULT_PLACEHOLDER = "[invalid image removed]"

/** Closed knob set for `withImageSanitizationRetry`. exactOptional. */
export interface ImageSanitizationRetryOptions {
  /** Maximum sanitize-and-retry attempts per stream() call. `0` disables the
   *  retry (the wrap becomes identity — first `invalid_image` throws). Default:
   *  {@link DEFAULT_MAX_ATTEMPTS} (1). Negative / non-finite / >5 is CLAMPED to
   *  [0, 5] — a deeper retry budget would re-poison the history past the
   *  point where mechanical sanitization helps. */
  readonly maxAttempts?: number
  /** Placeholder text written into the sanitized text block. Default:
   *  {@link DEFAULT_PLACEHOLDER}. The placeholder is observable in the
   *  transcript (working memory), so a host MAY override it for branding
   *  (`"<image removed: invalid>"`) without changing recovery semantics. */
  readonly placeholder?: string
}
