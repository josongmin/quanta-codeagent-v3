/**
 * ADR-0323 — image content sanitization domain types.
 *
 * The Codex parent slice (`codex-rs/core/src/session/turn.rs:363-371`) mutates
 * the in-session history in place when the provider returns a 400 invalid-image
 * error so the same poisoned image never retries forever. quanta has no such
 * scrubbing path today — an invalid `ImageBlock` / `DocumentBlock` stays in the
 * `WorkingMemory<Message>` buffer and every retry resubmits the same bytes.
 *
 * This slice is the type surface. The closed port `HistorySanitizationPort`
 * (see `./port.ts`) and the `working-memory-adapter` consume these types; no
 * production wiring lives here (default-OFF by ADR-0323).
 *
 * Closed enums: `SanitizationReason` is intentionally finite. A new reason
 * (e.g. `oversize_document`, `pii_leak`) MUST come with a new ADR — the call
 * site that introduces it has to justify the new mutation policy.
 */

/**
 * Why the call site is requesting a sanitization pass. Closed enum: each
 * variant maps to a documented error class at the adapter boundary.
 *
 * - `invalid_image`  — provider returned 400 invalid-image (the parent case
 *                      this ADR exists to handle). Codex parity.
 * - `oversize`       — image / document bytes exceeded the per-call cap and a
 *                      truncation pass is preferred over a hard fail.
 * - `denied`         — admissibility / safety gate refused the attachment.
 *                      The history must still be cleaned so the next sample
 *                      doesn't re-send the same bytes.
 */
export type SanitizationReason = "invalid_image" | "oversize" | "denied"

/**
 * All valid {@link SanitizationReason} values, exported for adapter validation
 * and exhaustive hellgate iteration. Adding a variant here without extending
 * the union above is a tsc error.
 */
export const SANITIZATION_REASONS: readonly SanitizationReason[] = [
  "invalid_image",
  "oversize",
  "denied",
]

/**
 * Outcome of a single sanitization pass over the history.
 *
 * - `replacedCount` — total number of content blocks (or `tool_result` inner
 *                     blocks) that were rewritten to text. Zero ⇒ nothing
 *                     matched; `wasMutated` is then `false`.
 * - `wasMutated`    — `true` iff the underlying buffer (`WorkingMemory`) was
 *                     handed a new message array via `wm.replace(...)`. The
 *                     port contract guarantees this is equivalent to
 *                     `replacedCount > 0` — both fields are surfaced because
 *                     downstream policy (Codex's `if state.history.replace... { continue }`)
 *                     branches off a boolean and we don't want every caller to
 *                     reconstruct it from the count.
 */
export interface SanitizationResult {
  readonly replacedCount: number
  readonly wasMutated: boolean
}
