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

import { lowerShellTree, parseShell } from "./shell"
import { VEHICLE_HEADS } from "./shell/rules"
import { stripVehicleHeads } from "./shell/vehicle"

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
/** Metacharacters the IR cannot vouch for, i.e. {@link SHELL_METACHARS} MINUS
 *  the quote characters.
 *
 *  Quotes are the one class the parser reads better than the text rule: a quoted
 *  argument is still a single simple invocation, and refusing it cost a prompt
 *  on every `git commit -m 'msg'`. Everything else stays refused by TEXT, on
 *  purpose — most importantly `&`, which BACKGROUNDS a command and which the IR
 *  does NOT record: `git status &` lowers to exactly the same one-command shape
 *  as `git status`. Trusting the IR alone would therefore widen the grant on a
 *  shape it cannot actually see, so the parser may only ever narrow the KEY, and
 *  may widen ADMISSION for quotes alone. */
const NON_QUOTE_METACHARS = /[;&|<>(){}$`\\\n\r*?!#]/

/** The program a prefix grant should name, read off the parsed command.
 *
 *  `null` when the parser is unavailable or cannot vouch for the command, in
 *  which case the caller keeps the textual rule — a grant path must never widen
 *  because a parser failed to load. */
/** A `VAR=value` token anywhere in the command.
 *
 *  An environment prefix can REPLACE the program it appears to run:
 *  `PATH=/tmp/evil git push` executes `/tmp/evil/git`, and
 *  `LD_PRELOAD=… git push` executes the real git with injected code. So a
 *  command carrying one is never prefix-grantable, no matter how simple its
 *  structure looks — the parser correctly reports the program as `git`, and that
 *  is exactly the answer that would be wrong here.
 *
 *  Matches an identifier followed by `=`, so `--grep=fix` (starts with `-`) is
 *  untouched. */
const ASSIGNMENT_TOKEN = /(?:^|\s)[A-Za-z_][A-Za-z0-9_]*=/

const parsedGrantProgram = (cmd: string): string | null => {
  const root = parseShell(cmd)
  if (root === null) return null
  const ir = lowerShellTree(root)
  // Exactly ONE command, cleanly parsed: two commands is a chain, and a chain is
  // the smuggling this module exists to refuse.
  if (ir.hasParseError || ir.commands.length !== 1) return null
  const only = ir.commands[0]
  if (only === undefined) return null
  // A redirect makes the command WRITE somewhere the grant never named
  // (`git log > /etc/passwd`), so it is not covered by "always allow git".
  if (only.redirects.length > 0) return null
  // Any word the shell would still have to evaluate (`$(…)`, backtick, `${…}`)
  // could name a different program or argument than the text suggests.
  if (!only.head?.resolved || only.args.some((a) => !a.resolved)) return null
  const payload = stripVehicleHeads(only)
  const head = payload?.head
  if (payload === null || head === undefined || head === null || !head.resolved) return null
  return head.text
}

export const derivePrefixGrantKey = (actionKey: string): string | null => {
  const cmd = commandOf(actionKey)
  if (cmd.length === 0) return null
  // FLOOR, unchanged: anything the text rule calls unsafe stays unsafe. The
  // parser is only allowed to make the answer NARROWER (name the payload rather
  // than the vehicle) or to admit the quote case it can positively vouch for.
  if (NON_QUOTE_METACHARS.test(cmd)) return null
  // Applies to BOTH derivations below. An env prefix is not a program name, and
  // minting it as one (`bash|FOO=bar`) would hand out a grant that later covers
  // any command sharing that prefix — `FOO=bar rm -rf /tmp/x` rides a grant the
  // operator gave for `FOO=bar git push`.
  if (ASSIGNMENT_TOKEN.test(cmd)) return null

  // WHY THE PAYLOAD, NOT THE FIRST TOKEN. A vehicle head is not a metacharacter,
  // so `sudo apt-get install -y jq` is a "simple" command whose first token is
  // `sudo` — and the minted key was `bash|sudo`. Measured: that one grant then
  // covered `sudo cp evil /etc/passwd`, `sudo tee /etc/hosts` and
  // `sudo chmod 777 /etc` with no prompt (HARD_DENY catches `sudo rm -rf /`, but
  // a narrow denylist is not the consent boundary — this grant is). The operator
  // consented to apt-get; they must not get "sudo anything".
  const program = parsedGrantProgram(cmd)
  if (program !== null) return `${toolOf(actionKey)}|${program}`

  // Parser unavailable / could not vouch ⇒ the original textual derivation,
  // quotes included in the refusal. Never wider than before.
  if (!isSimpleCommand(cmd)) return null
  const first = cmd.split(SPLIT_RE).find((t) => t.length > 0)
  if (first === undefined) return null
  // …with one refusal the text rule always needed: a VEHICLE head is not a
  // program. Without the parser we cannot see past it, and minting `bash|sudo`
  // is the very hole this derivation exists to close — so refuse rather than
  // let a missing parser hand back the wide key.
  if (VEHICLE_HEADS.has(first)) return null
  return `${toolOf(actionKey)}|${first}`
}

/** The operator-facing label for the prefix a confirm would grant — the program
 *  token (e.g. `git`), or `null` when the action cannot be safely prefix-granted
 *  (so the surface should not offer the prefix verb / should fall back to the
 *  exact session grant). Surfacing this in the prompt keeps consent INFORMED. */
export const prefixGrantLabel = (actionKey: string): string | null => {
  // DERIVED FROM THE KEY, never re-derived. The label is the CONSENT TEXT: if it
  // said `sudo` while the key minted `apt-get`, the operator would be shown one
  // permission and given another — a worse failure than either alone. Splitting
  // the key is what makes them incapable of disagreeing.
  const key = derivePrefixGrantKey(actionKey)
  if (key === null) return null
  const idx = key.indexOf("|")
  return idx >= 0 ? key.slice(idx + 1) : null
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
