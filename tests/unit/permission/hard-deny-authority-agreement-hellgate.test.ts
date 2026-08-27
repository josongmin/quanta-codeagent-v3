/**
 * HELLGATE — the POPULATION of "authorities that can hard-deny a command".
 *
 * ITERATION 5 OF ONE GENERATIVE DEFECT: a fix lands where the bug was reported
 * and nobody enumerates the population of the same predicate. The four prior
 * instances are on the record in
 * `shell-predicate-population-hellgate.test.ts` (git global-option consumption
 * living in two functions, `--attr-source` never probed, valueless globals, the
 * diskutil verb/group population). This file pins the FIFTH.
 *
 * THE FIFTH INSTANCE. `hardDenyReason` is a UNION of two independent
 * authorities and only one of them was changed:
 *
 *   `permission/policy.ts:82`  runs the REGEX corpus (`HARD_DENY`, projected
 *                              from `policy-rules.ts`) FIRST, and returns on
 *                              the first match.
 *   `permission/policy.ts:97`  only then consults `assessShellCommand`, the
 *                              STRUCTURAL authority.
 *
 * A commit softened `git checkout -- <path>` from `hard-deny` to
 * `sensitive-known` in the STRUCTURAL table and asserted, in its message and in
 * a test comment, that those commands were now "permitted in practice, exactly
 * as `git restore` has been all along". They were not. `policy-rules.ts`'s
 * `git-checkout-discard` still carried a `\s--\s` alternative, so the regex
 * matched first and the softening never reached the operator. Measured through
 * the real entry point:
 *
 *     assess=sensitive-known hardDenied=YES :: git checkout -- src/foo.ts
 *     assess=sensitive-known hardDenied=no  :: git restore src/foo.ts
 *
 * — the exact spelling tax the change set out to delete, still there. And
 * `permission/inspect.ts` reported `HARD_DENY matched 1 rule(s):
 * git-checkout-discard` for a command the assessor was simultaneously labelling
 * `sensitive-known` under the sibling name `git-checkout-discard-path`: ONE
 * rule identity, TWO answers.
 *
 * WHAT "DISAGREE" MEANS HERE, and why it is not "the two verdicts differ".
 *
 * The seam is deliberately a UNION and deliberately DENY-WIDENING: `policy.ts`
 * consults the structural authority only to ADD denials, never to remove one.
 * So a regex that denies MORE than the assessor is the designed state, not a
 * bug — measured over the regex corpus's own fixtures there are ~38 such
 * commands, and every one of them is a hazard the structural table simply has
 * no rule for (`git -c alias.x='!sh' x`, `git rebase -i`, `find . -delete`,
 * `git --exec-path=/tmp/evil status`). Flagging those would make this guard
 * fire on correct behaviour and it would be deleted within a week.
 *
 * The direction that IS a defect is the one the campaign actually produced:
 *
 *     the two authorities name the SAME RULE IDENTITY and return OPPOSITE
 *     verdicts — one terminal, one not.
 *
 * `rules.ts` says so in its own header: "Rule NAMES are the ones the shipping
 * `HARD_DENY_RULES` catalog already uses, so a denial keeps the same identity
 * across the two authorities and operators do not learn a second vocabulary."
 * Once a name is shared, the two authorities are making a claim ABOUT THE SAME
 * EFFECT, and they cannot both be right. `-path` is the structural table's own
 * documented soft-tier sibling suffix (`GIT_WORKTREE_DISCARD_PATH` in
 * `assess.ts`), so `git-checkout-discard` and `git-checkout-discard-path` are
 * one identity — which is precisely why the divergence was invisible: the two
 * names are not string-equal.
 *
 * Three things this file does that a corpus of hand-typed commands cannot:
 *
 *  A-1 The corpus is DERIVED from `permission-rules.fixtures.ts` — the regex
 *      authority's OWN adversarial corpus, curated in a separate file by a
 *      separate reviewer — plus the structural authority's own discard
 *      spellings. Neither authority chose the cases it is judged on.
 *  A-2 The model of the regex half is proven byte-faithful to the REAL
 *      operator entry point before it is used to judge anything. A guard that
 *      measures a reimplementation of the fold cannot see a bug in the fold.
 *  A-3 The discriminator is a pure function, so the paired controls feed it
 *      the historical defect (must report), an independent hazard (must not),
 *      and the benign widening (must not).
 */

