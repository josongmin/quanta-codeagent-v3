/**
 * `@/permission/shell/assess` — the ONE shell effect assessment.
 *
 * Walks the IR in execution order, threading the effective cwd, stripping
 * vehicles, recursing into `-c` shell payloads, and judging each command's
 * effect. Returns a single verdict for the whole command line, worst-first:
 * one `hard-deny` anywhere denies the line; otherwise one `unknown` anywhere
 * makes the line unknown; otherwise the line is safe.
 *
 * `unknown` is NOT a soft "probably fine". It means the authority could not
 * read the command, and every consumer must route it to the existing
 * ask/deny/sandbox boundary rather than to an allow. An AST is not a sandbox.
 *
 * Pure: no IO, no clock, no randomness. Same input ⇒ identical assessment.
 */

import type { ShellCommandIr, ShellWord } from "./ir"
import { lowerShellTree } from "./ir"
import { parseShell, type ShellNode } from "./parser"
import {
  applyCd,
  CALLER_CWD,
  type EffectiveCwd,
  isCatastrophicDeleteTarget,
  resolveAgainst,
  UNKNOWN_CWD,
} from "./path-effect"
import {
  DELETE_HEADS,
  DISKUTIL_DESTRUCTIVE_VERBS,
  DISKUTIL_LEADING_MODIFIERS,
  DISKUTIL_VERB_GROUPS,
  EGRESS_HEADS,
  EVAL_HEADS,
  expandFlagCluster,
  FETCH_HEADS,
  FILESYSTEM_FORMAT_HEADS,
  FIND_ACTION_FLAGS,
  GIT_WHOLE_TREE_PATHSPECS,
  gitOperandTokens,
  gitRestoreTouchesWorktree,
  INLINE_CODE_FLAGS,
  INTERPRETER_HEADS,
  isSecretStorePath,
  LITERAL_PRODUCER_HEADS,
  SECRET_READ_HEADS,
  SHELL_HEADS,
  STDIN_OPERAND_HEADS,
} from "./rules"
import { stripVehicleHeads } from "./vehicle"

/** Verdict for a command line.
 *
 *  - `safe-known`      — read in full; no effect that needs a gate.
 *  - `sensitive-known` — read in full; an effect a policy layer should weigh.
 *  - `hard-deny`       — read in full; an effect no mode may authorize.
 *  - `unknown`         — NOT read in full. Never treat as safe. */
export type ShellAssessmentKind = "safe-known" | "sensitive-known" | "hard-deny" | "unknown"

export interface ShellAssessment {
  readonly kind: ShellAssessmentKind
  /** The rule name when the verdict names one — every `hard-deny`, and every
   *  `sensitive-known` — so the two authorities name the same effect the same
   *  way. */
  readonly rule?: string
  readonly reason: string
}

const safe = (): ShellAssessment => ({ kind: "safe-known", reason: "no gated effect" })
const unknown = (reason: string): ShellAssessment => ({ kind: "unknown", reason })
const deny = (rule: string, reason: string): ShellAssessment => ({
  kind: "hard-deny",
  rule,
  reason,
})
/** An effect that is REAL and READ IN FULL but that `hard-deny`'s own
 *  definition — "no mode may authorize" — does not fit.
 *
 *  BE PLAIN ABOUT THIS: `sensitive-known` is INERT today. Nothing produced it
 *  before this function and the only consumer of an assessment,
 *  `permission/policy.ts`, branches on `=== "hard-deny"`, so a
 *  `sensitive-known` command is permitted exactly as `safe-known` is. It is
 *  still the right label, for two reasons. First, the alternative labels are
 *  both lies: `hard-deny` says no tier may ever revert a single file, and
 *  `safe-known` says reverting one is "no effect that needs a gate" — the very
 *  claim that let `git restore src/foo.ts` sail past while its `git checkout --`
 *  twin was unappealable. Second, `RANK` already orders it above `safe-known`,
 *  so the first policy layer that reads it inherits a correct corpus instead of
 *  having to re-derive one. */
const sensitive = (rule: string, reason: string): ShellAssessment => ({
  kind: "sensitive-known",
  rule,
  reason,
})

const RANK: Record<ShellAssessmentKind, number> = {
  "safe-known": 0,
  "sensitive-known": 1,
  unknown: 2,
  "hard-deny": 3,
}

