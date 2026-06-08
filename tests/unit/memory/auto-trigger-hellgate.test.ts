/**
 * ADR-0281 + ADR-0282 — memory auto-trigger + cross-session inject
 * hellgate (22 adversarial cases).
 *
 * Locks the no-throw / default-OFF / determinism contract of:
 *   - `DefaultMemoryAutoTrigger.onSessionEnd` (Phase 1 → stage1 → promote)
 *   - `DefaultMemoryAutoTrigger.shouldPromote` (lexical Jaccard)
 *   - `DefaultCrossSessionInjector.selectForInject` (byte-cap, oldest-first)
 *   - `renderMemorySection`
 *   - `assembleMemoryAuto` (env-projection helper)
 *
 * Test harness: in-memory stage1 store + fake Phase1Port / Stage1StorePort.
 */

import { describe, expect, mock, test } from "bun:test"
import {
  assembleMemoryAuto,
  DEFAULT_TRIGGER_POLICY,
  DefaultMemoryAutoTrigger,
  type MemoryAutoTrigger,
  TriggerError,
} from "../../../src/memory/auto-trigger"
import type {
  Phase1Port,
  Stage1Output,
  Stage1StorePort,
  WatermarkState,
} from "../../../src/memory/consolidate"
import {
  DEFAULT_INJECT_MAX_BYTES,
  DefaultCrossSessionInjector,
  MEMORY_SECTION_HEADER,
  renderMemorySection,
} from "../../../src/memory/cross-session"
import {
  InMemoryStage1Store,
  type Stage1Entry,
  type Stage1OutputsStore,
} from "../../../src/memory/stage1-store"

// ─── Helpers ────────────────────────────────────────────────────────────

const mkClock = (start = 1_700_000_000_000) => {
  let t = start
  return {
    now: () => t,
    set: (v: number): void => {
      t = v
    },
    advance: (ms: number): void => {
      t += ms
    },
  }
}

const mkPhase1OkPort = (
  result: {
    rolloutSummary?: string
    rawMemory?: string
    preferenceSignals?: readonly string[]
  } = {},
): Phase1Port => ({
  distill: async () => ({
    rolloutSummary: result.rolloutSummary ?? "summary about bun and typescript",
    rawMemory: result.rawMemory ?? "- decision: use bun",
    preferenceSignals: result.preferenceSignals ?? ["bun"],
  }),
})

const mkPhase1ThrowPort = (err: Error): Phase1Port => ({
  distill: async () => {
    throw err
  },
})

const mkRecordingPhase1Store = (
  upsertBehaviour: (out: Stage1Output) => Promise<void> = () => Promise.resolve(),
): { port: Stage1StorePort; upserts: Stage1Output[] } => {
  const upserts: Stage1Output[] = []
  const port: Stage1StorePort = {
    upsert: (out) => {
      upserts.push(out)
      return upsertBehaviour(out)
    },
    fetchSince: () => Promise.resolve([]),
    countSince: () => Promise.resolve(0),
    getWatermark: () =>
      Promise.resolve<WatermarkState>({
        lastSuccessAt: null,
        lastInitAt: null,
        lastConsolidatedCount: 0,
      }),
    setWatermark: () => Promise.resolve(),
  }
  return { port, upserts }
}

const baseSessionEnd = (
  over: { threadId?: string; turnCount?: number; messages?: number; signal?: AbortSignal } = {},
) => {
  const n = over.messages ?? 6
  const rolloutMessages: { role: string; content: unknown }[] = []
  for (let i = 0; i < n; i++) {
    rolloutMessages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `msg-${i}`,
    })
  }
  const out: {
    threadId: string
    sessionId: string
    rolloutMessages: { role: string; content: unknown }[]
    turnCount: number
    signal?: AbortSignal
  } = {
    threadId: over.threadId ?? "thr-1",
    sessionId: "sess-1",
    rolloutMessages,
    turnCount: over.turnCount ?? 5,
  }
  if (over.signal !== undefined) out.signal = over.signal
  return out
}

const baseEntry = (over: Partial<Stage1Entry> = {}): Stage1Entry => ({
  threadId: "thr-x",
  sourceUpdatedAt: 1,
  rawMemory: "- raw",
  rolloutSummary: "summary",
  generatedAt: 1,
  rolloutSlug: "slug",
  usageCount: 1,
  lastUsage: 1,
  selectedForPhase2: true,
  ...over,
})

