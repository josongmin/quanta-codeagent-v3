/**
 * Adversarial multi-voter verification (ADR-0433) — hellgate. Adversarial
 * coverage of the refute-biased quorum aggregate with `ScriptedLLM` voters,
 * plus the byte-identical-when-absent invariant against the ADR-0084
 * branch-search scorer.
 *
 * Battery:
 *  - N voters all-pass ⇒ verdict pass
 *  - majority pass with 1 dissent ⇒ pass (dissent doesn't flip)
 *  - tie (1-of-2) ⇒ fail-closed (refute bias)
 *  - voter throws ⇒ counted as refute, loop survives
 *  - unparseable output ⇒ counted as refute (fail-closed)
 *  - explicit quorum threshold respected (>= q)
 *  - clamp + parse robustness
 *  - absent config ⇒ branch-search score byte-identical (no voter signal)
 */
import { describe, expect, test } from "bun:test"
import { DEFAULT_WEIGHTS, defaultScorer, type VerifierSignal } from "@/agent/branch-search"
import {
  generateVerifierSkill,
  parseVerdict,
  quorumPasses,
  runMultiVoter,
  type Verdict,
  type Voter,
  voterQuorumSignal,
} from "@/agent/multi-voter"
import type { LLMPort, StreamEvent } from "@/llm"

// ---------------------------------------------------------------------------
// ScriptedLLM test double — emits a fixed verdict JSON as one text_delta turn,
// or throws if constructed with a boom.
// ---------------------------------------------------------------------------

const scriptedLlm = (verdict: Verdict | string): LLMPort => ({
  model: "scripted",
  async *stream(): AsyncIterable<StreamEvent> {
    const text = typeof verdict === "string" ? verdict : JSON.stringify(verdict)
    yield { type: "text_delta", delta: text }
    yield { type: "message_stop", stop_reason: "end_turn" }
  },
})

const throwingLlm = (msg: string): LLMPort => ({
  model: "boom",
  stream(): AsyncIterable<StreamEvent> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(new Error(msg)),
      }),
    }
  },
})

const pass = (confidence = 0.9, reason = "ok"): Verdict => ({ pass: true, confidence, reason })
const fail = (confidence = 0.9, reason = "refuted"): Verdict => ({
  pass: false,
  confidence,
  reason,
})

const voter = (id: string, port: LLMPort, lens?: string): Voter =>
  lens === undefined ? { id, port } : { id, port, lens }

const claim = "the fix resolves the off-by-one in pagination"

// monotonic clock so durationMs is deterministic
const fakeClock = (): (() => number) => {
  let t = 0
  return () => (t += 5)
}