/** Worst verdict wins: a line is only as safe as its most dangerous command. */
const worst = (a: ShellAssessment, b: ShellAssessment): ShellAssessment =>
  RANK[b.kind] > RANK[a.kind] ? b : a

const argTexts = (args: readonly ShellWord[]): string[] => args.map((a) => a.text)

/** Flags of a command, with POSIX clusters expanded. Unresolved words are
 *  excluded — their text is not the flag the shell will see. */
const flagsOf = (args: readonly ShellWord[]): Set<string> => {
  const out = new Set<string>()
  for (const a of args) {
    if (!a.resolved || !a.text.startsWith("-")) continue
    for (const f of expandFlagCluster(a.text)) out.add(f)
  }
  return out
}

/** Non-flag operands, resolved only. */
const operandsOf = (args: readonly ShellWord[]): ShellWord[] =>
  args.filter((a) => !(a.resolved && a.text.startsWith("-")))

interface Ctx {
  cwd: EffectiveCwd
  depth: number
}

const MAX_DEPTH = 4

/* ------------------------------------------------------------------------- *
 * per-head effect rules
 * ------------------------------------------------------------------------- */

const assessDelete = (cmd: ShellCommandIr, ctx: Ctx): ShellAssessment => {
  const flags = flagsOf(cmd.args)
  const head = cmd.head?.text ?? ""
  const recursive =
    flags.has("-r") || flags.has("-R") || flags.has("--recursive") || head === "rimraf"
  const forced = flags.has("-f") || flags.has("--force") || head === "rimraf"
  const operands = operandsOf(cmd.args)
  if (operands.length === 0) return safe()
  let verdict = safe()
  for (const op of operands) {
    if (!op.resolved) {
      verdict = worst(verdict, unknown(`${head}: target "${op.text}" is not statically resolvable`))
      continue
    }
    const resolved = resolveAgainst(ctx.cwd, op.text)
    if (resolved.kind === "unknown") {
      verdict = worst(
        verdict,
        unknown(`${head}: target "${op.text}" resolves under an unknown working directory`),
      )
      continue
    }
    // A caller-relative target stays inside the directory the operator pointed
    // the agent at — ordinary destructive work (`rm -rf ./build`), not a gate.
    if (resolved.kind === "caller-relative") continue
    if (recursive && forced && isCatastrophicDeleteTarget(resolved.path)) {
      verdict = worst(
        verdict,
        deny(
          "rm-recursive-force-system-root",
          `recursive forced delete of ${resolved.path} (from "${head} ${argTexts(cmd.args).join(" ")}")`,
        ),
      )
    }
  }
  return verdict
}

/** `find <absolute-root> -delete|-exec …` walks and destroys a system tree.
 *  `find .` and `find ./src` are ordinary and stay safe — the rule turns on the
 *  ROOT being absolute-and-catastrophic, exactly as the shipping
 *  `find-absolute-root-delete-or-exec-rm` rule does. */
const assessFind = (cmd: ShellCommandIr, ctx: Ctx): ShellAssessment => {
  const hasAction = cmd.args.some((a) => a.resolved && FIND_ACTION_FLAGS.has(a.text))
  if (!hasAction) return safe()
  const roots = operandsOf(cmd.args)
  let verdict = safe()
  for (const root of roots) {
    if (!root.resolved) {
      verdict = worst(verdict, unknown(`find: root "${root.text}" is not statically resolvable`))
      continue
    }
    const resolved = resolveAgainst(ctx.cwd, root.text)
    if (resolved.kind === "unknown") {
      verdict = worst(verdict, unknown(`find: root "${root.text}" is under an unknown directory`))
      continue
    }
    if (resolved.kind === "abs" && isCatastrophicDeleteTarget(resolved.path)) {
      verdict = worst(
        verdict,
        deny(
          "find-absolute-root-delete-or-exec-rm",
          `find walks ${resolved.path} with a destructive action`,
        ),
      )
    }
  }
  return verdict
}

/** Refspecs that rewrite or delete remote history. `+main` is a force-push
 *  written in refspec syntax — the same effect as `--force`, and the form the
 *  regex gate never matched. `:main` deletes the remote branch. */
