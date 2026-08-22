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