describe("ADR-0433 multi-voter — quorum aggregation", () => {
  test("N voters all-pass ⇒ verdict pass", async () => {
    const out = await runMultiVoter({
      claim,
      now: fakeClock(),
      voters: [
        voter("v1", scriptedLlm(pass())),
        voter("v2", scriptedLlm(pass())),
        voter("v3", scriptedLlm(pass())),
      ],
    })
    expect(out.verdict).toBe(true)
    expect(out.passVotes).toBe(3)
    expect(out.totalVotes).toBe(3)
    expect(out.quorumMet).toBe(true)
    expect(out.votes.every((v) => v.source === "parsed")).toBe(true)
  })

  test("majority pass with 1 dissent ⇒ pass (dissent doesn't flip)", async () => {
    const out = await runMultiVoter({
      claim,
      now: fakeClock(),
      voters: [
        voter("v1", scriptedLlm(pass())),
        voter("v2", scriptedLlm(pass())),
        voter("v3", scriptedLlm(fail())),
      ],
    })
    expect(out.verdict).toBe(true)
    expect(out.passVotes).toBe(2)
    expect(out.totalVotes).toBe(3)
  })

  test("tie (1-of-2) ⇒ fail-closed (refute bias)", async () => {
    const out = await runMultiVoter({
      claim,
      now: fakeClock(),
      voters: [voter("v1", scriptedLlm(pass())), voter("v2", scriptedLlm(fail()))],
    })
    expect(out.passVotes).toBe(1)
    expect(out.totalVotes).toBe(2)
    expect(out.verdict).toBe(false)
    expect(out.quorumMet).toBe(false)
  })

  test("exactly-half on 4 voters ⇒ fail-closed under strict-majority default", async () => {
    const out = await runMultiVoter({
      claim,
      now: fakeClock(),
      voters: [
        voter("v1", scriptedLlm(pass())),
        voter("v2", scriptedLlm(pass())),
        voter("v3", scriptedLlm(fail())),
        voter("v4", scriptedLlm(fail())),
      ],
    })
    expect(out.passVotes).toBe(2)
    expect(out.verdict).toBe(false)
  })

  test("voter throws ⇒ counted as refute; loop survives", async () => {
    const out = await runMultiVoter({
      claim,
      now: fakeClock(),
      voters: [
        voter("v1", scriptedLlm(pass())),
        voter("v2", throwingLlm("provider exploded")),
        voter("v3", scriptedLlm(pass())),
      ],
    })
    // 2 pass / 3 ⇒ strict majority holds
    expect(out.verdict).toBe(true)
    expect(out.passVotes).toBe(2)
    const threw = out.votes.find((v) => v.voterId === "v2")
    expect(threw?.source).toBe("threw")
    expect(threw?.verdict.pass).toBe(false)
    expect(threw?.verdict.reason).toContain("provider exploded")
  })

  test("one throw flips a would-be tie to fail-closed", async () => {
    const out = await runMultiVoter({
      claim,
      now: fakeClock(),
      voters: [voter("v1", scriptedLlm(pass())), voter("v2", throwingLlm("boom"))],
    })
    expect(out.passVotes).toBe(1)
    expect(out.verdict).toBe(false)
  })

  test("unparseable output ⇒ counted as refute (fail-closed)", async () => {
    const out = await runMultiVoter({
      claim,
      now: fakeClock(),
      voters: [
        voter("v1", scriptedLlm("I think it is probably fine, no JSON here")),
        voter("v2", scriptedLlm(pass())),
        voter("v3", scriptedLlm(pass())),
      ],
    })
    expect(out.passVotes).toBe(2)
    expect(out.verdict).toBe(true)
    const garbage = out.votes.find((v) => v.voterId === "v1")
    expect(garbage?.source).toBe("unparseable")
    expect(garbage?.verdict.pass).toBe(false)
  })

  test("zero voters ⇒ fail-closed", async () => {
    const out = await runMultiVoter({ claim, voters: [], now: fakeClock() })
    expect(out.totalVotes).toBe(0)
    expect(out.verdict).toBe(false)
    expect(out.quorumMet).toBe(false)
  })

  test("explicit quorum threshold respected (>= q)", async () => {
    // 2 of 3 pass = 0.667; quorum 0.7 ⇒ fail, quorum 0.6 ⇒ pass.
    const voters = (): Voter[] => [
      voter("v1", scriptedLlm(pass())),
      voter("v2", scriptedLlm(pass())),
      voter("v3", scriptedLlm(fail())),
    ]
    const strict = await runMultiVoter({ claim, voters: voters(), quorum: 0.7, now: fakeClock() })
    expect(strict.verdict).toBe(false)
    const loose = await runMultiVoter({ claim, voters: voters(), quorum: 0.6, now: fakeClock() })
    expect(loose.verdict).toBe(true)
  })

  test("quorum exactly at fraction boundary passes (>=)", async () => {
    // 1 of 2 = 0.5; explicit quorum 0.5 uses >= so it PASSES (distinct from
    // the strict-majority DEFAULT which fails the same split).
    const out = await runMultiVoter({
      claim,
      quorum: 0.5,
      now: fakeClock(),
      voters: [voter("v1", scriptedLlm(pass())), voter("v2", scriptedLlm(fail()))],
    })
    expect(out.verdict).toBe(true)
  })

  test("diverse-lens hint is accepted and run", async () => {
    const out = await runMultiVoter({
      claim,
      now: fakeClock(),
      voters: [
        voter("sec", scriptedLlm(pass()), "security"),
        voter("perf", scriptedLlm(pass()), "performance"),
      ],
    })
    expect(out.verdict).toBe(true)
    expect(out.votes.map((v) => v.voterId)).toEqual(["sec", "perf"])
  })
})

describe("ADR-0433 multi-voter — parse + quorum unit", () => {
  test("parseVerdict clamps confidence to [0,1]", () => {
    expect(parseVerdict('{"pass":true,"confidence":5,"reason":"x"}')).toEqual({
      pass: true,
      confidence: 1,
      reason: "x",
    })
    expect(parseVerdict('{"pass":false,"confidence":-3,"reason":"y"}')).toEqual({
      pass: false,
      confidence: 0,
      reason: "y",
    })
  })

  test("parseVerdict extracts JSON embedded in prose", () => {
    const v = parseVerdict(
      'Here is my verdict: {"pass": false, "confidence": 0.2, "reason": "leak"} done',
    )
    expect(v?.pass).toBe(false)
    expect(v?.reason).toBe("leak")
  })

  test("parseVerdict returns undefined on missing pass / non-bool / garbage", () => {
    expect(parseVerdict("no json")).toBeUndefined()
    expect(parseVerdict('{"confidence":0.9}')).toBeUndefined()
    expect(parseVerdict('{"pass":"yes"}')).toBeUndefined()
    expect(parseVerdict("{not valid json}")).toBeUndefined()
  })

  test("quorumPasses default is strict majority; explicit is >=", () => {
    expect(quorumPasses(2, 3, 0.5)).toBe(true) // strict majority
    expect(quorumPasses(1, 2, 0.5)).toBe(false) // tie fails-closed (default path)
    expect(quorumPasses(1, 2, 0.5 + 1e-9)).toBe(false) // explicit >0.5
    expect(quorumPasses(2, 3, 0.6)).toBe(true) // 0.667 >= 0.6
    expect(quorumPasses(2, 3, 0.7)).toBe(false)
    expect(quorumPasses(0, 0, 0.5)).toBe(false) // zero voters
  })
})