const forcePushRefspec = (operand: string): boolean =>
  operand.startsWith("+") || (operand.startsWith(":") && operand.length > 1)

const GIT_DESTRUCTIVE: ReadonlyArray<{
  readonly rule: string
  readonly matches: (
    sub: string,
    flags: ReadonlySet<string>,
    operands: readonly string[],
  ) => boolean
  readonly what: string
}> = [
  {
    rule: "git-push-force",
    what: "force-push rewrites published history",
    matches: (sub, flags, operands) =>
      sub === "push" &&
      (flags.has("-f") ||
        flags.has("--force") ||
        flags.has("--force-with-lease") ||
        flags.has("--mirror") ||
        flags.has("--delete") ||
        operands.some(forcePushRefspec)),
  },
  {
    rule: "git-reset-hard",
    what: "discards working-tree and index state irrecoverably",
    matches: (sub, flags) => sub === "reset" && flags.has("--hard"),
  },
  {
    rule: "git-clean-force",
    what: "deletes untracked files with no reflog to recover them",
    matches: (sub, flags) => sub === "clean" && (flags.has("-f") || flags.has("--force")),
  },
  {
    // WHOLE-TREE discard only. `git checkout .` / `git checkout -- .` throw
    // away every uncommitted edit in the tree, which is `git reset --hard`'s
    // blast radius — the reason that one is hard-deny too.
    //
    // The single-path form `git checkout -- src/foo.ts` USED to land here, and
    // that was wrong in a way this campaign keeps making: `hard-deny` is
    // terminal, so no mode — however trusted, however explicit the user — could
    // revert one file, while `git restore src/foo.ts`, git's own supported
    // spelling of the identical effect, was fully allowed. An unappealable
    // verdict that the next spelling walks around is not a safety property. It
    // is now `sensitive-known`; see GIT_WORKTREE_DISCARD_PATH below.
    rule: "git-checkout-discard",
    what: "discards every uncommitted edit in the working tree",
    matches: (sub, flags, operands) =>
      sub === "checkout" &&
      (flags.has("-f") ||
        flags.has("--force") ||
        operands.some((o) => GIT_WHOLE_TREE_PATHSPECS.has(o))),
  },
  {
    // `git restore .` and `git restore --worktree --staged .` — measured
    // `safe-known`, i.e. the modern spelling of the effect the line above has
    // denied since ADR-0100 was fully allowed. `--staged` ALONE is an
    // index-only unstage and deliberately does NOT fire.
    rule: "git-restore-discard",
    what: "discards every uncommitted edit in the working tree",
    matches: (sub, flags, operands) =>
      sub === "restore" &&
      gitRestoreTouchesWorktree(flags) &&
      operands.some((o) => GIT_WHOLE_TREE_PATHSPECS.has(o)),
  },
  {
    // `git switch --discard-changes main` — measured `safe-known`. git's own
    // `-h` calls `-f, --force` "an alias for --discard-changes", so all three
    // spellings are one rule. There is no pathspec form: switch discards the
    // WHOLE tree or nothing.
    rule: "git-switch-discard-changes",
    what: "throws away every local modification while switching",
    matches: (sub, flags) =>
      sub === "switch" &&
      (flags.has("--discard-changes") || flags.has("-f") || flags.has("--force")),
  },
  {
    rule: "git-commit-amend",
    what: "rewrites the last commit",
    matches: (sub, flags) => sub === "commit" && flags.has("--amend"),
  },
]

/** Operands of a git invocation, read by the SHARED {@link gitOperandTokens}
 *  so this authority and `decideBranchOnly` cannot resolve a different
 *  subcommand for the same command line. `assessGit` has already refused
 *  anything unresolved, so the raw texts ARE the argv the shell will see. */
const gitOperands = (args: readonly ShellWord[]): string[] =>
  gitOperandTokens(args.map((a) => a.text))

/**
 * Named-path discards: the SAME effect as the whole-tree rules above, one file
 * at a time. `sensitive-known`, not `hard-deny` — see {@link sensitive}.
 *
 * Kept as its own table so the two tiers cannot drift into each other: a rule
 * here can never produce a terminal verdict, and a rule in `GIT_DESTRUCTIVE`
 * can never produce a soft one.
 *
 * KNOWN GAP, stated rather than papered over: `git checkout src/foo.ts` — no
 * `--`, one token — discards that file too, and is NOT covered. A ref and a
 * pathspec are indistinguishable at this token (`git checkout main` is a branch
 * switch and must stay `safe-known`), and only the repository can tell them
 * apart. Covering it would mean labelling every `git checkout <branch>` a
 * discard. `--` is git's own disambiguator and is what this table reads.
 */
