import { describe, expect, test } from "bun:test"
import type { HardGateSignals, SoftScoreSignals } from "@/agent/verification-bundle/types"
import type { IssueDeclaredExpected } from "@/agent/verification-plan/extract-issue-declared-expected"
import {
  buildPublicDeclaredExpectedPort,
  matchCandidateAgainstDeclaredExpected,
} from "@/runner/batch/eval/declared-expected-matcher"
import { bestEffortEligible, scoreWithAuthority } from "@/runner/batch/eval/selection-gates"
import type { Candidate } from "@/runner/batch/eval/selection-types"

/**
 * T2b — public-sourced declared-expected spec-fidelity matcher (`matchCandidate…`)
 * plus the CLEAN-mode authority contract: the static prose-regex match may only
 * ever ADD ranking credit in clean mode, NEVER hard-veto. A `match === false`
 * verdict keeps the candidate admissible AND best-effort eligible in clean mode
 * (no `hard:declaredExpectedMatch=false` reason is stamped). RESEARCH mode keeps
 * the legacy answer-key veto byte-identically (paired controls below).
 */

const publicExpected = (
  value: string,
  kind: IssueDeclaredExpected["kind"] = "stdout",
): IssueDeclaredExpected => ({ kind, value, provenance: "public-issue-text" })

const patchAdding = (...lines: readonly string[]): string =>
  ["--- a/x.py", "+++ b/x.py", "@@ -1 +1 @@", ...lines.map((l) => `+${l}`)].join("\n")

const candidate = (patch: string): Candidate => ({
  id: "c0",
  patch,
  turns: 1,
  files: ["x.py"],
  baseValidatedRed: null,
})

