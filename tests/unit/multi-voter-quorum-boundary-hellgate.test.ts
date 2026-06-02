/**
 * Adversarial multi-voter (ADR-0433) — HARDER hellgate beyond the existing 20.
 *
 * Two batteries:
 *
 *  (A) Quorum EXACT boundary — for several N, the quorum is a CLEAN RULE (no
 *      tuned threshold). We pin the rule precisely and test n=quorum-1 (fail)
 *      vs n=quorum (pass):
 *        - strict-majority DEFAULT: pass IFF passVotes*2 > N. The boundary is
 *          `ceil((N+1)/2)` passes; one fewer fails.
 *        - explicit fraction quorum q: pass IFF passVotes/N >= q. We pick q so
 *          the boundary lands on an integer and test ±1 vote around it.
 *      Plus: ALL voters throw ⇒ all counted refute ⇒ fail-closed; byzantine
 *      exact-half split ⇒ deterministic fail by the strict-majority rule;
 *      1 dissent among many ⇒ doesn't flip; unparseable ⇒ refute (no crash);
 *      voter prompts are refute-biased (assert prompt content).
 *
 *  (B) e2e — a `runBranchSearch` run with the voter verifier wired and
 *      DETERMINISTIC ScriptedLLM voters changes the hand-computed winner vs the
 *      same run WITHOUT the voter signal; and absent the signal the score is
 *      byte-identical (weight mass unchanged).
 */
import { describe, expect, test } from "bun:test"
import {
  argmaxSelector,
  buildSeeds,
  DEFAULT_WEIGHTS,
  defaultScorer,
  type Isolator,
  type RunCandidate,
  runBranchSearch,
  type Verifier,
  type VerifierSignal,
} from "@/agent/branch-search"
import {
  buildRefutePrompt,
  runMultiVoter,
  type Verdict,
  type Voter,
  voterQuorumVerifier,
} from "@/agent/multi-voter"
import type { LLMPort, StreamEvent } from "@/llm"

// ---------------------------------------------------------------------------
// Deterministic ScriptedLLM test doubles.
// ---------------------------------------------------------------------------

/** Emits a fixed verdict JSON (or raw string) as one text turn. */
const scriptedLlm = (verdict: Verdict | string): LLMPort => ({
  model: "scripted",
  async *stream(): AsyncIterable<StreamEvent> {
    const text = typeof verdict === "string" ? verdict : JSON.stringify(verdict)
    yield { type: "text_delta", delta: text }
    yield { type: "message_stop", stop_reason: "end_turn" }
  },
})

/** Always rejects — exercises the "voter threw ⇒ refute" path. */
const throwingLlm = (msg: string): LLMPort => ({
  model: "boom",
  stream: (): AsyncIterable<StreamEvent> => ({
    [Symbol.asyncIterator]: () => ({ next: () => Promise.reject(new Error(msg)) }),
  }),
})

/** A claim-aware LLM: reads the user prompt text and returns pass IFF the
 *  prompt contains one of `passIfClaimIncludes`. Deterministic — used to make
 *  per-candidate voters vote differently in the e2e (the claim embeds the
 *  candidate id). */
const claimAwareLlm = (passIfClaimIncludes: readonly string[]): LLMPort => ({
  model: "claim-aware",
  async *stream(req): AsyncIterable<StreamEvent> {
    const text = req.messages
      .flatMap((m) => (Array.isArray(m.content) ? m.content : []))
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
    const pass = passIfClaimIncludes.some((needle) => text.includes(needle))
    yield {
      type: "text_delta",
      delta: JSON.stringify({ pass, confidence: 0.9, reason: pass ? "ok" : "refuted" }),
    }
    yield { type: "message_stop", stop_reason: "end_turn" }
  },
})

const pass = (): Verdict => ({ pass: true, confidence: 0.9, reason: "ok" })
const fail = (): Verdict => ({ pass: false, confidence: 0.9, reason: "no" })
const voter = (id: string, port: LLMPort): Voter => ({ id, port })
const fakeClock = (): (() => number) => {
  let t = 0
  return () => (t += 5)
}
const claim = "the fix is correct"