const GIT_WORKTREE_DISCARD_PATH: ReadonlyArray<{
  readonly rule: string
  readonly matches: (
    sub: string,
    flags: ReadonlySet<string>,
    operands: readonly string[],
  ) => boolean
  readonly what: string
}> = [
  {
    // The `--` arm was DEAD until `gitOperandTokens` stopped dropping the
    // end-of-options marker: every operand reader filtered `-`-leading tokens,
    // so `git checkout -- src/foo.ts` never matched anything at all.
    rule: "git-checkout-discard-path",
    what: "restores named paths over uncommitted edits",
    matches: (sub, _flags, operands) => sub === "checkout" && operands.includes("--"),
  },
  {
    // `git restore src/foo.ts`. Whole-tree forms were already denied above, so
    // anything reaching here names paths.
    rule: "git-restore-discard-path",
    what: "restores named paths over uncommitted edits",
    matches: (sub, flags, operands) =>
      sub === "restore" && gitRestoreTouchesWorktree(flags) && operands.length > 0,
  },
]

const assessGit = (cmd: ShellCommandIr, _ctx: Ctx): ShellAssessment => {
  const args = cmd.args
  if (args.some((a) => !a.resolved)) {
    return unknown("git: an argument is not statically resolvable")
  }
  const flags = flagsOf(args)
  const operands = gitOperands(args)
  const sub = operands[0]
  if (sub === undefined) return safe()
  const rest = operands.slice(1)
  for (const rule of GIT_DESTRUCTIVE) {
    if (rule.matches(sub, flags, rest)) {
      return deny(rule.rule, `git ${sub}: ${rule.what}`)
    }
  }
  // Strictly AFTER the terminal tier, so a whole-tree discard can never be
  // downgraded by also naming a path.
  for (const rule of GIT_WORKTREE_DISCARD_PATH) {
    if (rule.matches(sub, flags, rest)) {
      return sensitive(rule.rule, `git ${sub}: ${rule.what}`)
    }
  }
  return safe()
}

/**
 * A rule that needs only the head + resolved argv, expressed as DATA.
 *
 * THE SHAPE IS THE INVARIANT. `assessSimple` matches on the READABLE SUBSET of
 * a command's operands, which is sound only while every rule's fold is MONOTONE
 * in that subset — adding an operand may switch a rule ON, never OFF. That held
 * only by accident: all four predicates happened to be `() => true` or
 * `operands.some(...)`. A future rule folding with `operands.every(...)` or
 * `operands.length === 0` would turn an operand we simply COULD NOT READ into a
 * FALSE `hard-deny` — by this file's header, an effect no mode may authorize —
 * and nothing would fail.
 *
 * So a rule no longer receives the arrays at all. It declares SETS and a
 * PER-OPERAND predicate, and the seam owns every fold, folding both with
 * `some` — which is monotone for ANY predicate whatsoever. `every` and
 * `length === 0` are not expressible here, so the invariant is enforced by the
 * type instead of asserted by a comment.
 * `tests/unit/permission/shell-predicate-population-hellgate.test.ts` pins the
 * declared key set, so widening this interface is a test failure too.
 */
export interface SimpleDenialRule {
  readonly rule: string
  readonly heads: ReadonlySet<string>
  /** Fires only when at least one of these flags is present. Omitted = no flag
   *  condition. A SET rather than a predicate for the same reason: a rule
   *  written `!flags.has(x)` is anti-monotone in the readable FLAG set exactly
   *  as `every` is in the operand set, and `flagsOf` also drops what it cannot
   *  resolve. */
  readonly anyFlag?: ReadonlySet<string>
  /** Fires only when at least one READABLE operand satisfies this. Omitted = no
   *  operand condition. Receives ONE operand — never the array, never an
   *  index — so no rule can observe how much of the command was read. */
  readonly anyOperand?: (operand: string) => boolean
  readonly what: string
}