describe("matchCandidateAgainstDeclaredExpected — execution-free spec fidelity", () => {
  const V = "TimeSeries object is invalid - expected ['time'] as the first columns"

  test("consistent: added line surfaces the declared literal ⇒ true (credit)", () => {
    const patch = patchAdding(`raise ValueError("${V}")`)
    expect(matchCandidateAgainstDeclaredExpected(patch, publicExpected(V))).toBe(true)
  })

  test("MUTATION-KILL includes: V verbatim with an extra suffix still ⇒ true (substring, not exact/prefix)", () => {
    // The added literal is `<V> (strict mode)` — V is a SUBSTRING, not the whole
    // line and not a prefix. Kills `includes` → `===` and `includes` → `startsWith`.
    const patch = patchAdding(`raise ValueError("${V} (strict mode)")`)
    expect(matchCandidateAgainstDeclaredExpected(patch, publicExpected(V))).toBe(true)
  })

  test("contradiction: candidate invents a DIFFERENT message literal, V absent ⇒ false (veto)", () => {
    const patch = patchAdding(`raise ValueError("TimeSeries is broken, please check your columns")`)
    expect(matchCandidateAgainstDeclaredExpected(patch, publicExpected(V))).toBe(false)
  })

  test("abstain: candidate touches no spec-bearing literal ⇒ null (fail-open)", () => {
    const patch = patchAdding("if cols is None:", "    cols = []")
    expect(matchCandidateAgainstDeclaredExpected(patch, publicExpected(V))).toBeNull()
  })

  test("MUTATION-KILL ||/.some: a competing literal that is a SUBSTRING of V ⇒ null (not veto)", () => {
    // "as the first columns" is a clean contiguous substring of V (so v.includes(s)
    // holds even though the added line does not contain all of V). The matcher must
    // NOT veto — it overlaps the declared message. Kills line-125 `||` → `&&` and the
    // `.some(...)` predicate → constant-false (both would wrongly return false here).
    const patch = patchAdding(`raise ValueError("as the first columns")`)
    expect(matchCandidateAgainstDeclaredExpected(patch, publicExpected(V))).toBeNull()
  })

  test("isSpecBearing structural: a long BARE IDENTIFIER (no whitespace, no punctuation) is NOT spec-bearing ⇒ null (abstain)", () => {
    // `abcdefghijklmnop` is a valid bare identifier — a plausible attribute/dict key,
    // carrying no spec — so it must abstain REGARDLESS of length. This is the case the
    // old `length >= 12` length cutoff WRONGLY vetoed. Parameter-free rule: an
    // identifier-shaped token is never a competing message.
    const patch = patchAdding(`raise KeyError("abcdefghijklmnop")`)
    expect(matchCandidateAgainstDeclaredExpected(patch, publicExpected(V))).toBeNull()
  })

  test("isSpecBearing structural: a SHORT NON-IDENTIFIER literal IS spec-bearing ⇒ false (veto) — the case `>= 12` wrongly excluded", () => {
    // `[1,2,3]`, `a.b.c`, `<x>` are all short (< 12 chars) and would have been dropped
    // by the old length cutoff, yet each has punctuation/structure that no plausible
    // bare identifier has ⇒ a real value, not an incidental key ⇒ spec-bearing ⇒ veto
    // (none overlaps V). Each kills the reintroduction of a numeric length floor.
    for (const lit of ["[1,2,3]", "a.b.c", "<x>"]) {
      const patch = patchAdding(`raise ValueError("${lit}")`)
      expect(matchCandidateAgainstDeclaredExpected(patch, publicExpected(V))).toBe(false)
    }
  })

  test("isSpecBearing structural: short BARE identifiers/dict-keys (`id`,`x`,`foo`) are NOT spec-bearing ⇒ null (abstain)", () => {
    // Short structureless identifier-shaped tokens are plausible keys/attrs ⇒ must not
    // be treated as competing messages, or correct dict/attr edits get false-vetoed.
    for (const key of ["id", "x", "foo"]) {
      const patch = patchAdding(`obj["${key}"] = value`)
      expect(matchCandidateAgainstDeclaredExpected(patch, publicExpected(V))).toBeNull()
    }
  })

  test("isSpecBearing structural: a whitespace-bearing value (`index out of range`) IS spec-bearing ⇒ false (veto)", () => {
    // Whitespace ⇒ a phrase ⇒ spec-bearing regardless of length; it does not overlap V
    // ⇒ competing message ⇒ veto. Kills dropping the whitespace arm of the rule.
    const patch = patchAdding(`raise IndexError("index out of range")`)
    expect(matchCandidateAgainstDeclaredExpected(patch, publicExpected(V))).toBe(false)
  })

  test("T2b-FIX: a DYNAMIC f-string message ⇒ abstain (null), NOT a false veto", () => {
    // The final message is built at runtime; a literal comparison cannot prove
    // contradiction. A correct dynamic fix must not be vetoed → PASS→FAIL.
    const patch = patchAdding(
      'raise ValueError(f"TimeSeries object is invalid - expected {required} as the first columns")',
    )
    expect(matchCandidateAgainstDeclaredExpected(patch, publicExpected(V))).toBeNull()
  })

  test("T2b-FIX: a %-format / str.format template message ⇒ abstain (null)", () => {
    expect(
      matchCandidateAgainstDeclaredExpected(
        patchAdding('raise ValueError("expected %s as the first column" % name)'),
        publicExpected(V),
      ),
    ).toBeNull()
    expect(
      matchCandidateAgainstDeclaredExpected(
        patchAdding('raise ValueError("expected {0} as the first column".format(name))'),
        publicExpected(V),
      ),
    ).toBeNull()
  })

  test("T2b-FIX: a stale message in an added COMMENT is not mined ⇒ no false veto", () => {
    // The real change is a non-string fix; the comment merely mentions an old
    // message. Stripping comments before mining prevents a false contradiction.
    const patch = patchAdding(
      '# historical: used to read "TimeSeries totally different wrong message"',
      "cols = list(required_columns)",
    )
    expect(matchCandidateAgainstDeclaredExpected(patch, publicExpected(V))).toBeNull()
  })

  test("M4 regression: a stale message in an INLINE trailing comment is NOT mined ⇒ no false veto (fail-CLOSED guard)", () => {
    // The real change is a non-string fix; the trailing comment merely recalls an
    // old message. Before the inline-strip fix this hard-vetoed a correct candidate.
    const patch = patchAdding(
      'cols = list(required_columns)  # previously raised "TimeSeries was totally broken before now"',
    )
    expect(matchCandidateAgainstDeclaredExpected(patch, publicExpected(V))).toBeNull()
  })

  test("M4 control: a `#` INSIDE a real string literal is preserved (not mistaken for a comment)", () => {
    // The message itself contains a '#'. The contradiction veto must still fire on a
    // concrete wrong message that happens to include '#'.
    const patch = patchAdding('raise ValueError("the wrong message about color #fff entirely")')
    expect(matchCandidateAgainstDeclaredExpected(patch, publicExpected(V))).toBe(false)
  })

  test("T2b-FIX preserves the TRUE positive: a concrete DIFFERENT literal still vetoes (no over-abstain)", () => {
    // A static, non-template, spec-bearing wrong message must STILL be vetoed —
    // the fix must not neuter the real contradiction signal.
    const patch = patchAdding('raise ValueError("the columns provided are not valid at all here")')
    expect(matchCandidateAgainstDeclaredExpected(patch, publicExpected(V))).toBe(false)
  })

  test("abstain: competing literal is a short non-spec-bearing identifier ⇒ null (no veto)", () => {
    // `time` is a short, structureless key — must NOT be treated as a competing
    // message literal, or correct dict/attr edits would be falsely vetoed.
    const patch = patchAdding(`obj["time"] = value`)
    expect(matchCandidateAgainstDeclaredExpected(patch, publicExpected(V))).toBeNull()
  })

  test("isSpecBearing structural: an EMPTY-STRING literal is NOT spec-bearing ⇒ null (abstain) — preserves empty⇒false", () => {
    // `""` is a degenerate literal carrying no spec; the rule must return false for it
    // (length 0 fails both the whitespace and the not-an-identifier arm). A correct fix
    // that adds an empty default string must not be vetoed. Note QUOTED requires ≥1
    // body char, so the empty literal is not even mined — but pairing it with a real
    // bare-identifier key proves NEITHER registers as competing ⇒ abstain.
    const patch = patchAdding('default = ""', 'obj["k"] = default')
    expect(matchCandidateAgainstDeclaredExpected(patch, publicExpected(V))).toBeNull()
  })

  test("stdout-empty declarations abstain (execution-free contradiction unreliable)", () => {
    const empty = publicExpected("issue declares the correct output is empty", "stdout-empty")
    expect(matchCandidateAgainstDeclaredExpected(patchAdding('print("boom")'), empty)).toBeNull()
  })

  test("empty patch ⇒ null", () => {
    expect(matchCandidateAgainstDeclaredExpected("", publicExpected(V))).toBeNull()
  })

  test("INJECTION: a mismatched-quote token is NOT mined as a competing literal", () => {
    // `"broken quote'` opens with `"` but never closes with `"` — the matched-quote
    // regex must reject it (a loose `[`'"]…[`'"]` regex would falsely extract it
    // and could flip the verdict). No well-formed literal ⇒ abstain, not a guess.
    const patch = patchAdding(`x = "broken quote' + helper()`)
    expect(matchCandidateAgainstDeclaredExpected(patch, publicExpected(V))).toBeNull()
  })
})