/** Build N voters: the first `nPass` pass, the rest fail. Deterministic. */
const voters = (nPass: number, nFail: number): Voter[] => [
  ...Array.from({ length: nPass }, (_u, i) => voter(`p${i}`, scriptedLlm(pass()))),
  ...Array.from({ length: nFail }, (_u, i) => voter(`f${i}`, scriptedLlm(fail()))),
]

// ===========================================================================
// (A) Quorum EXACT boundary — strict-majority DEFAULT rule
// ===========================================================================

describe("ADR-0433 quorum boundary — strict-majority default (passVotes*2 > N)", () => {
  // For each N, the minimum passes to win is floor(N/2)+1. We test exactly one
  // below (fail) and exactly at (pass).
  const cases: ReadonlyArray<{ N: number; quorumPasses: number }> = [
    { N: 2, quorumPasses: 2 }, // need >1 ⇒ 2
    { N: 3, quorumPasses: 2 }, // need >1.5 ⇒ 2
    { N: 4, quorumPasses: 3 }, // need >2 ⇒ 3
    { N: 5, quorumPasses: 3 }, // need >2.5 ⇒ 3
    { N: 6, quorumPasses: 4 }, // need >3 ⇒ 4
    { N: 7, quorumPasses: 4 }, // need >3.5 ⇒ 4
  ]
  for (const { N, quorumPasses } of cases) {
    test(`N=${N}: n=quorum-1 (${quorumPasses - 1}) fails, n=quorum (${quorumPasses}) passes`, async () => {
      const below = await runMultiVoter({
        claim,
        now: fakeClock(),
        voters: voters(quorumPasses - 1, N - (quorumPasses - 1)),
      })
      expect(below.passVotes).toBe(quorumPasses - 1)
      expect(below.totalVotes).toBe(N)
      expect(below.verdict).toBe(false)

      const at = await runMultiVoter({
        claim,
        now: fakeClock(),
        voters: voters(quorumPasses, N - quorumPasses),
      })
      expect(at.passVotes).toBe(quorumPasses)
      expect(at.verdict).toBe(true)
    })
  }
})

describe("ADR-0433 quorum boundary — explicit fraction (passVotes/N >= q)", () => {
  // Boundary chosen so it lands on an INTEGER vote count: N=10, q=0.7 ⇒ need
  // 7 passes exactly (7/10=0.7 >= 0.7). 6 fails, 7 passes.
  test("N=10 q=0.7: 6 passes fails, 7 passes passes (>= boundary inclusive)", async () => {
    const six = await runMultiVoter({ claim, quorum: 0.7, now: fakeClock(), voters: voters(6, 4) })
    expect(six.passVotes).toBe(6)
    expect(six.verdict).toBe(false)
    const seven = await runMultiVoter({
      claim,
      quorum: 0.7,
      now: fakeClock(),
      voters: voters(7, 3),
    })
    expect(seven.passVotes).toBe(7)
    expect(seven.verdict).toBe(true)
  })

  // N=4, q=0.5 (explicit) ⇒ 2/4=0.5 >= 0.5 PASSES — distinct from the
  // strict-majority default which fails the exact-half split.
  test("N=4 q=0.5 explicit: exact-half PASSES (>=), unlike strict-majority default", async () => {
    const explicit = await runMultiVoter({
      claim,
      quorum: 0.5,
      now: fakeClock(),
      voters: voters(2, 2),
    })
    expect(explicit.verdict).toBe(true)
    const dflt = await runMultiVoter({ claim, now: fakeClock(), voters: voters(2, 2) })
    expect(dflt.verdict).toBe(false)
  })
})

