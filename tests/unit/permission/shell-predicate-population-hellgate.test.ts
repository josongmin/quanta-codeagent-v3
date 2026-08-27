/**
 * HELLGATE — the POPULATION of a predicate, not the instance an audit reported.
 *
 * Every defect this file pins was found the same way: a fix landed exactly
 * where a bug was reported and nobody enumerated the other places the same
 * predicate lives. Three instances are already on the record —
 *
 *   1. `git` global-option consumption existed in TWO functions and only one
 *      was fixed, so `decideBranchOnly` still allowed a protected-branch
 *      force-push behind four flags.
 *   2. `--attr-source` was absent from the flag list entirely, because nobody
 *      asked the installed git which globals actually consume a value.
 *   3. (measured here) `git --no-pager push origin +main` — a VALUELESS global,
 *      a shape neither fix considered — is `hard-deny` to the structural
 *      authority and ALLOWED by `decideBranchOnly`.
 *
 * So the arms below are written over the whole population: every flag in the
 * shared set, both spellings, both consumers; every rule in the denial table,
 * not the one rule an audit named.
 *
 * Invariants:
 *
 *  P-1  `diskutil` is SUBCOMMAND-aware. `hard-deny` is defined by `assess.ts`
 *       as "an effect NO MODE MAY AUTHORIZE", so a read-only `diskutil list` /
 *       `diskutil info` must never carry it. Destructive verbs still do.
 *  P-2  The `SIMPLE_DENIALS` partial-read invariant is ENFORCED, not asserted.
 *       The seam matches on the readable subset of operands; that is only sound
 *       while every rule's fold is monotone (`some`). A rule folding with
 *       `every` or `length === 0` would turn an UNREADABLE operand into a FALSE
 *       hard-deny, and today nothing fails.
 *  P-3  Discarding uncommitted work is covered in EVERY spelling git supports,
 *       at the verdict each one earns. `git checkout -- <path>` was
 *       unappealable while `git restore <path>` — git's own spelling of the
 *       identical effect — was fully allowed, and `git restore .` /
 *       `git switch --discard-changes` were allowed outright.
 *  P-4  The two `GIT_GLOBAL_VALUE_FLAGS` consumers resolve the SAME subcommand
 *       for the same input, across the whole flag set and both spellings.
 *  P-5  The diskutil verb population is DERIVED from `/usr/sbin/diskutil`, not
 *       from a hand-written corpus. P-1's corpus is a list of verbs somebody
 *       thought of, which is why `resetFusion` (three lines above `eraseDisk`
 *       in the list that WAS read) and the entire `appleRAID` group (one of the
 *       four the binary prints) both passed it.
 *  P-6  The `mkfs-format-filesystem` heads are an OS PROBE. After `diskutil`
 *       moved out, not one head left in that rule existed on this machine.
 *  P-7  `GIT_GLOBAL_VALUE_FLAGS` membership is PINNED as a literal here and
 *       RE-PROBED against the installed git. P-4 iterates the set under test,
 *       so its cases vanish with the entry they test: deleting `--config-env`
 *       left 269 pass / 0 fail across both permission hellgates.
 *
 *  Every arm is paired with a control that fails if the fix is satisfied the
 *  lazy way — by denying everything, or by allowing everything. For P-5..P-7
 *  the control is stronger: the derivation is a pure function fed a value the
 *  rules certainly do not know, so the check is proven to have teeth rather
 *  than assumed to.
 */

import { beforeAll, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, readdirSync, statSync } from "node:fs"
import { decideBranchOnly } from "@/permission/branch-only"
import { hardDenyReason } from "@/permission/policy"
import { assessShellCommand, initShellEffectParser } from "@/permission/shell"
import { SIMPLE_DENIAL_RULES } from "@/permission/shell/assess"
import {
  DISKUTIL_DESTRUCTIVE_VERBS,
  DISKUTIL_GROUPS,
  DISKUTIL_REVIEWED_SAFE_VERBS,
  FILESYSTEM_FORMAT_HEADS,
  GIT_GLOBAL_FLAGS_TAKING_NO_SEPARATED_VALUE,
  GIT_GLOBAL_VALUE_FLAGS,
  GIT_VALUE_FLAGS_ABSENT_ON_INSTALLED_GIT,
  GIT_VALUE_FLAGS_VERIFIED_ON_INSTALLED_GIT,
  gitOperandTokens,
  gitValueFlagProbe,
} from "@/permission/shell/rules"
import type { ToolAction } from "@/permission/types"

beforeAll(async () => {
  await initShellEffectParser()
})

const kindOf = (cmd: string) => assessShellCommand(cmd).kind
const verdictOf = (cmd: string) => {
  const a = assessShellCommand(cmd)
  return { kind: a.kind, rule: a.kind === "hard-deny" ? a.rule : undefined }
}

/**
 * THE OPERATOR-FACING ENTRY POINT, not the structural authority alone.
 *
 * Every arm below used to assert `assessShellCommand` and nothing else, and
 * that is precisely how the fourth instance of this campaign's defect shipped:
 * `git checkout -- <path>` was softened to `sensitive-known` in the STRUCTURAL
 * table while `policy.ts` still ran the REGEX corpus first, so the operator
 * kept getting an unappealable denial the structural table no longer issued.
 * A single `expect(hardDenyReason(...)).toBeNull()` would have caught it.
 *
 * `hardDenyReason` is what a real dispatch calls, so it folds BOTH authorities:
 * `HARD_DENY` regexes first, `assessShellCommand().kind === "hard-deny"` second.
 */
const bashAction = (cmd: string): ToolAction => ({
  tool: "bash",
  input: { command: cmd },
  isReadOnly: false,
  shellCommand: cmd,
})
const operatorHardDenied = (cmd: string): boolean => hardDenyReason(bashAction(cmd)) !== null

/* ------------------------------------------------------------------------- *
 * P-1 — diskutil is a subcommand, not a head
 * ------------------------------------------------------------------------- */

