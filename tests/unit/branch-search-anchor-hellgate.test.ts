/**
 * ★ CONTRACT — ADR-0116: Shadow ODB → branch-search anchor wiring.
 *
 * 18-case hellgate organized in three blocks:
 *  A. parseDiffMeasurement — pure-function counting invariants (HELL-A1..A5).
 *  B. shadowOdbAnchor      — default ShadowOdb-backed BranchSearchAnchor
 *                            no-throw / idempotency / null-on-failure
 *                            invariants (HELL-B1..B8).
 *  C. runBranchSearch wiring — anchor threading through the orchestrator,
 *                              including the byte-identical no-anchor path
 *                              (HELL-C1..C5).
 *
 * Everything is hermetic: A is pure, B uses a hand-rolled fake ShadowOdb,
 * C uses fake isolator/runCandidate/verifier (same shape as the existing
 * `branch-search.test.ts` orchestrator coverage). No real git, no tmpdir.
 */

import { describe, expect, test } from "bun:test"
import type {
  BranchCandidate,
  BranchSearchAnchor,
  BranchTraceEvent,
  DeltaMeasurement,
  Isolator,
  Verifier,
  VerifierSignal,
} from "@/agent/branch-search"
import {
  argmaxSelector,
  buildSeeds,
  defaultScorer,
  parseDiffMeasurement,
  runBranchSearch,
  shadowOdbAnchor,
} from "@/agent/branch-search"
import type { LLMPort } from "@/llm"
import type { ShadowOdb } from "@/storage"

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

const fakeLlm: LLMPort = { model: "fake", async *stream() {} }

const sig = (
  over: Partial<VerifierSignal> & Pick<VerifierSignal, "kind" | "pass">,
): VerifierSignal => ({ detail: "", durationMs: 1, ...over })

/** Minimal fake `ShadowOdb`. Each test wires only the methods it exercises;
 *  everything else throws `not-implemented` so an accidental call surfaces
 *  loudly rather than silently no-op'ing. */
const makeFakeOdb = (over: Partial<ShadowOdb>): ShadowOdb => {
  const ni = (name: string) => async (): Promise<never> => {
    throw new Error(`fake odb: ${name} not implemented`)
  }
  return {
    init: over.init ?? (ni("init") as ShadowOdb["init"]),
    registerHead: over.registerHead ?? (ni("registerHead") as ShadowOdb["registerHead"]),
    diffSinceLast: over.diffSinceLast ?? (ni("diffSinceLast") as ShadowOdb["diffSinceLast"]),
    diffWorkspaceSinceLast:
      over.diffWorkspaceSinceLast ??
      (ni("diffWorkspaceSinceLast") as ShadowOdb["diffWorkspaceSinceLast"]),
    rewindToLast: over.rewindToLast ?? (ni("rewindToLast") as ShadowOdb["rewindToLast"]),
    listSnapshots: over.listSnapshots ?? (ni("listSnapshots") as ShadowOdb["listSnapshots"]),
    rewindToRef: ni("rewindToRef") as ShadowOdb["rewindToRef"],
    restorePartialFromRef: ni("restorePartialFromRef") as ShadowOdb["restorePartialFromRef"],
    diffSinceRef: ni("diffSinceRef") as ShadowOdb["diffSinceRef"],
    cleanup: over.cleanup ?? (ni("cleanup") as ShadowOdb["cleanup"]),
    restorePartial: over.restorePartial ?? (ni("restorePartial") as ShadowOdb["restorePartial"]),
    markVerified: over.markVerified ?? (ni("markVerified") as ShadowOdb["markVerified"]),
    rewindToVerified:
      over.rewindToVerified ?? (ni("rewindToVerified") as ShadowOdb["rewindToVerified"]),
  }
}

const fakeIsolator = (log: string[] = []): Isolator => ({
  async acquire(i) {
    return {
      workspace: `/ws/cand-${i}`,
      cleanup: async () => {
        log.push(`cleanup-${i}`)
      },
    }
  },
})

/* ================================================================== */
/* A. parseDiffMeasurement                                             */
/* ================================================================== */

