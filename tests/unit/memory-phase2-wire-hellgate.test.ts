/**
 * Slice S9 Part B — Phase 2 session-start auto-trigger wire hellgate.
 *
 * Pins the contract for `runMemoryPhase2AutoTrigger`:
 *   - DEFAULT-OFF: absent / `enabled !== true` ⇒ structured skip
 *     `phase2_disabled` (NO store reads, NO LLM, NO writer touch).
 *   - port / store / writer absent ⇒ structured skip arms.
 *   - Threshold A (pending count): countSince ≥ PHASE2_AUTO_TRIGGER_PENDING
 *     ⇒ schedule `pending_count`.
 *   - Threshold B (age):
 *     `now - lastSuccessAt ≥ PHASE2_AUTO_TRIGGER_MAX_AGE_MS` AND
 *     pending > 0 ⇒ schedule `age_exceeded`.
 *   - Below thresholds AND not first-run ⇒ skip `below_thresholds`.
 *   - First run (lastSuccessAt === null) + pending > 0 ⇒ age branch fires
 *     (Number.POSITIVE_INFINITY age covers it). Pending-count branch wins
 *     when both fire to keep the reason deterministic.
 *   - NON-BLOCKING: the await on `runMemoryPhase2AutoTrigger` resolves
 *     BEFORE the background `runPhase2` resolves. The hook returns
 *     `kind:"scheduled"` synchronously; the actual run surfaces via the
 *     log callback's `completed` arm later.
 *   - Background `runPhase2` rejection ⇒ surfaces via log `kind:"error"`
 *     and is otherwise swallowed (no unhandled rejection).
 *   - Idempotent (in-flight guard): two near-simultaneous schedules
 *     against the SAME writer ⇒ second call skips
 *     `already_running` until the first resolves.
 */
import { describe, expect, test } from "bun:test"
import {
  __resetPhase2InflightForTests,
  type Phase2AutoTriggerLogger,
  type Phase2AutoTriggerOutcome,
  runMemoryPhase2AutoTrigger,
} from "@/agent/memory-consolidator-hook"
import {
  type MemoryWriter,
  PHASE2_AUTO_TRIGGER_MAX_AGE_MS,
  PHASE2_AUTO_TRIGGER_PENDING,
  type Phase2Port,
  type Stage1Output,
  type Stage1StorePort,
  type WatermarkState,
} from "@/memory"

// ─── Fakes ───────────────────────────────────────────────────────────────

const fixtureRow = (threadId: string): Stage1Output => ({
  threadId,
  rolloutSlug: `slug-${threadId}`,
  rolloutSummary: "summary",
  rawMemory: "- decision",
  preferenceSignals: [],
  sourceUpdatedAt: 1,
  selectedForPhase2: true,
  selectedForPhase2SourceUpdatedAt: 1,
  lastUsage: null,
  usageCount: 0,
})

const makeStore = (init: {
  pendingCount: number
  watermark: WatermarkState
  rows?: Stage1Output[]
}): Stage1StorePort & {
  countSinceCalls: number
  getWatermarkCalls: number
  fetchSinceCalls: number
} => {
  const state = {
    pendingCount: init.pendingCount,
    watermark: { ...init.watermark },
    rows: init.rows ?? [],
    countSinceCalls: 0,
    getWatermarkCalls: 0,
    fetchSinceCalls: 0,
  }
  return {
    async upsert() {
      /* not used */
    },
    async fetchSince() {
      state.fetchSinceCalls += 1
      return state.rows
    },
    async countSince() {
      state.countSinceCalls += 1
      return state.pendingCount
    },
    async getWatermark() {
      state.getWatermarkCalls += 1
      return state.watermark
    },
    async setWatermark(next: WatermarkState) {
      state.watermark = next
    },
    get countSinceCalls() {
      return state.countSinceCalls
    },
    get getWatermarkCalls() {
      return state.getWatermarkCalls
    },
    get fetchSinceCalls() {
      return state.fetchSinceCalls
    },
  } as Stage1StorePort & {
    countSinceCalls: number
    getWatermarkCalls: number
    fetchSinceCalls: number
  }
}