/**
 * Verified against `/usr/sbin/diskutil` on this machine (macOS, Darwin 24.6.0):
 * the top-level verb list comes from bare `diskutil`, the APFS verbs from
 * `diskutil apfs`, the CoreStorage verbs from `diskutil coreStorage`. Verb
 * matching is CASE-INSENSITIVE there (`diskutil erasedisk` and
 * `diskutil ERASEDISK` both print the eraseDisk usage) and a leading `quiet`
 * is accepted before the verb (`diskutil quiet eraseDisk` → eraseDisk usage),
 * so the rule must do both. Arbitrary abbreviation is NOT accepted
 * (`diskutil eraseD` → 'did not recognize verb "eraseD"'), so only the
 * documented `ap[fs]` / `coreStorage|CS` group spellings are aliased.
 */
const DISKUTIL_DESTRUCTIVE = [
  "diskutil eraseDisk JHFS+ Blank /dev/disk2",
  "diskutil eraseVolume JHFS+ Blank /dev/disk2s1",
  "diskutil reformat /dev/disk2s1",
  "diskutil zeroDisk /dev/disk2",
  "diskutil randomDisk 2 /dev/disk2",
  "diskutil secureErase 0 /dev/disk2",
  "diskutil eraseOptical /dev/disk2",
  "diskutil partitionDisk /dev/disk2 1 GPT JHFS+ x 100%",
  "diskutil splitPartition /dev/disk2s1",
  "diskutil mergePartitions JHFS+ x disk2s1 disk2s3",
  "diskutil apfs deleteContainer disk2",
  "diskutil apfs deleteVolume disk2s1",
  "diskutil apfs deleteVolumeGroup disk2s1",
  "diskutil apfs eraseVolume disk2s1",
  "diskutil apfs create disk2 Blank",
  "diskutil apfs createContainer disk2",
  "diskutil coreStorage delete LVG-UUID",
  // documented spellings of the same verbs
  "diskutil ap deleteContainer disk2",
  "diskutil CS delete LVG-UUID",
  "diskutil erasedisk JHFS+ Blank /dev/disk2",
  "diskutil ERASEDISK JHFS+ Blank /dev/disk2",
  "diskutil quiet eraseDisk JHFS+ Blank /dev/disk2",
  "sudo diskutil eraseDisk JHFS+ Blank /dev/disk2",
  "/usr/sbin/diskutil eraseDisk JHFS+ Blank /dev/disk2",
] as const

const DISKUTIL_READONLY = [
  "diskutil list",
  "diskutil info /",
  "diskutil info disk0s1",
  "diskutil information /",
  "diskutil listFilesystems",
  "diskutil listClients",
  "diskutil activity",
  "diskutil apfs list",
  "diskutil apfs listSnapshots /",
  "diskutil coreStorage list",
  "diskutil coreStorage info UUID",
  "diskutil verifyVolume /",
  "diskutil verifyDisk disk0",
  "diskutil mount disk2s1",
  "diskutil unmount /Volumes/x",
  "diskutil eject disk2",
  "diskutil rename disk2s1 newname",
] as const

describe("P-1 diskutil is subcommand-aware", () => {
  for (const cmd of DISKUTIL_DESTRUCTIVE) {
    test(`DENY ${cmd}`, () => {
      expect({ cmd, ...verdictOf(cmd) }).toEqual({
        cmd,
        kind: "hard-deny",
        rule: "diskutil-destructive-verb",
      })
    })
  }

  // PAIRED CONTROL — the whole defect was a rule that denied EVERY diskutil
  // invocation. A fix that keeps `matches: () => true` under a new rule name
  // passes every arm above and fails every arm here.
  for (const cmd of DISKUTIL_READONLY) {
    test(`PAIRED CONTROL — safe ${cmd}`, () => {
      expect({ cmd, kind: kindOf(cmd) }).toEqual({ cmd, kind: "safe-known" })
    })
  }

  test("an UNREADABLE verb is unknown — never safe, never hard-deny", () => {
    // `hard-deny` here would be the original defect wearing a predicate; `safe`
    // would be a positive assertion about a verb that was never read.
    expect(kindOf("diskutil $VERB /dev/disk2")).toBe("unknown")
    expect(kindOf("diskutil apfs $VERB disk2")).toBe("unknown")
  })

  test("a read verb with an unreadable OPERAND stays safe", () => {
    // The verb is what decides; the target of a `list`/`info` is a read either
    // way, so an unresolvable disk name must not manufacture a prompt.
    expect(kindOf("diskutil info $DISK")).toBe("safe-known")
    expect(kindOf("diskutil list $DISK")).toBe("safe-known")
  })

  test("mkfs-family heads keep their own rule name", () => {
    // The diskutil verbs were smuggled into `mkfs-format-filesystem`. Splitting
    // them out must not rename the denial the mkfs heads have always carried.
    expect(verdictOf("mkfs.ext4 /dev/sda1")).toEqual({
      kind: "hard-deny",
      rule: "mkfs-format-filesystem",
    })
    expect(verdictOf("newfs /dev/disk2")).toEqual({
      kind: "hard-deny",
      rule: "mkfs-format-filesystem",
    })
  })
})

/* ------------------------------------------------------------------------- *
 * P-2 — the partial-read invariant, enforced
 * ------------------------------------------------------------------------- */

