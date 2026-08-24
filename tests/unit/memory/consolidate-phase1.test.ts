import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { MIN_TURN_THRESHOLD } from "../../../src/memory/consolidate/constants"
import { runPhase1 } from "../../../src/memory/consolidate/phase1"
import { Stage1Store } from "../../../src/memory/consolidate/store"
import {
  Phase1DistillError,
  type Phase1Input,
  type Phase1Port,
  type Stage1Output,
  type Stage1StorePort,
  type WatermarkState,
} from "../../../src/memory/consolidate/types"
import { nth } from "../../_helpers/expect-present"

/**
 * ADR-0068 Wave A — `runPhase1` orchestration conformance.
 *
 * Skip path tests use a recording store (asserts `upsert` NOT called).
 * Happy/error tests use a real `Stage1Store` over a `:memory:` DB so
 * persistence + REPLACE semantics are exercised end-to-end.
 */

const FIXED_NOW = 1_700_000_000_000

const baseInput = (over: Partial<Phase1Input> = {}): Phase1Input => ({
  threadId: "thr-1",
  sessionId: "sess-1",
  rolloutMessages: [
    { role: "user", content: "hello" },
    { role: "assistant", content: "hi" },
  ],
  turnCount: MIN_TURN_THRESHOLD, // exactly at threshold (>=) — distills
  memoryMode: "enabled",
  now: () => FIXED_NOW,
  ...over,
})

/** Sequential-clock helper — first call returns `start`, subsequent
 *  calls advance by `step`. Used to verify durationMs subtraction. */
const seqClock = (start: number, step: number): (() => number) => {
  let n = start
  return () => {
    const v = n
    n += step
    return v
  }
}

const okPort: Phase1Port = {
  distill: async () => ({
    rolloutSummary: "summary",
    rawMemory: "raw",
    preferenceSignals: ["pref-a"],
  }),
}

/** Recording store with optional injected behaviour. Captures every
 *  `upsert` call so the skip-path tests can assert "never called". */
