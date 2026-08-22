/**
 * UUX-1-15 Hellgate — spinner-stall detector → operator-notice bus wire.
 *
 * Root cause: the ADR-0227 stall detector ticks in adapters (`onChunk`) but no
 * surface consumed the stall signal — a silent mid-turn provider stall was
 * invisible to the operator. The operator-notice bus (WS-G,
 * `src/shared/operator-notice.ts`) is the ONE seam for exactly this class.
 *
 * Fix under test: `wireStallDetectorToOperatorNotices(detector)` — co-located
 * with the detector slice so the COMPOSITION ROOT that constructs a detector
 * wires the notice sink in one call (NOT inside adapters; adapters only honor
 * the tick hook). Latch semantics ride the emitter's edge-triggering: ONE warn
 * per stall episode, recovery clears the latch (and surfaces an info), a new
 * episode warns again.
 *
 *   §1 stall DETECTED ⇒ exactly ONE latched warn notice (no spam across polls).
 *   §2 recovery clears the latch (info notice) and a NEW episode warns again.
 *   §3 no operator sink installed (headless/bench default) ⇒ polling is a
 *      total no-op, never throws (byte-identical posture).
 *   §4 a THROWING operator sink cannot poison the poll (bus no-throw contract).
 */

import { afterEach, describe, expect, test } from "bun:test"
import { createDefaultStallDetector } from "@/llm/spinner-stall"
import { wireStallDetectorToOperatorNotices } from "@/llm/spinner-stall/operator-notice-wire"
import {
  __resetOperatorNoticeSinkForTest,
  installOperatorNoticeSink,
  type OperatorNotice,
} from "@/shared/operator-notice"

afterEach(() => {
  __resetOperatorNoticeSinkForTest()
})

const capture = (): { notices: OperatorNotice[] } => {
  const notices: OperatorNotice[] = []
  installOperatorNoticeSink((n) => notices.push(n))
  return { notices }
}

const T0 = 1_000_000
const THRESHOLD = 30_000

describe("UUX-1-15 §1 — stall ⇒ ONE latched warn notice", () => {
  test("first poll past threshold warns once; repeat polls while stalled do NOT re-warn", () => {
    const { notices } = capture()
    const detector = createDefaultStallDetector()
    const emitter = wireStallDetectorToOperatorNotices(detector)
    detector.start({ correlationId: "c1", stallThresholdMs: THRESHOLD, now: T0 })

    emitter.poll(T0 + THRESHOLD + 1_000)
    expect(notices.length).toBe(1)
    expect(notices[0]?.severity).toBe("warn")
    expect(notices[0]?.message).toContain("stall")

    // Still stalled on later polls ⇒ the latch holds, no spam.
    emitter.poll(T0 + THRESHOLD + 5_000)
    emitter.poll(T0 + THRESHOLD + 60_000)
    expect(notices.filter((n) => n.severity === "warn").length).toBe(1)
  })

  test("no stall (ticking stream) ⇒ zero notices", () => {
    const { notices } = capture()
    const detector = createDefaultStallDetector()
    const emitter = wireStallDetectorToOperatorNotices(detector)
    detector.start({ correlationId: "c1", stallThresholdMs: THRESHOLD, now: T0 })
    detector.tickEvent({ correlationId: "c1", now: T0 + 20_000 })
    emitter.poll(T0 + 40_000) // 20s since last tick < threshold
    expect(notices).toEqual([])
  })
})

describe("UUX-1-15 §2 — recovery clears the latch; a NEW episode warns again", () => {
  test("stall → recover (info) → stall again ⇒ second warn", () => {
    const { notices } = capture()
    const detector = createDefaultStallDetector()
    const emitter = wireStallDetectorToOperatorNotices(detector)
    detector.start({ correlationId: "c1", stallThresholdMs: THRESHOLD, now: T0 })

    // Episode 1.
    emitter.poll(T0 + THRESHOLD + 1_000)
    // Recovery: a chunk arrives (the detector distinguishes recovery).
    const tRecover = T0 + THRESHOLD + 2_000
    detector.tickEvent({ correlationId: "c1", now: tRecover })
    emitter.poll(tRecover + 1_000)
    // Episode 2.
    emitter.poll(tRecover + THRESHOLD + 5_000)

    const warns = notices.filter((n) => n.severity === "warn")
    const infos = notices.filter((n) => n.severity === "info")
    expect(warns.length).toBe(2) // one per stall EPISODE
    expect(infos.length).toBe(1) // the recovery cleared the latch, surfaced once
  })

  test("explicit stop (turn ended) via forceClear also re-arms without a stray warn", () => {
    const { notices } = capture()
    const detector = createDefaultStallDetector()
    const emitter = wireStallDetectorToOperatorNotices(detector)
    detector.start({ correlationId: "c1", stallThresholdMs: THRESHOLD, now: T0 })
    emitter.poll(T0 + THRESHOLD + 1_000)
    detector.stop({ correlationId: "c1" })
    emitter.forceClear("c1")
    expect(notices.filter((n) => n.severity === "warn").length).toBe(1)
    // No further polls may warn for the stopped id.
    emitter.poll(T0 + THRESHOLD + 90_000)
    expect(notices.filter((n) => n.severity === "warn").length).toBe(1)
  })
})

describe("UUX-1-15 §3 — no operator sink installed ⇒ total no-op (headless/bench)", () => {
  test("polling a stalled detector without an installed sink emits nothing and never throws", () => {
    // NO installOperatorNoticeSink — the bus emit is a no-op by contract.
    const detector = createDefaultStallDetector()
    const emitter = wireStallDetectorToOperatorNotices(detector)
    detector.start({ correlationId: "c1", stallThresholdMs: THRESHOLD, now: T0 })
    expect(() => emitter.poll(T0 + THRESHOLD + 1_000)).not.toThrow()
  })
})

describe("UUX-1-15 §4 — a throwing operator sink cannot poison the poll", () => {
  test("sink throws ⇒ poll survives (bus no-throw contract holds through the wire)", () => {
    installOperatorNoticeSink(() => {
      throw new Error("hostile sink")
    })
    const detector = createDefaultStallDetector()
    const emitter = wireStallDetectorToOperatorNotices(detector)
    detector.start({ correlationId: "c1", stallThresholdMs: THRESHOLD, now: T0 })
    expect(() => emitter.poll(T0 + THRESHOLD + 1_000)).not.toThrow()
  })
})