describe("P-2 SIMPLE_DENIALS cannot express an anti-monotone fold", () => {
  /** The ONLY keys a denial rule may declare. `heads`/`anyFlag` are SETS and
   *  `anyOperand` is a PER-OPERAND predicate, so the seam owns every fold and
   *  folds them all with `some` — which is monotone in the operand set by
   *  construction. Re-introducing a whole-array `matches` (the shape that let
   *  `every(...)` / `length === 0` produce a FALSE hard-deny on a partial read)
   *  fails here. */
  const ALLOWED_KEYS = ["anyFlag", "anyOperand", "heads", "rule", "what"] as const

  test("no rule declares a key outside the monotone-by-construction shape", () => {
    const offenders = SIMPLE_DENIAL_RULES.flatMap((r) =>
      Object.keys(r)
        .filter((k) => !(ALLOWED_KEYS as readonly string[]).includes(k))
        .map((k) => `${r.rule}.${k}`),
    )
    expect(offenders).toEqual([])
  })

  test("every rule is reachable — the table has no rule that can never fire", () => {
    // A drift guard is worthless if it guards an empty table.
    expect(SIMPLE_DENIAL_RULES.length).toBeGreaterThan(0)
    for (const r of SIMPLE_DENIAL_RULES) {
      expect({ rule: r.rule, heads: r.heads.size > 0 }).toEqual({ rule: r.rule, heads: true })
    }
  })

  /** BEHAVIOURAL half: blanking any single operand to an unresolvable `$V` may
   *  only ever move a verdict AWAY from `hard-deny`. This is the property the
   *  comment asserts; an `every`/`length === 0` rule breaks it, and unlike the
   *  shape guard it does not depend on the table staying exported. */
  const MONOTONE_CORPUS = [
    "dd if=/dev/zero of=/tmp/img",
    "dd if=/dev/zero of=/dev/sda",
    "chmod -R 755 ./build",
    "chmod -R 777 /",
    "chown -R me:me ./build",
    "diskutil info /",
    "diskutil list",
    "diskutil eraseDisk JHFS+ Blank /dev/disk2",
    "mkfs.ext4 /dev/sda1",
    "shutdown -h now",
  ] as const

  for (const cmd of MONOTONE_CORPUS) {
    test(`blanking an operand of \`${cmd}\` never CREATES a hard-deny`, () => {
      const parts = cmd.split(" ")
      const base = assessShellCommand(cmd).kind
      for (let i = 1; i < parts.length; i++) {
        if (parts[i]?.startsWith("-") === true) continue
        const blanked = parts.map((p, j) => (j === i ? "$V" : p)).join(" ")
        const got = assessShellCommand(blanked).kind
        if (base !== "hard-deny") {
          expect({ blanked, kind: got }).not.toEqual({ blanked, kind: "hard-deny" })
        }
      }
    })
  }
})

/* ------------------------------------------------------------------------- *
 * P-3 — discarding uncommitted work: every spelling, and the RIGHT verdict
 * ------------------------------------------------------------------------- */

