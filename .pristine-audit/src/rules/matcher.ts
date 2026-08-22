/**
 * Prefix-rule matcher — deterministic longest-prefix-match over a single
 * rule set.
 *
 * Algorithm (no heuristic, no magic constants):
 *
 * 1. Normalise the input command by stripping LEADING whitespace only.
 *    Trailing whitespace and internal spacing are preserved — commands
 *    such as `git commit -m "msg with trailing space "` are matched as
 *    written, so a rule cannot be bypassed by appending spaces.
 * 2. Sort rules by prefix length, descending. Stable order is preserved
 *    for equal-length prefixes via the original index — the matcher is
 *    a total deterministic function of (command, rules).
 * 3. For each rule (longest first), accept iff:
 *      command === rule.prefix
 *    OR command.startsWith(rule.prefix) AND command[rule.prefix.length]
 *      is exactly ASCII space (0x20).
 *
 *    The space-boundary check is what prevents `git` from matching
 *    `github` — the rule prefix must end at a word boundary as
 *    interpreted by shell argument parsing (we do not honour tabs as
 *    argument separators because shells don't either in unquoted form).
 * 4. Return the first matching rule; otherwise `{ kind: "no_match" }`.
 *
 * The "no_match" branch is NOT an error — see types.ts. The caller
 * (admissibility-gate, ADR-0031) decides whether to default-deny or
 * fall through.
 */

import { matchArgvRule, tokenizeArgv } from "./argv"
import type { MatchOutcome, Rule } from "./types"

/** Internal fast path for callers that own rule lifecycle and can prepare
 *  rule order once up-front (e.g. `RulesStore`). Not re-exported from the
 *  barrel; external callers should keep using `matchCommand()`. */
export const matchPreparedCommand = (
  command: string,
  preparedRules: readonly Rule[],
): MatchOutcome => {
  const normalised = stripLeading(command)
  if (preparedRules.length === 0) {
    return { kind: "no_match" }
  }

  // §10.2 — lazily tokenize the command argv ONCE, only if at least one argv
  // rule is present. A rule set with NO argv rules never tokenizes, so the
  // byte-prefix hot path is byte-identical to before (zero new work).
  let argv: readonly string[] | null = null
  for (const rule of preparedRules) {
    if (rule.argv !== undefined) {
      if (argv === null) argv = tokenizeArgv(command)
      if (matchArgvRule(rule.argv, argv)) {
        return { kind: "matched", rule }
      }
    } else if (matchesPrefix(normalised, rule.prefix)) {
      return { kind: "matched", rule }
    }
  }
  return { kind: "no_match" }
}

/** Deterministic longest-prefix order for a rule array. Returns a fresh
 *  frozen view and never mutates caller-owned arrays. Equal-length ties
 *  preserve original source order via the input index. */
export const prepareRulesForMatch = (rules: readonly Rule[]): readonly Rule[] => {
  if (rules.length < 2) {
    return rules
  }

  const indexed = rules.map((rule, index) => ({ rule, index }))
  indexed.sort((a, b) => {
    const lenDiff = b.rule.prefix.length - a.rule.prefix.length
    if (lenDiff !== 0) return lenDiff
    return a.index - b.index
  })

  return Object.freeze(indexed.map(({ rule }) => rule))
}

/**
 * Match a command against a flat rule list. Layer precedence is NOT
 * applied here — that is `RulesStore`'s job. Within one rule set the
 * longest-prefix-match rule wins.
 *
 * @param command Raw command string (e.g. `"git status --short"`). Leading
 *                whitespace is stripped; everything else is matched literally.
 * @param rules   Rule set to search. May be empty (always `no_match`).
 *                Caller retains ownership; the matcher does not mutate.
 */
export const matchCommand = (command: string, rules: readonly Rule[]): MatchOutcome =>
  matchPreparedCommand(command, prepareRulesForMatch(rules))

/** Exact-or-space-bounded prefix match. See module header for invariants. */
const matchesPrefix = (command: string, prefix: string): boolean => {
  if (command.length < prefix.length) return false
  if (!command.startsWith(prefix)) return false
  // Exact-length match: `git status` against `git status` → true.
  if (command.length === prefix.length) return true
  // The character immediately after the prefix MUST be ASCII space.
  // 0x20 = ' '. We intentionally do NOT accept `\t` here — shells split
  // unquoted args on space; treating tab as a boundary would be a
  // heuristic that diverges across runtimes.
  return command.charCodeAt(prefix.length) === 0x20
}

/** Strip ASCII space / tab from the front of `s`. Trailing whitespace is
 *  preserved (see module header rationale). */
const stripLeading = (s: string): string => {
  let i = 0
  while (i < s.length) {
    const c = s.charCodeAt(i)
    if (c !== 0x20 && c !== 0x09) break
    i++
  }
  return i === 0 ? s : s.slice(i)
}
