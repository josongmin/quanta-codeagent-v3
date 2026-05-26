/**
 * ADR-0325 — Pure mention parser for user input text.
 *
 * Three closed-enum mention sigils (mirrors Codex
 * `build_skills_and_plugins` in `codex-rs/core/src/session/turn.rs:436-575`):
 *
 *   `@skill-name`       → MentionKind = "skill"
 *   `plugin://name`     → MentionKind = "plugin"
 *   `@@app-name`        → MentionKind = "app"
 *
 * Syntax rules (LOCKED — extending requires a new ADR):
 *
 *   1. Identifier alphabet: `[a-z][a-z0-9-]*` (ASCII kebab-case, must
 *      start with a lowercase letter). Unicode names are rejected; this
 *      is a known limitation, NOT a TODO. Codex's registries use
 *      ASCII-only identifiers, so we match.
 *   2. Identifier length: ≥ 1 and ≤ 64 chars (post-sigil). Longer matches
 *      are rejected — the parser is a frontend for explicit user
 *      activation, not arbitrary text. 64 is generous (Codex skill ids
 *      empirically stay under 32).
 *   3. Left-boundary: the sigil MUST sit at the start of the input OR
 *      immediately after a whitespace / punctuation byte. The full
 *      "not a word character" predicate is JS `\w`-negative
 *      (`/[\w]/.test(prev) === false`). This rules out `foo@bar.com`
 *      (`@` follows `o`, a word character ⇒ not a mention).
 *   4. Right-boundary: the trailing char after the identifier MUST NOT
 *      be `[a-z0-9-]` (otherwise we'd be reading a prefix of a longer
 *      identifier — the regex `\b`-style stop). End-of-input counts as
 *      a boundary.
 *   5. Dedup: per `(kind, target)` pair, KEEP THE FIRST occurrence.
 *      Subsequent matches are dropped. Insertion order is preserved.
 *   6. Code fences / inline backticks are NOT treated specially — a
 *      mention inside ```@skill-name``` is still parsed. Documented as
 *      a limitation; downstream may strip before calling if needed.
 *   7. Empty target after sigil (`@`, `plugin://`, `@@`) is NOT a
 *      mention. The full sigil MUST be followed by a valid identifier.
 *
 * NO-THROW invariant: any input string produces a `readonly ParsedMention[]`.
 * Pure: no clock read, no I/O, no global state.
 */

import type { MentionKind, ParsedMention } from "./types"

/** Max identifier length (post-sigil). */
const MAX_TARGET_LEN = 64

/**
 * Combined regex. Each alternative captures the FULL match (sigil + ident)
 * via the named-group `raw` for offset bookkeeping, plus a kind-tagged
 * group so the kind switch is regex-driven (not post-hoc string-prefix
 * sniffing — that would mis-classify `@@x` as `skill`).
 *
 * IMPORTANT ordering: `@@app` MUST be tried before `@skill`, otherwise the
 * single-`@` alternative consumes the first `@` and leaves `@app` dangling
 * as a fresh skill match. Plugin scheme is independent (no `@` prefix).
 *
 * The trailing negative-lookahead `(?![a-z0-9-])` enforces rule 4
 * (right-boundary). The non-capturing wrapper `(?:...)` keeps the group
 * indices stable.
 */
const MENTION_RE =
  /(?<app>@@(?<appName>[a-z][a-z0-9-]*))(?![a-z0-9-])|(?<plugin>plugin:\/\/(?<pluginName>[a-z][a-z0-9-]*))(?![a-z0-9-])|(?<skill>@(?<skillName>[a-z][a-z0-9-]*))(?![a-z0-9-])/g

/**
 * Left-boundary predicate (rule 3). `prevChar` is the codepoint
 * immediately BEFORE the match start (or `""` at start-of-input). A
 * mention starts only when the previous char is not a JS word char.
 *
 * Why JS `\w` semantics (`[A-Za-z0-9_]`):
 *   - `@bar.com` post-`foo` ⇒ `foo` ends with a word char ⇒ NOT a
 *     mention. ✅ rejects email false positives.
 *   - `(@skill)` (`(` is non-word) ⇒ mention. ✅
 *   - `\n@skill` ⇒ mention. ✅
 *   - `hello @skill` (space) ⇒ mention. ✅
 *   - `_@skill` ⇒ `_` is word ⇒ NOT a mention (intentional — a leading
 *     underscore-letter run is treated as one identifier).
 */
const isLeftBoundaryOk = (prevChar: string): boolean => {
  if (prevChar === "") return true
  return /[^\w]/.test(prevChar)
}

/** Dispatch the captured groups to a kind / target pair. Exhaustive: the
 *  regex guarantees exactly one of `skill`/`plugin`/`app` is set per match,
 *  so the final `null` is unreachable when the regex matched. */
const dispatchKind = (
  groups: Record<string, string | undefined>,
): { kind: MentionKind; target: string } | null => {
  if (groups.app !== undefined && groups.appName !== undefined) {
    return { kind: "app", target: groups.appName }
  }
  if (groups.plugin !== undefined && groups.pluginName !== undefined) {
    return { kind: "plugin", target: groups.pluginName }
  }
  if (groups.skill !== undefined && groups.skillName !== undefined) {
    return { kind: "skill", target: groups.skillName }
  }
  return null
}

/**
 * Validate one regex match against all syntax rules (left-boundary,
 * kind dispatch, max-length). Returns the would-be {@link ParsedMention}
 * or `null` if the match is rejected by any rule. Pure.
 */
const validateMatch = (m: RegExpMatchArray, text: string): ParsedMention | null => {
  const start = m.index
  if (start === undefined) return null

  const raw = m[0]
  const prevChar = start === 0 ? "" : (text[start - 1] ?? "")
  if (!isLeftBoundaryOk(prevChar)) return null

  const dispatch = dispatchKind(m.groups ?? {})
  if (dispatch === null) return null
  if (dispatch.target.length > MAX_TARGET_LEN) return null

  return {
    kind: dispatch.kind,
    target: dispatch.target,
    span: { start, end: start + raw.length },
    raw,
  }
}

/**
 * Parse `userInputText` and return the (deduped, in-order) list of
 * explicit mentions. NO-THROW: degenerate inputs produce `[]`.
 *
 * Dedup key: `${kind}\x1f${target}` — a separator that cannot appear in
 * the identifier alphabet so `kind=skill,target="a-b"` is distinct from
 * a hypothetical `kind=skill-a,target="b"` (which can't be produced
 * anyway, since `skill` is enum-closed).
 */
export const parseMentions = (userInputText: string): readonly ParsedMention[] => {
  if (typeof userInputText !== "string" || userInputText.length === 0) {
    return []
  }

  const out: ParsedMention[] = []
  const seen = new Set<string>()

  // Reset stateful regex (defensive — module-level flag could be re-used).
  MENTION_RE.lastIndex = 0
  for (const m of userInputText.matchAll(MENTION_RE)) {
    const candidate = validateMatch(m, userInputText)
    if (candidate === null) continue

    const key = `${candidate.kind}\x1f${candidate.target}`
    if (seen.has(key)) continue
    seen.add(key)

    out.push(candidate)
  }

  return out
}