export const SIMPLE_DENIAL_RULES: readonly SimpleDenialRule[] = [
  {
    // `diskutil` used to sit in this set with `matches: () => true`, which made
    // `diskutil list` and `diskutil info /` unrunnable at every tier. It is a
    // SUBCOMMAND dispatcher, not a formatter, and now has its own assessor.
    // …and after it moved out, EVERY head left in this rule was a Linux
    // spelling that does not exist on macOS (`which newfs mkfs` → neither
    // found), so the rule was live and unable to fire while `newfs_hfs
    // /dev/disk2s1` measured `safe-known`. The head list is now a shared,
    // PROBED population — see FILESYSTEM_FORMAT_HEADS.
    rule: "mkfs-format-filesystem",
    heads: FILESYSTEM_FORMAT_HEADS,
    what: "formats a filesystem",
  },
  {
    rule: "dd-write-to-dev",
    heads: new Set(["dd"]),
    anyOperand: (o) => o.startsWith("of=/dev/"),
    what: "writes directly to a block device",
  },
  {
    rule: "shutdown-reboot-halt-command",
    heads: new Set(["shutdown", "reboot", "halt", "poweroff"]),
    what: "halts the machine",
  },
  {
    rule: "chmod-recursive-system-root",
    heads: new Set(["chmod", "chown"]),
    anyFlag: new Set(["-R", "--recursive"]),
    anyOperand: (o) => o.startsWith("/") && isCatastrophicDeleteTarget(o),
    what: "recursively rewrites permissions on a system root",
  },
]

/** THE fold, and the only one. Both conditions are `some` over what was
 *  readable, so a partial read can only ever ADD a hit. */
const simpleDenialFires = (
  rule: SimpleDenialRule,
  flags: ReadonlySet<string>,
  operands: readonly string[],
): boolean => {
  const flagHit = rule.anyFlag === undefined || [...rule.anyFlag].some((f) => flags.has(f))
  const operandHit =
    rule.anyOperand === undefined || operands.some((o) => rule.anyOperand?.(o) === true)
  return flagHit && operandHit
}

/* ------------------------------------------------------------------------- *
 * diskutil
 * ------------------------------------------------------------------------- */

/** `diskutil [quiet] <verb> …` and `diskutil [quiet] <group> <verb> …`.
 *
 *  The verb decides, not the head: `list`/`info` are reads and must stay
 *  runnable, `eraseDisk`/`apfs deleteContainer` destroy a volume. A verb this
 *  authority could not READ is `unknown` — neither the old blanket `hard-deny`
 *  (which is what made a read unappealable) nor `safe`, which would be a
 *  positive assertion about a verb nobody saw. */
const assessDiskutil = (cmd: ShellCommandIr): ShellAssessment => {
  const operands = operandsOf(cmd.args)
  const lead = operands[0]
  const start =
    lead?.resolved === true && DISKUTIL_LEADING_MODIFIERS.has(lead.text.toLowerCase()) ? 1 : 0
  const verbWord = operands[start]
  // Bare `diskutil` (or `diskutil quiet`) prints usage and touches nothing.
  if (verbWord === undefined) return safe()
  if (!verbWord.resolved) return unknown("diskutil: the verb is not statically resolvable")
  const verb = verbWord.text.toLowerCase()
  const denial = deny(
    "diskutil-destructive-verb",
    `diskutil ${verbWord.text}: erases a volume, container or partition map`,
  )
  const group = DISKUTIL_VERB_GROUPS.get(verb)
  if (group === undefined) return DISKUTIL_DESTRUCTIVE_VERBS.has(verb) ? denial : safe()
  const subWord = operands[start + 1]
  if (subWord === undefined) return safe()
  if (!subWord.resolved) {
    return unknown(`diskutil ${verbWord.text}: the verb is not statically resolvable`)
  }
  return group.has(subWord.text.toLowerCase()) ? denial : safe()
}