const makePort = (
  opts: { throwOnConsolidate?: boolean; waitFor?: Promise<void> } = {},
): Phase2Port & { consolidateCalls: number } => {
  let calls = 0
  return {
    get consolidateCalls() {
      return calls
    },
    async consolidate() {
      calls += 1
      if (opts.waitFor !== undefined) await opts.waitFor
      if (opts.throwOnConsolidate) throw new Error("consolidate boom")
      return {
        memoryMd: "# memory",
        rawMemoriesMd: "# raw",
        memorySummaryMd: "# summary",
      }
    },
  } as Phase2Port & { consolidateCalls: number }
}

// Minimal writer fake — runPhase2's contract on `writer.writeAtomic`
// returns `{ gitCommitSha: string | null }`. We do not touch disk; the
// hook only forwards the writer to runPhase2.
const makeWriter = (): MemoryWriter & { writeCalls: number } => {
  let writeCalls = 0
  const paths = {
    root: "/tmp/memwriter-fake",
    memoryMd: "/tmp/memwriter-fake/MEMORY.md",
    rawMemoriesMd: "/tmp/memwriter-fake/raw_memories.md",
    memorySummaryMd: "/tmp/memwriter-fake/memory_summary.md",
  }
  const writer = {
    paths,
    async ensureDir() {},
    async readExisting() {
      return { memoryMd: null, rawMemoriesMd: null, memorySummaryMd: null }
    },
    async writeAtomic() {
      writeCalls += 1
      return { gitCommitSha: null }
    },
    get writeCalls() {
      return writeCalls
    },
  }
  return writer as unknown as MemoryWriter & { writeCalls: number }
}

const collectLogger = (): {
  events: Parameters<Phase2AutoTriggerLogger>[0][]
  log: Phase2AutoTriggerLogger
} => {
  const events: Parameters<Phase2AutoTriggerLogger>[0][] = []
  return { events, log: (e) => events.push(e) }
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe("memory-phase2-wire-hellgate — default-OFF + skip arms", () => {
  test("absent phase2 block ⇒ skip phase2_disabled (BYTE-IDENTICAL no-op)", async () => {
    const { log, events } = collectLogger()
    const out = await runMemoryPhase2AutoTrigger({ phase2: undefined }, log)
    expect(out).toEqual({ kind: "skipped", reason: "phase2_disabled" })
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ kind: "skipped", reason: "phase2_disabled" })
  })

  test("enabled !== true ⇒ skip phase2_disabled", async () => {
    const out = await runMemoryPhase2AutoTrigger({
      phase2: {
        enabled: false,
        port: makePort(),
        store: makeStore({
          pendingCount: 100,
          watermark: { lastSuccessAt: null, lastInitAt: null, lastConsolidatedCount: 0 },
        }),
        writer: makeWriter(),
      },
    })
    expect(out).toEqual({ kind: "skipped", reason: "phase2_disabled" })
  })

  test("port missing ⇒ skip port_missing", async () => {
    const out = await runMemoryPhase2AutoTrigger({
      phase2: {
        enabled: true,
        store: makeStore({
          pendingCount: 100,
          watermark: { lastSuccessAt: null, lastInitAt: null, lastConsolidatedCount: 0 },
        }),
        writer: makeWriter(),
      },
    })
    expect(out).toEqual({ kind: "skipped", reason: "port_missing" })
  })

  test("store missing ⇒ skip store_missing", async () => {
    const out = await runMemoryPhase2AutoTrigger({
      phase2: { enabled: true, port: makePort(), writer: makeWriter() },
    })
    expect(out).toEqual({ kind: "skipped", reason: "store_missing" })
  })

  test("writer missing ⇒ skip writer_missing", async () => {
    const out = await runMemoryPhase2AutoTrigger({
      phase2: {
        enabled: true,
        port: makePort(),
        store: makeStore({
          pendingCount: 100,
          watermark: { lastSuccessAt: null, lastInitAt: null, lastConsolidatedCount: 0 },
        }),
      },
    })
    expect(out).toEqual({ kind: "skipped", reason: "writer_missing" })
  })

  test("hook is no-throw when memory disabled (default-OFF byte-identical)", async () => {
    const before = process.listenerCount("unhandledRejection")
    const out = await runMemoryPhase2AutoTrigger({ phase2: undefined })
    expect(out.kind).toBe("skipped")
    expect(process.listenerCount("unhandledRejection")).toBe(before)
  })
})