// ─── HELL-MAT-01: session-end → phase1.distill + stage1.put ─────────────

describe("HELL-MAT-01: onSessionEnd calls phase1.distill AND stage1.put", () => {
  test("happy path stores Stage1 entry derived from phase1 output", async () => {
    const clk = mkClock()
    const stage1Store: Stage1OutputsStore = new InMemoryStage1Store({ now: clk.now })
    const { port: phase1Store, upserts } = mkRecordingPhase1Store()
    const distillSpy = mock(async () => ({
      rolloutSummary: "alpha beta",
      rawMemory: "- raw bun",
      preferenceSignals: ["bun"],
    }))
    const phase1Port: Phase1Port = { distill: distillSpy }
    const trigger = new DefaultMemoryAutoTrigger({
      phase1Port,
      phase1Store,
      stage1Store,
      now: clk.now,
    })
    const outcome = await trigger.onSessionEnd(baseSessionEnd())
    expect(distillSpy).toHaveBeenCalledTimes(1)
    expect(upserts).toHaveLength(1)
    expect(outcome.kind).toBe("stored")
    if (outcome.kind === "stored") {
      expect(outcome.stage1ThreadId).toBe("thr-1")
    }
    const stored = stage1Store.get("thr-1")
    expect(stored).not.toBeNull()
    expect(stored?.rolloutSummary).toBe("alpha beta")
  })
})

// ─── HELL-MAT-02: similarity > threshold → promote ──────────────────────

describe("HELL-MAT-02: similarity above threshold ⇒ promote (markSelectedForPhase2)", () => {
  test("entry whose tokens overlap a sibling corpus is marked", async () => {
    const clk = mkClock()
    const stage1Store: Stage1OutputsStore = new InMemoryStage1Store({ now: clk.now })
    // Pre-seed a sibling whose tokens entirely overlap so jaccard = 1.0
    stage1Store.put(
      baseEntry({
        threadId: "thr-prior",
        rolloutSummary: "alpha beta gamma delta",
        usageCount: 5,
        selectedForPhase2: true,
      }),
    )
    const { port: phase1Store } = mkRecordingPhase1Store()
    const trigger = new DefaultMemoryAutoTrigger({
      phase1Port: mkPhase1OkPort({ rolloutSummary: "alpha beta gamma delta" }),
      phase1Store,
      stage1Store,
      now: clk.now,
      policy: { promoteThreshold: 0.5, minUsageCount: 0 },
    })
    const outcome = await trigger.onSessionEnd(baseSessionEnd())
    expect(outcome.kind).toBe("stored")
    if (outcome.kind === "stored") expect(outcome.promoted).toBe(true)
    const stored = stage1Store.get("thr-1")
    expect(stored?.selectedForPhase2).toBe(true)
    expect(stored?.selectedForPhase2SourceUpdatedAt).toBeDefined()
  })
})

// ─── HELL-MAT-03: similarity < threshold → stage1 stored, not promoted ─

describe("HELL-MAT-03: similarity below threshold ⇒ stored but NOT promoted", () => {
  test("disjoint corpus gives jaccard=0 < 0.7 default ⇒ not promoted", async () => {
    const clk = mkClock()
    const stage1Store: Stage1OutputsStore = new InMemoryStage1Store({ now: clk.now })
    stage1Store.put(
      baseEntry({
        threadId: "thr-prior",
        rolloutSummary: "completely different vocabulary here",
        selectedForPhase2: true,
      }),
    )
    const { port: phase1Store } = mkRecordingPhase1Store()
    const trigger = new DefaultMemoryAutoTrigger({
      phase1Port: mkPhase1OkPort({ rolloutSummary: "alpha beta gamma" }),
      phase1Store,
      stage1Store,
      now: clk.now,
    })
    const outcome = await trigger.onSessionEnd(baseSessionEnd())
    expect(outcome.kind).toBe("stored")
    if (outcome.kind === "stored") expect(outcome.promoted).toBe(false)
    const stored = stage1Store.get("thr-1")
    expect(stored?.selectedForPhase2).toBe(false)
  })
})

// ─── HELL-MAT-04: minUsageCount unmet → no promote even if score high ──