describe("P-3 worktree discards are covered in both tiers", () => {
  /** WHOLE-TREE — `git reset --hard`'s blast radius, so terminal.
   *  `git restore .` and `git switch --discard-changes` are git's own modern
   *  spellings of `git checkout .`, and both measured `safe-known` while the
   *  checkout form was already `hard-deny`. */
  const WHOLE_TREE: ReadonlyArray<readonly [string, string]> = [
    ["git checkout .", "git-checkout-discard"],
    ["git checkout -- .", "git-checkout-discard"],
    ["git checkout ./", "git-checkout-discard"],
    ["git checkout :/", "git-checkout-discard"],
    ["git checkout -f main", "git-checkout-discard"],
    ["git checkout --force main", "git-checkout-discard"],
    ["git -C /repo checkout .", "git-checkout-discard"],
    ["git restore .", "git-restore-discard"],
    ["git restore -- .", "git-restore-discard"],
    ["git restore --worktree .", "git-restore-discard"],
    ["git restore --worktree --staged .", "git-restore-discard"],
    ["git restore -W -S .", "git-restore-discard"],
    ["git restore :/", "git-restore-discard"],
    ["git -C /repo restore .", "git-restore-discard"],
    ["git switch --discard-changes main", "git-switch-discard-changes"],
    ["git switch -f main", "git-switch-discard-changes"],
    ["git switch --force main", "git-switch-discard-changes"],
  ]
  for (const [cmd, rule] of WHOLE_TREE) {
    test(`DENY ${cmd}`, () => {
      expect({ cmd, ...verdictOf(cmd) }).toEqual({ cmd, kind: "hard-deny", rule })
    })
    test(`DENY reaches the OPERATOR — ${cmd}`, () => {
      // The structural verdict above is not what a dispatch calls. This is.
      expect({ cmd, hardDenied: operatorHardDenied(cmd) }).toEqual({ cmd, hardDenied: true })
    })
  }

  /**
   * NAMED PATHS — the SAME effect on one file, and deliberately NOT terminal.
   *
   * `hard-deny` is defined as "an effect no mode may authorize", so putting a
   * one-file revert there meant no tier could ever run it — while
   * `git restore src/foo.ts`, git's supported spelling of the identical effect,
   * was fully allowed. That is not a safety property, it is a spelling tax.
   *
   * `sensitive-known` is INERT in the STRUCTURAL seam — `policy.ts` branches on
   * `=== "hard-deny"` there and nothing else consumes the label yet. It is
   * still the right label: `safe-known` would assert "no effect that needs a
   * gate" about discarding a user's edits, which is the false claim that
   * produced this hole.
   *
   * WHAT THIS ARM GOT WRONG FOR ONE ITERATION. The sentence that used to stand
   * here — "so these commands are permitted in practice, exactly as
   * `git restore` has been all along" — was FALSE and this test could not see
   * it, because it only ever asked `assessShellCommand`. `policy.ts:82` runs
   * the REGEX corpus BEFORE it consults the assessor at `:97`, and
   * `policy-rules.ts`'s `git-checkout-discard` still carried a `\s--\s`
   * alternative, so the softening never reached the operator. Measured:
   * `hardDenyReason("git checkout -- src/foo.ts")` was NON-null while
   * `hardDenyReason("git restore src/foo.ts")` was null — the exact spelling
   * tax the change set out to delete, still there, under a rule name
   * (`git-checkout-discard`) the assessor was simultaneously answering
   * `git-checkout-discard-path` for.
   *
   * So each arm now asserts the OPERATOR-FACING fold as well. That is the
   * assertion that would have caught it.
   */
  const NAMED_PATH: ReadonlyArray<readonly [string, string]> = [
    ["git checkout -- src/foo.ts", "git-checkout-discard-path"],
    ["git checkout HEAD -- src/foo.ts", "git-checkout-discard-path"],
    ["git checkout main -- packages/x/index.ts", "git-checkout-discard-path"],
    ["git -C /repo checkout -- src/foo.ts", "git-checkout-discard-path"],
    ["git restore src/foo.ts", "git-restore-discard-path"],
    ["git restore -- src/foo.ts", "git-restore-discard-path"],
    ["git restore --worktree --staged src/foo.ts", "git-restore-discard-path"],
    ["git restore --source HEAD src/foo.ts", "git-restore-discard-path"],
  ]
  for (const [cmd, rule] of NAMED_PATH) {
    test(`SENSITIVE ${cmd}`, () => {
      const a = assessShellCommand(cmd)
      expect({ cmd, kind: a.kind, rule: a.rule }).toEqual({ cmd, kind: "sensitive-known", rule })
    })
    test(`SENSITIVE is NOT a hard deny to the operator — ${cmd}`, () => {
      // `sensitive-known` means "an effect a policy layer should weigh", which
      // is the opposite of "no mode may authorize". If the operator-facing
      // fold still refuses it, the label is a lie and the spelling tax is live.
      expect({ cmd, hardDenied: operatorHardDenied(cmd) }).toEqual({ cmd, hardDenied: false })
    })
  }

  test("a whole-tree discard is never DOWNGRADED by also naming a path", () => {
    // The soft tier runs strictly after the terminal one. `git restore src .`
    // matches both; the terminal verdict must win.
    expect(verdictOf("git restore src/foo.ts .")).toEqual({
      kind: "hard-deny",
      rule: "git-restore-discard",
    })
  })

  // PAIRED CONTROL — every arm above is satisfiable by denying every `git
  // checkout`/`restore`/`switch`, or every `--`-bearing git command. All fail
  // here. `--staged` ALONE is an index-only unstage: the file's content is
  // still in the working tree, nothing is discarded, and git's own `-h` says
  // so (`-S, --staged  restore the index`).
  const ORDINARY = [
    "git checkout main",
    "git checkout -b feature/x",
    "git checkout -B feature/x main",
    "git switch main",
    "git restore --staged .",
    "git restore --staged src/foo.ts",
    "git restore -S -- src/foo.ts",
    "git log -- src/foo.ts",
    "git diff -- src/foo.ts",
    "git status",
    "git -C /repo status",
  ] as const
  for (const cmd of ORDINARY) {
    test(`PAIRED CONTROL — safe ${cmd}`, () => {
      expect({ cmd, kind: kindOf(cmd), hardDenied: operatorHardDenied(cmd) }).toEqual({
        cmd,
        kind: "safe-known",
        hardDenied: false,
      })
    })
  }

  /**
   * FOUND BY ADDING `hardDenyReason` TO THE ARMS ABOVE, and pinned rather than
   * quietly fixed or quietly dropped.
   *
   * `git switch -c feature/x` used to sit in ORDINARY asserting only
   * `assessShellCommand`, which answers `safe-known`. Through the OPERATOR the
   * command is hard-denied — by `git-config-injection`, whose pattern is
   * `/\bgit\b[\s\S]*?\s-c[\s=]/` and which therefore cannot tell git's
   * GLOBAL `-c <key>=<value>` from a SUBCOMMAND's own `-c` flag. Measured:
   *
   *   git switch -c feature/x    regexRule=git-config-injection  assess=safe-known
   *   git branch -c old new      regexRule=git-config-injection  assess=safe-known
   *   git checkout -b feature/x  regexRule=null                  assess=safe-known
   *   git switch -C feature/x    regexRule=null                  assess=safe-known
   *
   * This is the BENIGN-WIDENING direction, not the contradiction this
   * iteration is about: the two authorities name DIFFERENT rules (the assessor
   * names none), so `hard-deny-authority-agreement-hellgate.test.ts` correctly
   * ignores it. It is left alone on purpose — narrowing the pattern to require
   * an `=` would newly ALLOW `git -c core.fsmonitor status` and friends, which
   * is a security change that needs its own measurement and its own fixture
   * review, not a drive-by in a test about `checkout`.
   *
   * Pinned as a POSITIVE so it cannot be forgotten: whoever fixes
   * `git-config-injection` gets a RED here and has to come read this note.
   */
  const REGEX_OVER_DENIES_UNDER_A_DIFFERENT_RULE = [
    "git switch -c feature/x",
    "git branch -c old-name new-name",
  ] as const
  for (const cmd of REGEX_OVER_DENIES_UNDER_A_DIFFERENT_RULE) {
    test(`KNOWN over-denial (git-config-injection, not a contradiction) — ${cmd}`, () => {
      expect({ cmd, kind: kindOf(cmd), hardDenied: operatorHardDenied(cmd) }).toEqual({
        cmd,
        kind: "safe-known",
        hardDenied: true,
      })
    })
  }
})

/* ------------------------------------------------------------------------- *
 * P-4 — the two git-global consumers, pinned to each other
 * ------------------------------------------------------------------------- */

/** Globals the installed git accepts that consume NO value. Verified on this
 *  machine against git 2.50.1: each of these runs
 *  `git <flag> rev-parse --git-dir` successfully, so the token after it is the
 *  SUBCOMMAND. `decideBranchOnly` returned the flag itself as the subcommand
 *  and allowed `git --no-pager push origin +main` — the third instance of this
 *  campaign's generative defect, measured here. */
const GIT_VALUELESS_GLOBALS = [
  "--no-pager",
  "--paginate",
  "-p",
  "--literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks",
  "--no-replace-objects",
  "--bare",
] as const