describe("memory-phase2-wire-hellgate — threshold arms", () => {
  test("pending count ≥ threshold ⇒ scheduled (reason=pending_count)", async () => {
    const writer = makeWriter()
    const out = await runMemoryPhase2AutoTrigger({
      phase2: {
        enabled: true,
        port: makePort(),
        store: makeStore({
          pendingCount: PHASE2_AUTO_TRIGGER_PENDING,
          watermark: { lastSuccessAt: 0, lastInitAt: null, lastConsolidatedCount: 0 },
          rows: [],
        }),
        writer,
      },
      now: () => 100, // age = 100 < threshold ⇒ pending wins
    })
    expect(out).toEqual({ kind: "scheduled", reason: "pending_count" })
    __resetPhase2InflightForTests(writer)
  })

  test("pending count BELOW threshold + recent watermark ⇒ skip below_thresholds", async () => {
    const out = await runMemoryPhase2AutoTrigger({
      phase2: {
        enabled: true,
        port: makePort(),
        store: makeStore({
          pendingCount: PHASE2_AUTO_TRIGGER_PENDING - 1,
          watermark: { lastSuccessAt: 100, lastInitAt: null, lastConsolidatedCount: 0 },
        }),
        writer: makeWriter(),
      },
      now: () => 200, // age = 100 << threshold
    })
    expect(out).toEqual({ kind: "skipped", reason: "below_thresholds" })
  })

  test("age ≥ threshold AND pending > 0 ⇒ scheduled (reason=age_exceeded)", async () => {
    const writer = makeWriter()
    const lastSuccessAt = 0
    const now = lastSuccessAt + PHASE2_AUTO_TRIGGER_MAX_AGE_MS
    const out = await runMemoryPhase2AutoTrigger({
      phase2: {
        enabled: true,
        port: makePort(),
        store: makeStore({
          pendingCount: 1,
          watermark: { lastSuccessAt, lastInitAt: null, lastConsolidatedCount: 0 },
          rows: [],
        }),
        writer,
      },
      now: () => now,
    })
    expect(out).toEqual({ kind: "scheduled", reason: "age_exceeded" })
    __resetPhase2InflightForTests(writer)
  })

  test("age ≥ threshold BUT pending === 0 ⇒ skip below_thresholds (no wasteful LLM call)", async () => {
    const lastSuccessAt = 0
    const now = lastSuccessAt + PHASE2_AUTO_TRIGGER_MAX_AGE_MS + 1
    const out = await runMemoryPhase2AutoTrigger({
      phase2: {
        enabled: true,
        port: makePort(),
        store: makeStore({
          pendingCount: 0,
          watermark: { lastSuccessAt, lastInitAt: null, lastConsolidatedCount: 0 },
        }),
        writer: makeWriter(),
      },
      now: () => now,
    })
    expect(out).toEqual({ kind: "skipped", reason: "below_thresholds" })
  })

  test("first-run (lastSuccessAt=null) with pending > 0 ⇒ scheduled via age branch", async () => {
    const writer = makeWriter()
    const out = await runMemoryPhase2AutoTrigger({
      phase2: {
        enabled: true,
        port: makePort(),
        store: makeStore({
          pendingCount: 1,
          watermark: { lastSuccessAt: null, lastInitAt: null, lastConsolidatedCount: 0 },
          rows: [],
        }),
        writer,
      },
    })
    expect(out.kind).toBe("scheduled")
    if (out.kind === "scheduled") {
      // Either branch is acceptable: pending=1 is < threshold so age branch
      // fires via Number.POSITIVE_INFINITY age.
      expect(out.reason).toBe("age_exceeded")
    }
    __resetPhase2InflightForTests(writer)
  })

  test("pending threshold wins over age when BOTH fire (deterministic reason)", async () => {
    const writer = makeWriter()
    const lastSuccessAt = 0
    const now = lastSuccessAt + PHASE2_AUTO_TRIGGER_MAX_AGE_MS + 999
    const out = await runMemoryPhase2AutoTrigger({
      phase2: {
        enabled: true,
        port: makePort(),
        store: makeStore({
          pendingCount: PHASE2_AUTO_TRIGGER_PENDING,
          watermark: { lastSuccessAt, lastInitAt: null, lastConsolidatedCount: 0 },
          rows: [],
        }),
        writer,
      },
      now: () => now,
    })
    expect(out).toEqual({ kind: "scheduled", reason: "pending_count" })
    __resetPhase2InflightForTests(writer)
  })
})