describe("H1 dynamic-message-matcher — fixed-skeleton narrows the abstain region", () => {
  const V = "TimeSeries object is invalid - expected ['time'] as the first columns"
  const ON = { dynamicSkeleton: true } as const

  test("RED-ON-DISABLE / regression floor: knob OFF ⇒ EVERY dynamic template abstains (legacy byte-identical)", () => {
    // This is the parity guarantee. With the knob off, an f-string with a WRONG
    // skeleton must STILL abstain (null) exactly as before the H1 change — proving
    // the new behavior is fully gated. If the matcher decided this without the
    // option, the legacy path would have regressed.
    const wrong = patchAdding('raise ValueError(f"completely unrelated boom: {x} happened")')
    expect(matchCandidateAgainstDeclaredExpected(wrong, publicExpected(V))).toBeNull()
    expect(matchCandidateAgainstDeclaredExpected(wrong, publicExpected(V), { dynamicSkeleton: false })).toBeNull()
  })

  test("ENGAGE: knob ON + WRONG f-string skeleton ⇒ false (veto) — the abstain region SHRANK", () => {
    // The author hard-coded "completely unrelated boom:" / "happened" — neither is a
    // fragment of V. Skeleton COMPETING ⇒ veto. This is the 13033 residual the legacy
    // matcher (above) could only abstain on.
    const wrong = patchAdding('raise ValueError(f"completely unrelated boom: {x} happened")')
    expect(matchCandidateAgainstDeclaredExpected(wrong, publicExpected(V), ON)).toBe(false)
  })

  test("RED-ON-INJECTION (the teeth): knob ON + CONSISTENT f-string skeleton ⇒ null (abstain), NOT a false veto", () => {
    // The fix is the CORRECT dynamic shape: V with the literal ['time'] abstracted to
    // a runtime field. Every fixed fragment ("TimeSeries object is invalid - expected",
    // "as the first columns") appears in V in order ⇒ consistent ⇒ MUST abstain. A
    // skeleton matcher that vetoed here would false-fail a correct fix (PASS→FAIL).
    const correct = patchAdding(
      'raise ValueError(f"TimeSeries object is invalid - expected {required} as the first columns")',
    )
    expect(matchCandidateAgainstDeclaredExpected(correct, publicExpected(V), ON)).toBeNull()
  })

  test("ENGAGE: knob ON + WRONG %-format skeleton ⇒ false (veto)", () => {
    const wrong = patchAdding('raise ValueError("the table is missing %s entirely now" % col)')
    expect(matchCandidateAgainstDeclaredExpected(wrong, publicExpected(V), ON)).toBe(false)
  })

  test("ENGAGE: knob ON + CONSISTENT %-format skeleton ⇒ null (abstain)", () => {
    // Fixed fragments ("TimeSeries object is invalid - expected", "as the first columns")
    // are ordered substrings of V; only the %s sits where ['time'] is ⇒ consistent.
    const correct = patchAdding(
      'raise ValueError("TimeSeries object is invalid - expected %s as the first columns" % cols)',
    )
    expect(matchCandidateAgainstDeclaredExpected(correct, publicExpected(V), ON)).toBeNull()
  })

  test("ENGAGE: knob ON + WRONG str.format skeleton ⇒ false (veto)", () => {
    const wrong = patchAdding('raise ValueError("nope, bad columns {0} were given".format(col))')
    expect(matchCandidateAgainstDeclaredExpected(wrong, publicExpected(V), ON)).toBe(false)
  })

  test("ENGAGE: knob ON + CONSISTENT str.format skeleton ⇒ null (abstain)", () => {
    const correct = patchAdding(
      'raise ValueError("TimeSeries object is invalid - expected {0} as the first columns".format(cols))',
    )
    expect(matchCandidateAgainstDeclaredExpected(correct, publicExpected(V), ON)).toBeNull()
  })

  test("ENGAGE: knob ON + ORDER matters — fragments present but TRANSPOSED ⇒ false (veto)", () => {
    // Both fragments occur in V but in the WRONG order. fragmentsInOrder must fail,
    // so this is a competing (reordered) message, not a consistent skeleton. Kills a
    // mutation of fragmentsInOrder → "every fragment is somewhere in V" (set-membership).
    const transposed = patchAdding(
      'raise ValueError(f"as the first columns {x} TimeSeries object is invalid - expected")',
    )
    expect(matchCandidateAgainstDeclaredExpected(transposed, publicExpected(V), ON)).toBe(false)
  })

  test("ENGAGE: knob ON + pure-placeholder template (no substantive fixed text) ⇒ null (undecidable)", () => {
    // `"{0}"` / `f"{x}"` carry NO hard-coded message to compare; the runtime value is
    // unknown ⇒ abstain even with the knob on. Kills a mutation that treats an
    // empty-skeleton template as competing (it would false-veto a correct fix that
    // forwards a computed message).
    const placeholderOnly = patchAdding('raise ValueError(f"{computed_message}")')
    expect(matchCandidateAgainstDeclaredExpected(placeholderOnly, publicExpected(V), ON)).toBeNull()
  })

  test("ENGAGE: knob ON + a CONSISTENT template alongside a competing one ⇒ null (consistency wins, no veto)", () => {
    // Two added templates: one is the correct shape, one looks wrong. We cannot prove
    // the candidate emits the wrong one, so a single consistent template forces
    // abstain. Kills a mutation flipping `includes("consistent")` precedence.
    const mixed = patchAdding(
      'msg_a = f"TimeSeries object is invalid - expected {required} as the first columns"',
      'msg_b = f"some other unrelated note {y} here"',
    )
    expect(matchCandidateAgainstDeclaredExpected(mixed, publicExpected(V), ON)).toBeNull()
  })

  test("ENGAGE: knob ON does NOT change the CONCRETE-literal path (a static wrong literal still vetoes)", () => {
    // When a non-template concrete competing literal exists, the H1 branch is skipped
    // entirely (concrete.length>0). The legacy concrete veto must be untouched.
    const wrong = patchAdding('raise ValueError("the columns provided are not valid at all here")')
    expect(matchCandidateAgainstDeclaredExpected(wrong, publicExpected(V), ON)).toBe(false)
  })

  test("ENGAGE: knob ON preserves the verbatim-consistent fast path (V surfaced literally ⇒ true)", () => {
    const patch = patchAdding(`raise ValueError("${V}")`)
    expect(matchCandidateAgainstDeclaredExpected(patch, publicExpected(V), ON)).toBe(true)
  })
})

