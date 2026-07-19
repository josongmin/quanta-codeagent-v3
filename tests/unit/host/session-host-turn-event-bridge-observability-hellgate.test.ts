/**
 * Hellgate — bridge expansion for the HIGH-VALUE observability events
 * (UUX-1-12/13). The AgentEvent→SessionHostTurnEvent bridge forwarded 7 types;
 * `tool_progress` / `recovery` / `context_compacted` / `budget_breach` were
 * DROPPED at the bridge (returned undefined) so the web surface never saw a
 * keyed progress notice, a compaction marker, a budget-cap crossing, or a
 * recovery trace. This gate pins the ADDITIVE expansion:
 *
 *   BE-01..04  each new AgentEvent bridges to its own NON-PROSE host event type
 *              (payload fields carried verbatim / clamped — drop a field ⇒ RED).
 *   BE-05      the new events NEVER ride the prose `assistant_text.delta`
 *              channel (the exact ALBB-18 display-corruption bug class).
 *   BE-06      `progress_update` stays EXCLUDED (documented decision).
 *   BE-07      projection: each new host event projects onto its own additive
 *              SessionEvent wire type with seq/revision bumped and NO transcript
 *              state mutation (pure observation).
 *   BE-08 ADV  long free-text payloads are clamped (a 1MB tool_progress message
 *              cannot bloat the wire frame).
 */
import { describe, expect, test } from "bun:test"
import { toSessionHostTurnEvent } from "../../../src/host/runtime/internal/session-host-turn-event-bridge"
import { createKernelSessionState } from "../../../src/kernel/session"
import { projectSessionHostTurnEvent } from "../../../src/kernel/session/session-host-turn-event-projection"
import { capabilitiesFor } from "../../support/session-fixtures"

const manifest = capabilitiesFor({ approvals: "operator", tools: true })

describe("bridge expansion — new observability events cross the bridge", () => {
  test("BE-01: tool_progress bridges to tool.progress (keyed by tool-call id)", () => {
    const bridged = toSessionHostTurnEvent({
      type: "tool_progress",
      id: "call_7",
      name: "bash",
      message: "installing dependencies",
    })
    expect(bridged).toEqual({
      type: "tool.progress",
      toolCallId: "call_7",
      toolName: "bash",
      message: "installing dependencies",
    })
  })

  test("BE-02: recovery bridges to recovery (reason + optional detail)", () => {
    expect(toSessionHostTurnEvent({ type: "recovery", reason: "backoff" })).toEqual({
      type: "recovery",
      reason: "backoff",
    })
    expect(
      toSessionHostTurnEvent({ type: "recovery", reason: "compact", detail: "window full" }),
    ).toEqual({ type: "recovery", reason: "compact", detail: "window full" })
  })

  test("BE-03: context_compacted bridges to context.compacted (archive payload)", () => {
    const bridged = toSessionHostTurnEvent({
      type: "context_compacted",
      fromTurnId: "t1",
      toTurnId: "t9",
      summary: "compacted 9 turns of exploration",
      ts: 1_760_000_000_000,
      tokens: 4200,
    })
    expect(bridged).toEqual({
      type: "context.compacted",
      fromTurnId: "t1",
      toTurnId: "t9",
      summary: "compacted 9 turns of exploration",
      ts: 1_760_000_000_000,
      tokens: 4200,
    })
  })

  test("BE-04: budget_breach bridges to budget.breach (severity/scope/observed/limit)", () => {
    const bridged = toSessionHostTurnEvent({
      type: "budget_breach",
      severity: "soft",
      scope: "session-abc",
      observed: 1.25,
      limit: 1.0,
    })
    expect(bridged).toEqual({
      type: "budget.breach",
      severity: "soft",
      scope: "session-abc",
      observed: 1.25,
      limit: 1.0,
    })
  })

  test("BE-05: none of the new events ride the prose assistant_text.delta channel", () => {
    const bridgedTypes = [
      toSessionHostTurnEvent({ type: "tool_progress", id: "c", name: "bash", message: "x" }),
      toSessionHostTurnEvent({ type: "recovery", reason: "nudge" }),
      toSessionHostTurnEvent({
        type: "context_compacted",
        fromTurnId: "a",
        toTurnId: "b",
        summary: "s",
        ts: 1,
        tokens: 1,
      }),
      toSessionHostTurnEvent({
        type: "budget_breach",
        severity: "hard",
        scope: "daily-2026-07-10",
        observed: 5,
        limit: 5,
      }),
    ].map((e) => e?.type)
    for (const t of bridgedTypes) {
      expect(t).toBeDefined()
      expect(t).not.toBe("assistant_text.delta")
    }
  })

  test("BE-06: progress_update stays EXCLUDED (do not relitigate ALBB-18)", () => {
    expect(
      toSessionHostTurnEvent({ type: "progress_update", currentStep: "resolving imports" }),
    ).toBeUndefined()
  })
})

