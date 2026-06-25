import { describe, expect, it } from "bun:test"
import type { CandidateVerdict, HardGateSignals } from "@/agent/verification-bundle"
import {
  bestEffortEligible,
  nonEmptyFallbackEligible,
} from "@/runner/batch/eval/selection-gates"
import {
  type Candidate,
  runSelection,
  type SelectionPorts,
} from "@/runner/batch/eval/selection-executor"

// -- Pure predicate teeth -----------------------------------------------------

const hardOf = (over: Partial<HardGateSignals>): HardGateSignals => ({
  baseValidatedRed: true,
  patchProduced: true,
  applyClean: true,
  regressionGreen: null,
  smokeGreen: null,
  patchedResolvedKofN: null,
  ...over,
})

const verdictOf = (reasons: readonly string[]): CandidateVerdict => ({
  admissible: false,
  score: 0,
  reasons,
})

const MWE_RED = "hard:mweProof=candidate_red (public issue MWE still fails after patch)"
const STATIC_SANITY = "hard:staticSanity=NameError: undefined name 'frobnicate'"

describe("nonEmptyFallbackEligible (rock-solid subset)", () => {
  it("ELIGIBLE: a candidate barred ONLY by the self-oracle (mwe candidate_red)", () => {
    // applyClean true, regressionGreen not-false, non-empty, no static-sanity:
    // the ONLY rejection is the candidate's own MWE — a known ~45% false-negative.
    const entry = {
      hard: hardOf({ applyClean: true, regressionGreen: true }),
      verdict: verdictOf([MWE_RED]),
    }
    expect(nonEmptyFallbackEligible(entry, "clean")).toBe(true)
    // CONTROL — this same candidate is NOT bestEffortEligible (best-effort bars
    // mwe candidate_red), proving the fallback is a STRICTLY WIDER set on exactly
    // the self-oracle axis (the corrected design), not a duplicate of best-effort.
    expect(bestEffortEligible(entry, "clean")).toBe(false)
  })

  it("ELIGIBLE: regressionGreen null (fail-open) is allowed, not barred", () => {
    const entry = {
      hard: hardOf({ applyClean: true, regressionGreen: null }),
      verdict: verdictOf([MWE_RED]),
    }
    expect(nonEmptyFallbackEligible(entry, "clean")).toBe(true)
  })

  it("ELIGIBLE: applyClean null (fail-open) is allowed, not barred", () => {
    const entry = {
      hard: hardOf({ applyClean: null, regressionGreen: true }),
      verdict: verdictOf([MWE_RED]),
    }
    expect(nonEmptyFallbackEligible(entry, "clean")).toBe(true)
  })

  it("NOT eligible: applyClean === false (would-not-apply risks a grader error)", () => {
    const entry = {
      hard: hardOf({ applyClean: false, regressionGreen: true }),
      verdict: verdictOf([MWE_RED]),
    }
    expect(nonEmptyFallbackEligible(entry, "clean")).toBe(false)
  })

  it("NOT eligible: regressionGreen === false (real breakage, not merely a 0)", () => {
    const entry = {
      hard: hardOf({ applyClean: true, regressionGreen: false }),
      verdict: verdictOf([MWE_RED]),
    }
    expect(nonEmptyFallbackEligible(entry, "clean")).toBe(false)
  })

  it("NOT eligible: static-sanity reject (deterministic NameError-class break)", () => {
    const entry = {
      hard: hardOf({ applyClean: true, regressionGreen: true }),
      verdict: verdictOf([STATIC_SANITY]),
    }
    expect(nonEmptyFallbackEligible(entry, "clean")).toBe(false)
  })

  it("NOT eligible: empty patch (patchProduced false)", () => {
    const entry = {
      hard: hardOf({ patchProduced: false, applyClean: null, regressionGreen: null }),
      verdict: verdictOf([]),
    }
    expect(nonEmptyFallbackEligible(entry, "clean")).toBe(false)
  })

  it("static-sanity bars EVEN WHEN also self-oracle barred (rock-solid wins)", () => {
    const entry = {
      hard: hardOf({ applyClean: true, regressionGreen: true }),
      verdict: verdictOf([MWE_RED, STATIC_SANITY]),
    }
    expect(nonEmptyFallbackEligible(entry, "clean")).toBe(false)
  })
})

// -- Executor wiring teeth ----------------------------------------------------

const cand = (over: Partial<Candidate> & { id: string }): Candidate => ({
  patch: "diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1,1 +1,1 @@\n-old\n+new",
  turns: 1,
  files: ["x.py"],
  baseValidatedRed: true,
  ...over,
})

