/**
 * R5 audit-H4 closeout — `rebuildCriteria` / `rebuildBlockers` truncation is
 * observable via `logger.warn`.
 *
 * Pre-fix: the snapshot rebuild path (`fromSnapshot` → `cellFromObjective` →
 * `rebuildCriteria` / `rebuildBlockers`) silently truncated past
 * `MAX_CRITERIA_PER_OBJECTIVE = 256` / `MAX_BLOCKERS_PER_OBJECTIVE = 64`.
 * Operators inspecting "why did my snapshot lose data" had zero signal.
 *
 * Post-fix: when `raw.length` exceeds the cap, the rebuild path emits a
 * single `logger.warn` with a stable colon-prefixed label so:
 *   - operators can grep `objective.rebuild.truncate:` for the signal
 *   - the label-keyed leaky bucket in `logger.ts` rate-limits a replay
 *     flood (one bucket per label, not per call)
 *   - the warn line reports both the incoming count AND the cap so the
 *     diagnosis is self-contained
 *
 * Four cases:
 *   (1) over-cap criteria snapshot — warn emitted with stable label + counts
 *   (2) over-cap blockers snapshot — warn emitted with stable label + counts
 *   (3) under-cap healthy snapshot — NO warn (silent on the happy path)
 *   (4) at-cap boundary snapshot   — NO warn (boundary is "no truncation")
 *
 * Replay against pre-fix tree → (1)(2) flip RED (no warn emitted).
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test"
import { createObjectiveStore } from "@/objective"
import { __resetLoggerRateLimit, __resetRuntimeConfig, setTerminalIo } from "@/shared"

let captured: string[] = []

beforeEach(() => {
  captured = []
  setTerminalIo({
    stdout: () => {},
    stderr: (chunk) => captured.push(chunk),
  })
  __resetLoggerRateLimit()
  __resetRuntimeConfig()
})

afterAll(() => {
  setTerminalIo(null)
})

const stderrText = (): string => captured.join("")

const makeCriterion = (i: number) => ({
  id: `c-${i}`,
  text: `criterion ${i}`,
  met: false,
  kind: "manual" as const,
})
const makeBlocker = (i: number) => ({
  id: `b-${i}`,
  reason: `blocker ${i}`,
  waitingOn: "user" as const,
  since: 1_000_000 + i,
})

describe("R5 audit-H4 — objective rebuild truncation observability", () => {
  test("(1) over-cap criteria emits logger.warn with stable label + counts", () => {
    const store = createObjectiveStore()
    store.fromSnapshot({
      objectives: [
        {
          threadId: "t1",
          objectiveId: "obj-t1",
          createdBy: "system" as const,
          attempts: { autonomousTurnsStarted: 0 },
          goal: "g",
          successCriteria: Array.from({ length: 1000 }, (_, i) => makeCriterion(i)),
          status: "active" as const,
          budget: { tokensUsed: 0, turnsUsed: 0 },
          blockers: [],
          blockerObservations: [],
          nextActions: [],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    })
    const o = stderrText()
    // Stable label (operator-grep contract).
    expect(o.includes("objective.rebuild.truncate:")).toBe(true)
    // Reports the incoming count.
    expect(o.includes("criteria=1000")).toBe(true)
    // Reports the cap (so diagnosis is self-contained).
    expect(o.includes("capped to 256")).toBe(true)
    // Severity is warn (not error — truncation is degraded-but-safe).
    expect(o.includes("[warn]")).toBe(true)
    // Truncation still happened — invariant unchanged.
    expect(store.get("t1")?.successCriteria.length).toBe(256)
  })

  test("(2) over-cap blockers emits logger.warn with stable label + counts", () => {
    const store = createObjectiveStore()
    store.fromSnapshot({
      objectives: [
        {
          threadId: "t2",
          objectiveId: "obj-t2",
          createdBy: "system" as const,
          attempts: { autonomousTurnsStarted: 0 },
          goal: "g",
          successCriteria: [],
          status: "blocked" as const,
          budget: { tokensUsed: 0, turnsUsed: 0 },
          blockers: Array.from({ length: 500 }, (_, i) => makeBlocker(i)),
          blockerObservations: [],
          nextActions: [],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    })
    const o = stderrText()
    expect(o.includes("objective.rebuild.truncate:")).toBe(true)
    expect(o.includes("blockers=500")).toBe(true)
    expect(o.includes("capped to 64")).toBe(true)
    expect(o.includes("[warn]")).toBe(true)
    expect(store.get("t2")?.blockers.length).toBe(64)
  })

  test("(3) under-cap snapshot emits NO truncate warn (silent happy path)", () => {
    const store = createObjectiveStore()
    store.fromSnapshot({
      objectives: [
        {
          threadId: "t3",
          objectiveId: "obj-t3",
          createdBy: "system" as const,
          attempts: { autonomousTurnsStarted: 0 },
          goal: "g",
          successCriteria: Array.from({ length: 200 }, (_, i) => makeCriterion(i)),
          status: "active" as const,
          budget: { tokensUsed: 0, turnsUsed: 0 },
          blockers: Array.from({ length: 30 }, (_, i) => makeBlocker(i)),
          blockerObservations: [],
          nextActions: [],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    })
    const o = stderrText()
    expect(o.includes("objective.rebuild.truncate:")).toBe(false)
    expect(store.get("t3")?.successCriteria.length).toBe(200)
    expect(store.get("t3")?.blockers.length).toBe(30)
  })

  test("(4) at-cap boundary (256 / 64) emits NO truncate warn", () => {
    // Boundary case: raw.length == cap. No truncation occurs → no warn.
    const store = createObjectiveStore()
    store.fromSnapshot({
      objectives: [
        {
          threadId: "t4",
          objectiveId: "obj-t4",
          createdBy: "system" as const,
          attempts: { autonomousTurnsStarted: 0 },
          goal: "g",
          successCriteria: Array.from({ length: 256 }, (_, i) => makeCriterion(i)),
          status: "active" as const,
          budget: { tokensUsed: 0, turnsUsed: 0 },
          blockers: Array.from({ length: 64 }, (_, i) => makeBlocker(i)),
          blockerObservations: [],
          nextActions: [],
          createdAt: 1,
          updatedAt: 2,
        },
      ],
    })
    const o = stderrText()
    expect(o.includes("objective.rebuild.truncate:")).toBe(false)
    expect(store.get("t4")?.successCriteria.length).toBe(256)
    expect(store.get("t4")?.blockers.length).toBe(64)
  })
})