import { describe, expect, test } from "bun:test"
import { HARD_DENY_RULES, hardDenyReason } from "@/permission/policy"
import { normalizeShellForDeny } from "@/permission/policy-rules"
import {
  assessShellCommand,
  initShellEffectParser,
  type ShellAssessmentKind,
} from "@/permission/shell"
import type { ToolAction } from "@/permission/types"
import { PERMISSION_RULE_FIXTURES } from "../permission-rules.fixtures"

await initShellEffectParser()

/* ------------------------------------------------------------------------- *
 * The two authorities, read exactly as `policy.ts` reads them
 * ------------------------------------------------------------------------- */

/** The FIRST regex rule that fires, matched against the same normalized probe
 *  `hardDenyReason` builds. Returns the rule NAME — the identity the operator
 *  sees in `inspect.ts` — not merely a boolean. */
const regexRuleFor = (cmd: string): string | null => {
  const probe = normalizeShellForDeny(cmd)
  return HARD_DENY_RULES.find((r) => r.pattern.test(probe))?.name ?? null
}

const bashAction = (cmd: string): ToolAction => ({
  tool: "bash",
  input: { command: cmd },
  isReadOnly: false,
  shellCommand: cmd,
})

/** THE OPERATOR-FACING FOLD. Not `assessShellCommand`, not the regex list —
 *  the function a real dispatch calls. */
const operatorHardDenied = (cmd: string): boolean => hardDenyReason(bashAction(cmd)) !== null

/* ------------------------------------------------------------------------- *
 * The discriminator — a pure function so the controls can prove it has teeth
 * ------------------------------------------------------------------------- */

/**
 * Identity of a rule ACROSS the two authorities.
 *
 * The structural table reuses the regex catalog's names by design, and appends
 * `-path` for its soft-tier sibling of the same effect
 * (`GIT_WORKTREE_DISCARD_PATH`). Stripping that suffix is what makes
 * `git-checkout-discard` and `git-checkout-discard-path` compare equal — and
 * the fact that they did NOT compare equal as raw strings is why one authority
 * could be changed and the other left behind without a single test noticing.
 */
export const ruleIdentity = (name: string): string => name.replace(/-path$/, "")

interface Contradiction {
  readonly cmd: string
  readonly identity: string
  readonly regexRule: string
  readonly structuralRule: string
  readonly structuralKind: ShellAssessmentKind
}

/**
 * Does this command make the two authorities contradict each other?
 *
 * Returns `null` for every state that is DESIGNED, and a record only for the
 * one state that cannot be right:
 *
 *  - regex permits            -> the structural authority may still deny; the
 *                                seam is a union and that is its purpose.
 *  - both deny                -> agreement.
 *  - regex denies, structural
 *    names NO rule            -> benign widening: a hazard the structural table
 *                                has no rule for at all. ~38 of these ship
 *                                today and every one is correct.
 *  - regex denies, structural
 *    names a DIFFERENT rule   -> two INDEPENDENT hazards in one command line.
 *                                Denying on the stronger one is correct.
 *  - regex denies under R,
 *    structural names R and
 *    does NOT deny            -> CONTRADICTION. One identity, two answers. The
 *                                operator is refused under a rule name whose
 *                                own authority says the effect is authorizable.
 */
export const contradictionOf = (
  cmd: string,
  regexRule: string | null,
  structuralKind: ShellAssessmentKind,
  structuralRule: string | undefined,
): Contradiction | null => {
  if (regexRule === null) return null
  if (structuralKind === "hard-deny") return null
  if (structuralRule === undefined) return null
  if (ruleIdentity(structuralRule) !== ruleIdentity(regexRule)) return null
  return { cmd, identity: ruleIdentity(regexRule), regexRule, structuralRule, structuralKind }
}