const makeRecordingStore = (
  upsertBehaviour: (out: Stage1Output) => Promise<void> = () => Promise.resolve(),
): {
  port: Stage1StorePort
  upserts: Stage1Output[]
} => {
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

describe("runPhase1 — skip paths (each in deterministic order)", () => {
  test("threadId empty → skipped reason='thread_id_empty', upsert NOT called", async () => {
    const { port, upserts } = makeRecordingStore()
    const out = await runPhase1(baseInput({ threadId: "" }), okPort, port)
    expect(out.kind).toBe("skipped")
    if (out.kind === "skipped") expect(out.reason).toBe("thread_id_empty")
    expect(upserts).toHaveLength(0)
  })

  test("memoryMode='disabled' → skipped reason='memory_mode_disabled'", async () => {
    const { port, upserts } = makeRecordingStore()
    const out = await runPhase1(baseInput({ memoryMode: "disabled" }), okPort, port)
    expect(out.kind).toBe("skipped")
    if (out.kind === "skipped") expect(out.reason).toBe("memory_mode_disabled")
    expect(upserts).toHaveLength(0)
  })

  test("rolloutMessages empty → skipped reason='no_messages'", async () => {
    const { port, upserts } = makeRecordingStore()
    const out = await runPhase1(baseInput({ rolloutMessages: [] }), okPort, port)
    expect(out.kind).toBe("skipped")
    if (out.kind === "skipped") expect(out.reason).toBe("no_messages")
    expect(upserts).toHaveLength(0)
  })

  test("turnCount < MIN_TURN_THRESHOLD → skipped reason='turns_below_threshold'", async () => {
    const { port, upserts } = makeRecordingStore()
    const out = await runPhase1(baseInput({ turnCount: MIN_TURN_THRESHOLD - 1 }), okPort, port)
    expect(out.kind).toBe("skipped")
    if (out.kind === "skipped") expect(out.reason).toBe("turns_below_threshold")
    expect(upserts).toHaveLength(0)
  })

  test("turnCount === MIN_TURN_THRESHOLD does NOT skip (>= threshold)", async () => {
    const store = new Stage1Store(new Database(":memory:"))
    const out = await runPhase1(baseInput({ turnCount: MIN_TURN_THRESHOLD }), okPort, store)
    expect(out.kind).toBe("distilled")
  })

  test("port.distill is NOT awaited on the skip paths (no LLM cost)", async () => {
    let called = false
    const distillRecording: Phase1Port = {
      distill: async () => {
        called = true
        return { rolloutSummary: "", rawMemory: "", preferenceSignals: [] }
      },
    }
    const { port } = makeRecordingStore()
    await runPhase1(baseInput({ memoryMode: "disabled" }), distillRecording, port)
    expect(called).toBe(false)
  })

  test("skip-order: threadId_empty wins over memory_mode_disabled", async () => {
    const { port } = makeRecordingStore()
    const out = await runPhase1(baseInput({ threadId: "", memoryMode: "disabled" }), okPort, port)
    expect(out.kind).toBe("skipped")
    if (out.kind === "skipped") expect(out.reason).toBe("thread_id_empty")
  })

  test("skip-order: memory_mode_disabled wins over no_messages", async () => {
    const { port } = makeRecordingStore()
    const out = await runPhase1(
      baseInput({ memoryMode: "disabled", rolloutMessages: [] }),
      okPort,
      port,
    )
    expect(out.kind).toBe("skipped")
    if (out.kind === "skipped") expect(out.reason).toBe("memory_mode_disabled")
  })

  test("skip-order: no_messages wins over turns_below_threshold", async () => {
    const { port } = makeRecordingStore()
    const out = await runPhase1(baseInput({ rolloutMessages: [], turnCount: 0 }), okPort, port)
    expect(out.kind).toBe("skipped")
    if (out.kind === "skipped") expect(out.reason).toBe("no_messages")
  })
})

describe("runPhase1 — happy path (distilled outcome)", () => {
  test("returns kind='distilled' with Stage1Output assembled correctly", async () => {
    const store = new Stage1Store(new Database(":memory:"))
    const out = await runPhase1(baseInput(), okPort, store)
    expect(out.kind).toBe("distilled")
    if (out.kind !== "distilled") throw new Error("unreachable")
    expect(out.stage1.threadId).toBe("thr-1")
    expect(out.stage1.rolloutSlug).toBe("sess-1") // derived from sessionId
    expect(out.stage1.rolloutSummary).toBe("summary")
    expect(out.stage1.rawMemory).toBe("raw")
    expect(out.stage1.preferenceSignals).toEqual(["pref-a"])
  })

  test("selectedForPhase2=true and selectedForPhase2SourceUpdatedAt=now()", async () => {
    const store = new Stage1Store(new Database(":memory:"))
    const out = await runPhase1(baseInput(), okPort, store)
    if (out.kind !== "distilled") throw new Error("unreachable")
    expect(out.stage1.selectedForPhase2).toBe(true)
    expect(out.stage1.selectedForPhase2SourceUpdatedAt).toBe(FIXED_NOW)
    expect(out.stage1.sourceUpdatedAt).toBe(FIXED_NOW)
  })

  test("lastUsage=null and usageCount=0 (Phase 2 hasn't seen this row yet)", async () => {
    const store = new Stage1Store(new Database(":memory:"))
    const out = await runPhase1(baseInput(), okPort, store)
    if (out.kind !== "distilled") throw new Error("unreachable")
    expect(out.stage1.lastUsage).toBeNull()
    expect(out.stage1.usageCount).toBe(0)
  })

  test("store.upsert is called exactly once with the returned Stage1Output", async () => {
    const { port, upserts } = makeRecordingStore()
    const out = await runPhase1(baseInput(), okPort, port)
    if (out.kind !== "distilled") throw new Error("unreachable")
    expect(upserts).toHaveLength(1)
    expect(upserts[0]).toEqual(out.stage1)
  })

  test("durationMs is computed via input.now() subtraction (deterministic)", async () => {
    // seqClock: entry latency clock → 1000; startedAt → 1100;
    // sourceUpdatedAt → 1200; duration end → 1300.
    // runPhase1 reports duration from startedAt, so 1300 - 1100 = 200.
    const clock = seqClock(1000, 100)
    const store = new Stage1Store(new Database(":memory:"))
    const out = await runPhase1(baseInput({ now: clock }), okPort, store)
    if (out.kind !== "distilled") throw new Error("unreachable")
    expect(out.stage1.sourceUpdatedAt).toBe(1200)
    expect(out.durationMs).toBe(200)
  })

  test("port.distill receives the exact rolloutMessages from input", async () => {
    let received: ReadonlyArray<{ role: string; content: unknown }> | undefined
    const capturePort: Phase1Port = {
      distill: async (args) => {
        received = args.rolloutMessages
        return { rolloutSummary: "s", rawMemory: "r", preferenceSignals: [] }
      },
    }
    const msgs = [
      { role: "user", content: "Q1" },
      { role: "assistant", content: "A1" },
      { role: "user", content: "Q2" },
    ]
    const store = new Stage1Store(new Database(":memory:"))
    await runPhase1(baseInput({ rolloutMessages: msgs }), capturePort, store)
    expect(received).toBe(msgs)
  })

  test("port.distill receives caller signal verbatim", async () => {
    const ac = new AbortController()
    let received: AbortSignal | undefined
    const capturePort: Phase1Port = {
      distill: async (args) => {
        received = args.signal
        return { rolloutSummary: "s", rawMemory: "r", preferenceSignals: [] }
      },
    }
    const store = new Stage1Store(new Database(":memory:"))
    await runPhase1(baseInput({ signal: ac.signal }), capturePort, store)
    expect(received).toBe(ac.signal)
  })

  test("happy-path row is queryable via fetchSince(null) on the real store", async () => {
    const store = new Stage1Store(new Database(":memory:"))
    await runPhase1(baseInput(), okPort, store)
    const rows = await store.fetchSince(null)
    expect(rows).toHaveLength(1)
    expect(nth(rows, 0, "rows").threadId).toBe("thr-1")
    expect(nth(rows, 0, "rows").preferenceSignals).toEqual(["pref-a"])
  })

  test("re-running Phase 1 for the same thread REPLACEs (1 row, latest values)", async () => {
    const store = new Stage1Store(new Database(":memory:"))
    await runPhase1(baseInput(), okPort, store)
    const port2: Phase1Port = {
      distill: async () => ({
        rolloutSummary: "v2",
        rawMemory: "raw2",
        preferenceSignals: ["pref-v2"],
      }),
    }
    await runPhase1(baseInput({ now: () => FIXED_NOW + 1000 }), port2, store)
    expect(await store.countSince(null)).toBe(1)
    const rows = await store.fetchSince(null)
    expect(nth(rows, 0, "rows").rolloutSummary).toBe("v2")
    expect(nth(rows, 0, "rows").preferenceSignals).toEqual(["pref-v2"])
    expect(nth(rows, 0, "rows").sourceUpdatedAt).toBe(FIXED_NOW + 1000)
  })

  test("disjoint threadIds → independent rows after two runPhase1 calls", async () => {
    const store = new Stage1Store(new Database(":memory:"))
    await runPhase1(baseInput({ threadId: "thr-a", sessionId: "sess-a" }), okPort, store)
    await runPhase1(baseInput({ threadId: "thr-b", sessionId: "sess-b" }), okPort, store)
    const rows = await store.fetchSince(null)
    expect(rows.map((r) => r.threadId).sort()).toEqual(["thr-a", "thr-b"])
  })

  test("preferenceSignals empty array roundtrip through Phase 1 → store", async () => {
    const store = new Stage1Store(new Database(":memory:"))
    const port: Phase1Port = {
      distill: async () => ({
        rolloutSummary: "s",
        rawMemory: "r",
        preferenceSignals: [],
      }),
    }
    await runPhase1(baseInput(), port, store)
    const rows = await store.fetchSince(null)
    expect(nth(rows, 0, "rows").preferenceSignals).toEqual([])
  })
})

describe("runPhase1 — error propagation (no silent catch)", () => {
  test("port.distill throws Error → Phase1DistillError with threadId", async () => {
    const failingPort: Phase1Port = {
      distill: async () => {
        throw new Error("LLM-timeout")
      },
    }
    const { port, upserts } = makeRecordingStore()
    await expect(
      runPhase1(baseInput({ threadId: "thr-err" }), failingPort, port),
    ).rejects.toBeInstanceOf(Phase1DistillError)
    // upsert MUST NOT have been called when distill failed.
    expect(upserts).toHaveLength(0)
  })

  test("Phase1DistillError carries the threadId and wraps the message", async () => {
    const failingPort: Phase1Port = {
      distill: async () => {
        throw new Error("LLM-timeout")
      },
    }
    const { port } = makeRecordingStore()
    try {
      await runPhase1(baseInput({ threadId: "thr-err" }), failingPort, port)
      throw new Error("expected runPhase1 to throw")
    } catch (e) {
      expect(e).toBeInstanceOf(Phase1DistillError)
      const err = e as Phase1DistillError
      expect(err.threadId).toBe("thr-err")
      expect(err.message).toContain("thr-err")
      expect(err.message).toContain("LLM-timeout")
      // cause is preserved for triage.
      expect((err as Phase1DistillError & { cause?: unknown }).cause).toBeInstanceOf(Error)
    }
  })

  test("port.distill rejects with non-Error value → Phase1DistillError still thrown", async () => {
    const failingPort: Phase1Port = {
      distill: () => Promise.reject("plain-string-rejection"),
    }
    const { port } = makeRecordingStore()
    await expect(runPhase1(baseInput(), failingPort, port)).rejects.toBeInstanceOf(
      Phase1DistillError,
    )
  })

  test("AbortError from port.distill propagates unchanged", async () => {
    const aborted = new Error("cancelled by caller")
    aborted.name = "AbortError"
    const failingPort: Phase1Port = {
      distill: async () => {
        throw aborted
      },
    }
    const { port, upserts } = makeRecordingStore()
    const caught = await runPhase1(
      baseInput({ signal: new AbortController().signal }),
      failingPort,
      port,
    ).catch((err: unknown) => err)
    expect(caught).toBe(aborted)
    expect(upserts).toHaveLength(0)
  })

  test("store.upsert throws → original error propagates (not wrapped)", async () => {
    const { port, upserts } = makeRecordingStore(() => Promise.reject(new Error("sqlite-locked")))
    await expect(runPhase1(baseInput(), okPort, port)).rejects.toThrow(/sqlite-locked/)
    // recording wrapper still pushed before the rejection
    expect(upserts).toHaveLength(1)
  })

  test("store.upsert throw is NOT wrapped in Phase1DistillError", async () => {
    const { port } = makeRecordingStore(() => Promise.reject(new Error("disk-full")))
    let caught: unknown
    try {
      await runPhase1(baseInput(), okPort, port)
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(Error)
    expect(caught).not.toBeInstanceOf(Phase1DistillError)
  })
})