describe("HELL-MAT-04: minUsageCount unmet ⇒ promote skipped", () => {
  test("usageCount 0 < minUsageCount 5 ⇒ no promote despite jaccard=1", async () => {
    const clk = mkClock()
    const stage1Store: Stage1OutputsStore = new InMemoryStage1Store({ now: clk.now })
    stage1Store.put(
      baseEntry({
        threadId: "thr-prior",
        rolloutSummary: "alpha beta gamma",
        selectedForPhase2: true,
      }),
    )
    const { port: phase1Store } = mkRecordingPhase1Store()
    const trigger = new DefaultMemoryAutoTrigger({
      phase1Port: mkPhase1OkPort({ rolloutSummary: "alpha beta gamma" }),
      phase1Store,
      stage1Store,
      now: clk.now,
      policy: { promoteThreshold: 0.5, minUsageCount: 5 },
    })
    const outcome = await trigger.onSessionEnd(baseSessionEnd())
    expect(outcome.kind).toBe("stored")
    if (outcome.kind === "stored") expect(outcome.promoted).toBe(false)
  })
})

// ─── HELL-MAT-05: phase1 throws → graceful error outcome + warn ────────

describe("HELL-MAT-05: phase1 throws ⇒ graceful TriggerError outcome + warn (no leak)", () => {
  test("error outcome carries phase1_throw reason; logger called once", async () => {
    const clk = mkClock()
    const stage1Store: Stage1OutputsStore = new InMemoryStage1Store({ now: clk.now })
    const { port: phase1Store, upserts } = mkRecordingPhase1Store()
    const warns: string[] = []
    const trigger = new DefaultMemoryAutoTrigger({
      phase1Port: mkPhase1ThrowPort(new Error("LLM timeout")),
      phase1Store,
      stage1Store,
      now: clk.now,
      logWarn: (m) => warns.push(m),
    })
    const outcome = await trigger.onSessionEnd(baseSessionEnd())
    expect(outcome.kind).toBe("error")
    if (outcome.kind === "error") {
      expect(outcome.error).toBeInstanceOf(TriggerError)
      expect(outcome.error.reason).toBe("phase1_throw")
    }
    expect(warns).toHaveLength(1)
    expect(upserts).toHaveLength(0) // No leak — never reached put
  })
})

// ─── HELL-MAT-06: stage1Store full → LRU compatible ────────────────────

describe("HELL-MAT-06: LRU-pruned store is compatible (trigger does not break)", () => {
  test("after prune({maxEntries:1}), new put still succeeds and outcome stored", async () => {
    const clk = mkClock()
    const stage1Store: Stage1OutputsStore = new InMemoryStage1Store({ now: clk.now })
    // Fill + prune to 1 max — simulates a saturated store.
    for (let i = 0; i < 5; i++) {
      clk.advance(1)
      stage1Store.put(baseEntry({ threadId: `t-${i}`, generatedAt: clk.now() }))
    }
    expect(stage1Store.list().length).toBe(5)
    stage1Store.prune({ maxEntries: 1 })
    expect(stage1Store.list().length).toBe(1)
    const { port: phase1Store } = mkRecordingPhase1Store()
    const trigger = new DefaultMemoryAutoTrigger({
      phase1Port: mkPhase1OkPort(),
      phase1Store,
      stage1Store,
      now: clk.now,
    })
    const outcome = await trigger.onSessionEnd(baseSessionEnd())
    expect(outcome.kind).toBe("stored")
    // Store now has 2 entries (the LRU survivor + our new one).
    expect(stage1Store.list().length).toBe(2)
  })
})

// ─── HELL-MAT-07: concurrent session-end ⇒ isolated, no race ───────────

describe("HELL-MAT-07: concurrent session-end (3 parallel) isolated", () => {
  test("three parallel calls each produce a stored outcome with distinct thread ids", async () => {
    const clk = mkClock()
    const stage1Store: Stage1OutputsStore = new InMemoryStage1Store({ now: clk.now })
    const { port: phase1Store } = mkRecordingPhase1Store()
    const trigger = new DefaultMemoryAutoTrigger({
      phase1Port: mkPhase1OkPort(),
      phase1Store,
      stage1Store,
      now: clk.now,
    })
    const results = await Promise.all([
      trigger.onSessionEnd(baseSessionEnd({ threadId: "thrA" })),
      trigger.onSessionEnd(baseSessionEnd({ threadId: "thrB" })),
      trigger.onSessionEnd(baseSessionEnd({ threadId: "thrC" })),
    ])
    for (const r of results) expect(r.kind).toBe("stored")
    const ids = new Set(stage1Store.list().map((e) => e.threadId))
    expect(ids).toEqual(new Set(["thrA", "thrB", "thrC"]))
  })
})