describe("memory-phase2-wire-hellgate — non-blocking semantics", () => {
  test("scheduled hook resolves BEFORE background runPhase2 finishes", async () => {
    let releaseConsolidate = (): void => {}
    const consolidateBlocked = new Promise<void>((resolve) => {
      releaseConsolidate = resolve
    })
    let observeCompletion = (): void => {}
    const completionObserved = new Promise<void>((resolve) => {
      observeCompletion = resolve
    })
    const writer = makeWriter()
    const port = makePort({ waitFor: consolidateBlocked })
    const events: Parameters<Phase2AutoTriggerLogger>[0][] = []
    const log: Phase2AutoTriggerLogger = (event) => {
      events.push(event)
      if (event.kind === "completed") observeCompletion()
    }
    const out = await runMemoryPhase2AutoTrigger(
      {
        phase2: {
          enabled: true,
          port,
          store: makeStore({
            pendingCount: PHASE2_AUTO_TRIGGER_PENDING,
            watermark: { lastSuccessAt: 0, lastInitAt: null, lastConsolidatedCount: 0 },
            rows: [fixtureRow("t1")],
          }),
          writer,
        },
      },
      log,
    )
    expect(out.kind).toBe("scheduled")
    // The background owner is structurally blocked, so returning here proves the
    // hook did not await runPhase2. No wall-clock race can decide this verdict.
    expect(events.find((e) => e.kind === "completed")).toBeUndefined()
    releaseConsolidate()
    await completionObserved
    const completed = events.find((e) => e.kind === "completed")
    expect(completed).toBeDefined()
    expect(port.consolidateCalls).toBe(1)
    expect(writer.writeCalls).toBe(1)
    __resetPhase2InflightForTests(writer)
  })

  test("background runPhase2 rejection surfaces via log; hook NEVER throws", async () => {
    const writer = makeWriter()
    let observeError = (): void => {}
    const errorObserved = new Promise<void>((resolve) => {
      observeError = resolve
    })
    const events: Parameters<Phase2AutoTriggerLogger>[0][] = []
    const log: Phase2AutoTriggerLogger = (event) => {
      events.push(event)
      if (event.kind === "error") observeError()
    }
    const port = makePort({ throwOnConsolidate: true })
    let caught: unknown = null
    try {
      await runMemoryPhase2AutoTrigger(
        {
          phase2: {
            enabled: true,
            port,
            store: makeStore({
              pendingCount: PHASE2_AUTO_TRIGGER_PENDING,
              watermark: { lastSuccessAt: 0, lastInitAt: null, lastConsolidatedCount: 0 },
              rows: [fixtureRow("t1")],
            }),
            writer,
          },
        },
        log,
      )
    } catch (e) {
      caught = e
    }
    expect(caught).toBeNull()
    await errorObserved
    const err = events.find((e) => e.kind === "error")
    expect(err).toBeDefined()
    expect((err as { kind: "error"; message: string }).message).toContain("consolidate")
    __resetPhase2InflightForTests(writer)
  })

  test("idempotent — concurrent schedule against same writer skips already_running", async () => {
    let releaseConsolidate = (): void => {}
    const consolidateBlocked = new Promise<void>((resolve) => {
      releaseConsolidate = resolve
    })
    let observeCompletion = (): void => {}
    const completionObserved = new Promise<void>((resolve) => {
      observeCompletion = resolve
    })
    const log: Phase2AutoTriggerLogger = (event) => {
      if (event.kind === "completed") observeCompletion()
    }
    const writer = makeWriter()
    const port = makePort({ waitFor: consolidateBlocked })
    const phase2 = {
      enabled: true as const,
      port,
      store: makeStore({
        pendingCount: PHASE2_AUTO_TRIGGER_PENDING,
        watermark: { lastSuccessAt: 0, lastInitAt: null, lastConsolidatedCount: 0 },
        rows: [fixtureRow("t1")],
      }),
      writer,
    }
    const out1 = await runMemoryPhase2AutoTrigger({ phase2 }, log)
    expect(out1.kind).toBe("scheduled")
    // Immediately try again — the background is still in-flight.
    const out2 = await runMemoryPhase2AutoTrigger({ phase2 })
    expect(out2).toEqual({ kind: "skipped", reason: "already_running" })
    releaseConsolidate()
    await completionObserved
    expect(port.consolidateCalls).toBe(1)
    __resetPhase2InflightForTests(writer)
  })

  test("store read error ⇒ kind:error outcome, NO scheduled background", async () => {
    const writer = makeWriter()
    const throwingStore: Stage1StorePort = {
      async upsert() {},
      async fetchSince() {
        return []
      },
      async countSince() {
        throw new Error("sqlite boom")
      },
      async getWatermark() {
        return { lastSuccessAt: null, lastInitAt: null, lastConsolidatedCount: 0 }
      },
      async setWatermark() {},
    }
    const port = makePort()
    const out = await runMemoryPhase2AutoTrigger({
      phase2: {
        enabled: true,
        port,
        store: throwingStore,
        writer,
      },
    })
    expect(out.kind).toBe("error")
    if (out.kind === "error") expect(out.message).toContain("sqlite boom")
    expect(port.consolidateCalls).toBe(0)
    expect(writer.writeCalls).toBe(0)
  })
})

describe("memory-phase2-wire-hellgate — anti-leak invariants", () => {
  test("memory score / content NEVER appears in the structured outcome", async () => {
    const writer = makeWriter()
    const out: Phase2AutoTriggerOutcome = await runMemoryPhase2AutoTrigger({
      phase2: {
        enabled: true,
        port: makePort(),
        store: makeStore({
          pendingCount: PHASE2_AUTO_TRIGGER_PENDING,
          watermark: { lastSuccessAt: 0, lastInitAt: null, lastConsolidatedCount: 0 },
          rows: [],
        }),
        writer,
      },
    })
    const serialized = JSON.stringify(out)
    // The outcome surface is `{kind, reason}` only — no MEMORY.md bytes,
    // no scoring fields, no rollout content.
    expect(serialized).not.toContain("memoryMd")
    expect(serialized).not.toContain("rawMemoriesMd")
    expect(serialized).not.toContain("memorySummaryMd")
    expect(serialized).not.toContain("score")
    __resetPhase2InflightForTests(writer)
  })
})
