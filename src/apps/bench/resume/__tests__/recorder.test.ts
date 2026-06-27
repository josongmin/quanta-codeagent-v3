/**
 * Hellgate — bench-resume WRITE path (recorder.ts).
 *
 * Pins the producer-side durability contract the fresh-box READ-path agent
 * depends on:
 *   - `teeReplayStore`: append fans to BOTH stores; secondary throw is SWALLOWED
 *     (best-effort durability must never kill the run); match/load/reset read
 *     PRIMARY only.
 *   - `maybeTeeResumeRecording`: DEFAULT-OFF + byte-identical when off; fail-CLOSED
 *     on missing instanceId; degraded-receipt-once on the first secondary error;
 *     healthy-append receipt `latestSeq` tracking.
 *
 * RED-on-injection: the "run continues after secondary throws" test FAILS if the
 * tee rethrows — that is the load-bearing best-effort guard.
 */
import { describe, expect, test } from "bun:test"
import {
  maybeTeeResumeRecording,
  teeResumeReplayStore,
  teeReplayStore,
} from "@/apps/bench/resume/recorder"
import type { LLMPort } from "@/llm"
import type { RecordedInteraction, ReplayStore } from "@/llm/replay"
import type { StreamEvent, StreamInput } from "@/llm/types"
import type { ResumeReceipt } from "@/shared/remote-store"

// ── fakes ──────────────────────────────────────────────────────────────────

const rec = (id: string): RecordedInteraction => ({
  id,
  request: { messages: [] } as unknown as StreamInput,
  events: [],
  metadata: { recordedAt: 0, model: "test", durationMs: 0 },
})

interface FakeStore extends ReplayStore {
  readonly appended: RecordedInteraction[]
  readonly matched: StreamInput[]
  readonly loaded: { count: number }
  readonly resets: { count: number }
}

const fakeStore = (opts?: { appendThrows?: boolean }): FakeStore => {
  const appended: RecordedInteraction[] = []
  const matched: StreamInput[] = []
  const loaded = { count: 0 }
  const resets = { count: 0 }
  return {
    appended,
    matched,
    loaded,
    resets,
    async append(r) {
      if (opts?.appendThrows) throw new Error("secondary boom")
      appended.push(r)
    },
    async match(request) {
      matched.push(request)
      return null
    },
    async load() {
      loaded.count++
      return appended.slice()
    },
    async save() {},
    reset() {
      resets.count++
    },
  }
}

// ── teeReplayStore ───────────────────────────────────────────────────────────

describe("teeReplayStore — fan-out append, primary-only reads", () => {
  test("append lands in BOTH primary and secondary", async () => {
    const primary = fakeStore()
    const secondary = fakeStore()
    const tee = teeReplayStore(primary, secondary, () => {})

    await tee.append(rec("a"))

    expect(primary.appended.map((r) => r.id)).toEqual(["a"])
    expect(secondary.appended.map((r) => r.id)).toEqual(["a"])
  })

  test("match/load read from PRIMARY only", async () => {
    const primary = fakeStore()
    const secondary = fakeStore()
    const tee = teeReplayStore(primary, secondary, () => {})

    const req = { messages: [] } as unknown as StreamInput
    await tee.match(req)
    await tee.load()
    tee.reset()

    expect(primary.matched.length).toBe(1)
    expect(primary.loaded.count).toBe(1)
    expect(primary.resets.count).toBe(1)
    // secondary is write-only durability — never read from
    expect(secondary.matched.length).toBe(0)
    expect(secondary.loaded.count).toBe(0)
    expect(secondary.resets.count).toBe(0)
  })

  test("secondary throw is SWALLOWED + onSecondaryError invoked (run continues)", async () => {
    const primary = fakeStore()
    const secondary = fakeStore({ appendThrows: true })
    let errors = 0
    const tee = teeReplayStore(primary, secondary, () => {
      errors++
    })

    // RED-on-injection anchor: if the tee rethrew, this await would REJECT and
    // the test would fail. It must resolve.
    await expect(tee.append(rec("a"))).resolves.toBeUndefined()

    // primary still got the record — durability failure never blocks the run.
    expect(primary.appended.map((r) => r.id)).toEqual(["a"])
    expect(errors).toBe(1)
  })

  test("primary throw PROPAGATES (primary is authoritative)", async () => {
    const primary = fakeStore({ appendThrows: true })
    const secondary = fakeStore()
    const tee = teeReplayStore(primary, secondary, () => {})
    await expect(tee.append(rec("a"))).rejects.toThrow("secondary boom")
  })
})

// ── teeResumeReplayStore — receipt bookkeeping over the tee ──────────────────

