/**
 * ADR-0314 — Mention filter with trust-scope gating.
 *
 * `matchMention` returns a {@link MentionMatch} that is `matched: true` ONLY
 * when ALL of these hold (no heuristics — every signal is structural):
 *
 *  1. The body contains one of the configured trigger phrases on a line
 *     that is NOT inside a fenced code block (```), NOT inside an inline
 *     code span (`` ` ``), and NOT a blockquote line (starts with `>`).
 *  2. Comparison is case-insensitive, word-boundary anchored (phrase
 *     followed by whitespace, EOL, or punctuation; preceded by start of
 *     line or whitespace).
 *
 * `createMentionFilter(opts)` wraps `matchMention` with trust-scope + bot
 * gating: even a successful phrase match is invalidated when the sender's
 * trust scope is insufficient or the sender is a bot (unless `allowBots`).
 *
 * Self-loop defense: bodies containing our own idempotency marker
 * `<!-- quanta:idempotency=` are unconditionally treated as non-mentions —
 * a comment we posted cannot wake us up.
 */

import { IDEMPOTENCY_MARKER_PREFIX } from "./outbound-body-policy"
import type { MentionMatch, NormalizedGhEvent, TrustScope } from "./types"

export interface MentionFilterOpts {
  readonly triggerPhrases: readonly string[]
  /** Minimum trust scope required for a mention to count. Default
   *  `"collaborator"`. `"public"` opens to anyone (NOT recommended). */
  readonly requireTrustScope: TrustScope
  /** When `false` (default), sender.type === "Bot" never matches even if the
   *  phrase appears. */
  readonly allowBots: boolean
}

export interface MentionFilter {
  evaluate(event: NormalizedGhEvent): MentionMatch
}

const TRUST_RANK: Record<TrustScope, number> = {
  public: 0,
  collaborator: 1,
  member: 2,
  owner: 3,
}

/**
 * Body-only mention detector. Pure: same input ⇒ same output.
 * `phrases` is matched case-insensitively. Empty phrases are ignored.
 */
