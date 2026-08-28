/**
 * Log-text sanitize layer — strips forge-vector control / ANSI / Unicode
 * sequences so a hostile `e.message` cannot inject log lines, clear the
 * terminal, set the terminal title, or visually reorder severity tags.
 *
 * Extracted from {@link ./logger.ts} (R8 audit SRP split): the sanitize stage
 * is pure (no state, no clock, no env) and shared by the line logger here +
 * any future sink that wants to neutralize untrusted text without reaching
 * into rate-limit internals. Test seam belongs in `log-rate-limit.ts` — this
 * module has no seam because the regex set is decision-deterministic.
 *
 * Forge vectors covered:
 *   - C0 controls (U+0000-U+0008, U+000A-U+001F) including embedded `\n`,
 *     `\r`, `\b` — the writer appends a terminating `\n` OUTSIDE this layer so
 *     single-line discipline survives.
 *   - C1 controls (U+007F-U+009F) including DEL + 8-bit CSI introducer.
 *   - ANSI CSI / OSC / DCS / APC / SOS / PM sequences terminated by BEL
 *     (U+0007) or ST (ESC `\`) — full match removed.
 *   - Unicode bidi (U+202A-U+202E, U+2066-U+2069) + zero-width (U+200B-
 *     U+200F, U+FEFF) + soft hyphen (U+00AD) + lone surrogates
 *     (U+D800-U+DFFF). Soft hyphen and lone surrogates do NOT decompose
 *     under NFKC, so they need an explicit strip.
 *   - NFKC NORMALIZATION runs FIRST so compatibility variants (fullwidth `[`
 *     U+FF3B, ligature `ﬁ` U+FB01, fullwidth digits, combining-mark
 *     attacks) decompose to ASCII and land in the strip set. NFKC is
 *     decision-deterministic (Unicode standard), constant-rate per byte.
 *
 * Failure mode: `normalize("NFKC")` can throw RangeError on lone unpaired
 * surrogates in some engines. The try/catch falls through to the raw regex
 * pass (still safer than nothing), and the `BIDI_ZW_RE` set strips lone
 * surrogates explicitly so a hostile surrogate cannot break the logger.
 *
 * NOTE: `new RegExp(string)` avoids biome's `noControlCharactersInRegex`
 * rule trip on the literal form.
 *
 * Limits (documented, not bugs):
 *   - TAB (U+0009) is intentionally PRESERVED — not a forge vector, column
 *     alignment matters for operator-readable structured logs.
 *   - IDN homograph confusable characters (Latin/Cyrillic look-alikes) are
 *     NOT NFKC-equivalent and PASS THROUGH. Defence here is label-prefix
 *     whitelisting at the alerting layer, not sanitize.
 */

import { sliceWholeChars } from "./slice-whole-chars"

// biome-ignore lint/suspicious/noControlCharactersInRegex: the sanitizer deliberately matches OSC/DCS/APC escapes to strip them.
const ANSI_OSC_DCS_APC_RE = /\u001b\][\s\S]*?(?:\u0007|\u001b\\)|\u001b[PX^_][\s\S]*?\u001b\\/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matches CSI escapes to strip them.
const ANSI_CSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g
// biome-ignore lint/suspicious/noControlCharactersInRegex: deliberately matches C0/C1 control chars to strip them.
const CONTROL_RE = /[\u0000-\u0008\u000a-\u001f\u007f-\u009f]/g
/** Bidi controls + zero-width + soft hyphen (U+00AD). (Lone surrogates are
 *  handled separately by LONE_SURROGATE_RE so VALID astral pairs survive.)
 *  Soft hyphen is invisible but splits grep-anchored alert tokens. Lone
 *  surrogates corrupt UTF-8 at the terminal level (R6 audit-M closure —
 *  NFKC throws on lone surrogates, the try/catch fallback leaves them in
 *  the raw stream, and no other regex catches them). NFKC does not
 *  decompose any of these. */
