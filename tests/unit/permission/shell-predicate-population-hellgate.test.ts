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
 *  P-3  `git-checkout-discard` has no dead arm. Its `o === "--"` test could
 *       never fire, because both operand readers dropped every `-`-leading
 *       token — so `git checkout -- src/foo.ts`, which is exactly what the rule
 *       says it catches ("restores files over uncommitted edits"), was safe.
 *  P-4  The two `GIT_GLOBAL_VALUE_FLAGS` consumers resolve the SAME subcommand
 *       for the same input, across the whole flag set and both spellings.
 *
 *  Every arm is paired with a control that fails if the fix is satisfied the
 *  lazy way — by denying everything, or by allowing everything.
 */

import { beforeAll, describe, expect, test } from "bun:test"
import { decideBranchOnly } from "@/permission/branch-only"
import { assessShellCommand, initShellEffectParser } from "@/permission/shell"
import { SIMPLE_DENIAL_RULES } from "@/permission/shell/assess"
import { GIT_GLOBAL_VALUE_FLAGS, gitOperandTokens } from "@/permission/shell/rules"

beforeAll(async () => {
  await initShellEffectParser()
})

const kindOf = (cmd: string) => assessShellCommand(cmd).kind
const verdictOf = (cmd: string) => {
  const a = assessShellCommand(cmd)
  return { kind: a.kind, rule: a.kind === "hard-deny" ? a.rule : undefined }
}

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
 * P-3 — the dead `--` arm
 * ------------------------------------------------------------------------- */

describe("P-3 git-checkout-discard has no unreachable arm", () => {
  const DISCARDS = [
    "git checkout -- src/foo.ts",
    "git checkout -- .",
    "git checkout --",
    "git checkout .",
    "git checkout HEAD -- src/foo.ts",
    "git -C /repo checkout -- src/foo.ts",
  ] as const
  for (const cmd of DISCARDS) {
    test(`DENY ${cmd}`, () => {
      expect({ cmd, ...verdictOf(cmd) }).toEqual({
        cmd,
        kind: "hard-deny",
        rule: "git-checkout-discard",
      })
    })
  }

  // PAIRED CONTROL — the arm above is satisfiable by denying every `git
  // checkout`, or by denying every `--`-bearing git command. Both fail here.
  const ORDINARY = [
    "git checkout main",
    "git checkout -b feature/x",
    "git log -- src/foo.ts",
    "git diff -- src/foo.ts",
    "git status",
    "git -C /repo status",
  ] as const
  for (const cmd of ORDINARY) {
    test(`PAIRED CONTROL — safe ${cmd}`, () => {
      expect({ cmd, kind: kindOf(cmd) }).toEqual({ cmd, kind: "safe-known" })
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