// ─── HELL-MAT-08: duplicate threadId session-end twice ⇒ idempotent ────

describe("HELL-MAT-08: duplicate threadId session-end twice is idempotent (replace)", () => {
  test("two calls with same threadId leave exactly one stage1 row", async () => {
    const clk = mkClock()
    const stage1Store: Stage1OutputsStore = new InMemoryStage1Store({ now: clk.now })
    const { port: phase1Store } = mkRecordingPhase1Store()
    const trigger = new DefaultMemoryAutoTrigger({
      phase1Port: mkPhase1OkPort(),
      phase1Store,
      stage1Store,
      now: clk.now,
    })
    await trigger.onSessionEnd(baseSessionEnd({ threadId: "thr-dup" }))
    clk.advance(1000)
    const second = await trigger.onSessionEnd(baseSessionEnd({ threadId: "thr-dup" }))
    expect(second.kind).toBe("stored")
    expect(stage1Store.list().length).toBe(1)
  })
})

// ─── HELL-MAT-09: empty session (0 messages) ⇒ skip ────────────────────

describe("HELL-MAT-09: empty session (0 messages) skips trigger entirely", () => {
  test("rolloutMessages=[] ⇒ {kind:skipped, reason:empty_session}; no LLM call", async () => {
    const clk = mkClock()
    const stage1Store: Stage1OutputsStore = new InMemoryStage1Store({ now: clk.now })
    const { port: phase1Store, upserts } = mkRecordingPhase1Store()
    const distillSpy = mock(async () => ({
      rolloutSummary: "",
      rawMemory: "",
      preferenceSignals: [],
    }))
    const trigger = new DefaultMemoryAutoTrigger({
      phase1Port: { distill: distillSpy },
      phase1Store,
      stage1Store,
      now: clk.now,
    })
    const outcome = await trigger.onSessionEnd(baseSessionEnd({ messages: 0 }))
    expect(outcome.kind).toBe("skipped")
    if (outcome.kind === "skipped") expect(outcome.reason).toBe("empty_session")
    expect(distillSpy).toHaveBeenCalledTimes(0)
    expect(upserts).toHaveLength(0)
  })
})

// ─── HELL-MAT-10: malformed stage1 entry ⇒ skip in injector ───────────

describe("HELL-MAT-10: injector skips malformed stage1 entries silently", () => {
  test("non-string rolloutSummary entry is filtered out, valid ones returned", () => {
    const clk = mkClock()
    const stage1Store: Stage1OutputsStore = new InMemoryStage1Store({ now: clk.now })
    // Two valid entries + one malformed.
    stage1Store.put(baseEntry({ threadId: "ok-1", rolloutSummary: "valid one" }))
    stage1Store.put(baseEntry({ threadId: "ok-2", rolloutSummary: "valid two" }))
    // Inject a malformed entry via direct Map mutation is not possible
    // (frozen) — simulate by putting an entry with empty/whitespace
    // summary which should ALSO be filtered.
    stage1Store.put(baseEntry({ threadId: "bad-1", rolloutSummary: "   " }))
    const inj = new DefaultCrossSessionInjector({ stage1Store })
    const out = inj.selectForInject({ maxBytes: 1024 })
    const ids = out.map((e) => e.threadId)
    expect(ids).toContain("ok-1")
    expect(ids).toContain("ok-2")
    expect(ids).not.toContain("bad-1")
  })
})

// ─── HELL-MAT-11: threshold 0 ⇒ every entry promotes (edge) ────────────