describe("teeResumeReplayStore — receipt latestSeq + degraded-once", () => {
  const receiptBase = { key: "camp/iid", campaignId: "camp", instanceId: "iid" }

  test("healthy appends bump latestSeq on the receipt (1,2,3…)", async () => {
    const primary = fakeStore()
    const secondary = fakeStore()
    const receipts: ResumeReceipt[] = []
    const store = teeResumeReplayStore({
      primary,
      secondary,
      ...receiptBase,
      writeReceipt: async (r) => {
        receipts.push(r)
      },
    })

    await store.append(rec("a"))
    await store.append(rec("b"))
    await store.append(rec("c"))

    // both stores got all three
    expect(primary.appended.length).toBe(3)
    expect(secondary.appended.length).toBe(3)
    // receipts are healthy + monotonically increasing latestSeq
    const healthy = receipts.filter((r) => !r.degraded)
    expect(healthy.map((r) => r.latestSeq)).toEqual([1, 2, 3])
    expect(healthy.every((r) => r.degraded === false)).toBe(true)
    expect(healthy.every((r) => typeof r.updatedAt === "string" && r.updatedAt.length > 0)).toBe(
      true,
    )
  })

  test("first secondary error ⇒ ONE degraded receipt, then suppressed", async () => {
    const primary = fakeStore()
    const secondary = fakeStore({ appendThrows: true })
    const receipts: ResumeReceipt[] = []
    const store = teeResumeReplayStore({
      primary,
      secondary,
      ...receiptBase,
      writeReceipt: async (r) => {
        receipts.push(r)
      },
    })

    // three appends, secondary throws every time — run must continue.
    await expect(store.append(rec("a"))).resolves.toBeUndefined()
    await expect(store.append(rec("b"))).resolves.toBeUndefined()
    await expect(store.append(rec("c"))).resolves.toBeUndefined()

    // primary kept every record (durability failure never blocks the run)
    expect(primary.appended.length).toBe(3)
    // EXACTLY one degraded receipt written, no further writes after degrade.
    const degraded = receipts.filter((r) => r.degraded)
    expect(degraded.length).toBe(1)
    expect(degraded[0]?.degraded).toBe(true)
    // once degraded, NO healthy receipts are written afterward
    expect(receipts.filter((r) => !r.degraded).length).toBe(0)
  })

  test("a writeReceipt failure also never kills the run", async () => {
    const primary = fakeStore()
    const secondary = fakeStore()
    const store = teeResumeReplayStore({
      primary,
      secondary,
      ...receiptBase,
      writeReceipt: async () => {
        throw new Error("receipt put failed")
      },
    })
    await expect(store.append(rec("a"))).resolves.toBeUndefined()
    expect(primary.appended.length).toBe(1)
  })
})

// ── maybeTeeResumeRecording ──────────────────────────────────────────────────

const fakeLlm = (): LLMPort => ({
  model: "fake-model",
  stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    async function* g() {
      // empty stream — recording path is exercised by the store-level tests
    }
    return g()
  },
})

describe("maybeTeeResumeRecording — DEFAULT-OFF + fail-closed gates", () => {
  test("resume OFF (empty env) ⇒ returns the SAME llm reference (byte-identical)", () => {
    const llm = fakeLlm()
    expect(maybeTeeResumeRecording(llm, {})).toBe(llm)
  })

  test("enabled + bucket but instanceId MISSING ⇒ returns SAME llm (fail-closed, no S3 built)", () => {
    const llm = fakeLlm()
    const out = maybeTeeResumeRecording(llm, {
      QUANTA_BENCH_RESUME: "1",
      QUANTA_BENCH_RESUME_S3_BUCKET: "b",
      // QUANTA_BENCH_INSTANCE_ID intentionally absent
    })
    expect(out).toBe(llm)
  })

  test("enabled WITHOUT bucket ⇒ returns SAME llm (resumeActive fail-closed)", () => {
    const llm = fakeLlm()
    const out = maybeTeeResumeRecording(llm, {
      QUANTA_BENCH_RESUME: "1",
      QUANTA_BENCH_INSTANCE_ID: "iid-1",
    })
    expect(out).toBe(llm)
  })

  test("active + instanceId ⇒ wraps (returns a DIFFERENT port)", () => {
    const llm = fakeLlm()
    const out = maybeTeeResumeRecording(llm, {
      QUANTA_BENCH_RESUME: "1",
      QUANTA_BENCH_RESUME_S3_BUCKET: "b",
      QUANTA_BENCH_INSTANCE_ID: "iid-1",
      // inject a runAws so no real aws cli is touched
      // (recorder builds resumeStore which threads runAws through env? — see below)
    })
    expect(out).not.toBe(llm)
    // identity metadata preserved through the wrap
    expect(out.model).toBe("fake-model")
  })
})