describe("P-4 both git-global consumers resolve the same subcommand", () => {
  const spellings = (flag: string): string[] => [`${flag} VALUE`, `${flag}=VALUE`]

  for (const flag of GIT_GLOBAL_VALUE_FLAGS) {
    for (const spelling of spellings(flag)) {
      test(`\`git ${spelling} push …\` — SSOT resolves subcommand \`push\``, () => {
        expect({
          spelling,
          sub: gitOperandTokens(`${spelling} push origin +main`.split(" "))[0],
        }).toEqual({ spelling, sub: "push" })
      })

      test(`\`git ${spelling} push origin +main\` — BOTH authorities deny`, () => {
        const cmd = `git ${spelling} push origin +main`
        expect({
          cmd,
          structural: verdictOf(cmd),
          branchOnly: decideBranchOnly(cmd).allowed,
        }).toEqual({
          cmd,
          structural: { kind: "hard-deny", rule: "git-push-force" },
          branchOnly: false,
        })
      })

      // PAIRED CONTROL — denying everything behind a global satisfies the arm
      // above. An ordinary read behind the same global must stay allowed.
      test(`PAIRED CONTROL — \`git ${spelling} status\` stays allowed by both`, () => {
        const cmd = `git ${spelling} status`
        expect({ cmd, kind: kindOf(cmd), branchOnly: decideBranchOnly(cmd).allowed }).toEqual({
          cmd,
          kind: "safe-known",
          branchOnly: true,
        })
      })
    }
  }

  for (const flag of GIT_VALUELESS_GLOBALS) {
    test(`\`git ${flag} push origin +main\` — BOTH authorities deny`, () => {
      const cmd = `git ${flag} push origin +main`
      expect({
        cmd,
        structural: verdictOf(cmd),
        branchOnly: decideBranchOnly(cmd).allowed,
      }).toEqual({
        cmd,
        structural: { kind: "hard-deny", rule: "git-push-force" },
        branchOnly: false,
      })
    })

    test(`\`git ${flag} push origin main\` — branch-only sees the protected ref`, () => {
      // Not a force-push, so the STRUCTURAL authority is right to stay safe;
      // this is purely the branch-only lever, and the flag must not hide it.
      const cmd = `git ${flag} push origin main`
      expect({ cmd, branchOnly: decideBranchOnly(cmd).allowed }).toEqual({ cmd, branchOnly: false })
    })

    test(`PAIRED CONTROL — \`git ${flag} push origin feature/x\` stays allowed`, () => {
      const cmd = `git ${flag} push origin feature/x`
      expect({ cmd, kind: kindOf(cmd), branchOnly: decideBranchOnly(cmd).allowed }).toEqual({
        cmd,
        kind: "safe-known",
        branchOnly: true,
      })
    })
  }

  test("PAIRED CONTROL — a non-git command is untouched by either authority", () => {
    expect(decideBranchOnly("echo git push origin +main").allowed).toBe(true)
    expect(kindOf("echo git push origin +main")).toBe("safe-known")
  })

  test("PAIRED CONTROL — the SSOT does not eat a subcommand that is not a flag", () => {
    expect(gitOperandTokens(["status"])).toEqual(["status"])
    expect(gitOperandTokens(["push", "origin", "main"])).toEqual(["push", "origin", "main"])
    expect(gitOperandTokens([])).toEqual([])
  })
})

/* ------------------------------------------------------------------------- *
 * P-5 — the diskutil POPULATION comes from the binary, not from memory
 * ------------------------------------------------------------------------- *
 *
 * THE POINT OF THIS ARM. Three fixes landed in the diskutil rule and each one
 * added exactly the verb an audit had named. `resetFusion` sat three lines
 * above `eraseDisk` in the very list that was read and was missed; the whole
 * `appleRAID` GROUP — one of the four the binary prints — was never read at
 * all. A test written the same way (a hand-typed corpus of commands) can only
 * ever re-check the verbs someone already thought of, which is why P-1's
 * corpus passed throughout.
 *
 * So this arm does not list verbs. It RUNS `/usr/sbin/diskutil` and its group
 * listings and fails if the binary prints a verb the rules do not classify.
 * When macOS adds one, this goes red instead of opening a hole.
 */

const DISKUTIL_BIN = "/usr/sbin/diskutil"
const hasDiskutil = existsSync(DISKUTIL_BIN)
/** Same visibility rule as P-7's gate: `test.skipIf` prints no reason, so the
 *  reason goes in a test NAME that always runs. */
const DISKUTIL_ENV_REASON = hasDiskutil
  ? `ready — ${DISKUTIL_BIN}`
  : `SKIPPED — no ${DISKUTIL_BIN} (not macOS)`

const diskutilHelp = (args: readonly string[]): string => {
  try {
    return execFileSync(DISKUTIL_BIN, [...args], { encoding: "utf8", stdio: "pipe" })
  } catch (e) {
    // Every one of these listings exits non-zero (it is a usage message), so
    // the output lives on the thrown error.
    const out = (e as { stdout?: string | Buffer; stderr?: string | Buffer }).stdout
    const err = (e as { stderr?: string | Buffer }).stderr
    return `${out?.toString() ?? ""}${err?.toString() ?? ""}`
  }
}

/** `info[rmation]` → `info` + `information`; `u[n]mount` → `umount` +
 *  `unmount`. The binary's own notation for "both spellings work". */