const contradictionFor = (cmd: string): Contradiction | null => {
  const a = assessShellCommand(cmd)
  return contradictionOf(cmd, regexRuleFor(cmd), a.kind, a.rule)
}

/* ------------------------------------------------------------------------- *
 * The corpus — DERIVED, not authored here
 * ------------------------------------------------------------------------- */

/** The regex authority's own adversarial corpus, both polarities flattened.
 *  Curated in a separate file, reviewed independently of the regexes — so
 *  neither authority picked the cases it is judged on. */
const FIXTURE_CORPUS: readonly string[] = [
  ...new Set(
    Object.values(PERMISSION_RULE_FIXTURES).flatMap((f) => [...f.mustBlock, ...f.mustAllow]),
  ),
]

/** The STRUCTURAL authority's side of the same population: every spelling of a
 *  worktree discard, at both tiers, plus the ordinary lookalikes. The regex
 *  corpus has no `switch`/`restore` entries at all, so without these the check
 *  would only ever see half the vocabulary. */
const STRUCTURAL_CORPUS = [
  "git checkout -- src/foo.ts",
  "git checkout HEAD -- src/foo.ts",
  "git checkout main -- packages/x/index.ts",
  "git -C /repo checkout -- src/foo.ts",
  "git checkout .",
  "git checkout -- .",
  "git checkout ./",
  "git checkout :/",
  "git checkout --",
  "git checkout -f main",
  "git checkout --force main",
  "git checkout main",
  "git checkout -b feature/x",
  "git restore src/foo.ts",
  "git restore -- src/foo.ts",
  "git restore --worktree --staged src/foo.ts",
  "git restore --source HEAD src/foo.ts",
  "git restore .",
  "git restore -- .",
  "git restore --staged src/foo.ts",
  "git switch --discard-changes main",
  "git switch -f main",
  "git switch main",
  "git log -- src/foo.ts",
  "git diff -- src/foo.ts",
] as const

const CORPUS: readonly string[] = [...new Set([...FIXTURE_CORPUS, ...STRUCTURAL_CORPUS])]

/* ------------------------------------------------------------------------- *
 * A-2 — the model is proven faithful BEFORE it judges anything
 * ------------------------------------------------------------------------- */

describe("A-2 the regex half is modelled byte-faithfully to the real fold", () => {
  test("`hardDenyReason` is (a regex rule fired) OR (the structural verdict is hard-deny)", () => {
    // WIRING PROOF. `regexRuleFor` is a reimplementation of half of
    // `policy.ts`'s loop; if it drifted, every arm below would be measuring a
    // fold no operator ever runs. Asserted over the WHOLE corpus, both
    // polarities, so it cannot be satisfied by a corpus of denials.
    const mismatches = CORPUS.filter(
      (cmd) =>
        operatorHardDenied(cmd) !==
        (regexRuleFor(cmd) !== null || assessShellCommand(cmd).kind === "hard-deny"),
    )
    expect({ modelMismatches: mismatches }).toEqual({ modelMismatches: [] })
  })

  test("the union direction holds: a structural hard-deny always reaches the operator", () => {
    // `policy.ts` consults the assessor only to ADD denials. If this ever
    // fails, the seam stopped being monotone and a structural denial is being
    // swallowed.
    const swallowed = CORPUS.filter(
      (cmd) => assessShellCommand(cmd).kind === "hard-deny" && !operatorHardDenied(cmd),
    )
    expect({ structuralDenialsNotReachingOperator: swallowed }).toEqual({
      structuralDenialsNotReachingOperator: [],
    })
  })

  test("NON-VACUITY — the corpus exercises both halves of the fold", () => {
    // A guard whose corpus happens to contain no denials passes everything.
    const regexOnly = CORPUS.filter(
      (c) => regexRuleFor(c) !== null && assessShellCommand(c).kind !== "hard-deny",
    )
    const structuralOnly = CORPUS.filter(
      (c) => regexRuleFor(c) === null && assessShellCommand(c).kind === "hard-deny",
    )
    const permitted = CORPUS.filter((c) => !operatorHardDenied(c))
    expect({
      corpus: CORPUS.length > 200,
      regexOnly: regexOnly.length > 0,
      structuralOnly: structuralOnly.length > 0,
      permitted: permitted.length > 0,
    }).toEqual({ corpus: true, regexOnly: true, structuralOnly: true, permitted: true })
  })

  test("NON-VACUITY — the two authorities actually SHARE rule identities", () => {
    // The discriminator compares rule NAMES. If the two vocabularies were
    // disjoint over this corpus, `contradictionOf` could never return anything
    // and the whole file would be a no-op that reads like a guard.
    const regexIdentities = new Set(
      CORPUS.map(regexRuleFor).flatMap((r) => (r === null ? [] : [ruleIdentity(r)])),
    )
    const structuralIdentities = new Set(
      CORPUS.map((c) => assessShellCommand(c).rule).flatMap((r) =>
        r === undefined ? [] : [ruleIdentity(r)],
      ),
    )
    const shared = [...regexIdentities].filter((i) => structuralIdentities.has(i)).sort()
    expect({ sharedIsNonEmpty: shared.length > 0 }).toEqual({ sharedIsNonEmpty: true })
    // ...and the identity at the centre of this defect is one of them.
    expect(shared).toContain("git-checkout-discard")
  })
})