describe("H1 wiring-proof — buildPublicDeclaredExpectedPort threads the option to the matcher", () => {
  const V = "TimeSeries object is invalid - expected ['time'] as the first columns"
  const wrongDynamic = candidate(
    patchAdding('raise ValueError(f"completely unrelated boom: {x} happened")'),
  )

  test("port built WITHOUT the option ⇒ dynamic wrong message abstains (null) — knob-OFF parity", async () => {
    const port = buildPublicDeclaredExpectedPort(publicExpected(V))
    expect(await port?.(wrongDynamic)).toBeNull()
  })

  test("port built WITH { dynamicSkeleton: true } ⇒ same dynamic wrong message vetoes (false)", async () => {
    // Proves the boolean reaches the matcher through the port factory — the ONLY
    // delta vs the OFF case above is the option, so the verdict flip is attributable
    // to the wired knob (red-on-injection through the live port).
    const port = buildPublicDeclaredExpectedPort(publicExpected(V), { dynamicSkeleton: true })
    expect(await port?.(wrongDynamic)).toBe(false)
  })
})

describe("buildPublicDeclaredExpectedPort — answer-key guard (red-on-injection)", () => {
  const V = "expected ['time', 'flux'] as the first columns"

  test("public-issue-text provenance ⇒ a real port that can veto", async () => {
    const port = buildPublicDeclaredExpectedPort(publicExpected(V))
    expect(port).toBeDefined()
    const verdict = await port?.(
      candidate(patchAdding(`raise ValueError("a totally different message here")`)),
    )
    expect(verdict).toBe(false)
  })

  test("INJECTION: a non-public provenance ⇒ NO port (gold/test_patch can never veto)", () => {
    // Forge a declared-expected as if sourced from the answer key. The guard must
    // refuse it outright — the clean-mode veto is reachable ONLY from public text.
    const forged = {
      kind: "stdout",
      value: V,
      provenance: "gold-patch",
    } as unknown as IssueDeclaredExpected
    expect(buildPublicDeclaredExpectedPort(forged)).toBeUndefined()
  })

  test("undefined / empty value ⇒ no port", () => {
    expect(buildPublicDeclaredExpectedPort(undefined)).toBeUndefined()
    expect(buildPublicDeclaredExpectedPort(publicExpected("   "))).toBeUndefined()
  })
})