// ---------------------------------------------------------------------------
// Default-OFF / byte-identical invariant against the ADR-0084 scorer.
// ---------------------------------------------------------------------------

const sig = (
  over: Partial<VerifierSignal> & Pick<VerifierSignal, "kind" | "pass">,
): VerifierSignal => ({
  detail: "",
  durationMs: 1,
  ...over,
})

describe("ADR-0433 branch-search composition — default-OFF byte-identical", () => {
  test("absent voter signal ⇒ branch-search score byte-identical to pre-ADR-0433 inputs", () => {
    // A signal set with NO llm_voter_quorum entry must score identically
    // whether or not the multi-voter slice exists — the scorer never reads the
    // new weight because no signal of that kind is present.
    const signals = [
      sig({ kind: "tsc", pass: true }),
      sig({ kind: "test", pass: true }),
      sig({ kind: "lint", pass: false, magnitude: 0.5 }),
    ]
    // Hand-computed expectation (independent of DEFAULT_WEIGHTS object identity):
    const w = DEFAULT_WEIGHTS
    const num = w.tsc * 1 + w.test * 1 + w.lint * 0.5
    const den = w.tsc + w.test + w.lint
    const expected = num / den
    const score = defaultScorer(signals)
    expect(score.total).toBeCloseTo(expected, 12)
    // And the breakdown is the signals verbatim (no injected voter signal).
    expect(score.breakdown.some((s) => s.kind === "llm_voter_quorum")).toBe(false)
  })

  test("voterQuorumSignal composes additively when explicitly injected", () => {
    const base = [sig({ kind: "tsc", pass: true }), sig({ kind: "test", pass: true })]
    const baseTotal = defaultScorer(base).total
    expect(baseTotal).toBeCloseTo(1, 12)

    const voteSig = voterQuorumSignal(
      { verdict: false, votes: [], passVotes: 1, totalVotes: 4, quorumMet: false },
      7,
    )
    expect(voteSig.kind).toBe("llm_voter_quorum")
    expect(voteSig.pass).toBe(false)
    expect(voteSig.magnitude).toBeCloseTo(0.25, 12)
    expect(voteSig.durationMs).toBe(7)

    // Injecting the signal LOWERS the total (a failing low-fraction quorum
    // drags the reward down) — proving it is additive and orthogonal.
    const composed = defaultScorer([...base, voteSig]).total
    expect(composed).toBeLessThan(baseTotal)
  })

  test("voterQuorumSignal pass mirrors verdict; magnitude is pass-fraction", () => {
    const s = voterQuorumSignal({
      verdict: true,
      votes: [],
      passVotes: 9,
      totalVotes: 10,
      quorumMet: true,
    })
    expect(s.pass).toBe(true)
    expect(s.magnitude).toBeCloseTo(0.9, 12)
    expect(s.detail).toContain("9/10")
  })
})

describe("ADR-0433 verifier-skill-spec generator", () => {
  test("generates SKILL.md-shaped artefact per surface", () => {
    const md = generateVerifierSkill({
      name: "cli-login-flow",
      surface: "cli",
      intent: "Confirm a wrong password is rejected with a non-zero exit code.",
      votesPerBug: 5,
      target: "myapp login",
      lenses: ["security", "ux"],
    })
    expect(md).toContain("name: cli-login-flow")
    expect(md).toContain("surface: cli")
    expect(md).toContain("votes-per-bug: 5")
    expect(md).toContain("target: myapp login")
    expect(md).toContain("5 independent voter")
    expect(md).toContain("security, ux")
  })

  test("playwright + api surfaces render distinct how-to lines; missing target/lenses handled", () => {
    const pw = generateVerifierSkill({
      name: "pw-checkout",
      surface: "playwright",
      intent: "Cart total must equal the sum of line items after a coupon.",
      votesPerBug: 3,
    })
    expect(pw).toContain("Playwright")
    expect(pw).toContain("target: (unset)")
    expect(pw).toContain("(generic)")

    const api = generateVerifierSkill({
      name: "api-rate-limit",
      surface: "api",
      intent: "429 after the Nth request within the window.",
      votesPerBug: 4,
    })
    expect(api).toContain("API surface")
  })
})