const assessSimple = (cmd: ShellCommandIr): ShellAssessment | null => {
  // BASENAME, not the raw text. `assessByHead` already strips the directory
  // before dispatching; recomputing from `head.text` here meant every rule in
  // this table was bypassed by spelling the command with a path
  // (`/sbin/reboot`, `/bin/chmod -R 777 /` measured `safe-known`), including
  // the B-14 unreadable-operand escalation added beside it.
  const head = cmd.head?.text?.split("/").pop()
  if (head === undefined) return null
  const flags = flagsOf(cmd.args)
  const operands = operandsOf(cmd.args)
  // Match on what we CAN read. A rule that fires on the readable subset is a
  // real hit — this seam only ever widens denial, so a partial read may deny
  // but may never absolve.
  const texts = operands.filter((o) => o.resolved).map((o) => o.text)
  for (const rule of SIMPLE_DENIAL_RULES) {
    if (rule.heads.has(head) && simpleDenialFires(rule, flags, texts)) {
      return deny(rule.rule, `${head}: ${rule.what}`)
    }
  }
  // B-14 — an operand we could not read, on a head this table GATES, is
  // `unknown`, never `safe`. Returning `null` here reached `assessByHead`'s
  // `?? safe()`, which is a POSITIVE safety assertion about a command whose
  // target was never read (`chmod -R 777 $ROOT`, `dd if=/dev/zero of=$OUT`).
  // Every sibling assessor (delete/find/git/interpreter) already answers
  // `unknown` in this position. Scoped to gated heads so an ordinary `$VAR`
  // on an ungated head stays `safe`.
  if (operands.some((o) => !o.resolved) && SIMPLE_DENIAL_RULES.some((r) => r.heads.has(head))) {
    return unknown(`${head}: an operand is not statically resolvable`)
  }
  return null
}

/* ------------------------------------------------------------------------- *
 * command dispatch
 * ------------------------------------------------------------------------- */

const headName = (cmd: ShellCommandIr): string | null => {
  const h = cmd.head
  if (h === null || !h.resolved) return null
  return h.text.split("/").pop() ?? h.text
}

/** `xargs rm -rf` — the payload's TARGETS arrive on stdin, so an argv-only
 *  reading sees a delete with NO operands and would call it safe. */
const stdinOperandVerdict = (
  rawHead: string | null,
  cmd: ShellCommandIr,
): ShellAssessment | null => {
  if (rawHead === null || !STDIN_OPERAND_HEADS.has(rawHead)) return null
  const payload = headName(cmd)
  if (payload === null) return null
  if (!DELETE_HEADS.has(payload) && payload !== "sh" && payload !== "bash") return null
  return unknown(`${rawHead}: ${payload} operands arrive on stdin and cannot be read`)
}

/** `sh -c '<script>'` — the payload IS shell, so re-parse it rather than
 *  treating the whole script as one opaque word. */
const shellPayloadVerdict = (name: string, cmd: ShellCommandIr, ctx: Ctx): ShellAssessment => {
  // B-12 — `-lc` / `-ec` / `-lic` are ONE POSIX cluster carrying `-c`. Matching
  // the exact text let a login/errexit shell smuggle its whole script past this
  // re-parse (`bash -lc 'cd / && rm -rf *'` measured `safe-known` while the
  // `sh -c` twin was `hard-deny`). `flagsOf` already expands clusters two
  // functions up; this lookup is the one place that did not.
  const idx = cmd.args.findIndex((a) => a.resolved && expandFlagCluster(a.text).includes("-c"))
  if (idx === -1) return safe()
  const payload = cmd.args[idx + 1]
  if (payload === undefined || !payload.resolved) {
    return unknown(`${name} -c: payload is not statically resolvable`)
  }
  if (ctx.depth >= MAX_DEPTH) return unknown(`${name} -c: nesting too deep to read`)
  return assessScript(payload.text, { cwd: ctx.cwd, depth: ctx.depth + 1 })
}

/** Judge one command by its head family. Ordered most-specific first; a head
 *  the authority has no rule for is safe by construction, because every way of
 *  NOT reading a command has already produced `unknown` above. */
const assessByHead = (name: string, cmd: ShellCommandIr, ctx: Ctx): ShellAssessment => {
  if (EVAL_HEADS.has(name)) return unknown(`${name}: evaluates text produced at runtime`)
  if (SHELL_HEADS.has(name)) return shellPayloadVerdict(name, cmd, ctx)
  if (INTERPRETER_HEADS.has(name)) {
    return cmd.args.some((a) => a.resolved && INLINE_CODE_FLAGS.has(a.text))
      ? unknown(`${name}: inline source cannot be read by a shell grammar`)
      : safe()
  }
  if (name === "find") return assessFind(cmd, ctx)
  if (DELETE_HEADS.has(name)) return assessDelete(cmd, ctx)
  if (name === "git") return assessGit(cmd, ctx)
  if (name === "diskutil") return assessDiskutil(cmd)
  return assessSimple(cmd) ?? safe()
}

