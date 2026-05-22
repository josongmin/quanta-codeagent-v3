/**
 * Speculative branch search (ADR-0084) — unit coverage for the pure + ported
 * pieces. The orchestrator + propose run against FAKE isolator/runCandidate/
 * verifier so the suite is hermetic + deterministic (the real non-determinism
 * is the live agent fan-out, exercised only by an opt-in live smoke).
 */
import { describe, expect, test } from "bun:test"
import type {
  BranchCandidate,
  BranchTraceEvent,
  Isolator,
  Verifier,
  VerifierSignal,
} from "@/agent/branch-search"
import {
  argmaxSelector,
  buildSeeds,
  combineVerifiers,
  DEFAULT_WEIGHTS,
  defaultScorer,
  makeScorer,
  parallelPropose,
  type RunCandidate,
  runBranchSearch,
} from "@/agent/branch-search"
import type { LLMPort } from "@/llm"

const sig = (
  over: Partial<VerifierSignal> & Pick<VerifierSignal, "kind" | "pass">,
): VerifierSignal => ({
  detail: "",
  durationMs: 1,
  ...over,
})

const fakeLlm: LLMPort = { model: "fake", async *stream() {} }

// ---------------------------------------------------------------------------
// score.ts
// ---------------------------------------------------------------------------
describe("defaultScorer", () => {
  test("empty signals ⇒ 0", () => {
    expect(defaultScorer([]).total).toBe(0)
  })
  test("all-pass tsc+lint normalizes to 1", () => {
    const s = defaultScorer([sig({ kind: "tsc", pass: true }), sig({ kind: "lint", pass: true })])
    expect(s.total).toBeCloseTo(1, 5)
  })
  test("tsc fail, lint pass ⇒ partial by weight mass", () => {
    // weights tsc=0.4 lint=0.1 ⇒ reward = (0*0.4 + 1*0.1)/0.5 = 0.2
    const s = defaultScorer([sig({ kind: "tsc", pass: false }), sig({ kind: "lint", pass: true })])
    expect(s.total).toBeCloseTo(0.2, 5)
  })
  test("lint magnitude refines the binary pass", () => {
    const s = defaultScorer([sig({ kind: "lint", pass: false, magnitude: 0.8 })])
    expect(s.total).toBeCloseTo(0.8, 5)
  })
  test("patch_size penalty subtracts", () => {
    const s = defaultScorer([
      sig({ kind: "tsc", pass: true }),
      sig({ kind: "patch_size", pass: true, magnitude: 1 }),
    ])
    // reward = 1 (tsc), penalty = 0.1*1 ⇒ 0.9
    expect(s.total).toBeCloseTo(0.9, 5)
  })
  test("makeScorer override changes weighting", () => {
    const scorer = makeScorer({ tsc: 1, lint: 0 })
    const s = scorer([sig({ kind: "tsc", pass: false }), sig({ kind: "lint", pass: true })])
    expect(s.total).toBe(0) // lint weight 0 ⇒ only tsc counts, tsc failed
  })
  test("DEFAULT_WEIGHTS is frozen", () => {
    expect(Object.isFrozen(DEFAULT_WEIGHTS)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// select.ts
// ---------------------------------------------------------------------------
describe("argmaxSelector", () => {
  const cand = (id: string): BranchCandidate => ({
    id,
    seed: {},
    workspace: `/w/${id}`,
    outcome: { kind: "completed", turns: 1 },
  })
  test("picks highest total", () => {
    const w = argmaxSelector([
      { cand: cand("a"), score: { total: 0.3, breakdown: [] } },
      { cand: cand("b"), score: { total: 0.9, breakdown: [] } },
    ])
    expect(w.id).toBe("b")
  })
  test("tie-break: faster (less verifier-ms) wins", () => {
    const w = argmaxSelector([
      {
        cand: cand("a"),
        score: { total: 0.5, breakdown: [sig({ kind: "tsc", pass: true, durationMs: 99 })] },
      },
      {
        cand: cand("b"),
        score: { total: 0.5, breakdown: [sig({ kind: "tsc", pass: true, durationMs: 10 })] },
      },
    ])
    expect(w.id).toBe("b")
  })
  test("tie-break: equal speed ⇒ lexicographic id (stable)", () => {
    const w = argmaxSelector([
      { cand: cand("z"), score: { total: 0.5, breakdown: [] } },
      { cand: cand("a"), score: { total: 0.5, breakdown: [] } },
    ])
    expect(w.id).toBe("a")
  })
  test("throws on empty", () => {
    expect(() => argmaxSelector([])).toThrow()
  })
})

// ---------------------------------------------------------------------------
// seed.ts
// ---------------------------------------------------------------------------
describe("buildSeeds", () => {
  test("spreads temperatures across [0.2,1.0]", () => {
    const seeds = buildSeeds(3)
    expect(seeds.map((s) => s.temperature)).toEqual([0.2, 0.6, 1.0])
  })
  test("first candidate gets no prompt hint (faithful baseline)", () => {
    expect(buildSeeds(3)[0]?.promptHint).toBeUndefined()
  })
  test("round-robins model candidates", () => {
    const models = [
      { id: "m1", port: fakeLlm },
      { id: "m2", port: fakeLlm },
    ]
    const seeds = buildSeeds(3, models)
    expect(seeds.map((s) => s.modelOverride?.id)).toEqual(["m1", "m2", "m1"])
  })
  test("N=1 ⇒ single low-temp seed", () => {
    expect(buildSeeds(1).map((s) => s.temperature)).toEqual([0.2])
  })
})

// ---------------------------------------------------------------------------
// verify.ts (combineVerifiers — crash isolation)
// ---------------------------------------------------------------------------
describe("combineVerifiers", () => {
  const cand: BranchCandidate = {
    id: "c",
    seed: {},
    workspace: "/w",
    outcome: { kind: "completed", turns: 1 },
  }
  test("concatenates signals in parallel", async () => {
    const a: Verifier = async () => [sig({ kind: "tsc", pass: true })]
    const b: Verifier = async () => [sig({ kind: "lint", pass: false })]
    const out = await combineVerifiers(a, b)(cand)
    expect(out.map((s) => s.kind).sort()).toEqual(["lint", "tsc"])
  })
  test("a crashed verifier becomes a failed signal, not a thrown pipeline", async () => {
    const good: Verifier = async () => [sig({ kind: "tsc", pass: true })]
    const bad: Verifier = async () => {
      throw new Error("verifier boom")
    }
    const out = await combineVerifiers(good, bad)(cand)
    expect(out.some((s) => s.pass === false && s.detail.includes("crashed"))).toBe(true)
    expect(out.some((s) => s.kind === "tsc" && s.pass)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// propose.ts + search.ts (fake isolator + runCandidate + verifier)
// ---------------------------------------------------------------------------
const fakeIsolator = (log: string[]): Isolator => ({
  async acquire(i) {
    return {
      workspace: `/ws/cand-${i}`,
      cleanup: async () => {
        log.push(`cleanup-${i}`)
      },
    }
  },
})

describe("parallelPropose", () => {
  test("spawns N candidates, completed outcomes", async () => {
    const log: string[] = []
    const runCandidate: RunCandidate = async ({ id }) => ({
      kind: "completed",
      turns: id === "cand-1" ? 2 : 1,
    })
    const r = await parallelPropose({
      N: 3,
      seeds: buildSeeds(3),
      baseLlm: fakeLlm,
      task: "t",
      timeoutPerBranchMs: 1000,
      isolator: fakeIsolator(log),
      runCandidate,
    })
    expect(r.candidates).toHaveLength(3)
    expect(r.candidates.every((c) => c.outcome.kind === "completed")).toBe(true)
    expect(r.cleanups).toHaveLength(3)
  })
  test("a thrown candidate becomes failed, others survive", async () => {
    const runCandidate: RunCandidate = async ({ id }) => {
      if (id === "cand-1") throw new Error("kaboom")
      return { kind: "completed", turns: 1 }
    }
    const r = await parallelPropose({
      N: 3,
      seeds: buildSeeds(3),
      baseLlm: fakeLlm,
      task: "t",
      timeoutPerBranchMs: 1000,
      isolator: fakeIsolator([]),
      runCandidate,
    })
    const failed = r.candidates.filter((c) => c.outcome.kind === "failed")
    expect(failed).toHaveLength(1)
    expect(failed[0]?.id).toBe("cand-1")
  })
  test("timeout fails the slow candidate only", async () => {
    const runCandidate: RunCandidate = ({ id }) =>
      id === "cand-0"
        ? new Promise(() => {}) // never resolves → timeout
        : Promise.resolve({ kind: "completed", turns: 1 })
    const r = await parallelPropose({
      N: 2,
      seeds: buildSeeds(2),
      baseLlm: fakeLlm,
      task: "t",
      timeoutPerBranchMs: 20,
      isolator: fakeIsolator([]),
      runCandidate,
    })
    expect(r.candidates[0]?.outcome.kind).toBe("failed")
    expect(r.candidates[1]?.outcome.kind).toBe("completed")
  })
})

describe("runBranchSearch", () => {
  const verifierByWorkspace =
    (passSet: ReadonlySet<string>): Verifier =>
    async (cand) => [sig({ kind: "tsc", pass: passSet.has(cand.id) })]

  test("selects the candidate whose verifier passes; cleans up all", async () => {
    const log: string[] = []
    const traces: BranchTraceEvent[] = []
    const r = await runBranchSearch({
      N: 3,
      seeds: buildSeeds(3),
      baseLlm: fakeLlm,
      task: "fix it",
      timeoutPerBranchMs: 1000,
      verifier: verifierByWorkspace(new Set(["cand-2"])),
      scorer: defaultScorer,
      selector: argmaxSelector,
      isolator: fakeIsolator(log),
      runCandidate: async () => ({ kind: "completed", turns: 1 }),
      onTrace: (e) => traces.push(e),
    })
    expect(r.winner.id).toBe("cand-2")
    expect(r.winnerScore.total).toBeCloseTo(1, 5)
    expect(log.sort()).toEqual(["cleanup-0", "cleanup-1", "cleanup-2"])
    expect(traces.some((t) => t.kind === "winner-selected" && t.winnerId === "cand-2")).toBe(true)
  })

  test("failed candidate scores 0 (verifier not even run)", async () => {
    let verifierCalls = 0
    const r = await runBranchSearch({
      N: 2,
      seeds: buildSeeds(2),
      baseLlm: fakeLlm,
      task: "t",
      timeoutPerBranchMs: 1000,
      verifier: async () => {
        verifierCalls++
        return [sig({ kind: "tsc", pass: true })]
      },
      scorer: defaultScorer,
      selector: argmaxSelector,
      isolator: fakeIsolator([]),
      runCandidate: async ({ id }) =>
        id === "cand-0" ? Promise.reject(new Error("dead")) : { kind: "completed", turns: 1 },
    })
    // Only the surviving candidate's verifier ran.
    expect(verifierCalls).toBe(1)
    expect(r.winner.id).toBe("cand-1")
  })

  test("N<2 and N>8 throw", async () => {
    const base = {
      seeds: buildSeeds(2),
      baseLlm: fakeLlm,
      task: "t",
      timeoutPerBranchMs: 100,
      verifier: verifierByWorkspace(new Set()),
      scorer: defaultScorer,
      selector: argmaxSelector,
      isolator: fakeIsolator([]),
      runCandidate: async () => ({ kind: "completed" as const, turns: 1 }),
    }
    await expect(runBranchSearch({ ...base, N: 1 })).rejects.toThrow()
    await expect(runBranchSearch({ ...base, N: 9 })).rejects.toThrow()
  })

  test("cleanups run even when the verifier throws for all", async () => {
    const log: string[] = []
    await runBranchSearch({
      N: 2,
      seeds: buildSeeds(2),
      baseLlm: fakeLlm,
      task: "t",
      timeoutPerBranchMs: 1000,
      // verifier returns a crash-signal (combineVerifiers-style) rather than
      // throwing past the orchestrator; selector still picks the least-bad.
      verifier: async () => [sig({ kind: "tsc", pass: false })],
      scorer: defaultScorer,
      selector: argmaxSelector,
      isolator: fakeIsolator(log),
      runCandidate: async () => ({ kind: "completed", turns: 1 }),
    })
    expect(log.sort()).toEqual(["cleanup-0", "cleanup-1"])
  })
})