const expandBracketAlternatives = (token: string): string[] => {
  const m = /^([^[]*)\[([^\]]+)\]([^[]*)$/.exec(token)
  if (m === null) return [token]
  return [`${m[1]}${m[3]}`, `${m[1]}${m[2]}${m[3]}`]
}

/** Verbs of a CLASSIC `diskutil` usage listing: five spaces, the verb, two or
 *  more spaces, then the parenthesised description. */
const classicVerbs = (help: string): string[] =>
  help
    .split("\n")
    .flatMap((line) => {
      const m = /^ {5}(\S+)(?: <\w+>)?\s{2,}\(/.exec(line)
      return m?.[1] === undefined ? [] : expandBracketAlternatives(m[1])
    })
    .map((v) => v.toLowerCase())

/** `diskutil image` is a swift-argument-parser tool with a different layout. */
const swiftSubcommands = (help: string): string[] => {
  const idx = help.indexOf("SUBCOMMANDS:")
  if (idx < 0) return []
  return help
    .slice(idx)
    .split("\n")
    .flatMap((line) => {
      const m = /^ {2}([a-z][A-Za-z]*)\s{2,}\S/.exec(line)
      return m?.[1] === undefined ? [] : [m[1].toLowerCase()]
    })
}

/** THE CHECK, as a pure function so the paired control can feed it a verb the
 *  rules certainly do not know and prove it reports one. */
const unclassified = (verbs: readonly string[], known: ReadonlySet<string>): string[] =>
  verbs.filter((v) => !known.has(v))

const GROUP_ALIASES = new Set(DISKUTIL_GROUPS.flatMap((g) => g.aliases))

describe("P-5 the diskutil verb population is derived from the binary", () => {
  test(`diskutil probe environment — ${DISKUTIL_ENV_REASON}`, () => {
    expect(DISKUTIL_ENV_REASON.startsWith(hasDiskutil ? "ready" : "SKIPPED")).toBe(true)
    // biome-ignore lint/suspicious/noConsole: visible skip — `test.skipIf` prints no reason
    if (!hasDiskutil) console.warn(`P-5 diskutil probes ${DISKUTIL_ENV_REASON}`)
  })

  test.skipIf(!hasDiskutil)("every TOP-LEVEL verb the binary prints is classified", () => {
    const verbs = classicVerbs(diskutilHelp([]))
    // Guard against a parser that silently matched nothing — the failure mode
    // that would make this whole arm vacuous.
    expect(verbs.length).toBeGreaterThan(30)
    expect(verbs).toContain("resetfusion")
    expect(verbs).toContain("appleraid")
    const known = new Set([
      ...DISKUTIL_DESTRUCTIVE_VERBS,
      ...DISKUTIL_REVIEWED_SAFE_VERBS,
      ...GROUP_ALIASES,
    ])
    expect({ unclassifiedTopLevelVerbs: unclassified(verbs, known) }).toEqual({
      unclassifiedTopLevelVerbs: [],
    })
  })

  test.skipIf(!hasDiskutil)("the binary prints exactly the GROUPS the rules know", () => {
    // The `appleRAID` miss was a missing GROUP, not a missing verb, so the
    // group set gets its own derivation: a line of the form `x <verb>` in the
    // top-level listing IS a dispatcher.
    const printed = diskutilHelp([])
      .split("\n")
      .flatMap((line) => {
        const m = /^ {5}(\S+) <\w+>\s{2,}\(/.exec(line)
        return m?.[1] === undefined ? [] : [m[1].toLowerCase()]
      })
    expect(printed.sort()).toEqual(["apfs", "appleraid", "corestorage", "image"])
    expect(unclassified(printed, GROUP_ALIASES)).toEqual([])
  })

  for (const group of DISKUTIL_GROUPS) {
    const name = group.aliases[0] ?? ""
    test.skipIf(!hasDiskutil)(`every \`diskutil ${name} <verb>\` is classified`, () => {
      const help = diskutilHelp([name])
      const verbs = name === "image" ? swiftSubcommands(help) : classicVerbs(help)
      expect(verbs.length).toBeGreaterThan(3)
      const known = new Set([...group.destructive, ...group.reviewedSafe])
      expect({ group: name, unclassified: unclassified(verbs, known) }).toEqual({
        group: name,
        unclassified: [],
      })
    })
  }

  test.skipIf(!hasDiskutil)("every alias the rules claim is one the BINARY accepts", () => {
    // The reverse direction: an alias invented here would silently widen the
    // deny surface for a spelling no user can even type.
    for (const alias of GROUP_ALIASES) {
      const help = diskutilHelp([alias])
      expect({ alias, recognized: !help.includes("did not recognize verb") }).toEqual({
        alias,
        recognized: true,
      })
    }
  })

  test("PAIRED CONTROL — the derivation reports a verb the rules do not know", () => {
    // Satisfying the arms above by classifying EVERYTHING (a `known` set that
    // swallows any input) fails here.
    const known = new Set([
      ...DISKUTIL_DESTRUCTIVE_VERBS,
      ...DISKUTIL_REVIEWED_SAFE_VERBS,
      ...GROUP_ALIASES,
    ])
    expect(unclassified(["erasedisk", "verbthatdoesnotexist"], known)).toEqual([
      "verbthatdoesnotexist",
    ])
  })

  test("PAIRED CONTROL — destructive and reviewed-safe do not overlap", () => {
    // A verb in BOTH sets would pass every totality check above while leaving
    // the classification meaningless.
    const both = [...DISKUTIL_DESTRUCTIVE_VERBS].filter((v) => DISKUTIL_REVIEWED_SAFE_VERBS.has(v))
    expect(both).toEqual([])
    for (const g of DISKUTIL_GROUPS) {
      expect([...g.destructive].filter((v) => g.reviewedSafe.has(v))).toEqual([])
    }
  })

  test("PAIRED CONTROL — the classification still separates reads from erasures", () => {
    expect(kindOf("diskutil appleRAID list")).toBe("safe-known")
    expect(verdictOf("diskutil appleRAID delete raidUUID")).toEqual({
      kind: "hard-deny",
      rule: "diskutil-destructive-verb",
    })
  })
})

/* ------------------------------------------------------------------------- *
 * P-6 — the filesystem-formatter heads come from an OS probe
 * ------------------------------------------------------------------------- *
 *
 * After `diskutil` moved out to its own assessor, EVERY head left in the
 * `mkfs-format-filesystem` rule was a Linux spelling and none existed on this
 * machine (`which newfs mkfs` → neither found). The rule was live and could not
 * fire, while `newfs_hfs /dev/disk2s1` — the spelling that actually ships —
 * measured `safe-known`. A hand-written head list cannot notice that; a scan of
 * the directories the formatters live in can.
 */

const FORMATTER_DIRS = ["/sbin", "/usr/sbin", "/bin", "/usr/bin"] as const

const installedFormatters = (): string[] =>
  FORMATTER_DIRS.flatMap((dir) => {
    if (!existsSync(dir)) return []
    return readdirSync(dir).filter(
      (n) => /^(mkfs|newfs)/.test(n) && statSync(`${dir}/${n}`).isFile(),
    )
  })

/**
 * The LINUX half of the population, which no scan of THIS machine can reach.
 *
 * The macOS arms below probe `/sbin` and find the six `newfs_*`. That says
 * nothing about the boxes this agent actually shells into, and the rules file
 * claimed its Linux spellings "are pinned by hand and stay" — a claim made
 * without ever looking at an image. Two of the seven formatters a stock
 * `debian:12` installs were missing, so `mkfs.cramfs /dev/sda1` read
 * `safe-known` there and the machine-probe arm above would have gone RED on
 * any Debian host.
 *
 * SECOND-HAND: measured by the audit that reported the gap with
 * `docker run --rm --platform linux/amd64 debian:12` +
 * `ls /sbin /usr/sbin /bin /usr/bin | grep -E '^(mkfs|newfs)' | sort -u`, NOT
 * re-derived here — the Docker daemon on this machine is down (`docker info`
 * → "Cannot connect to the Docker daemon"). Pinned as a literal so it is
 * checkable by anyone who can run that one line, and so the two additions
 * cannot be dropped again by a set that looks tidy on macOS.
 */
const DEBIAN_12_FORMATTERS = [
  "mkfs",
  "mkfs.bfs",
  "mkfs.cramfs",
  "mkfs.ext2",
  "mkfs.ext3",
  "mkfs.ext4",
  "mkfs.minix",
] as const

describe("P-6 filesystem-formatter heads are probed, not remembered", () => {
  test("every formatter a stock debian:12 installs is a head — and the rule FIRES", () => {
    // Runs on every platform, because it asserts through `assessShellCommand`
    // rather than through the filesystem. That is the point: the Linux
    // population is unreachable by a probe HERE, so the only thing that can
    // guard it is a pinned corpus run through the real assessor.
    expect(unclassified([...DEBIAN_12_FORMATTERS], FILESYSTEM_FORMAT_HEADS)).toEqual([])
    for (const head of DEBIAN_12_FORMATTERS) {
      expect({ head, ...verdictOf(`${head} /dev/sda1`) }).toEqual({
        head,
        kind: "hard-deny",
        rule: "mkfs-format-filesystem",
      })
    }
  })

  test("every formatter installed on this machine is a head of the rule", () => {
    const found = installedFormatters()
    // On macOS this is the six `newfs_*` in /sbin. On a Linux box it would be
    // the mkfs family. Either way an EMPTY probe would make the arm vacuous.
    expect(found.length).toBeGreaterThan(0)
    expect(unclassified(found, FILESYSTEM_FORMAT_HEADS)).toEqual([])
  })

  test("the rule that consumes the heads actually fires on each of them", () => {
    // WIRING PROOF: the set could be correct and unreferenced. This asserts
    // through `assessShellCommand`, not through the exported set.
    for (const head of installedFormatters()) {
      expect({ head, ...verdictOf(`${head} /dev/disk9s1`) }).toEqual({
        head,
        kind: "hard-deny",
        rule: "mkfs-format-filesystem",
      })
    }
  })

  test("PAIRED CONTROL — the probe reports a formatter the heads do not name", () => {
    expect(unclassified(["newfs_hfs", "newfs_notreal"], FILESYSTEM_FORMAT_HEADS)).toEqual([
      "newfs_notreal",
    ])
  })

  test("PAIRED CONTROL — the rule has not become deny-everything", () => {
    // A "fix" that added every /sbin binary as a head passes the arm above.
    for (const cmd of ["ls /dev", "mount", "fsck -n /dev/disk1", "df -h"]) {
      expect({ cmd, kind: kindOf(cmd) }).toEqual({ cmd, kind: "safe-known" })
    }
    expect(FILESYSTEM_FORMAT_HEADS.has("ls")).toBe(false)
    expect(FILESYSTEM_FORMAT_HEADS.has("mount")).toBe(false)
  })
})

/* ------------------------------------------------------------------------- *
 * P-7 — GIT_GLOBAL_VALUE_FLAGS: pinned membership AND re-derived from git
 * ------------------------------------------------------------------------- *
 *
 * THE SURVIVING MUTANT THIS ARM KILLS. P-4 iterates
 * `for (const flag of GIT_GLOBAL_VALUE_FLAGS)`, so its case list is DERIVED
 * from the set under test: deleting `--config-env` from the set deleted its
 * own cases too, and both permission hellgates stayed green (measured: 269
 * pass / 0 fail). Only `--attr-source` was caught, and only because a
 * different file happens to hardcode it. A set that shrinks silently is not
 * pinned at all.
 *
 * Two independent guards, because either alone is defeatable:
 *  (a) the membership is a LITERAL here, so removing any flag is red;
 *  (b) the membership is RE-DERIVED from the installed git, so a flag that
 *      does not behave as claimed is red even if both lists agree.
 */

/**
 * ENVIRONMENT GATE for the arms that SHELL OUT to git.
 *
 * P-5 gates every `diskutil` arm on `existsSync("/usr/sbin/diskutil")`. P-7
 * gated nothing, and it needs TWO conditions, not one: the binary must exist
 * AND the suite must be running inside a git work tree, because every probe is
 * `git <flag> <sentinel> rev-parse --is-inside-work-tree` and that answers
 * `true` only from inside one.
 *
 * MEASURED with git removed from PATH: NINE hard failures —
 *
 *   (fail) `-C` really does eat the next token on the installed git
 *   (fail) `-c` … `--git-dir` … `--work-tree` … `--namespace` …
 *   (fail) `--config-env` … `--attr-source` …
 *   (fail) `--super-prefix` is still absent from the installed git
 *   (fail) PAIRED CONTROL — the probe distinguishes …
 *
 * — every one of which reads as a PERMISSION REGRESSION and none of which is.
 * The cause is a missing binary. Note that `--super-prefix is still absent`
 * fails in the WRONG DIRECTION too: with no git at all the probe returns no
 * "unknown option" text, so a test whose whole job is to notice a flag coming
 * BACK reports a problem when nothing came back.
 *
 * The 3 arms that pass without git (`membership is EXACTLY the pinned list`,
 * `--exec-path is pinned OUT`, `the two provenance tiers partition the set`)
 * are pure and stay ungated — measured, not assumed.
 */
const GIT_ENV: { readonly ok: boolean; readonly reason: string } = (() => {
  try {
    execFileSync("git", ["--version"], { encoding: "utf8", stdio: "pipe" })
  } catch {
    return { ok: false, reason: "SKIPPED — no `git` on PATH" }
  }
  try {
    const out = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      encoding: "utf8",
      stdio: "pipe",
    }).trim()
    if (out !== "true") return { ok: false, reason: "SKIPPED — not inside a git work tree" }
  } catch {
    return { ok: false, reason: "SKIPPED — not inside a git work tree" }
  }
  return { ok: true, reason: "ready — git on PATH, inside a work tree" }
})()

const gitProbe = (args: readonly string[]): { rc: number; out: string } => {
  try {
    const out = execFileSync("git", [...args], {
      encoding: "utf8",
      stdio: "pipe",
      env: { ...process.env, GIT_VALUE_FLAG_PROBE: "probe.value" },
    })
    return { rc: 0, out: out.trim() }
  } catch (e) {
    const err = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer }
    return {
      rc: err.status ?? 1,
      out: `${err.stdout?.toString() ?? ""}${err.stderr?.toString() ?? ""}`.trim(),
    }
  }
}