const assessCommand = (raw: ShellCommandIr, ctx: Ctx): ShellAssessment => {
  const rawHead = raw.head?.resolved === true ? (raw.head.text.split("/").pop() ?? null) : null
  const cmd = stripVehicleHeads(raw)
  if (cmd === null) return unknown("a vehicle's payload is not statically resolvable")
  const head = cmd.head
  if (head === null) return safe()
  if (!head.resolved) return unknown(`command name "${head.text}" is not statically resolvable`)
  const stdin = stdinOperandVerdict(rawHead, cmd)
  if (stdin !== null) return stdin
  return assessByHead(head.text.split("/").pop() ?? head.text, cmd, ctx)
}

/* ------------------------------------------------------------------------- *
 * pipeline-shape rules
 *
 * These read the RELATIONSHIP between commands, which is the whole reason the
 * IR keeps pipeline membership. `curl x | sh` is not "a curl and a sh"; it is
 * one command whose program text is downloaded at runtime, and no per-command
 * argv inspection can see that.
 * ------------------------------------------------------------------------- */

/** Which named rule a fetch-into-executor pipe violates. */
const fetchPipeRule = (producer: string, consumer: string): string =>
  producer === "base64"
    ? "base64-pipe-to-shell"
    : SHELL_HEADS.has(consumer)
      ? "curl-wget-pipe-to-shell"
      : "curl-wget-pipe-to-interpreter"

/** Judge ONE producer→consumer hop of a pipeline. */
/** The hop where the CONSUMER executes its stdin as a program (`… | sh`,
 *  `… | python`). Returns undefined when it does not — the whole point of the
 *  guard is that a consumer of this kind makes the PRODUCER's output into code,
 *  so nothing below it may be judged by ordinary argv rules. */
const assessExecutedPipe = (
  prod: ShellCommandIr,
  producer: string,
  consumer: string,
  ctx: Ctx,
): ShellAssessment | undefined => {
  if (!SHELL_HEADS.has(consumer) && !INTERPRETER_HEADS.has(consumer)) return undefined
  if (FETCH_HEADS.has(producer)) {
    return deny(
      fetchPipeRule(producer, consumer),
      `${producer} output is executed as a program by ${consumer}`,
    )
  }
  // A literal producer's output IS readable: assess what it actually emits
  // rather than guessing. `echo 'rm -rf /' | sh` is the delete it spells;
  // `echo hi | sh` is nothing.
  if (LITERAL_PRODUCER_HEADS.has(producer) && prod.args.every((w) => w.resolved)) {
    return SHELL_HEADS.has(consumer)
      ? assessScript(prod.args.map((w) => w.text).join(" "), ctx)
      : safe()
  }
  // Anything else: the program text is produced at runtime and cannot be read.
  return unknown(`${consumer} executes program text produced at runtime by ${producer}`)
}

/** The hop that READS a file and SENDS it off the machine. Returns undefined
 *  when the pair is not a read→egress, and `safe` is left to the caller for the
 *  ordinary case: reading a file and uploading it is normal work (`cat
 *  report.json | curl -d @- …`), so ONLY a known secret store — or an argument
 *  we cannot resolve well enough to rule one out — is a finding. */
const assessExfilPipe = (
  prod: ShellCommandIr,
  producer: string,
  consumer: string,
): ShellAssessment | undefined => {
  if (!SECRET_READ_HEADS.has(producer) || !EGRESS_HEADS.has(consumer)) return undefined
  const secret = prod.args.find((w) => w.resolved && isSecretStorePath(w.text))
  if (secret !== undefined) {
    return deny(
      "credential-exfil-pipe",
      `${producer} ${secret.text} is sent off the machine by ${consumer}`,
    )
  }
  if (prod.args.some((w) => !w.resolved)) {
    return unknown(`${producer}: the file piped into ${consumer} is not statically resolvable`)
  }
  return undefined
}