describe("ADR-0433 quorum — fail-closed adversarial paths", () => {
  test("ALL voters throw ⇒ all counted refute ⇒ fail-closed", async () => {
    const out = await runMultiVoter({
      claim,
      now: fakeClock(),
      voters: [
        voter("a", throwingLlm("x")),
        voter("b", throwingLlm("y")),
        voter("c", throwingLlm("z")),
      ],
    })
    expect(out.passVotes).toBe(0)
    expect(out.verdict).toBe(false)
    expect(out.votes.every((v) => v.source === "threw")).toBe(true)
    expect(out.votes.every((v) => v.verdict.pass === false)).toBe(true)
  })

  test("byzantine exact-half split (3/6) ⇒ deterministic FAIL by strict-majority rule", async () => {
    const out = await runMultiVoter({ claim, now: fakeClock(), voters: voters(3, 3) })
    expect(out.passVotes).toBe(3)
    expect(out.totalVotes).toBe(6)
    expect(out.verdict).toBe(false)
  })

  test("1 dissent among many (6 of 7) ⇒ does NOT flip the pass", async () => {
    const out = await runMultiVoter({ claim, now: fakeClock(), voters: voters(6, 1) })
    expect(out.passVotes).toBe(6)
    expect(out.verdict).toBe(true)
  })

  test("unparseable verdict ⇒ refute (no crash); survivors still decide", async () => {
    const out = await runMultiVoter({
      claim,
      now: fakeClock(),
      voters: [
        voter("garbage", scriptedLlm("definitely no JSON here, just prose")),
        voter("p0", scriptedLlm(pass())),
        voter("p1", scriptedLlm(pass())),
      ],
    })
    const g = out.votes.find((v) => v.voterId === "garbage")
    expect(g?.source).toBe("unparseable")
    expect(g?.verdict.pass).toBe(false)
    expect(out.passVotes).toBe(2)
    expect(out.verdict).toBe(true)
  })
})

describe("ADR-0433 voter prompt is refute-biased", () => {
  test("buildRefutePrompt instructs REFUTE + default-to-FAIL + JSON-only", () => {
    const p = buildRefutePrompt("the cache eviction is correct")
    expect(p).toContain("REFUTE")
    expect(p.toLowerCase()).toContain("default to failure")
    expect(p).toContain("the cache eviction is correct")
    expect(p).toContain('{"pass"')
  })

  test("lens is folded into the refuter prompt when present", () => {
    const p = buildRefutePrompt("claim", "security")
    expect(p).toContain("skeptical security reviewer")
  })
})

// ===========================================================================
// (B) e2e — voter signal DETERMINISTICALLY changes branch-search selection
// ===========================================================================

const fakeIsolator = (): Isolator => ({
  async acquire(i) {
    return { workspace: `/ws/cand-${i}`, cleanup: async () => {} }
  },
})
const fakeLlm: LLMPort = scriptedLlm(pass())
const allComplete: RunCandidate = async () => ({ kind: "completed", turns: 1 })

const sig = (
  over: Pick<VerifierSignal, "kind" | "pass"> & Partial<VerifierSignal>,
): VerifierSignal => ({ detail: "", durationMs: 1, ...over })