describe("HELL-MAT-11: threshold 0 ⇒ every entry promotes (edge)", () => {
  test("with threshold 0 + minUsageCount 0, any new entry is promoted", async () => {
    const clk = mkClock()
    const stage1Store: Stage1OutputsStore = new InMemoryStage1Store({ now: clk.now })
    const { port: phase1Store } = mkRecordingPhase1Store()
    const trigger = new DefaultMemoryAutoTrigger({
      phase1Port: mkPhase1OkPort(),
      phase1Store,
      stage1Store,
      now: clk.now,
      policy: { promoteThreshold: 0, minUsageCount: 0 },
    })
    const outcome = await trigger.onSessionEnd(baseSessionEnd())
    expect(outcome.kind).toBe("stored")
    if (outcome.kind === "stored") expect(outcome.promoted).toBe(true)
  })
})

// ─── HELL-MAT-12: threshold > 1 ⇒ nothing promotes ─────────────────────

describe("HELL-MAT-12: threshold > 1 ⇒ nothing promotes", () => {
  test("with promoteThreshold 1.5, even perfect jaccard does not promote", async () => {
    const clk = mkClock()
    const stage1Store: Stage1OutputsStore = new InMemoryStage1Store({ now: clk.now })
    stage1Store.put(
      baseEntry({
        threadId: "thr-prior",
        rolloutSummary: "alpha beta gamma",
        selectedForPhase2: true,
      }),
    )
    const { port: phase1Store } = mkRecordingPhase1Store()
    const trigger = new DefaultMemoryAutoTrigger({
      phase1Port: mkPhase1OkPort({ rolloutSummary: "alpha beta gamma" }),
      phase1Store,
      stage1Store,
      now: clk.now,
      policy: { promoteThreshold: 1.5, minUsageCount: 0 },
    })
    const outcome = await trigger.onSessionEnd(baseSessionEnd())
    expect(outcome.kind).toBe("stored")
    if (outcome.kind === "stored") expect(outcome.promoted).toBe(false)
  })
})

// ─── HELL-MAT-13: promote mid-flight stage1 invalidated ⇒ graceful ─────

describe("HELL-MAT-13: stage1 invalidated mid-trigger ⇒ graceful (no throw)", () => {
  test("if put succeeds but get returns null (e.g. concurrent prune), outcome is stored/not-promoted", async () => {
    const clk = mkClock()
    // A store impl whose `get` returns null even though `put` succeeded
    // — simulating a prune that fires between put and get.
    const evictingStore: Stage1OutputsStore = {
      get: () => null,
      put: () => {},
      touch: () => {},
      markSelectedForPhase2: () => {},
      list: () => Object.freeze([]),
      prune: () => 0,
    }
    const { port: phase1Store } = mkRecordingPhase1Store()
    const trigger = new DefaultMemoryAutoTrigger({
      phase1Port: mkPhase1OkPort(),
      phase1Store,
      stage1Store: evictingStore,
      now: clk.now,
    })
    const outcome = await trigger.onSessionEnd(baseSessionEnd())
    expect(outcome.kind).toBe("stored")
    if (outcome.kind === "stored") expect(outcome.promoted).toBe(false)
  })
})

// ─── HELL-MAT-14: clock backwards ⇒ lastUsage tolerated ────────────────

describe("HELL-MAT-14: clock backwards does not crash", () => {
  test("trigger tolerates a clock that regresses (lastUsage may regress; no throw)", async () => {
    let t = 1_000_000
    const stage1Store: Stage1OutputsStore = new InMemoryStage1Store({ now: () => t })
    const { port: phase1Store } = mkRecordingPhase1Store()
    const trigger = new DefaultMemoryAutoTrigger({
      phase1Port: mkPhase1OkPort(),
      phase1Store,
      stage1Store,
      now: () => t,
    })
    await trigger.onSessionEnd(baseSessionEnd({ threadId: "thr-c1" }))
    // Move clock BACKWARDS.
    t = 500_000
    const outcome = await trigger.onSessionEnd(baseSessionEnd({ threadId: "thr-c2" }))
    expect(outcome.kind).toBe("stored")
  })
})

// ─── HELL-MAT-15: session start → injector + prompt section ────────────