const BIDI_ZW_RE = /[\u00ad\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g
/** LONE (unpaired) surrogates ONLY. Lone surrogates corrupt UTF-8 at the terminal
 *  level (R6 audit-M closure \u2014 NFKC throws on them, the try/catch fallback leaves
 *  them in the raw stream, no other regex catches them). CRITICAL: a plain
 *  `[\ud800-\udfff]` char-class ALSO strips both halves of every VALID surrogate
 *  PAIR \u2014 destroying all astral chars (emoji, CJK-Ext, math alphanumerics), which
 *  the project's own `sliceWholeChars`/truncation defense exists to preserve. This
 *  lookaround removes ONLY the unpaired halves and leaves valid pairs intact. */
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

const normalizeNfkc = (s: string): string => {
  try {
    return s.normalize("NFKC")
  } catch {
    return s
  }
}

/** Strip control chars, ANSI escape sequences, and Unicode bidi /
 *  zero-width chars from `s` after NFKC normalization. Pure — no I/O,
 *  no allocation beyond the result string, no observable side effects. */
export const sanitizeLogText = (s: string): string =>
  normalizeNfkc(s)
    .replace(ANSI_OSC_DCS_APC_RE, "")
    .replace(ANSI_CSI_RE, "")
    .replace(CONTROL_RE, "?")
    .replace(BIDI_ZW_RE, "")
    .replace(LONE_SURROGATE_RE, "")

/** Anti-line-injection escape for ONE-LINE records (mailbox/transcript lines):
 *  fold CR/LF into a literal `\n` so an embedded newline in an (already redacted)
 *  body can't forge a second line. The ONE shared copy (jul-28 — was byte-
 *  duplicated in @/agent/subagent-mailbox/peer-inbox.ts + @/tool/subagent-mailbox,
 *  two slices that cannot cross-import, so @/shared is the only legal home). */
export const escapeBodyForLine = (body: string): string => body.replace(/\r\n|\r|\n/g, "\\n")

/**
 * Default number of leading characters of an untrusted identifier that
 * {@link summarizeUntrustedId} echoes. Long enough that an operator recognizes
 * the model slug / storage key they just typed, short enough that a hostile
 * value cannot use the log as a delivery channel for a payload.
 */
export const UNTRUSTED_ID_LOG_PREFIX_LENGTH = 24

/**
 * Non-cryptographic 32-bit FNV-1a digest, rendered as 8 lowercase hex chars.
 *
 * Its ONLY job is correlation: two log lines carrying the same digest name the
 * same rejected id, so an operator can tell "the client is retrying one bad
 * value" apart from "the client is spraying". It is deliberately NOT a crypto
 * hash — this module's header promises a pure, dependency-free sanitize layer,
 * and pulling `node:crypto` in for an operator-visible correlation tag would buy
 * collision resistance nobody here relies on. Never use it for anything that
 * needs to be unguessable.
 */
const fnv1a32Hex = (s: string): string => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i) & 0xff
    // The FNV prime, 16777619. `Math.imul` keeps the product in int32 instead
    // of the float rounding a plain `h * 0x01000193` would introduce past 2^53.
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, "0")
}

/**
 * Render an UNTRUSTED identifier (a model slug from a network client, a storage
 * key from a file any local process can write) for a log line.
 *
 * WHY THIS EXISTS. {@link sanitizeLogText} already neutralizes the FORGE vectors
 * — a hostile id cannot inject a line, clear the screen or set the terminal
 * title. What it does not do is bound LENGTH. The measured shape was the web
 * daemon's `logger.warn(`web control-request rejected: ${effect.value}`)`, where
 * `value` is the planner's `model "<RAW CLIENT STRING>" not recognized`: a client
 * can queue up to `MAX_PENDING_CONTROL_REQUESTS` (64) frames, each carrying an
 * arbitrarily long model string, and every one of them landed in the operator's
 * log verbatim. The operator needs to IDENTIFY the offending id, not to receive
 * it — so the echo is a sanitized prefix, the true length, and a digest that
 * correlates repeats.
 *
 * The reported length is that of the RAW input, not of the sanitized prefix:
 * "we dropped 900 000 characters" is the operationally interesting fact, and
 * quoting the post-strip length would understate an escape-heavy payload.
 *
 * The prefix is cut with {@link sliceWholeChars} so the truncation itself cannot
 * introduce a lone surrogate.
 */
export const summarizeUntrustedId = (
  raw: string,
  prefixLength: number = UNTRUSTED_ID_LOG_PREFIX_LENGTH,
): string => {
  const safe = sanitizeLogText(raw)
  const head = sliceWholeChars(safe, prefixLength)
  const elided = head.length < safe.length ? "…" : ""
  return `"${head}${elided}" (${raw.length} chars, fnv1a:${fnv1a32Hex(raw)})`
}
