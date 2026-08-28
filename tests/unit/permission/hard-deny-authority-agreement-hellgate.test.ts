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
import {
  type AxisStep,
  finalDecisionFor,
  inspectPermission,
  type PermissionInspection,
} from "@/permission/inspect"
import { HARD_DENY_RULES, hardDenyReason } from "@/permission/policy"
import { normalizeShellForDeny } from "@/permission/policy-rules"
import {
  __resetShellEffectParserForTest,
  assessShellCommand,
  assessShellCommandWith,
  initShellEffectParser,
  type ShellAssessmentKind,
  shellEffectParserReady,
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

/* ------------------------------------------------------------------------- *
 * A-4 — THE RENDERED SURFACE: the same union, or the operator is told a lie
 * ------------------------------------------------------------------------- */

/**
 * ITERATION 6 OF THE SAME GENERATIVE DEFECT, one layer out.
 *
 * `inspect.ts` computes `hardDenyMatched` as the UNION of both authorities —
 * and computes `hardDenyRules`, the ARRAY, from the REGEX HALF ONLY
 * (`matchHardDenyRules` walks `HARD_DENY_RULES` and nothing else). Two
 * consumers read that array, and on a structural-only denial both of them
 * contradict the verdict printed beside them, on one screen:
 *
 *   `finalDecisionFor`  ->  "HARD_DENY rule '(unknown rule)' matches …"
 *   `buildPipeline`     ->  axis hard-deny: n/a,
 *                           "No HARD_DENY pattern matched the supplied command"
 *
 * Measured before the fix, through `inspectPermission`:
 *
 *   git push origin +main:main        assess=hard-deny(git-push-force)
 *                                     matched=true rules=[] -> '(unknown rule)'
 *   git push --delete origin feature/x   ditto
 *   git push origin :feature/x           ditto
 *   git push origin :a :b                ditto
 *
 * The operator is refused, told the refusal has no rule and told no pattern
 * matched. The rule EXISTS — `git-push-force` is in `HARD_DENY_RULES`; the
 * structural authority named it and the array never asked.
 */
describe("A-4 the inspector's rule ARRAY is the same union as its own verdict", () => {
  const inspectFor = (cmd: string): PermissionInspection =>
    inspectPermission(
      "bash",
      { mode: "default" },
      { isReadOnly: false, hitlTier: "always-confirm", shellCommand: cmd },
    )

  const denyAxisOf = (cmd: string): AxisStep | undefined =>
    inspectFor(cmd).pipeline.find((s) => s.axis === "hard-deny")

  /** The four spellings the regex catalogue cannot see and the grammar can:
   *  a `+refspec` force-push and the three delete-a-remote-branch forms. */
  const STRUCTURAL_ONLY_PUSHES = [
    "git push origin +main:main",
    "git push --delete origin feature/x",
    "git push origin :feature/x",
    "git push origin :a :b",
  ] as const

  test("the four structural-only push denials name their rule instead of '(unknown rule)'", () => {
    const rendered = STRUCTURAL_ONLY_PUSHES.map((cmd) => {
      const insp = inspectFor(cmd)
      const decision = finalDecisionFor(insp, "default")
      return {
        cmd,
        operator: operatorHardDenied(cmd),
        matched: insp.hardDenyMatched,
        ruleNames: insp.hardDenyRules.map((r) => r.name),
        reason: decision.kind === "deny" ? decision.reason : `NOT-A-DENY:${decision.kind}`,
      }
    })
    expect(rendered).toEqual(
      STRUCTURAL_ONLY_PUSHES.map((cmd) => ({
        cmd,
        operator: true,
        matched: true,
        ruleNames: ["git-push-force"],
        reason: "HARD_DENY rule 'git-push-force' matches the supplied command",
      })),
    )
  })

  test("the four structural-only push denials render a DENY axis, not 'no matching pattern'", () => {
    // The second consumer of the same array. `buildPipeline` prints
    // `outcome: n/a` + "No HARD_DENY pattern matched" beside a decision that
    // says the command is refused — the axis trace an operator reads to learn
    // WHY, telling them the gate did not fire.
    for (const cmd of STRUCTURAL_ONLY_PUSHES) {
      const step = denyAxisOf(cmd)
      expect({
        cmd,
        outcome: step?.outcome,
        mentionsRule: step?.reason.includes("git-push-force"),
      }).toEqual({ cmd, outcome: "deny", mentionsRule: true })
    }
  })

  test("CORPUS-WIDE — every operator hard-deny carries at least one named rule", () => {
    // The same 219-command derived corpus the other two arms are judged on.
    // Neither authority picked these cases.
    const unnamed = CORPUS.filter(
      (cmd) => operatorHardDenied(cmd) && inspectFor(cmd).hardDenyRules.length === 0,
    )
    expect({ deniedWithNoNamedRule: unnamed }).toEqual({ deniedWithNoNamedRule: [] })
  })

  test("CORPUS-WIDE — '(unknown rule)' is never rendered, in any mode", () => {
    const lies = CORPUS.flatMap((cmd) => {
      const insp = inspectFor(cmd)
      return (["default", "acceptEdits", "bypass", "auto"] as const).flatMap((mode) => {
        const d = finalDecisionFor(insp, mode)
        return d.kind === "deny" && d.reason.includes("(unknown rule)") ? [`${cmd} @${mode}`] : []
      })
    })
    expect({ unknownRuleRenderings: lies }).toEqual({ unknownRuleRenderings: [] })
  })

  test("CORPUS-WIDE — the axis trace never says 'no pattern matched' about a denied command", () => {
    const contradictions = CORPUS.flatMap((cmd) => {
      if (!operatorHardDenied(cmd)) return []
      const step = denyAxisOf(cmd)
      if (step === undefined) return [`${cmd} :: NO hard-deny axis step at all`]
      return step.outcome === "deny" ? [] : [`${cmd} :: axis=${step.outcome} :: ${step.reason}`]
    })
    expect({ axisContradictions: contradictions }).toEqual({ axisContradictions: [] })
  })

  test("NON-VACUITY — the structural-only population is REAL in this corpus", () => {
    // Without this, all four arms above are satisfied by a corpus in which
    // every denial happens to have a regex rule, and the union is never
    // exercised.
    const structuralOnly = CORPUS.filter(
      (cmd) => regexRuleFor(cmd) === null && operatorHardDenied(cmd),
    )
    expect(structuralOnly.length).toBeGreaterThan(0)
    // ...and each one is named by the STRUCTURAL authority's own rule name, so
    // the array is a union of the two vocabularies rather than a stub that
    // pushes a placeholder to satisfy `length > 0`.
    for (const cmd of structuralOnly) {
      const expected = assessShellCommand(cmd).rule
      expect({ cmd, names: inspectFor(cmd).hardDenyRules.map((r) => r.name) }).toEqual({
        cmd,
        names: expect.arrayContaining([expected]),
      })
    }
  })

  test("SECURITY CONTRACT — an appended structural descriptor is still name+description ONLY", () => {
    // The array grew a new producer. The no-regex-literals contract that
    // governs it did not change.
    for (const cmd of STRUCTURAL_ONLY_PUSHES) {
      for (const rule of inspectFor(cmd).hardDenyRules) {
        expect(Object.keys(rule).sort()).toEqual(["description", "name"])
        expect(rule.description.length).toBeGreaterThan(0)
        expect(rule.description).not.toMatch(/\\b|\\s|\(\?:/)
      }
    }
  })

  test("PAIRED CONTROL — a permitted command still names NO rule, and no axis deny", () => {
    // The fix must not turn the array into "always non-empty".
    for (const cmd of ["git status", "ls -la ./src", "git restore src/foo.ts"]) {
      const insp = inspectFor(cmd)
      expect({ cmd, rules: insp.hardDenyRules.length, matched: insp.hardDenyMatched }).toEqual({
        cmd,
        rules: 0,
        matched: false,
      })
      expect(denyAxisOf(cmd)?.outcome).toBe("n/a")
    }
  })

  test("PAIRED CONTROL — a regex-only denial is UNCHANGED (no duplicate, same head)", () => {
    // `rm -rf /` is denied by the regex catalogue alone. Appending the
    // structural half must not duplicate a name nor reorder the array.
    const insp = inspectFor("rm -rf /")
    const names = insp.hardDenyRules.map((r) => r.name)
    expect(names[0]).toBe("rm-recursive-force-system-root")
    expect(new Set(names).size).toBe(names.length)
  })
})

/* ------------------------------------------------------------------------- *
 * A-5 — THE TRAP: the structural half is ASYNC-ARMED and the inspector is not
 * ------------------------------------------------------------------------- */

/**
 * `inspectPermission` is SYNCHRONOUS; `assessShellCommand` only works after
 * `initShellEffectParser()` has been awaited. Before that the grammar is
 * `null`, every assessment is `unknown`, and the union quietly collapses back
 * to the regex catalogue — the exact pre-fix behaviour, with no diff to blame.
 * That is how this defect returns, so it gets its own arm: the degrade must be
 * ABSENT (structural half gone) and OBSERVABLE (a flag on the record and an
 * explicit branch in the axis trace), never silent.
 */
describe("A-5 the not-armed structural authority degrades OBSERVABLY, not silently", () => {
  const inspectFor = (cmd: string): PermissionInspection =>
    inspectPermission(
      "bash",
      { mode: "default" },
      { isReadOnly: false, hitlTier: "always-confirm", shellCommand: cmd },
    )

  test("the not-ready parse path answers `unknown` — proven through the injected seam", () => {
    // No global mutation: `assessShellCommandWith` is the module's own seam for
    // exactly this. Proves the degrade is a real code path, not a hypothesis.
    expect(assessShellCommandWith("git push origin :feature/x", { parse: () => null }).kind).toBe(
      "unknown",
    )
  })

  test("with the grammar dropped: structural half ABSENT, and the record SAYS so", async () => {
    expect(shellEffectParserReady()).toBe(true)
    const armed = inspectFor("git push origin :feature/x")
    expect({
      ready: armed.structuralAuthorityReady,
      names: armed.hardDenyRules.map((r) => r.name),
      matched: armed.hardDenyMatched,
    }).toEqual({ ready: true, names: ["git-push-force"], matched: true })

    __resetShellEffectParserForTest()
    try {
      expect(shellEffectParserReady()).toBe(false)
      const bare = inspectFor("git push origin :feature/x")
      // ABSENT: the structural half is gone — the whole gate is, which is why
      // this cannot be allowed to be silent.
      expect({
        ready: bare.structuralAuthorityReady,
        names: bare.hardDenyRules.map((r) => r.name),
        matched: bare.hardDenyMatched,
      }).toEqual({ ready: false, names: [], matched: false })
      // OBSERVABLE: the axis trace takes an EXPLICIT not-armed branch instead
      // of asserting the confident "No HARD_DENY pattern matched".
      const step = bare.pipeline.find((s) => s.axis === "hard-deny")
      expect(step?.reason).not.toBe("No HARD_DENY pattern matched the supplied command")
      expect(step?.reason.toLowerCase()).toContain("structural")

      // PAIRED CONTROL — the reset removed ONLY the structural half. The regex
      // catalogue still denies, still names its rule, still renders a deny axis.
      const regexOnly = inspectFor("rm -rf /")
      expect({
        matched: regexOnly.hardDenyMatched,
        names: regexOnly.hardDenyRules.map((r) => r.name),
        axis: regexOnly.pipeline.find((s) => s.axis === "hard-deny")?.outcome,
      }).toEqual({
        matched: true,
        names: ["rm-recursive-force-system-root"],
        axis: "deny",
      })
    } finally {
      await initShellEffectParser()
    }
    // Restored for every arm that runs after this one.
    expect(shellEffectParserReady()).toBe(true)
    expect(inspectFor("git push origin :feature/x").hardDenyRules.map((r) => r.name)).toEqual([
      "git-push-force",
    ])
  })
})