describe("ADR-0433 e2e — voter signal flips the branch-search winner", () => {
  // Base verifier: BOTH candidates pass tsc with equal magnitude, so WITHOUT
  // the voter signal they tie and argmax's lexicographic tie-break picks
  // cand-0. WITH the voter signal, only cand-1's voters pass (claim embeds the
  // candidate id), so cand-1 outscores cand-0 and wins. Hand-computed.
  const baseTsc: Verifier = async () => [sig({ kind: "tsc", pass: true })]

  test("WITHOUT voter signal: tie ⇒ argmax lexicographic winner cand-0", async () => {
    const r = await runBranchSearch({
      N: 2,
      seeds: buildSeeds(2),
      baseLlm: fakeLlm,
      task: "fix the bug",
      timeoutPerBranchMs: 1000,
      verifier: baseTsc,
      scorer: defaultScorer,
      selector: argmaxSelector,
      isolator: fakeIsolator(),
      runCandidate: allComplete,
      now: fakeClock(),
    })
    expect(r.winner.id).toBe("cand-0")
    expect(r.winnerScore.total).toBeCloseTo(1, 12)
  })

  test("WITH voter signal (only cand-1's voters pass) ⇒ winner flips to cand-1", async () => {
    // The voter LLM passes ONLY when the claim mentions "Candidate cand-1".
    const voterVerifier = voterQuorumVerifier({
      llm: claimAwareLlm(["Candidate cand-1"]),
      task: "fix the bug",
      voters: 3,
      now: fakeClock(),
    })
    // Compose base tsc + voter signal per candidate (mirrors tool.ts wiring).
    const composed: Verifier = async (cand) => [
      ...(await baseTsc(cand)),
      ...(await voterVerifier(cand)),
    ]
    const r = await runBranchSearch({
      N: 2,
      seeds: buildSeeds(2),
      baseLlm: fakeLlm,
      task: "fix the bug",
      timeoutPerBranchMs: 1000,
      verifier: composed,
      scorer: defaultScorer,
      selector: argmaxSelector,
      isolator: fakeIsolator(),
      runCandidate: allComplete,
      now: fakeClock(),
    })
    expect(r.winner.id).toBe("cand-1")

    // Hand-computed scores. weights: tsc=0.4, llm_voter_quorum=0.3.
    // cand-1: voters all pass ⇒ quorum signal pass, magnitude 3/3=1.
    //   reward = (0.4*1 + 0.3*1) / (0.4+0.3) = 0.7/0.7 = 1.0
    // cand-0: voters all fail ⇒ quorum signal fail (pass:false), magnitude 0.
    //   reward = (0.4*1 + 0.3*0) / (0.4+0.3) = 0.4/0.7 ≈ 0.5714
    const w = DEFAULT_WEIGHTS
    const cand1Expected = (w.tsc * 1 + w.llm_voter_quorum * 1) / (w.tsc + w.llm_voter_quorum)
    const cand0Expected = (w.tsc * 1 + w.llm_voter_quorum * 0) / (w.tsc + w.llm_voter_quorum)
    const byId = new Map(r.allScored.map((s) => [s.cand.id, s.score.total]))
    expect(byId.get("cand-1")).toBeCloseTo(cand1Expected, 12)
    expect(byId.get("cand-0")).toBeCloseTo(cand0Expected, 12)
    expect(cand1Expected).toBeGreaterThan(cand0Expected)
  })

  test("knob absent ⇒ score byte-identical (no llm_voter_quorum in breakdown, weight mass unchanged)", async () => {
    const r = await runBranchSearch({
      N: 2,
      seeds: buildSeeds(2),
      baseLlm: fakeLlm,
      task: "fix the bug",
      timeoutPerBranchMs: 1000,
      verifier: baseTsc,
      scorer: defaultScorer,
      selector: argmaxSelector,
      isolator: fakeIsolator(),
      runCandidate: allComplete,
      now: fakeClock(),
    })
    // No candidate's breakdown carries the voter kind, so the scorer never
    // reads the llm_voter_quorum weight — the only weight mass is tsc.
    for (const s of r.allScored) {
      expect(s.score.breakdown.some((b) => b.kind === "llm_voter_quorum")).toBe(false)
      // tsc-only ⇒ reward = (0.4*1)/0.4 = 1, byte-identical to pre-ADR-0433.
      expect(s.score.total).toBeCloseTo(1, 12)
    }
  })
})

// ===========================================================================
// (C) voterQuorumVerifier unit — fail-closed + deterministic lens cycling
// ===========================================================================

describe("ADR-0433 voterQuorumVerifier — composition unit", () => {
  const cand = {
    id: "cand-0",
    seed: {},
    workspace: "/ws/cand-0",
    outcome: { kind: "completed", turns: 1 } as const,
  }

  test("emits exactly one llm_voter_quorum signal; pass mirrors quorum", async () => {
    const v = voterQuorumVerifier({
      llm: scriptedLlm(pass()),
      task: "t",
      voters: 3,
      now: fakeClock(),
    })
    const out = await v(cand)
    expect(out).toHaveLength(1)
    expect(out[0]?.kind).toBe("llm_voter_quorum")
    expect(out[0]?.pass).toBe(true)
    expect(out[0]?.magnitude).toBeCloseTo(1, 12)
  })

  test("all-fail voters ⇒ signal fails-closed, magnitude 0", async () => {
    const v = voterQuorumVerifier({
      llm: scriptedLlm(fail()),
      task: "t",
      voters: 4,
      now: fakeClock(),
    })
    const out = await v(cand)
    expect(out[0]?.pass).toBe(false)
    expect(out[0]?.magnitude).toBeCloseTo(0, 12)
  })

  test("explicit quorum forwarded verbatim (2/3 with q=0.7 fails)", async () => {
    const v = voterQuorumVerifier({
      llm: claimAwareLlm(["never-matches"]),
      task: "t",
      voters: 3,
      quorum: 0.7,
      now: fakeClock(),
    })
    // claim-aware never matches ⇒ all fail ⇒ fail-closed.
    const out = await v(cand)
    expect(out[0]?.pass).toBe(false)
  })
})