const assessPipeHop = (
  prod: ShellCommandIr,
  producer: string,
  consumer: string,
  ctx: Ctx,
): ShellAssessment =>
  assessExecutedPipe(prod, producer, consumer, ctx) ??
  assessExfilPipe(prod, producer, consumer) ??
  safe()

/** Group the flat command list back into its pipelines. */
const pipelineGroups = (commands: readonly ShellCommandIr[]): ShellCommandIr[][] => {
  const groups = new Map<number, ShellCommandIr[]>()
  for (const cmd of commands) {
    if (cmd.pipeline === null) continue
    const g = groups.get(cmd.pipeline)
    if (g === undefined) groups.set(cmd.pipeline, [cmd])
    else g.push(cmd)
  }
  return [...groups.values()]
}

const assessPipelines = (commands: readonly ShellCommandIr[], ctx: Ctx): ShellAssessment => {
  let verdict = safe()
  for (const group of pipelineGroups(commands)) {
    for (let i = 1; i < group.length; i++) {
      const prod = group[i - 1] as ShellCommandIr
      const producer = headName(prod)
      const consumer = headName(group[i] as ShellCommandIr)
      if (producer === null || consumer === null) continue
      verdict = worst(verdict, assessPipeHop(prod, producer, consumer, ctx))
    }
  }
  return verdict
}

const isCd = (cmd: ShellCommandIr): boolean => cmd.head?.resolved === true && cmd.head.text === "cd"

/** The cwd after a `cd`. A `cd` whose target the authority cannot resolve makes
 *  the cwd UNKNOWN — never "wherever we were", which is the assumption that
 *  would let `cd $X && rm -rf *` read as ordinary work. */
const cwdAfterCd = (cwd: EffectiveCwd, cmd: ShellCommandIr): EffectiveCwd => {
  const target = operandsOf(cmd.args)[0]
  if (target === undefined) return applyCd(cwd, undefined)
  return target.resolved ? applyCd(cwd, target.text) : UNKNOWN_CWD
}

/** Track the effective cwd across the list, then judge each command in it. */
const assessCommands = (commands: readonly ShellCommandIr[], ctx: Ctx): ShellAssessment => {
  let verdict = safe()
  const local: Ctx = { cwd: ctx.cwd, depth: ctx.depth }
  for (const cmd of commands) {
    if (isCd(cmd)) {
      local.cwd = cwdAfterCd(local.cwd, cmd)
      continue
    }
    verdict = worst(verdict, assessCommand(cmd, local))
  }
  return verdict
}

/** Parse + assess one command line. */
const assessScript = (command: string, ctx: Ctx): ShellAssessment => {
  const root = parseShell(command)
  if (root === null) return unknown("shell parser is not available")
  return assessTree(root, ctx)
}

const assessTree = (root: ShellNode, ctx: Ctx): ShellAssessment => {
  const ir = lowerShellTree(root)
  if (ir.hasForkBomb) {
    return deny("fork-bomb", "a function whose body invokes itself in the background")
  }
  const verdict = worst(assessCommands(ir.commands, ctx), assessPipelines(ir.commands, ctx))
  if (ir.hasParseError && verdict.kind !== "hard-deny") {
    return unknown("the command did not parse cleanly")
  }
  return verdict
}

/** THE public authority. `cwd` seeds the effective-directory tracking; omit it
 *  when the caller does not know the shell's starting directory (relative
 *  destructive targets then read as `unknown`, not as safe). */
export const assessShellCommand = (
  command: string,
  opts: { readonly cwd?: string } = {},
): ShellAssessment =>
  assessScript(command, {
    cwd: opts.cwd === undefined ? CALLER_CWD : { kind: "abs", path: opts.cwd },
    depth: 0,
  })

/** Seam for driving the authority with an injected parse — used to prove the
 *  not-ready path answers `unknown` without unloading the real grammar. */
export const assessShellCommandWith = (
  command: string,
  deps: { readonly parse: (c: string) => ShellNode | null },
  opts: { readonly cwd?: string } = {},
): ShellAssessment => {
  const root = deps.parse(command)
  if (root === null) return unknown("shell parser is not available")
  return assessTree(root, {
    cwd: opts.cwd === undefined ? CALLER_CWD : { kind: "abs", path: opts.cwd },
    depth: 0,
  })
}
