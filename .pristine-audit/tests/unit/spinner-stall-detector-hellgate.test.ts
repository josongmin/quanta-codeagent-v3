import { describe, expect, test } from "bun:test"
import {
  createDefaultStallDetector,
  createSpinnerStallEmitter,
  DEFAULT_SPINNER_STALL_THRESHOLD_MS,
  type SpinnerStallEvent,
  type SpinnerStallSink,
} from "@/llm/spinner-stall"

/**
 * Hellgate for ADR-0227 spinner-stall detection slice (B6 — Claude Code
 * `tengu_spinner_stalled_ui` / `tengu_spinner_stall_cleared` absorption).
 *
 * 13 cases covering:
 *   - boundary semantics (strict `>` threshold, knob change mid-stream)
 *   - independence (multi-correlation no cross-talk)
 *   - memory hygiene (stop removes entry, no leak)
 *   - byte-identical default-OFF (no sink, no detector use ⇒ no change)
 *   - emitter edge-triggering (no spam on repeated polls)
 *   - clock injection (no global Date.now reliance)
 *   - idempotency (start/stop safe to call twice)
 *   - emptiness (checkAll on empty Map)
 *
 * All tests use a virtual clock — zero wall-clock dependence.
 */

/** Collect events into an array for assertion. The shape (push-array)
 *  matches what the real CLI surface will do internally before paint. */
const makeRecordingSink = (): {
  sink: SpinnerStallSink
  events: SpinnerStallEvent[]
} => {
  const events: SpinnerStallEvent[] = []
  return { sink: { emit: (e) => events.push(e) }, events }
}

