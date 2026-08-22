import { describe, expect, test } from "bun:test"
import { toSessionHostTurnEvent } from "../../../src/host/runtime/internal/session-host-turn-event-bridge"
import { FULL_FIDELITY_MAX_CHARS } from "../../../src/shared"

/**
 * Ticket 04 (S1) — wire fidelity opt-in, PRODUCTION layer hellgate.
 *
 * Invariant chain:
 *  1. gate OFF (default) ⇒ the bridge emits ZERO full fields — `argsFull` /
 *     `resultFull` / `fidelityDegraded` are ABSENT, byte-identical to legacy.
 *  2. gate ON ⇒ the FULL model-visible args/result are carried alongside the
 *     preview (the preview itself is unchanged — the two coexist).
 *  3. gate ON + over-cap payload ⇒ the full field is DROPPED (not truncated) and
 *     `fidelityDegraded: true` is stamped.
 */

const TOOL_CALL = { type: "tool_call", id: "c1", name: "bash", input: { cmd: "pwd" } } as const
const TOOL_RESULT = {
  type: "tool_result",
  id: "c1",
  name: "bash",
  ok: true,
  preview: "the-full-model-visible-output",
} as const

describe("S1 — full-fidelity production gate (default-OFF byte-identical)", () => {
  test("gate OFF: tool.invoked carries NO argsFull / fidelityDegraded", () => {
    const invoked = toSessionHostTurnEvent(TOOL_CALL) // no opts ⇒ OFF
    expect(invoked?.type).toBe("tool.invoked")
    expect(invoked).not.toHaveProperty("argsFull")
    expect(invoked).not.toHaveProperty("fidelityDegraded")
    // The preview channel is UNCHANGED (byte-identical to legacy).
    if (invoked?.type !== "tool.invoked") throw new Error("wrong type")
    expect(invoked.argsPreview).toBe(JSON.stringify({ cmd: "pwd" }))
  })

  test("gate OFF explicit-false: still no full fields", () => {
    const invoked = toSessionHostTurnEvent(TOOL_CALL, { fullFidelity: false })
    expect(invoked).not.toHaveProperty("argsFull")
    const completed = toSessionHostTurnEvent(TOOL_RESULT, { fullFidelity: false })
    expect(completed).not.toHaveProperty("resultFull")
  })

  test("gate OFF: tool.completed carries NO resultFull / fidelityDegraded", () => {
    const completed = toSessionHostTurnEvent(TOOL_RESULT)
    expect(completed?.type).toBe("tool.completed")
    expect(completed).not.toHaveProperty("resultFull")
    expect(completed).not.toHaveProperty("fidelityDegraded")
  })
})

describe("S1 — full-fidelity production gate (ON)", () => {
  test("gate ON: tool.invoked carries the FULL args verbatim ALONGSIDE the preview", () => {
    const invoked = toSessionHostTurnEvent(TOOL_CALL, { fullFidelity: true })
    if (invoked?.type !== "tool.invoked") throw new Error("wrong type")
    expect(invoked.argsFull).toBe(JSON.stringify({ cmd: "pwd" }))
    // Preview STILL present — the two coexist (full is additive).
    expect(invoked.argsPreview).toBe(JSON.stringify({ cmd: "pwd" }))
    expect(invoked).not.toHaveProperty("fidelityDegraded")
  })

  test("gate ON: tool.completed carries the FULL result verbatim", () => {
    const completed = toSessionHostTurnEvent(TOOL_RESULT, { fullFidelity: true })
    if (completed?.type !== "tool.completed") throw new Error("wrong type")
    expect(completed.resultFull).toBe("the-full-model-visible-output")
    expect(completed.resultPreview).toBe("the-full-model-visible-output")
    expect(completed).not.toHaveProperty("fidelityDegraded")
  })

  test("gate ON: a >256-char result carries the FULL body on resultFull while the preview stays clamped", () => {
    const big = "x".repeat(1000)
    const completed = toSessionHostTurnEvent(
      { ...TOOL_RESULT, preview: big },
      { fullFidelity: true },
    )
    if (completed?.type !== "tool.completed") throw new Error("wrong type")
    // resultFull is the WHOLE 1000-char body; the preview is the clamped ~256.
    expect(completed.resultFull).toBe(big)
    expect(completed.resultPreview?.length).toBeLessThan(300)
    expect(completed.resultPreview).not.toBe(big)
  })
})

describe("S1 — cap → degrade (red-on-injection)", () => {
  test("gate ON + over-cap args: full DROPPED + fidelityDegraded stamped", () => {
    const huge = "a".repeat(FULL_FIDELITY_MAX_CHARS + 1)
    const invoked = toSessionHostTurnEvent(
      { type: "tool_call", id: "c1", name: "bash", input: huge },
      { fullFidelity: true },
    )
    if (invoked?.type !== "tool.invoked") throw new Error("wrong type")
    // The FULL field is DROPPED (not truncated to a partial lie)…
    expect(invoked).not.toHaveProperty("argsFull")
    // …and the honest degrade flag is set. If the cap check were removed and the
    // whole payload carried, THIS assertion goes red (red-on-injection).
    expect(invoked.fidelityDegraded).toBe(true)
    // The preview is still there — a consumer falls back to it.
    expect(invoked.argsPreview).toBeDefined()
  })

  test("gate ON + over-cap result: full DROPPED + fidelityDegraded stamped", () => {
    const huge = "b".repeat(FULL_FIDELITY_MAX_CHARS + 1)
    const completed = toSessionHostTurnEvent(
      { ...TOOL_RESULT, preview: huge },
      { fullFidelity: true },
    )
    if (completed?.type !== "tool.completed") throw new Error("wrong type")
    expect(completed).not.toHaveProperty("resultFull")
    expect(completed.fidelityDegraded).toBe(true)
  })

  test("gate ON + exactly-at-cap: carried, NOT degraded (boundary)", () => {
    const atCap = "c".repeat(FULL_FIDELITY_MAX_CHARS)
    const completed = toSessionHostTurnEvent(
      { ...TOOL_RESULT, preview: atCap },
      { fullFidelity: true },
    )
    if (completed?.type !== "tool.completed") throw new Error("wrong type")
    expect(completed.resultFull).toBe(atCap)
    expect(completed).not.toHaveProperty("fidelityDegraded")
  })
})