describe("scoreWithAuthority — CLEAN mode NEVER hard-vetoes on declaredExpected (ranking-only)", () => {
  const admissibleHard: HardGateSignals = {
    baseValidatedRed: null,
    patchProduced: true,
    patchedResolvedKofN: null,
    regressionGreen: null,
    smokeGreen: null,
    applyClean: true,
  }
  const soft: SoftScoreSignals = {
    declaredExpectedMatch: false,
    rubricScore: null,
    voterQuorum: null,
    minimality: 1,
    ownerCoverage: null,
  }

  test("clean + NOT public (default) + match=false ⇒ NOT vetoed (legacy byte-identical)", () => {
    const v = scoreWithAuthority(admissibleHard, soft, false, "clean")
    expect(v.admissible).toBe(true)
    expect(v.reasons.some((r) => r.startsWith("hard:declaredExpectedMatch"))).toBe(false)
  })

  test(
    "RED-ON-INJECTION (the teeth): clean + PUBLIC authority + match=false ⇒ STILL admissible " +
      "AND no reject reason — a static prose-regex mismatch may not hard-reject a correct fix",
    () => {
      // This is the hole the audit flagged: with declaredExpectedAuthority="public"
      // the old code set admissible:false here AND stamped the reject reason (which
      // also bars best-effort). The match is a NON-EXECUTED regex compare of the
      // candidate's added literals vs a value scraped from issue PROSE; it must
      // only ADD ranking credit (the true case), never reject. Reverting the
      // scoreWithAuthority change (re-enabling the clean-mode public veto) flips
      // BOTH assertions RED. The reason-absence assertion is what proves the
      // best-effort bar is ALSO neutralized (bestEffortEligible bars solely on this
      // reason — see the paired best-effort test below).
      const v = scoreWithAuthority(admissibleHard, soft, false, "clean", true)
      expect(v.admissible).toBe(true)
      expect(v.reasons.some((r) => r.startsWith("hard:declaredExpectedMatch"))).toBe(false)
    },
  )

  test("clean + PUBLIC + match=true ⇒ NOT vetoed (the true case never rejects)", () => {
    const v = scoreWithAuthority(
      admissibleHard,
      { ...soft, declaredExpectedMatch: true },
      true,
      "clean",
      true,
    )
    expect(v.admissible).toBe(true)
  })

  // PAIRED CONTROL: research mode is untouched — declaredExpected=false STILL vetoes
  // there regardless of provenance, proving the change is scoped to clean mode only.
  test("PAIRED CONTROL: research mode + match=false ⇒ STILL vetoed (byte-identical legacy)", () => {
    const research = scoreWithAuthority(admissibleHard, soft, false, "research")
    expect(research.admissible).toBe(false)
    expect(research.reasons.some((r) => r.startsWith("hard:declaredExpectedMatch"))).toBe(true)
    // public/non-public flag is irrelevant in research mode — both still veto.
    expect(scoreWithAuthority(admissibleHard, soft, false, "research", false).admissible).toBe(
      false,
    )
    expect(scoreWithAuthority(admissibleHard, soft, false, "research", true).admissible).toBe(false)
  })
})