describe("HELL-MAT-15: session start ⇒ injector returns promoted entries + prompt section rendered", () => {
  test("injector.selectForInject + renderMemorySection produces a non-empty system block", () => {
    const clk = mkClock()
    const stage1Store: Stage1OutputsStore = new InMemoryStage1Store({ now: clk.now })
    stage1Store.put(
      baseEntry({
        threadId: "thr-A",
        rolloutSummary: "decision: use bun",
        selectedForPhase2: true,
        usageCount: 2,
      }),
    )
    stage1Store.put(
      baseEntry({
        threadId: "thr-B",
        rolloutSummary: "fact: tsc strict",
        selectedForPhase2: true,
        usageCount: 3,
        generatedAt: 2,
      }),
    )
    const inj = new DefaultCrossSessionInjector({ stage1Store })
    const selected = inj.selectForInject({ maxBytes: 1024 })
    expect(selected.length).toBe(2)
    const block = renderMemorySection(selected)
    expect(block.type).toBe("text")
    expect(block.text).toContain(MEMORY_SECTION_HEADER)
    expect(block.text).toContain("decision: use bun")
    expect(block.text).toContain("fact: tsc strict")
    expect(block.cache).toBe(true)
  })
})

// ─── HELL-MAT-16: maxBytes cap exact — overflow truncated ──────────────

describe("HELL-MAT-16: maxBytes cap — overflow entries are NOT included", () => {
  test("byte budget enforced exactly; oldest-first; cumulative sum ≤ cap", () => {
    const clk = mkClock()
    const stage1Store: Stage1OutputsStore = new InMemoryStage1Store({ now: clk.now })
    // Three entries, summaries of known byte lengths.
    const sA = "a".repeat(10)
    const sB = "b".repeat(10)
    const sC = "c".repeat(10)
    stage1Store.put(
      baseEntry({ threadId: "A", rolloutSummary: sA, generatedAt: 1, selectedForPhase2: true }),
    )
    stage1Store.put(
      baseEntry({ threadId: "B", rolloutSummary: sB, generatedAt: 2, selectedForPhase2: true }),
    )
    stage1Store.put(
      baseEntry({ threadId: "C", rolloutSummary: sC, generatedAt: 3, selectedForPhase2: true }),
    )
    const inj = new DefaultCrossSessionInjector({ stage1Store })
    // 25 bytes ⇒ A (10) + B (10) = 20 fits, +C (10) ⇒ 30 > 25 ⇒ stop.
    const out = inj.selectForInject({ maxBytes: 25 })
    const ids = out.map((e) => e.threadId)
    expect(ids).toEqual(["A", "B"])
    // Edge: maxBytes 0 ⇒ empty.
    expect(inj.selectForInject({ maxBytes: 0 }).length).toBe(0)
    // Edge: maxBytes exactly 30 ⇒ all three.
    expect(inj.selectForInject({ maxBytes: 30 }).map((e) => e.threadId)).toEqual(["A", "B", "C"])
  })
})

// ─── HELL-MAT-17: kindFilter selects subset ────────────────────────────

describe("HELL-MAT-17: kindFilter matches first-token of rolloutSummary", () => {
  test("kindFilter=['fact'] ⇒ only entries whose summary starts with 'fact'", () => {
    const clk = mkClock()
    const stage1Store: Stage1OutputsStore = new InMemoryStage1Store({ now: clk.now })
    stage1Store.put(
      baseEntry({
        threadId: "f1",
        rolloutSummary: "fact bun is the runtime",
        selectedForPhase2: true,
        generatedAt: 1,
      }),
    )
    stage1Store.put(
      baseEntry({
        threadId: "d1",
        rolloutSummary: "decision use strict tsc",
        selectedForPhase2: true,
        generatedAt: 2,
      }),
    )
    stage1Store.put(
      baseEntry({
        threadId: "f2",
        rolloutSummary: "fact biome over eslint",
        selectedForPhase2: true,
        generatedAt: 3,
      }),
    )
    const inj = new DefaultCrossSessionInjector({ stage1Store })
    const got = inj.selectForInject({ maxBytes: 1024, kindFilter: ["fact"] })
    expect(got.map((e) => e.threadId)).toEqual(["f1", "f2"])
    // Empty kindFilter ⇒ NOTHING (explicit hard NO).
    expect(inj.selectForInject({ maxBytes: 1024, kindFilter: [] }).length).toBe(0)
  })
})

// ─── HELL-MAT-18: inject result empty ⇒ empty prompt section ───────────