export const matchMention = (
  body: string | undefined,
  phrases: readonly string[],
): MentionMatch => {
  if (typeof body !== "string" || body.length === 0) return { matched: false }
  if (body.includes(IDEMPOTENCY_MARKER_PREFIX)) return { matched: false }
  const cleanedPhrases = cleanPhrases(phrases)
  if (cleanedPhrases.length === 0) return { matched: false }

  const lines = body.split(/\r?\n/)
  let inFencedCode = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ""
    const trimmedStart = line.trimStart()
    if (/^(```|~~~)/.test(trimmedStart)) {
      inFencedCode = !inFencedCode
      continue
    }
    if (inFencedCode) continue
    if (trimmedStart.startsWith(">")) continue
    const hit = matchLine(line, cleanedPhrases, i + 1)
    if (hit !== undefined) return hit
  }
  return { matched: false }
}

const cleanPhrases = (phrases: readonly string[]): readonly string[] => {
  if (phrases.length === 0) return []
  return phrases
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => p.toLowerCase())
}

const matchLine = (
  line: string,
  cleanedPhrases: readonly string[],
  lineNumber: number,
): MentionMatch | undefined => {
  const stripped = stripInlineCode(line)
  const lower = stripped.toLowerCase()
  for (const phrase of cleanedPhrases) {
    const idx = findPhraseWithBoundary(lower, phrase)
    if (idx < 0) continue
    const args = extractArgs(stripped.slice(idx + phrase.length))
    return {
      matched: true,
      command: phrase,
      ...(args !== undefined ? { args } : {}),
      atLine: lineNumber,
    }
  }
  return undefined
}

/**
 * Build a {@link MentionFilter} that combines body match + trust-scope + bot
 * gating into one evaluate verb.
 */
export const createMentionFilter = (opts: MentionFilterOpts): MentionFilter => {
  const requiredRank = TRUST_RANK[opts.requireTrustScope]
  return {
    evaluate(event: NormalizedGhEvent): MentionMatch {
      // Bot gate — applies BEFORE phrase match so we never inspect bot bodies.
      if (event.sender.type === "Bot" && !opts.allowBots) return { matched: false }

      // Trust gate — derive scope from isCollaborator + sender.type.
      const senderScope = resolveScope(event)
      if (TRUST_RANK[senderScope] < requiredRank) return { matched: false }

      return matchMention(event.body, opts.triggerPhrases)
    },
  }
}

/**
 * GitHub's own association, where it names a scope directly. A `Map`, not an
 * object: `ASSOCIATION_SCOPE["constructor"]` on an object literal is a function,
 * and a function scope then ranked `undefined`, which passed every gate.
 */
const ASSOCIATION_SCOPE: ReadonlyMap<string, TrustScope> = new Map([
  ["OWNER", "owner"],
  ["MEMBER", "member"],
  ["COLLABORATOR", "collaborator"],
])

/**
 * Resolve the sender's trust scope. Order: GitHub's `author_association` when it
 * names a scope → explicit `isCollaborator` (payloads that carry only the
 * boolean) → "owner" when the repo owner's login is the sender's → "public".
 *
 * The association used to be read only through `isCollaborator`, which is true
 * for OWNER and MEMBER too, and that check came first — so every owner and
 * member resolved to `collaborator`, and the `owner` and `member` scopes
 * silently answered no one.
 */
const resolveScope = (event: NormalizedGhEvent): TrustScope => {
  const byAssociation =
    event.sender.association === undefined
      ? undefined
      : ASSOCIATION_SCOPE.get(event.sender.association)
  if (byAssociation !== undefined) return byAssociation
  if (event.sender.isCollaborator === true) return "collaborator"
  if (event.repo.owner === event.sender.login) return "owner"
  return "public"
}

const stripInlineCode = (line: string): string => {
  // Replace `...` with whitespace of equal length so column offsets stay
  // stable (we don't use offsets externally yet, but it keeps the substring
  // search aligned with the original line).
  let out = ""
  let i = 0
  while (i < line.length) {
    if (line[i] === "`") {
      const end = line.indexOf("`", i + 1)
      if (end < 0) {
        out += line.slice(i) // unmatched — keep literal
        break
      }
      out += " ".repeat(end - i + 1)
      i = end + 1
      continue
    }
    out += line[i]
    i += 1
  }
  return out
}

/**
 * Word-boundary phrase search. Phrase MUST be preceded by start-of-line,
 * whitespace, or an OPEN punctuation char (`([{<"'`) — matching GitHub's
 * native @mention behavior where `(@user)`, `[@user]`, `"@user"` are all
 * valid mentions. Followed by whitespace, EOL, or common CLOSE punctuation
 * (`,.;:)!?]`).  Returns the index of the FIRST boundary-valid match, or -1.
 */
const PRE_BOUNDARY_PUNCT = /[([{<"']/
const POST_BOUNDARY_PUNCT = /[.,;:!?)\]}>'"]/
const findPhraseWithBoundary = (haystack: string, phrase: string): number => {
  let from = 0
  while (from < haystack.length) {
    const idx = haystack.indexOf(phrase, from)
    if (idx < 0) return -1
    const prev = idx === 0 ? "" : (haystack[idx - 1] ?? "")
    const next = haystack[idx + phrase.length] ?? ""
    const prevOk = prev === "" || /\s/.test(prev) || PRE_BOUNDARY_PUNCT.test(prev)
    const nextOk = next === "" || /\s/.test(next) || POST_BOUNDARY_PUNCT.test(next)
    if (prevOk && nextOk) return idx
    from = idx + 1
  }
  return -1
}

const extractArgs = (after: string): string | undefined => {
  const trimmed = after.trim()
  if (trimmed.length === 0) return undefined
  // Strip leading punctuation we accepted as the boundary so args is clean.
  return trimmed.replace(/^[.,;:!?)\]}>'"]+\s*/, "")
}