describe("bestEffortEligible — CLEAN public declaredExpected mismatch does NOT bar best-effort", () => {
  const eligibleHard: HardGateSignals = {
    baseValidatedRed: null,
    patchProduced: true,
    patchedResolvedKofN: null,
    regressionGreen: null,
    smokeGreen: null,
    applyClean: true,
  }

  // The verdict a CLEAN + PUBLIC + match=false candidate now carries after the fix:
  // admissible with NO declaredExpected reject reason.
  const cleanVerdict = scoreWithAuthority(
    eligibleHard,
    {
      declaredExpectedMatch: false,
      rubricScore: null,
      voterQuorum: null,
      minimality: 1,
      ownerCoverage: null,
    },
    false,
    "clean",
    true,
  )

  test("RED-ON-INJECTION (best-effort teeth): clean candidate is best-effort eligible", () => {
    // Reverting the scoreWithAuthority change stamps DECLARED_EXPECTED_REJECT_REASON
    // onto cleanVerdict, which bestEffortEligible bars on ⇒ this flips RED. Proves
    // the best-effort bar (not only the admissibility veto) is neutralized in clean.
    expect(bestEffortEligible({ hard: eligibleHard, verdict: cleanVerdict }, "clean")).toBe(true)
  })

  test("PAIRED CONTROL: research declaredExpected=false verdict STILL bars best-effort", () => {
    const researchVerdict = scoreWithAuthority(
      eligibleHard,
      {
        declaredExpectedMatch: false,
        rubricScore: null,
        voterQuorum: null,
        minimality: 1,
        ownerCoverage: null,
      },
      false,
      "research",
    )
    expect(bestEffortEligible({ hard: eligibleHard, verdict: researchVerdict }, "research")).toBe(
      false,
    )
  })
})