describe("P-7 the git global value-flag population cannot shrink silently", () => {
  // THE SKIP IS VISIBLE. `test.skipIf` alone reports "(skip)" with no reason,
  // which is how a permanently-skipped arm survives for months. This one
  // always RUNS and carries the reason in its own name, so a reader of the
  // output sees why the probes did or did not execute.
  test(`git probe environment — ${GIT_ENV.reason}`, () => {
    expect({ gated: !GIT_ENV.ok, reason: GIT_ENV.reason }).toEqual({
      gated: !GIT_ENV.ok,
      reason: GIT_ENV.ok ? "ready — git on PATH, inside a work tree" : GIT_ENV.reason,
    })
    if (!GIT_ENV.ok) {
      // biome-ignore lint/suspicious/noConsole: visible skip — `test.skipIf` prints no reason
      console.warn(`P-7 git probes ${GIT_ENV.reason} — flag membership is still pinned below.`)
    }
  })

  /** PINNED LITERAL — deliberately NOT derived from the set under test.
   *  To extend it: probe the candidate with
   *  `git <flag> <sentinel> rev-parse --is-inside-work-tree`; it consumes a
   *  separated value iff that prints `true`. Then add the flag AND its
   *  sentinel to `GIT_VALUE_FLAG_PROBE_SENTINELS` in `rules.ts`. */
  const EXPECTED_MEMBERSHIP = [
    "--attr-source",
    "--config-env",
    "--git-dir",
    "--namespace",
    "--super-prefix",
    "--work-tree",
    "-C",
    "-c",
  ] as const

  test("membership is EXACTLY the pinned list — removing any flag is red", () => {
    expect([...GIT_GLOBAL_VALUE_FLAGS].sort()).toEqual([...EXPECTED_MEMBERSHIP].sort())
  })

  test("--exec-path is pinned OUT, as a negative", () => {
    // It shipped in the set and made `git --exec-path push origin +main` read
    // as subcommand `origin`: `safe-known`, and branch-only ALLOWED.
    for (const flag of GIT_GLOBAL_FLAGS_TAKING_NO_SEPARATED_VALUE) {
      expect({ flag, inSet: GIT_GLOBAL_VALUE_FLAGS.has(flag) }).toEqual({ flag, inSet: false })
    }
    expect(gitOperandTokens("--exec-path push origin +main".split(" "))[0]).toBe("push")
    expect(verdictOf("git --exec-path push origin +main")).toEqual({
      kind: "hard-deny",
      rule: "git-push-force",
    })
    expect(decideBranchOnly("git --exec-path push origin +main").allowed).toBe(false)
  })

  test("the two provenance tiers partition the set", () => {
    expect([...GIT_GLOBAL_VALUE_FLAGS].sort()).toEqual(
      [
        ...GIT_VALUE_FLAGS_VERIFIED_ON_INSTALLED_GIT,
        ...GIT_VALUE_FLAGS_ABSENT_ON_INSTALLED_GIT,
      ].sort(),
    )
    const both = [...GIT_VALUE_FLAGS_VERIFIED_ON_INSTALLED_GIT].filter((f) =>
      GIT_VALUE_FLAGS_ABSENT_ON_INSTALLED_GIT.has(f),
    )
    expect(both).toEqual([])
  })

  for (const flag of GIT_VALUE_FLAGS_VERIFIED_ON_INSTALLED_GIT) {
    test.skipIf(!GIT_ENV.ok)(
      `\`${flag}\` really does eat the next token on the installed git`,
      () => {
        const sentinel = gitValueFlagProbe(flag)
        // A flag claiming "verified" with no probe recipe is not verified.
        expect({ flag, sentinel: sentinel !== undefined }).toEqual({ flag, sentinel: true })
        const { out } = gitProbe([flag, sentinel ?? "", "rev-parse", "--is-inside-work-tree"])
        expect({ flag, out }).toEqual({ flag, out: "true" })
      },
    )
  }

  for (const flag of GIT_VALUE_FLAGS_ABSENT_ON_INSTALLED_GIT) {
    test.skipIf(!GIT_ENV.ok)(`\`${flag}\` is still absent from the installed git`, () => {
      // Retained for older gits. If it ever comes BACK, re-probe it and move
      // it to the verified tier rather than assuming this note still holds.
      const { rc, out } = gitProbe([flag, "zzz", "rev-parse", "--is-inside-work-tree"])
      expect({ flag, rc0: rc === 0, unknown: out.includes("unknown option") }).toEqual({
        flag,
        rc0: false,
        unknown: true,
      })
    })
  }

  test.skipIf(!GIT_ENV.ok)(
    "PAIRED CONTROL — the probe distinguishes, it does not answer `true` to all",
    () => {
      // If the discriminator returned `true` unconditionally, every arm above
      // would pass for any flag whatsoever.
      for (const flag of GIT_GLOBAL_FLAGS_TAKING_NO_SEPARATED_VALUE) {
        expect({
          flag,
          out: gitProbe([flag, "zzz", "rev-parse", "--is-inside-work-tree"]).out,
        }).not.toEqual({ flag, out: "true" })
      }
      expect(
        gitProbe(["--not-a-real-global", "zzz", "rev-parse", "--is-inside-work-tree"]).out,
      ).not.toBe("true")
      // …and the baseline it is measured against is itself real.
      expect(gitProbe(["rev-parse", "--is-inside-work-tree"]).out).toBe("true")
    },
  )
})