/** Generator that yields the listed candidate for indices < length, then an
 *  EMPTY patch — so the clean-mode selector-repair append degrades to a no-op
 *  (`empty_patch` stop) and `scored` holds exactly the listed candidates. */
const genThenEmpty = (list: readonly Candidate[]): SelectionPorts["generate"] => {
  return async (i) =>
    (list[i] ?? cand({ id: `repair-${i}`, patch: "", files: [] })) as Candidate
}

describe("runSelection non-empty fallback (default-OFF A/B arm)", () => {
  it("knob OFF ⇒ no fallbackCandidate, submission EMPTY (byte-identical control)", async () => {
    const r = await runSelection({
      n: 1,
      mode: "clean",
      seeds: [undefined],
      owners: new Set(["x.py"]),
      ports: {
        generate: genThenEmpty([cand({ id: "cand-0" })]),
        applyClean: async () => true,
        regression: async () => true,
        // candidate's own MWE is RED ⇒ inadmissible & not best-effort ⇒ no winner.
        mweProof: async () => ({ state: "candidate_red" }),
      },
    })
    expect(r.winner).toBeNull()
    // OFF: field absent ⇒ exactly today's behavior (winner?.patch ?? "" === "").
    expect(r.fallbackCandidate ?? null).toBeNull()
    expect(r.winner?.patch ?? r.fallbackCandidate?.patch ?? "").toBe("")
  })

  it("knob ON ⇒ fallbackCandidate is the self-oracle-only-barred candidate; submitted instead of empty", async () => {
    const r = await runSelection({
      n: 1,
      mode: "clean",
      nonEmptyFallback: true,
      seeds: [undefined],
      owners: new Set(["x.py"]),
      ports: {
        generate: genThenEmpty([cand({ id: "cand-0" })]),
        applyClean: async () => true,
        regression: async () => true,
        mweProof: async () => ({ state: "candidate_red" }),
      },
    })
    // Winner semantics UNCHANGED — telemetry stays honest (this was a fallback).
    expect(r.winner).toBeNull()
    expect(r.admissibleCount).toBe(0)
    // The rock-solid-subset candidate is the fallback, and the driver renderer
    // expression now submits its non-empty patch instead of "".
    expect(r.fallbackCandidate?.id).toBe("cand-0")
    const submitted = r.winner?.patch ?? r.fallbackCandidate?.patch ?? ""
    expect(submitted).not.toBe("")
    expect(submitted).toBe(cand({ id: "cand-0" }).patch)
  })

  it("knob ON but candidate REGRESSES ⇒ NOT chosen; submission stays empty", async () => {
    const r = await runSelection({
      n: 1,
      mode: "clean",
      nonEmptyFallback: true,
      seeds: [undefined],
      owners: new Set(["x.py"]),
      ports: {
        generate: genThenEmpty([cand({ id: "cand-0" })]),
        applyClean: async () => true,
        regression: async () => false, // regresses existing tests ⇒ real breakage
        mweProof: async () => ({ state: "candidate_red" }),
      },
    })
    expect(r.winner).toBeNull()
    expect(r.fallbackCandidate ?? null).toBeNull()
    expect(r.winner?.patch ?? r.fallbackCandidate?.patch ?? "").toBe("")
  })

  it("knob ON but candidate WON'T APPLY ⇒ NOT chosen; submission stays empty", async () => {
    const r = await runSelection({
      n: 1,
      mode: "clean",
      nonEmptyFallback: true,
      seeds: [undefined],
      owners: new Set(["x.py"]),
      ports: {
        generate: genThenEmpty([cand({ id: "cand-0" })]),
        applyClean: async () => false, // won't apply ⇒ grader-error risk
        regression: async () => true,
        mweProof: async () => ({ state: "candidate_red" }),
      },
    })
    expect(r.winner).toBeNull()
    expect(r.fallbackCandidate ?? null).toBeNull()
    expect(r.winner?.patch ?? r.fallbackCandidate?.patch ?? "").toBe("")
  })

  it("knob ON but candidate is a NameError-class static-sanity break ⇒ NOT chosen; stays empty", async () => {
    const r = await runSelection({
      n: 1,
      mode: "clean",
      nonEmptyFallback: true,
      seeds: [undefined],
      owners: new Set(["x.py"]),
      ports: {
        generate: genThenEmpty([cand({ id: "cand-0" })]),
        applyClean: async () => true,
        regression: async () => true,
        staticSanity: async () => [
          "hard:staticSanity=pythonUndefinedNameIntroduced(frobnicate@x.py)",
        ],
      },
    })
    expect(r.winner).toBeNull()
    expect(r.fallbackCandidate ?? null).toBeNull()
    expect(r.winner?.patch ?? r.fallbackCandidate?.patch ?? "").toBe("")
  })

  it("knob ON but a real WINNER exists ⇒ fallback never computed (no behavior change)", async () => {
    const r = await runSelection({
      n: 1,
      mode: "clean",
      nonEmptyFallback: true,
      seeds: [undefined],
      owners: new Set(["x.py"]),
      ports: {
        generate: genThenEmpty([cand({ id: "cand-0" })]),
        applyClean: async () => true,
        regression: async () => true,
        // executed positive proof ⇒ a genuine winner.
        resolvedKofN: async () => ({ votes: 3, k: 3 }),
      },
    })
    expect(r.winner?.id).toBe("cand-0")
    expect(r.fallbackCandidate ?? null).toBeNull()
    expect(r.winner?.patch ?? r.fallbackCandidate?.patch ?? "").toBe(cand({ id: "cand-0" }).patch)
  })
})

