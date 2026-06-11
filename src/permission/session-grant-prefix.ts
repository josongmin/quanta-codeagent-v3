/**
 * #20 — PREFIX-AWARE session grants (the "always allow `git …` this session"
 * verb). PURE; no IO, no shared state. The runtime approval controller
 * (`@/host/runtime/internal/context-binding.ts`) keeps a `Set<string>` of
 * granted prefix keys and consults {@link actionMatchesPrefixGrant} to decide
 * whether a fresh action rides a standing prefix grant the operator made
 * earlier in the session.
 *
 * THREAT MODEL (why this is conservative, not a footgun):
 *   A prefix grant widens the set of commands that skip the per-command prompt.
 *   Relative to the exact-key grant it sits beside, the new risk is COMMAND
 *   SMUGGLING: an operator who approved "always allow `git`" must NOT thereby
 *   approve `git status && rm -rf /` (whose first token is still `git`). So:
 *
 *     1. A prefix grant covers ONLY a SINGLE SIMPLE invocation — a command with
 *        NO shell control / chaining / redirection / substitution / glob /
 *        history metacharacter ({@link SHELL_METACHARS}). A command carrying any
 *        of them derives NO prefix key ⇒ it can never match a prefix grant ⇒ it
 *        re-prompts (fail-closed). This neutralises `&&`/`;`/`|`/`$()`/backtick
 *        chaining a benign program token could otherwise smuggle past the gate.
 *     2. The grant is keyed by `tool|<firstToken>` (the program name), with a
 *        TOKEN-BOUNDARY comparison (split on whitespace/commas) — so `bash|git`
 *        matches `git log` but NOT `github-dump` (different token) and NOT the
 *        `edit` tool (the tool is part of the key). No raw-substring prefix.
 *     3. HARD_DENY is checked by the admissibility gate BEFORE the reviewer /
 *        onConfirm is ever consulted (canonical gate order step 4 precedes the
 *        ask), so a denylisted command never reaches a grant at all — the guards
 *        here are defense-in-depth on top of that, not the only line.
 *
 * The mint key and the match key are the SAME derivation, so a grant minted for
 * `bash|git status` (⇒ key `bash|git`) is matched by any later simple `git`
 * command and by nothing else.
 */

/** Shell control / chaining / redirection / substitution / glob / history
 *  metacharacters. ANY of these in a command means it is NOT a single simple
 *  invocation, so {@link derivePrefixGrantKey} refuses to derive a prefix key
 *  (the command re-prompts). Deliberately a conservative SUPERSET — a false
 *  "complex" verdict only costs an extra prompt; a false "simple" verdict could
 *  smuggle a chained command past a benign-program grant. Quotes are included
 *  too: a quoted arg that happens to contain `;` is harmless, but refusing to
 *  prefix-grant it (re-prompt) is the safe call. */
const SHELL_METACHARS = /[;&|<>(){}$`\\\n\r*?!#'"]/

/** Token splitter — whitespace + commas, matching the trust-scope store's
 *  tokenizer so the two prefix notions stay consistent. */
const SPLIT_RE = /[\s,]+/

/** The command portion of an actionKey. An actionKey is `tool|command` for a
 *  shell-equivalent tool, or a bare `tool` name otherwise. Returns the trimmed
 *  command, or `""` when there is no `|` (a non-shell tool has no command, so
 *  no prefix applies). NOT lowercased — comparison stays case-exact so a grant
 *  for `git` can never broaden to cover `GIT` (case-folding would only widen). */
const commandOf = (actionKey: string): string => {
  const idx = actionKey.indexOf("|")
  return idx >= 0 ? actionKey.slice(idx + 1).trim() : ""
}

/** The tool portion of an actionKey (everything before the first `|`, or the
 *  whole string when there is none). The tool is part of the prefix key so a
 *  `bash` grant can never unlock an `edit` action. */
const toolOf = (actionKey: string): string => {
  const idx = actionKey.indexOf("|")
  return idx >= 0 ? actionKey.slice(0, idx) : actionKey
}

/** Is `cmd` a single simple invocation safe to cover by a program-token prefix
 *  grant? Empty ⇒ no. Any {@link SHELL_METACHARS} ⇒ no (could chain/smuggle). */
export const isSimpleCommand = (cmd: string): boolean =>
  cmd.length > 0 && !SHELL_METACHARS.test(cmd)

/** Derive the prefix-grant key for an actionKey, or `null` when no SAFE prefix
 *  exists (non-shell tool / empty / non-simple command). The key is
 *  `tool|<firstToken>` — the program name — so it means "all simple <program>
 *  commands for this tool, this session". Used for BOTH minting and matching, so
 *  the two can never disagree. */
export const derivePrefixGrantKey = (actionKey: string): string | null => {
  const cmd = commandOf(actionKey)
  if (!isSimpleCommand(cmd)) return null
  const first = cmd.split(SPLIT_RE).find((t) => t.length > 0)
  if (first === undefined) return null
  return `${toolOf(actionKey)}|${first}`
}

/** The operator-facing label for the prefix a confirm would grant — the program
 *  token (e.g. `git`), or `null` when the action cannot be safely prefix-granted
 *  (so the surface should not offer the prefix verb / should fall back to the
 *  exact session grant). Surfacing this in the prompt keeps consent INFORMED. */
export const prefixGrantLabel = (actionKey: string): string | null => {
  const cmd = commandOf(actionKey)
  if (!isSimpleCommand(cmd)) return null
  return cmd.split(SPLIT_RE).find((t) => t.length > 0) ?? null
}

/** Does `actionKey` match ANY granted prefix? Only a SIMPLE command derives a
 *  key, so a chained/complex command always returns false (re-prompts). The
 *  comparison is exact-key membership over the `tool|<firstToken>` keys, i.e.
 *  token-boundary + tool-scoped — never a raw substring prefix. */
export const actionMatchesPrefixGrant = (
  actionKey: string,
  grants: ReadonlySet<string>,
): boolean => {
  if (grants.size === 0) return false
  const key = derivePrefixGrantKey(actionKey)
  return key !== null && grants.has(key)
}