/* ------------------------------------------------------------------------- *
 * A-1 — THE GUARD
 * ------------------------------------------------------------------------- */

describe("A-1 the two hard-deny authorities never contradict each other", () => {
  test("no command is refused under a rule identity whose own authority permits it", () => {
    const contradictions = CORPUS.flatMap((cmd) => {
      const c = contradictionFor(cmd)
      if (c === null) return []
      return [`${c.cmd} :: regex ${c.regexRule}=DENY vs ${c.structuralRule}=${c.structuralKind}`]
    })
    expect({ contradictions }).toEqual({ contradictions: [] })
  })

  test("the `git checkout -- <path>` family specifically — both authorities permit", () => {
    // The instance that produced this file, asserted through the entry point
    // rather than through either authority alone. `git restore <path>` is the
    // paired baseline: git's own spelling of the identical effect, permitted
    // throughout. If the two ever differ again, that IS the spelling tax.
    for (const path of ["src/foo.ts", "packages/x/index.ts"]) {
      expect({
        path,
        checkout: operatorHardDenied(`git checkout -- ${path}`),
        restore: operatorHardDenied(`git restore ${path}`),
      }).toEqual({ path, checkout: false, restore: false })
    }
  })

  test("the WHOLE-TREE forms stay denied by BOTH — the softening did not overshoot", () => {
    // The narrowing that fixes the contradiction is one character class away
    // from deleting the rule. `git checkout .` and a trailing `--` are
    // `git reset --hard`'s blast radius and must still be refused, and the
    // REGEX must still be the one refusing them (the structural authority
    // agreeing is not evidence the regex half survived).
    for (const cmd of ["git checkout .", "git checkout -- .", "cd /tmp && git checkout ."]) {
      expect({ cmd, regexRule: regexRuleFor(cmd), operator: operatorHardDenied(cmd) }).toEqual({
        cmd,
        regexRule: "git-checkout-discard",
        operator: true,
      })
    }
  })

  test("a trailing `--` with NO pathspec is not denied by either — it has no effect", () => {
    // GROUND TRUTH, git 2.50.1, in a scratch repo with an uncommitted edit:
    //
    //     $ git checkout --      -> `M\tf.txt`,  file still CHANGED
    //     $ git checkout HEAD -- -> `M\tf.txt`,  file still CHANGED
    //     $ git checkout main -- -> `Already on 'main'`, file still CHANGED
    //     $ git checkout HEAD -- f.txt -> file restored to `a`
    //
    // So the pathspec is what discards, and a bare `--` discards nothing. The
    // regex used to deny all three anyway (a `\s--$` alternative) while the
    // assessor called them `sensitive-known` — the same contradiction as the
    // named-path forms, wearing a different spelling. Both authorities now
    // agree, and they agree with the binary.
    for (const cmd of ["git checkout --", "git checkout HEAD --", "git checkout main --"]) {
      expect({ cmd, regexRule: regexRuleFor(cmd), operator: operatorHardDenied(cmd) }).toEqual({
        cmd,
        regexRule: null,
        operator: false,
      })
    }
  })
})