// -- Agentless CONSENSUS floor (normalized-majority vote) ----------------------

// Two DISTINCT normalized edits to x.py: A (smaller diff) and B (larger diff).
// All self-oracle-barred (mwe candidate_red) so none can win → fallback floor.
const PATCH_A = "diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1,1 +1,1 @@\n-old\n+aaa"
const PATCH_B =
  "diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -5,1 +5,2 @@\n-old\n+bbb\n+bbb2"

describe("runSelection non-empty fallback — consensus (normalized-majority) floor", () => {
  const fourCandidates = [
    cand({ id: "a-1", patch: PATCH_A }),
    cand({ id: "b-1", patch: PATCH_B }),
    cand({ id: "a-2", patch: PATCH_A }),
    cand({ id: "a-3", patch: PATCH_A }),
  ]

  it("MAJORITY wins: 3×A vs 1×B ⇒ floor submits an A even though B is not the minority on minimality alone", async () => {
    const r = await runSelection({
      n: 4,
      mode: "clean",
      nonEmptyFallback: true,
      seeds: [undefined, undefined, undefined, undefined],
      owners: new Set(["x.py"]),
      ports: {
        generate: genThenEmpty(fourCandidates),
        applyClean: async () => true,
        regression: async () => true,
        mweProof: async () => ({ state: "candidate_red" }),
      },
    })
    expect(r.winner).toBeNull()
    // The 3-vote A bucket beats the lone B. The chosen id is one of the A copies.
    expect(["a-1", "a-2", "a-3"]).toContain(r.fallbackCandidate?.id ?? "")
    expect(r.fallbackCandidate?.patch).toBe(PATCH_A)
  })

  it("RED-on-injection: flip to 3×B vs 1×A ⇒ floor MUST follow the majority to B (proves consensus is the primary key, not minimality)", async () => {
    // B is the LARGER diff (worse on minimality). If the floor were minimality-led
    // it would pick A regardless of votes; consensus forces B when B is the bucket.
    const r = await runSelection({
      n: 4,
      mode: "clean",
      nonEmptyFallback: true,
      seeds: [undefined, undefined, undefined, undefined],
      owners: new Set(["x.py"]),
      ports: {
        generate: genThenEmpty([
          cand({ id: "b-1", patch: PATCH_B }),
          cand({ id: "a-1", patch: PATCH_A }),
          cand({ id: "b-2", patch: PATCH_B }),
          cand({ id: "b-3", patch: PATCH_B }),
        ]),
        applyClean: async () => true,
        regression: async () => true,
        mweProof: async () => ({ state: "candidate_red" }),
      },
    })
    expect(r.winner).toBeNull()
    expect(["b-1", "b-2", "b-3"]).toContain(r.fallbackCandidate?.id ?? "")
    expect(r.fallbackCandidate?.patch).toBe(PATCH_B)
  })

  it("NO consensus (all unique) ⇒ reduces to the structural ranking (minimality) — byte-identical to the pre-consensus floor", async () => {
    // Two distinct single-vote buckets: the smaller diff (A) wins on minimality,
    // exactly as the old lexicographic-only floor did. Proves the consensus layer
    // is inert without a genuine ≥2 agreement.
    const r = await runSelection({
      n: 2,
      mode: "clean",
      nonEmptyFallback: true,
      seeds: [undefined, undefined],
      owners: new Set(["x.py"]),
      ports: {
        generate: genThenEmpty([
          cand({ id: "b-1", patch: PATCH_B }),
          cand({ id: "a-1", patch: PATCH_A }),
        ]),
        applyClean: async () => true,
        regression: async () => true,
        mweProof: async () => ({ state: "candidate_red" }),
      },
    })
    expect(r.winner).toBeNull()
    expect(r.fallbackCandidate?.id).toBe("a-1")
    expect(r.fallbackCandidate?.patch).toBe(PATCH_A)
  })
})