describe("parseDiffMeasurement (HELL-A1..A5)", () => {
  test("HELL-A1: empty string ⇒ all zeros", () => {
    expect(parseDiffMeasurement("")).toEqual({
      changedFiles: 0,
      addedLines: 0,
      removedLines: 0,
    })
  })

  test("HELL-A2: single file, 3 additions + 2 removals", () => {
    const diff = [
      "diff --git a/foo.ts b/foo.ts",
      "index 0001..0002 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,3 +1,4 @@",
      " keep",
      "-removed1",
      "-removed2",
      "+added1",
      "+added2",
      "+added3",
    ].join("\n")
    expect(parseDiffMeasurement(diff)).toEqual({
      changedFiles: 1,
      addedLines: 3,
      removedLines: 2,
    })
  })

  test("HELL-A3: three `diff --git` headers ⇒ changedFiles=3", () => {
    const diff = [
      "diff --git a/a b/a",
      "+a1",
      "diff --git a/b b/b",
      "+b1",
      "-b0",
      "diff --git a/c b/c",
      "+c1",
    ].join("\n")
    const m = parseDiffMeasurement(diff)
    expect(m.changedFiles).toBe(3)
    expect(m.addedLines).toBe(3) // +a1, +b1, +c1
    expect(m.removedLines).toBe(1) // -b0
  })

  test("HELL-A4: `+++` and `---` header lines are NOT counted as body lines", () => {
    // If header lines leaked into counts, addedLines would be 2 (+++ + +real)
    // and removedLines would be 2 (--- + -real). Correct counts are 1/1.
    const diff = [
      "diff --git a/foo b/foo",
      "--- a/foo",
      "+++ b/foo",
      "@@ -1 +1 @@",
      "-realRemoved",
      "+realAdded",
    ].join("\n")
    expect(parseDiffMeasurement(diff)).toEqual({
      changedFiles: 1,
      addedLines: 1,
      removedLines: 1,
    })
  })

  test("HELL-A5: blank-line additions/removals (`+` and `-` with nothing after) are counted", () => {
    const diff = [
      "diff --git a/foo b/foo",
      "--- a/foo",
      "+++ b/foo",
      "@@ -1,2 +1,2 @@",
      "-",
      "+",
    ].join("\n")
    expect(parseDiffMeasurement(diff)).toEqual({
      changedFiles: 1,
      addedLines: 1,
      removedLines: 1,
    })
  })
})

/* ================================================================== */
/* B. shadowOdbAnchor                                                  */
/* ================================================================== */

describe("shadowOdbAnchor (HELL-B1..B8)", () => {
  test("HELL-B1: registerStart happy ⇒ odb.registerHead called once with baseCwd, returns ok:true", async () => {
    const calls: string[] = []
    const odb = makeFakeOdb({
      registerHead: async (ws) => {
        calls.push(ws)
        return "abcdef0123456789012345678901234567890123"
      },
    })
    const anchor = shadowOdbAnchor(odb, "/parent/cwd")
    const r = await anchor.registerStart()
    expect(r).toEqual({ ok: true })
    expect(calls).toEqual(["/parent/cwd"])
  })

  test("HELL-B2: registerStart idempotent — two calls ⇒ odb.registerHead called ONCE", async () => {
    let count = 0
    const odb = makeFakeOdb({
      registerHead: async () => {
        count += 1
        return "deadbeef00000000000000000000000000000000"
      },
    })
    const anchor = shadowOdbAnchor(odb, "/cwd")
    const a = await anchor.registerStart()
    const b = await anchor.registerStart()
    expect(a).toEqual({ ok: true })
    expect(b).toEqual({ ok: true })
    expect(count).toBe(1)
  })

  test("HELL-B3: registerStart — odb.registerHead throws ⇒ ok:false reason, no throw escapes", async () => {
    const odb = makeFakeOdb({
      registerHead: async () => {
        throw new Error("git missing")
      },
    })
    const anchor = shadowOdbAnchor(odb, "/cwd")
    const r = await anchor.registerStart()
    expect(r.ok).toBe(false)
    if (r.ok === false) expect(r.reason).toContain("git missing")
  })

  test("HELL-B4: measureDelta happy ⇒ diffWorkspaceSinceLast(baseCwd, workspace), parsed counts", async () => {
    const diff = [
      "diff --git a/x b/x",
      "--- a/x",
      "+++ b/x",
      "@@ -1,2 +1,3 @@",
      " keep",
      "-old",
      "-old2",
      "+new1",
      "+new2",
      "+new3",
    ].join("\n")
    const diffCalls: Array<[string, string]> = []
    const odb = makeFakeOdb({
      registerHead: async () => "a".repeat(40),
      diffWorkspaceSinceLast: async (a, b) => {
        diffCalls.push([a, b])
        return diff
      },
    })
    const anchor = shadowOdbAnchor(odb, "/parent")
    await anchor.registerStart()
    const m = await anchor.measureDelta("/cand/ws-0")
    expect(m).toEqual({ changedFiles: 1, addedLines: 3, removedLines: 2 })
    expect(diffCalls).toEqual([["/parent", "/cand/ws-0"]])
  })

  test("HELL-B5: measureDelta BEFORE registerStart ⇒ null, NO odb.diffWorkspaceSinceLast call", async () => {
    let diffCalled = false
    const odb = makeFakeOdb({
      diffWorkspaceSinceLast: async () => {
        diffCalled = true
        return ""
      },
    })
    const anchor = shadowOdbAnchor(odb, "/parent")
    const m = await anchor.measureDelta("/cand/ws-0")
    expect(m).toBeNull()
    expect(diffCalled).toBe(false)
  })

  test("HELL-B6: measureDelta — odb.diffWorkspaceSinceLast throws ⇒ null, no throw escapes", async () => {
    const odb = makeFakeOdb({
      registerHead: async () => "a".repeat(40),
      diffWorkspaceSinceLast: async () => {
        throw new Error("disk gone")
      },
    })
    const anchor = shadowOdbAnchor(odb, "/parent")
    await anchor.registerStart()
    const m = await anchor.measureDelta("/cand/ws-0")
    expect(m).toBeNull()
  })

  test("HELL-B7: measureDelta empty diff ⇒ {0,0,0} (NOT null)", async () => {
    const odb = makeFakeOdb({
      registerHead: async () => "a".repeat(40),
      diffWorkspaceSinceLast: async () => "",
    })
    const anchor = shadowOdbAnchor(odb, "/parent")
    await anchor.registerStart()
    const m = await anchor.measureDelta("/cand/ws-0")
    expect(m).toEqual({ changedFiles: 0, addedLines: 0, removedLines: 0 })
  })

  test("HELL-B8: concurrent measureDelta calls resolve independently", async () => {
    const odb = makeFakeOdb({
      registerHead: async () => "a".repeat(40),
      diffWorkspaceSinceLast: async (_a, b) => `diff --git a/${b} b/${b}\n+x\n`,
    })
    const anchor = shadowOdbAnchor(odb, "/parent")
    await anchor.registerStart()
    const [m0, m1] = await Promise.all([
      anchor.measureDelta("/cand/ws-0"),
      anchor.measureDelta("/cand/ws-1"),
    ])
    expect(m0).toEqual({ changedFiles: 1, addedLines: 1, removedLines: 0 })
    expect(m1).toEqual({ changedFiles: 1, addedLines: 1, removedLines: 0 })
  })
})