describe("bridge expansion — kernel projection onto additive wire types", () => {
  const state = createKernelSessionState({
    sessionId: "obs-s1",
    permissionMode: "default",
    capabilityManifest: manifest,
  })
  const ctx = { state, commandId: "c1", emittedAt: "2026-07-10T00:00:00.000Z" }

  test("BE-07a: tool.progress projects to the tool.progress wire event (seq bumped, transcript untouched)", () => {
    const projected = projectSessionHostTurnEvent({
      ...ctx,
      event: { type: "tool.progress", toolCallId: "c9", toolName: "bash", message: "compiling" },
    })
    expect(projected.emitted.type).toBe("tool.progress")
    expect(projected.emitted).toMatchObject({
      toolCallId: "c9",
      toolName: "bash",
      message: "compiling",
    })
    expect(projected.state.seq).toBe(state.seq + 1)
    expect(projected.state.revision).toBe(state.revision + 1)
    // pure observation: the streaming transcript slot is NOT touched (the exact
    // ALBB-18 corruption vector was appending to streamingAssistantText)
    expect(projected.state.transcript).toEqual(state.transcript)
  })

  test("BE-07b: recovery projects to turn.recovery", () => {
    const projected = projectSessionHostTurnEvent({
      ...ctx,
      event: { type: "recovery", reason: "compact", detail: "context window" },
    })
    expect(projected.emitted.type).toBe("turn.recovery")
    expect(projected.emitted).toMatchObject({ reason: "compact", detail: "context window" })
    expect(projected.state.transcript).toEqual(state.transcript)
  })

  test("BE-07c: context.compacted projects to context.compacted", () => {
    const projected = projectSessionHostTurnEvent({
      ...ctx,
      event: {
        type: "context.compacted",
        fromTurnId: "t1",
        toTurnId: "t4",
        summary: "sum",
        ts: 5,
        tokens: 77,
      },
    })
    expect(projected.emitted.type).toBe("context.compacted")
    expect(projected.emitted).toMatchObject({
      fromTurnId: "t1",
      toTurnId: "t4",
      summary: "sum",
      tokens: 77,
    })
  })

  test("BE-07d: budget.breach projects to budget.breach", () => {
    const projected = projectSessionHostTurnEvent({
      ...ctx,
      event: { type: "budget.breach", severity: "soft", scope: "session-x", observed: 2, limit: 1 },
    })
    expect(projected.emitted.type).toBe("budget.breach")
    expect(projected.emitted).toMatchObject({
      severity: "soft",
      scope: "session-x",
      observed: 2,
      limit: 1,
    })
  })
})

describe("bridge expansion — adversarial clamps", () => {
  test("BE-08: a huge tool_progress message is clamped before it hits the wire", () => {
    const bridged = toSessionHostTurnEvent({
      type: "tool_progress",
      id: "c1",
      name: "bash",
      message: "x".repeat(1_000_000),
    })
    expect(bridged?.type).toBe("tool.progress")
    if (bridged?.type === "tool.progress") {
      expect(bridged.message.length).toBeLessThanOrEqual(256)
    }
  })

  test("BE-08b: a huge compaction summary is clamped too", () => {
    const bridged = toSessionHostTurnEvent({
      type: "context_compacted",
      fromTurnId: "a",
      toTurnId: "b",
      summary: "y".repeat(1_000_000),
      ts: 1,
      tokens: 9,
    })
    expect(bridged?.type).toBe("context.compacted")
    if (bridged?.type === "context.compacted") {
      expect(bridged.summary.length).toBeLessThanOrEqual(512)
    }
  })
})