describe("HELL-MAT-18: empty injector result ⇒ empty prompt-section string", () => {
  test("zero entries ⇒ {text:'', cache:true}", () => {
    const clk = mkClock()
    const stage1Store: Stage1OutputsStore = new InMemoryStage1Store({ now: clk.now })
    const inj = new DefaultCrossSessionInjector({ stage1Store })
    const got = inj.selectForInject({ maxBytes: 1024 })
    expect(got.length).toBe(0)
    const block = renderMemorySection(got)
    expect(block.text).toBe("")
    expect(block.cache).toBe(true)
  })
})

// ─── HELL-MAT-19: env QUANTA_MEMORY_AUTO falsey ⇒ disabled (ADR-0413) ──

describe("HELL-MAT-19: assembleMemoryAuto is DEFAULT-ON; only falsey QUANTA_MEMORY_AUTO disables (ADR-0413)", () => {
  // ADR-0413 (Accepted 2026-05-28) flipped memory learning to DEFAULT-ON via
  // the session factory. The auto-trigger wire now uses `parseEnvFlag(raw,
  // /*defaultOn*/ true)`, so absent / "1" / "true" / "on" all ENABLE and only
  // the explicit falsey set ({0,false,off,no}, case-insensitive, trimmed)
  // returns null. The legacy "only 'on' enables" default-OFF contract is
  // superseded — this case now locks the inverse truth table.
  test("falsey set ⇒ null; absent / truthy aliases ⇒ enabled", () => {
    // Falsey ⇒ disabled (null).
    expect(assembleMemoryAuto({ QUANTA_MEMORY_AUTO: "off" })).toBeNull()
    expect(assembleMemoryAuto({ QUANTA_MEMORY_AUTO: "0" })).toBeNull()
    expect(assembleMemoryAuto({ QUANTA_MEMORY_AUTO: "false" })).toBeNull()
    expect(assembleMemoryAuto({ QUANTA_MEMORY_AUTO: "no" })).toBeNull()
    expect(assembleMemoryAuto({ QUANTA_MEMORY_AUTO: "OFF" })).toBeNull()
    // Absent + truthy aliases ⇒ enabled (default-ON).
    expect(assembleMemoryAuto({})).not.toBeNull()
    expect(assembleMemoryAuto({ QUANTA_MEMORY_AUTO: "1" })).not.toBeNull()
    expect(assembleMemoryAuto({ QUANTA_MEMORY_AUTO: "true" })).not.toBeNull()
    expect(assembleMemoryAuto({ QUANTA_MEMORY_AUTO: "ON" })).not.toBeNull()
  })

  test("explicit off-switch returns null so the host skips trigger construction", async () => {
    // When the composition root returns null from assembleMemoryAuto, the
    // host does NOT construct DefaultMemoryAutoTrigger. Under ADR-0413
    // default-ON, the off-path is reached via the explicit `=off` knob.
    const cfg = assembleMemoryAuto({ QUANTA_MEMORY_AUTO: "off" })
    expect(cfg).toBeNull()
  })
})

// ─── HELL-MAT-20: AbortSignal mid-trigger ⇒ propagate AbortError ──────

describe("HELL-MAT-20: AbortSignal abort ⇒ propagates AbortError, cleanup", () => {
  test("aborted signal during distill propagates an AbortError (not TriggerError)", async () => {
    const clk = mkClock()
    const stage1Store: Stage1OutputsStore = new InMemoryStage1Store({ now: clk.now })
    const { port: phase1Store, upserts } = mkRecordingPhase1Store()
    const ctrl = new AbortController()
    // Phase 1 port: distill throws an AbortError when called.
    const abortErr = new Error("aborted")
    abortErr.name = "AbortError"
    const trigger = new DefaultMemoryAutoTrigger({
      phase1Port: {
        distill: async () => {
          throw abortErr
        },
      },
      phase1Store,
      stage1Store,
      now: clk.now,
    })
    ctrl.abort()
    let caught: unknown
    try {
      await trigger.onSessionEnd(baseSessionEnd({ signal: ctrl.signal }))
    } catch (e) {
      caught = e
    }
    expect(caught).toBe(abortErr)
    expect(upserts).toHaveLength(0)
    // Stage1 store left clean.
    expect(stage1Store.list().length).toBe(0)
  })
})

