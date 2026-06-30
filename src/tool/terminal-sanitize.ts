/**
 * Terminal-output ESCAPE NEUTRALIZATION (shared by every tool that splices
 * terminal-origin bytes into the model transcript: `pty_read` pane captures and
 * `container_exec` stdout/stderr). Extracted from `@/tool/pty/tools.ts` (RFC
 * jun-29 audit — `container_exec` had drifted to a DROP-only C0/C1 strip, losing
 * the caret-visible + bidi/ZW/surrogate guarantees the pty path already had;
 * a single source removes that divergence).
 *
 * A hostile session / command can plant raw ANSI/CSI/OSC escapes, C0/C1 controls,
 * bidi-override, zero-width, or lone-surrogate bytes in its output. Spliced
 * VERBATIM into the transcript they become a forge channel (clear the screen, set
 * the terminal TITLE, repaint earlier lines to spoof a turn/tool boundary, or
 * visually reorder `exit: 1` to read `exit: 0`).
 *
 * We DEFANG rather than drop: every dangerous control is rewritten to its VISIBLE
 * caret form (ESC => `^[`, BEL => `^G`, CR => `^M`) so the model still SEES the
 * literal sequence (auditable) but no raw control byte survives to be
 * re-interpreted as an active escape — and two lines can never be silently MERGED
 * by a dropped CR/BS. Legible structure (`\n` line breaks, `\t` columns) is
 * PRESERVED. Bidi / zero-width forge chars and lone surrogates are stripped.
 *
 * Pure + idempotent: a caret form (`^[`) contains no control byte, so a second
 * pass is a no-op. Run BEFORE any head+tail cap so truncation only ever
 * measures/cuts an already-neutralized string. `new RegExp(string)` keeps raw
 * control bytes OUT of the source (mirrors the committed pty discipline).
 *
 * NFKC is DELIBERATELY NOT applied here (unlike `@/shared/log-sanitize`, which NFKC-normalizes
 * to fold fullwidth/compatibility homographs into its drop set). Two reasons: (1) the actual
 * forge vector is the raw control BYTE (ESC/CSI/CR), which caret-defang already neutralizes — a
 * fullwidth `[` (U+FF3B) is a distinct token to the model, not an active CSI introducer, so it
 * cannot forge a real escape; (2) terminal output is shown to the model VERBATIM for reasoning,
 * and NFKC would silently mangle legitimate CJK / width-sensitive program output the agent must
 * read exactly. Logs (single-line, grep-anchored) want the opposite tradeoff — hence the split.
 */

// Bidi controls + zero-width + soft hyphen — stripped outright (no legible
// content, pure forge vectors: visual reordering, invisible token-splitters).
// NOTE: surrogates are handled SEPARATELY (`LONE_SURROGATE_RE`) so a VALID astral
// pair (emoji, CJK-ext) is NOT torn apart — a per-code-unit class would match both
// halves of a legitimate pair and corrupt it. `new RegExp(string)` keeps the
// control-range literals out of the source (no biome rule trip).
const BIDI_ZW_RE = new RegExp("[\\u00ad\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]", "g")
// Strip only UNPAIRED surrogates (a high not followed by a low, or a low not
// preceded by a high) — these corrupt UTF-8 at a terminal but carry no content.
// A well-formed PAIR is left intact.
const LONE_SURROGATE_RE = new RegExp(
  "[\\ud800-\\udbff](?![\\udc00-\\udfff])|(?<![\\ud800-\\udbff])[\\udc00-\\udfff]",
  "g",
)
// Dangerous C0 (everything U+0000-U+001F EXCEPT TAB U+0009 / LF U+000A, the only
// two legible-structure controls) + DEL U+007F + C1 (U+0080-U+009F — includes the
// 8-bit CSI introducer U+009B and OSC introducer U+009D). ESC (U+001B) is matched
// here, so no raw CSI/OSC opener byte survives. CR U+000D is DELIBERATELY matched
// (defanged to `^M`): a bare/mid-line CR moves the cursor to column 0 and is an
// OVERWRITE-forge control.
const CONTROL_RE = new RegExp("[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f]", "g")

/** Rewrite one matched control char to its visible caret/hex notation: a C0
 *  char `X` => `^` + (X XOR 0x40) (so ESC U+001B => `^[`, BEL U+0007 => `^G`);
 *  DEL => `^?`; a C1 char => `\xHH` (no single-key caret form). Module-private. */
const caretOf = (ch: string): string => {
  const c = ch.charCodeAt(0)
  if (c === 0x7f) return "^?"
  if (c <= 0x1f) return `^${String.fromCharCode(c ^ 0x40)}`
  return `\\x${c.toString(16).padStart(2, "0")}`
}

/** Defang hostile terminal-origin text for the transcript: visible-ize every
 *  control escape (no raw ESC/CSI/OSC byte survives) while preserving legible
 *  `\n`/`\t`, and strip bidi/zero-width forge chars + lone surrogates. */
export const neutralizeTerminalOutput = (s: string): string =>
  s.replace(BIDI_ZW_RE, "").replace(LONE_SURROGATE_RE, "").replace(CONTROL_RE, caretOf)