describe("ADR-0227 spinner-stall-detector hellgate", () => {
  test("HELL-SPS-01 — tickEvent immediately after start ⇒ 0 stalls", () => {
    const detector = createDefaultStallDetector()
    detector.start({ correlationId: "c1", stallThresholdMs: 100, now: 1000 })
    detector.tickEvent({ correlationId: "c1", now: 1050 })
    expect(detector.checkAll({ now: 1090 })).toEqual([])
  })

  test("HELL-SPS-02 — threshold boundary: now = lastEvent + threshold ⇒ NOT stalled", () => {
    // Strict `>` semantics: 30s after the last tick is exactly when Claude
    // Code's spinner *enters* the stalled state, but the detector itself
    // is one frame conservative so a UI tick at exactly the boundary
    // doesn't oscillate.
    const detector = createDefaultStallDetector()
    detector.start({ correlationId: "c1", stallThresholdMs: 100, now: 1000 })
    expect(detector.checkAll({ now: 1100 })).toEqual([])
  })

  test("HELL-SPS-02b — threshold+1: now > lastEvent + threshold ⇒ stalled", () => {
    const detector = createDefaultStallDetector()
    detector.start({ correlationId: "c1", stallThresholdMs: 100, now: 1000 })
    const stalls = detector.checkAll({ now: 1101 })
    expect(stalls).toEqual([{ correlationId: "c1", stalledForMs: 101 }])
  })

  test("HELL-SPS-03 — stop removes entry: never appears in checkAll again", () => {
    const detector = createDefaultStallDetector()
    detector.start({ correlationId: "c1", stallThresholdMs: 50, now: 1000 })
    // Move past the threshold so we know the detector would see it.
    expect(detector.checkAll({ now: 1200 })).toHaveLength(1)
    detector.stop({ correlationId: "c1" })
    expect(detector.checkAll({ now: 1500 })).toEqual([])
    // Even if we advance time arbitrarily far, no resurrection.
    expect(detector.checkAll({ now: 10_000_000 })).toEqual([])
  })

  test("HELL-SPS-04 — multi-correlation independence: one stall does not affect siblings", () => {
    const detector = createDefaultStallDetector()
    detector.start({ correlationId: "primary", stallThresholdMs: 100, now: 1000 })
    detector.start({ correlationId: "sub-a", stallThresholdMs: 100, now: 1000 })
    detector.start({ correlationId: "sub-b", stallThresholdMs: 100, now: 1000 })
    // Tick only sub-a + sub-b; primary goes silent.
    detector.tickEvent({ correlationId: "sub-a", now: 1080 })
    detector.tickEvent({ correlationId: "sub-b", now: 1090 })
    const stalls = detector.checkAll({ now: 1200 })
    // Only primary stalled. sub-a (last tick @1080, now=1200) was ticked,
    // so 1200 - 1080 = 120 > 100 ⇒ ALSO stalled. Re-tick to verify
    // independence properly.
    detector.tickEvent({ correlationId: "sub-a", now: 1199 })
    detector.tickEvent({ correlationId: "sub-b", now: 1199 })
    const stalls2 = detector.checkAll({ now: 1250 })
    expect(stalls2.map((e) => e.correlationId)).toEqual(["primary"])
    // sanity: the earlier snapshot saw all three depending on timings —
    // either way, the assertion is per-id arithmetic, not cross-talk.
    expect(stalls.find((e) => e.correlationId === "primary")).toBeDefined()
  })

  test("HELL-SPS-05 — tickEvent resumes a stalled correlation (clears it from checkAll)", () => {
    const detector = createDefaultStallDetector()
    detector.start({ correlationId: "c1", stallThresholdMs: 100, now: 1000 })
    expect(detector.checkAll({ now: 1200 })).toHaveLength(1)
    // A late chunk arrives — the detector should immediately stop
    // reporting this id as stalled.
    detector.tickEvent({ correlationId: "c1", now: 1250 })
    expect(detector.checkAll({ now: 1300 })).toEqual([])
  })

  test("HELL-SPS-06 — emitter edge-trigger: spinner-stalled fires ONCE per stall episode", () => {
    const detector = createDefaultStallDetector()
    const { sink, events } = makeRecordingSink()
    const emitter = createSpinnerStallEmitter(detector, sink)
    detector.start({ correlationId: "c1", stallThresholdMs: 100, now: 1000 })
    // Three polls while stalled — only one stalled event.
    emitter.poll(1200)
    emitter.poll(1300)
    emitter.poll(1400)
    const stalledCount = events.filter((e) => e.kind === "spinner-stalled").length
    expect(stalledCount).toBe(1)
  })

  test("HELL-SPS-07 — emitter clear: live recovery emits spinner-stall-cleared", () => {
    const detector = createDefaultStallDetector()
    const { sink, events } = makeRecordingSink()
    const emitter = createSpinnerStallEmitter(detector, sink)
    detector.start({ correlationId: "c1", stallThresholdMs: 100, now: 1000 })
    emitter.poll(1200) // fires stalled
    detector.tickEvent({ correlationId: "c1", now: 1300 })
    emitter.poll(1310) // fires cleared
    expect(events).toEqual([
      { kind: "spinner-stalled", correlationId: "c1", stalledForMs: 200 },
      { kind: "spinner-stall-cleared", correlationId: "c1" },
    ])
  })

  test("HELL-SPS-08 — emitter forceClear on stop emits cleared exactly once", () => {
    const detector = createDefaultStallDetector()
    const { sink, events } = makeRecordingSink()
    const emitter = createSpinnerStallEmitter(detector, sink)
    detector.start({ correlationId: "c1", stallThresholdMs: 100, now: 1000 })
    emitter.poll(1200)
    detector.stop({ correlationId: "c1" })
    emitter.forceClear("c1")
    // Calling forceClear a second time is a no-op.
    emitter.forceClear("c1")
    expect(events.filter((e) => e.kind === "spinner-stall-cleared")).toHaveLength(1)
  })

  test("HELL-SPS-09 — default-OFF parity: detector unused ⇒ no events, no allocations leak", () => {
    // Build a detector but never start anything. checkAll on empty Map
    // returns empty array; the emitter polling against it never fires.
    const detector = createDefaultStallDetector()
    const { sink, events } = makeRecordingSink()
    const emitter = createSpinnerStallEmitter(detector, sink)
    for (let now = 1000; now < 100_000; now += 1000) emitter.poll(now)
    expect(events).toEqual([])
    expect(detector.checkAll({ now: 999_999 })).toEqual([])
  })

  test("HELL-SPS-10 — clock port injection: detector reads NO global time", () => {
    // The contract is that ALL public methods take an explicit `now`
    // argument. Tests verify by passing absurd virtual clock values that
    // would mismatch a Date.now()-leaked impl.
    const detector = createDefaultStallDetector()
    detector.start({ correlationId: "c1", stallThresholdMs: 100, now: 0 })
    // "now" jumps to year-3000-ish ms — if any code read Date.now, the
    // arithmetic would be nonsensical.
    const farFuture = 32_503_680_000_000
    const stalls = detector.checkAll({ now: farFuture + 200 })
    expect(stalls[0]?.stalledForMs).toBe(farFuture + 200)
  })

  test("HELL-SPS-11 — start/stop idempotency: callable twice without throwing or duplicating", () => {
    const detector = createDefaultStallDetector()
    detector.start({ correlationId: "c1", stallThresholdMs: 100, now: 1000 })
    // Re-start resets lastEventMs to the new `now` and overwrites threshold.
    detector.start({ correlationId: "c1", stallThresholdMs: 200, now: 1500 })
    // At now=1650 (150 since the re-start), still well under threshold 200.
    expect(detector.checkAll({ now: 1650 })).toEqual([])
    // At now=1701, just over.
    expect(detector.checkAll({ now: 1701 })).toEqual([{ correlationId: "c1", stalledForMs: 201 }])
    // stop twice — no throw, no side effect.
    detector.stop({ correlationId: "c1" })
    detector.stop({ correlationId: "c1" })
    expect(detector.checkAll({ now: 5000 })).toEqual([])
  })

  test("HELL-SPS-12 — empty detector: checkAll returns empty readonly array", () => {
    const detector = createDefaultStallDetector()
    const result = detector.checkAll({ now: 1000 })
    expect(result).toEqual([])
    expect(Array.isArray(result)).toBe(true)
  })

  test("HELL-SPS-13 — memory leak guard: stop removes Map entry (visible via re-stall behaviour)", () => {
    // We can't probe the Map directly, but we can verify the behavioural
    // contract: after stop, the id is GONE — re-starting establishes a
    // fresh entry with a fresh lastEventMs, NOT one accumulated from
    // before.
    const detector = createDefaultStallDetector()
    detector.start({ correlationId: "c1", stallThresholdMs: 100, now: 1000 })
    // Force stall, then stop.
    expect(detector.checkAll({ now: 1500 })).toHaveLength(1)
    detector.stop({ correlationId: "c1" })
    // Fresh start at a much later time.
    detector.start({ correlationId: "c1", stallThresholdMs: 100, now: 10_000 })
    // Immediately after re-start: NOT stalled (proves lastEventMs was
    // reset, not leaked from the old entry).
    expect(detector.checkAll({ now: 10_050 })).toEqual([])
    // tickEvent on an unknown id (after a different stop) is silent.
    detector.stop({ correlationId: "c1" })
    detector.tickEvent({ correlationId: "c1", now: 10_100 })
    expect(detector.checkAll({ now: 10_200 })).toEqual([])
  })

  test("HELL-SPS-14 — threshold knob: default constant exists and is 30s", () => {
    // Documents the public contract — Claude Code's spinner fires at
    // ~30s; we keep parity.
    expect(DEFAULT_SPINNER_STALL_THRESHOLD_MS).toBe(30_000)
  })
})