// ─── HELL-MAT-21: default policy = threshold 0.7 + minUsageCount 1 ────

describe("HELL-MAT-21: DEFAULT_TRIGGER_POLICY = {0.7, 1}", () => {
  test("constant matches spec exactly", () => {
    expect(DEFAULT_TRIGGER_POLICY.promoteThreshold).toBe(0.7)
    expect(DEFAULT_TRIGGER_POLICY.minUsageCount).toBe(1)
  })

  test("type-shape conformance — TriggerPolicy is closed-2 field", () => {
    // Assert the REAL exported constant's field-set (not a hand-built literal),
    // so adding/dropping a policy field in production is caught here.
    expect(Object.keys(DEFAULT_TRIGGER_POLICY).sort()).toEqual([
      "minUsageCount",
      "promoteThreshold",
    ])
  })
})

// ─── HELL-MAT-22: assembleMemoryAuto env-wire exactness ───────────────

describe("HELL-MAT-22: assembleMemoryAuto env wire is exact", () => {
  test("QUANTA_MEMORY_AUTO=on with no overrides ⇒ default policy", () => {
    const cfg = assembleMemoryAuto({ QUANTA_MEMORY_AUTO: "on" })
    expect(cfg).not.toBeNull()
    expect(cfg?.enabled).toBe(true)
    expect(cfg?.policy.promoteThreshold).toBe(0.7)
    expect(cfg?.policy.minUsageCount).toBe(1)
  })

  test("THRESHOLD + MIN_USAGE overrides parsed as number/int", () => {
    const cfg = assembleMemoryAuto({
      QUANTA_MEMORY_AUTO: "on",
      QUANTA_MEMORY_THRESHOLD: "0.85",
      QUANTA_MEMORY_MIN_USAGE: "3",
    })
    expect(cfg?.policy.promoteThreshold).toBe(0.85)
    expect(cfg?.policy.minUsageCount).toBe(3)
  })

  test("invalid THRESHOLD ⇒ default 0.7; invalid MIN_USAGE ⇒ default 1", () => {
    const cfg = assembleMemoryAuto({
      QUANTA_MEMORY_AUTO: "on",
      QUANTA_MEMORY_THRESHOLD: "not-a-number",
      QUANTA_MEMORY_MIN_USAGE: "negative-int",
    })
    expect(cfg?.policy.promoteThreshold).toBe(0.7)
    expect(cfg?.policy.minUsageCount).toBe(1)
  })

  test("negative MIN_USAGE ⇒ default 1 (gate is non-negative)", () => {
    const cfg = assembleMemoryAuto({
      QUANTA_MEMORY_AUTO: "on",
      QUANTA_MEMORY_MIN_USAGE: "-5",
    })
    expect(cfg?.policy.minUsageCount).toBe(1)
  })
})

// ─── Sanity: DEFAULT_INJECT_MAX_BYTES is the documented constant ─────

describe("constants: DEFAULT_INJECT_MAX_BYTES exposed and = 8192", () => {
  test("byte budget default", () => {
    expect(DEFAULT_INJECT_MAX_BYTES).toBe(8192)
  })
})

// ─── Sanity: MemoryAutoTrigger port shape matches MemoryAutoTrigger interface
describe("port shape: DefaultMemoryAutoTrigger implements MemoryAutoTrigger", () => {
  test("typed slot assignment is structurally valid", () => {
    const clk = mkClock()
    const stage1Store: Stage1OutputsStore = new InMemoryStage1Store({ now: clk.now })
    const { port: phase1Store } = mkRecordingPhase1Store()
    const t: MemoryAutoTrigger = new DefaultMemoryAutoTrigger({
      phase1Port: mkPhase1OkPort(),
      phase1Store,
      stage1Store,
      now: clk.now,
    })
    expect(typeof t.onSessionEnd).toBe("function")
    expect(typeof t.onSessionStart).toBe("function")
    expect(typeof t.shouldPromote).toBe("function")
  })

  // NOTE: removed the local `inspect`-switch test (REIMPLEMENTED): it fed
  // self-constructed literals into a test-defined switch, exercising no SUT.
  // All three SessionEndOutcome kinds are produced and asserted by real
  // onSessionEnd invocations in HELL-MAT-01/03/05 (stored / skipped /
  // error+TriggerError.reason at line 277).
})
