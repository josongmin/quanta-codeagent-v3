/**
 * THE single enforced path for embedding untrusted content into a named prompt
 * tag block.
 *
 * Background — the bug class this closes:
 * The per-turn prompt assembles user-/repo-/IDE-controllable fragments (file
 * paths, IDE selection text, diagnostics, memory aggregate, rule content) INSIDE
 * named tag blocks — `<system-reminder>…</system-reminder>` (the harness reminder
 * wrapper) and `<ide-context>…</ide-context>` (the editor-state wrapper). A
 * fragment that carries a LITERAL closer for the block it lands in (e.g. a file
 * whose selection text contains `</ide-context>`, or an `AGENTS.md` body with
 * `</system-reminder>`) would prematurely terminate that block. Everything after
 * the forged closer then reads as out-of-band context — the model can be tricked
 * into treating the trailing payload as a fresh system-attributed instruction.
 * A forged OPENER (`<ide-context>` / `<system-reminder>` mid-fragment) is the
 * same attack from the other side: it re-attributes the inner payload as a new
 * harness/editor block.
 *
 * Historically each block grew its own ad-hoc escaper (`escapeReminderBoundary`
 * for the reminder wrapper, `escapeContextBoundary` for ide-context), and a NEW
 * untrusted block could simply forget to escape its own wrapper. This module is
 * the structural fix: ALL untrusted fragments funnel through {@link embedUntrusted}
 * (or {@link escapeBoundary}), which defangs the block's OWN tag boundary AND the
 * always-defanged `system-reminder` boundary. A new untrusted block cannot forget
 * escaping — it names its tag once and the helper enforces the defense.
 *
 * Defang form (byte-identical to the two legacy helpers it replaces): a single
 * backslash is inserted immediately after the opening `<` of any `<tag>` or
 * `</tag>` token, case-insensitive, casing of the match preserved:
 *   `<ide-context>`        → `<\ide-context>`
 *   `</ide-context>`       → `<\/ide-context>`
 *   `</SYSTEM-REMINDER>`   → `<\/SYSTEM-REMINDER>`
 * The defanged form is not parsed as a tag by the harness or the model's
 * pattern-matcher, yet stays human-readable in transcripts. Only the exact
 * genuine token (`<tag>` / `</tag>`, ASCII hyphen, real `>`, no interior space)
 * is defanged — evasion variants ride as inert data because they are not the
 * genuine boundary spelling and therefore cannot terminate the genuine wrapper.
 *
 * BENIGN INVARIANT: for any fragment that does NOT contain a genuine boundary
 * token for the named tag or for `system-reminder`, the output is byte-identical
 * to the input — no escape is ever introduced where none is needed.
 */

/** The boundary that is ALWAYS defanged regardless of the named block, because
 *  every untrusted fragment ultimately rides inside the harness's per-turn
 *  `<system-reminder>` wrapper downstream. */
const ALWAYS_DEFANGED_TAG = "system-reminder"

/** Build the case-insensitive boundary regex for a single tag name. Matches the
 *  genuine opener `<tag>` and closer `</tag>` (capturing everything after the
 *  leading `<`) so the replacement `"<\\$1"` re-inserts the captured token with a
 *  single backslash wedged after the `<`. */
const boundaryPattern = (tagName: string): RegExp =>
  new RegExp(`<(\\/?${escapeRegExpLiteral(tagName)}>)`, "gi")

/** Escape a tag name for safe use inside a RegExp source. Tag names are simple
 *  identifiers (`system-reminder`, `ide-context`) today, but routing arbitrary
 *  names through this helper means a name with regex metacharacters MUST NOT
 *  silently change the matcher's meaning. */
const escapeRegExpLiteral = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/** Defang the genuine `<tag>` / `</tag>` boundary tokens (case-insensitive,
 *  casing preserved) by inserting a single backslash after the leading `<`. */
const defangTag = (s: string, tagName: string): string =>
  s.replace(boundaryPattern(tagName), "<\\$1")

/**
 * Escape a fragment's boundary tokens for a named block WITHOUT wrapping it.
 *
 * Defangs BOTH the given tag's opener/closer AND the always-defanged
 * `system-reminder` boundary. When `tagName` is `system-reminder` only one pass
 * runs (idempotent — a token is never double-escaped because the defanged form
 * `<\tag>` no longer matches the genuine `<tag>` pattern).
 *
 * Use this when you need the escaped TEXT but the wrapper is emitted elsewhere
 * (e.g. a renderer that interleaves escaped fragments with literal headings, or
 * a wrapper applied to a whole pre-assembled block). For the common case —
 * "escape and wrap" — use {@link embedUntrusted}.
 */
export const escapeBoundary = (tagName: string, content: string): string => {
  const reminderSafe = defangTag(content, ALWAYS_DEFANGED_TAG)
  // Avoid a redundant identical pass when the named tag IS the reminder tag.
  return tagName.toLowerCase() === ALWAYS_DEFANGED_TAG
    ? reminderSafe
    : defangTag(reminderSafe, tagName)
}

/**
 * THE canonical path: escape an untrusted fragment for a named tag block and
 * wrap it in that block. Returns `<tag>\n${escaped}\n</tag>`.
 *
 * The opener/closer emitted here are the LITERAL genuine tokens (the trust
 * boundary the harness/model relies on); only the interior `content` is the
 * escaped untrusted fragment, so the rendered block carries EXACTLY ONE genuine
 * opener and ONE genuine closer no matter how many boundaries the fragment
 * forged.
 */
export const embedUntrusted = (tagName: string, content: string): string =>
  `<${tagName}>\n${escapeBoundary(tagName, content)}\n</${tagName}>`
