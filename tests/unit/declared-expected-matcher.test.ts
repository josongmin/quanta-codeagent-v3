import { describe, expect, test } from "bun:test"
import type { HardGateSignals, SoftScoreSignals } from "@/agent/verification-bundle/types"
import type { IssueDeclaredExpected } from "@/agent/verification-plan/extract-issue-declared-expected"
import {
  buildPublicDeclaredExpectedPort,
  matchCandidateAgainstDeclaredExpected,
} from "@/runner/batch/eval/declared-expected-matcher"
import { scoreWithAuthority } from "@/runner/batch/eval/selection-gates"
import type { Candidate } from "@/runner/batch/eval/selection-types"

/**
 * T2b — public-sourced declared-expected spec-fidelity matcher + the clean-mode
 * enablement of the EXISTING `hard:declaredExpectedMatch=false` veto.
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

  test("MUTATION-KILL isSpecBearing upper boundary: a no-whitespace 12-char unrelated literal IS spec-bearing ⇒ false (veto)", () => {
    // 12 chars, no whitespace, no overlap with V ⇒ spec-bearing by the length>=12
    // arm ⇒ veto. Kills `>= 12` → `> 12` (which would drop it to a non-spec key and
    // abstain instead of vetoing).
    const patch = patchAdding(`raise KeyError("abcdefghijkl")`)
    expect(matchCandidateAgainstDeclaredExpected(patch, publicExpected(V))).toBe(false)
  })

  test("MUTATION-KILL isSpecBearing lower boundary: a no-whitespace 11-char unrelated literal is NOT spec-bearing ⇒ null (abstain)", () => {
    // 11 chars, no whitespace ⇒ below the length floor ⇒ treated as an incidental
    // key, not a competing message ⇒ abstain. Kills `>= 12` → `>= 11` (which would
    // wrongly veto a correct fix that happens to add a short dict key).
    const patch = patchAdding(`raise KeyError("abcdefghij1")`)
    expect(matchCandidateAgainstDeclaredExpected(patch, publicExpected(V))).toBeNull()
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

describe("scoreWithAuthority — clean-mode veto fires ONLY for public provenance", () => {
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

  test("clean + PUBLIC + match=false ⇒ vetoed (T2b enablement)", () => {
    const v = scoreWithAuthority(admissibleHard, soft, false, "clean", true)
    expect(v.admissible).toBe(false)
    expect(v.reasons.some((r) => r.startsWith("hard:declaredExpectedMatch"))).toBe(true)
  })

  test("clean + PUBLIC + match=true ⇒ NOT vetoed", () => {
    const v = scoreWithAuthority(
      admissibleHard,
      { ...soft, declaredExpectedMatch: true },
      true,
      "clean",
      true,
    )
    expect(v.admissible).toBe(true)
  })

  test("research mode + match=false ⇒ vetoed regardless of provenance (existing behavior)", () => {
    expect(scoreWithAuthority(admissibleHard, soft, false, "research").admissible).toBe(false)
    expect(scoreWithAuthority(admissibleHard, soft, false, "research", false).admissible).toBe(
      false,
    )
  })
})