/* ------------------------------------------------------------------------- *
 * A-3 — PAIRED CONTROLS: the discriminator has teeth, and is not a smoke alarm
 * ------------------------------------------------------------------------- */

describe("A-3 the discriminator reports the defect and nothing else", () => {
  test("it REPORTS the historical divergence", () => {
    // Fed the pre-fix state verbatim. A discriminator that returns `null`
    // unconditionally passes every arm above; it fails here.
    expect(
      contradictionOf(
        "git checkout -- src/foo.ts",
        "git-checkout-discard",
        "sensitive-known",
        "git-checkout-discard-path",
      ),
    ).toEqual({
      cmd: "git checkout -- src/foo.ts",
      identity: "git-checkout-discard",
      regexRule: "git-checkout-discard",
      structuralRule: "git-checkout-discard-path",
      structuralKind: "sensitive-known",
    })
  })

  test("it REPORTS a same-NAME divergence with no suffix involved", () => {
    // The `-path` suffix is not what makes it a contradiction; the shared
    // identity is. A guard that only ever fired on `-path` would be a
    // hard-coded assertion about one commit.
    expect(
      contradictionOf("git clean -f", "git-clean-force", "safe-known", "git-clean-force")?.identity,
    ).toBe("git-clean-force")
  })

  test("it does NOT report the benign widening — regex denies, structural has no rule", () => {
    // ~38 live commands are in this state and every one is correct. If the
    // discriminator flagged them the guard would be red on arrival and deleted.
    expect(
      contradictionOf("git rebase -i", "git-rebase-interactive", "safe-known", undefined),
    ).toBe(null)
    expect(contradictionOf("find . -delete", "find-action-flag-set", "safe-known", undefined)).toBe(
      null,
    )
  })

  test("it does NOT report two INDEPENDENT hazards in one command line", () => {
    // `git -c x=y restore src/foo.ts`: the regex denies for config injection,
    // the assessor labels the discard. Different effects, different names —
    // denying on the stronger one is right.
    expect(
      contradictionOf(
        "git -c x=y restore src/foo.ts",
        "git-config-injection",
        "sensitive-known",
        "git-restore-discard-path",
      ),
    ).toBe(null)
  })

  test("it does NOT report agreement, in either direction", () => {
    expect(
      contradictionOf(
        "git checkout .",
        "git-checkout-discard",
        "hard-deny",
        "git-checkout-discard",
      ),
    ).toBe(null)
    expect(contradictionOf("git status", null, "safe-known", undefined)).toBe(null)
    // Structural denies, regex has no rule — the union's whole purpose.
    expect(
      contradictionOf("git switch -f main", null, "hard-deny", "git-switch-discard-changes"),
    ).toBe(null)
  })

  test("PAIRED CONTROL — the benign-widening population is real, and shares no identity", () => {
    // Measured, not assumed: the state the discriminator deliberately ignores
    // must actually OCCUR in the corpus (otherwise the exclusion is untested),
    // and none of its members may share a rule identity (otherwise the
    // exclusion is hiding contradictions).
    const widening = CORPUS.flatMap((cmd) => {
      const rr = regexRuleFor(cmd)
      const a = assessShellCommand(cmd)
      if (rr === null || a.kind === "hard-deny") return []
      return a.rule === undefined ? [cmd] : []
    })
    expect(widening.length).toBeGreaterThan(20)
    for (const cmd of widening) expect({ cmd, c: contradictionFor(cmd) }).toEqual({ cmd, c: null })
  })

  test("PAIRED CONTROL — the guard is not satisfied by an empty rule catalog", () => {
    // `contradictions: []` is also what you get from a catalog with no rules
    // and an assessor that never names one.
    expect(HARD_DENY_RULES.length).toBeGreaterThanOrEqual(11)
    expect(regexRuleFor("rm -rf /")).toBe("rm-recursive-force-system-root")
    expect(assessShellCommand("git checkout -- src/foo.ts").rule).toBe("git-checkout-discard-path")
  })
})