/* ================================================================== */
/* C. runBranchSearch wiring                                           */
/* ================================================================== */

/** Build a "happy anchor" that returns the same delta for every candidate. */
const happyAnchor = (delta: DeltaMeasurement): BranchSearchAnchor => ({
  async registerStart() {
    return { ok: true }
  },
  async measureDelta() {
    return delta
  },
})

const passingVerifier: Verifier = async () => [sig({ kind: "tsc", pass: true })]

describe("runBranchSearch wiring (HELL-C1..C5)", () => {
  test("HELL-C1: anchor absent ⇒ byte-identical, no `delta` on any candidate", async () => {
    const r = await runBranchSearch({
      N: 2,
      seeds: buildSeeds(2),
      baseLlm: fakeLlm,
      task: "t",
      timeoutPerBranchMs: 1000,
      verifier: passingVerifier,
      scorer: defaultScorer,
      selector: argmaxSelector,
      isolator: fakeIsolator(),
      runCandidate: async () => ({ kind: "completed", turns: 1 }),
    })
    // exactOptionalPropertyTypes: when anchor is absent the orchestrator
    // must NEVER write `delta` onto the candidate. `"delta" in cand` is the
    // sharpest check — `cand.delta === undefined` would pass even on a
    // `{delta: undefined}` mis-spread (forbidden under exactOptional).
    for (const s of r.allScored) {
      expect("delta" in s.cand).toBe(false)
    }
  })

  test("HELL-C2: anchor present, registerStart ok, all candidates completed ⇒ delta attached + trace", async () => {
    const traces: BranchTraceEvent[] = []
    const delta: DeltaMeasurement = { changedFiles: 2, addedLines: 5, removedLines: 1 }
    const r = await runBranchSearch({
      N: 3,
      seeds: buildSeeds(3),
      baseLlm: fakeLlm,
      task: "t",
      timeoutPerBranchMs: 1000,
      verifier: passingVerifier,
      scorer: defaultScorer,
      selector: argmaxSelector,
      isolator: fakeIsolator(),
      runCandidate: async () => ({ kind: "completed", turns: 1 }),
      onTrace: (e) => traces.push(e),
      anchor: happyAnchor(delta),
    })
    expect(r.allScored).toHaveLength(3)
    for (const s of r.allScored) {
      expect(s.cand.delta).toEqual(delta)
    }
    const deltaTraces = traces.filter((t) => t.kind === "candidate-delta")
    expect(deltaTraces).toHaveLength(3)
    // Trace event id set matches the candidate id set.
    const ids = new Set(deltaTraces.map((t) => (t.kind === "candidate-delta" ? t.id : "")))
    expect(ids).toEqual(new Set(["cand-0", "cand-1", "cand-2"]))
  })

  test("HELL-C3: anchor present, registerStart ok:false ⇒ NO measureDelta calls, no `delta` on any candidate", async () => {
    const traces: BranchTraceEvent[] = []
    let measureCalls = 0
    const anchor: BranchSearchAnchor = {
      async registerStart() {
        return { ok: false, reason: "git missing" }
      },
      async measureDelta() {
        measureCalls += 1
        return { changedFiles: 1, addedLines: 1, removedLines: 0 }
      },
    }
    const r = await runBranchSearch({
      N: 2,
      seeds: buildSeeds(2),
      baseLlm: fakeLlm,
      task: "t",
      timeoutPerBranchMs: 1000,
      verifier: passingVerifier,
      scorer: defaultScorer,
      selector: argmaxSelector,
      isolator: fakeIsolator(),
      runCandidate: async () => ({ kind: "completed", turns: 1 }),
      onTrace: (e) => traces.push(e),
      anchor,
    })
    expect(measureCalls).toBe(0)
    for (const s of r.allScored) {
      expect("delta" in s.cand).toBe(false)
    }
    // The synthetic anchor-failure trace fires as `candidate-failed` with
    // id "anchor" (we reuse the variant rather than expand the union).
    const failedTraces = traces.filter((t) => t.kind === "candidate-failed" && t.id === "anchor")
    expect(failedTraces).toHaveLength(1)
  })

  test("HELL-C4: anchor present, ONE candidate failed ⇒ measureDelta NOT called for that one; failed cand has no `delta`", async () => {
    const measureFor: string[] = []
    const anchor: BranchSearchAnchor = {
      async registerStart() {
        return { ok: true }
      },
      async measureDelta(ws) {
        measureFor.push(ws)
        return { changedFiles: 1, addedLines: 1, removedLines: 0 }
      },
    }
    const r = await runBranchSearch({
      N: 2,
      seeds: buildSeeds(2),
      baseLlm: fakeLlm,
      task: "t",
      timeoutPerBranchMs: 1000,
      verifier: passingVerifier,
      scorer: defaultScorer,
      selector: argmaxSelector,
      isolator: fakeIsolator(),
      runCandidate: async ({ id }) =>
        id === "cand-0" ? Promise.reject(new Error("dead")) : { kind: "completed", turns: 1 },
      anchor,
    })
    // Only the surviving candidate's workspace was measured.
    expect(measureFor).toEqual(["/ws/cand-1"])
    // Index alignment: cand-0 is the failed one (no delta), cand-1 has delta.
    const byId: Record<string, BranchCandidate> = {}
    for (const s of r.allScored) byId[s.cand.id] = s.cand
    expect(byId["cand-0"]).toBeDefined()
    expect(byId["cand-1"]).toBeDefined()
    expect("delta" in (byId["cand-0"] as BranchCandidate)).toBe(false)
    expect((byId["cand-1"] as BranchCandidate).delta).toEqual({
      changedFiles: 1,
      addedLines: 1,
      removedLines: 0,
    })
  })

  test("HELL-C5: measureDelta returns null for ONE candidate ⇒ that one has `delta` OMITTED; others keep it", async () => {
    const traces: BranchTraceEvent[] = []
    const anchor: BranchSearchAnchor = {
      async registerStart() {
        return { ok: true }
      },
      async measureDelta(ws) {
        if (ws === "/ws/cand-1") return null
        return { changedFiles: 1, addedLines: 1, removedLines: 0 }
      },
    }
    const r = await runBranchSearch({
      N: 3,
      seeds: buildSeeds(3),
      baseLlm: fakeLlm,
      task: "t",
      timeoutPerBranchMs: 1000,
      verifier: passingVerifier,
      scorer: defaultScorer,
      selector: argmaxSelector,
      isolator: fakeIsolator(),
      runCandidate: async () => ({ kind: "completed", turns: 1 }),
      onTrace: (e) => traces.push(e),
      anchor,
    })
    const byId: Record<string, BranchCandidate> = {}
    for (const s of r.allScored) byId[s.cand.id] = s.cand
    expect((byId["cand-0"] as BranchCandidate).delta).toEqual({
      changedFiles: 1,
      addedLines: 1,
      removedLines: 0,
    })
    expect("delta" in (byId["cand-1"] as BranchCandidate)).toBe(false)
    expect((byId["cand-2"] as BranchCandidate).delta).toEqual({
      changedFiles: 1,
      addedLines: 1,
      removedLines: 0,
    })
    // Trace: 2 candidate-delta events (cand-0, cand-2), none for cand-1.
    const deltaTraces = traces.filter((t) => t.kind === "candidate-delta")
    expect(deltaTraces).toHaveLength(2)
    const ids = new Set(deltaTraces.map((t) => (t.kind === "candidate-delta" ? t.id : "")))
    expect(ids).toEqual(new Set(["cand-0", "cand-2"]))
  })
})
