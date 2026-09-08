import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  decodeSessionEvent,
  decodeSessionSnapshot,
  SessionProtocolValidationError,
} from "@/protocol/session"
import { HOST_ONLY_SESSION_COMMANDS, SESSION_COMMAND_TYPES } from "@/protocol/session/commands"
import { SESSION_EVENT_TYPES, type SessionEventType } from "@/protocol/session/events"

const envelope = (type: string, extra: Record<string, unknown>) =>
  JSON.stringify({
    version: "session.v1",
    kind: "event",
    payload: {
      eventId: "e1",
      seq: 1,
      revision: 1,
      emittedAt: "2026-01-01T00:00:00.000Z",
      type,
      ...extra,
    },
  })

const validExtra: Record<SessionEventType, Record<string, unknown>> = {
  "approval.requested": { approval: { approvalId: "a1" } },
  "approval.resolved": { approvalId: "a1", decision: "approve" },
  "artifact.ready": { artifact: { id: "art" } },
  "budget.breach": { severity: "soft", scope: "turn" },
  "context.compacted": { fromTurnId: "t0", toTurnId: "t1" },
  "item.completed": { itemId: "i1" },
  "item.delta": { itemId: "i1" },
  "item.started": { itemId: "i1" },
  "session.closed": {},
  "session.created": { capabilityManifest: { version: 1 } },
  "session.state.updated": { state: { status: "idle" } },
  "skill.scope.decision": { tool: "bash", activeSkill: "s" },
  "tool.completed": { toolCallId: "c1", toolName: "bash" },
  "tool.invoked": { toolCallId: "c1", toolName: "bash" },
  "tool.progress": { toolCallId: "c1", toolName: "bash", message: "p" },
  "turn.aborted": { message: "stop" },
  "turn.completed": { outcomeReason: "done" },
  "turn.failed": { message: "err" },
  "turn.llm.continuation": { surfaceId: "s" },
  "turn.llm.request": { model: "m" },
  "turn.output.delta": { delta: "x" },
  "turn.recovery": { reason: "nudge" },
  "turn.started": { prompt: "hi" },
}

describe("C-F11 event payload validation", () => {
  test("anti-vacuum: validator table covers every event type", () => {
    expect(Object.keys(validExtra).sort()).toEqual([...SESSION_EVENT_TYPES].sort())
    expect(SESSION_EVENT_TYPES.length).toBeGreaterThanOrEqual(20)
  })

  test("every discriminant accepts a valid payload", () => {
    for (const type of SESSION_EVENT_TYPES) {
      expect(decodeSessionEvent(envelope(type, validExtra[type])).type).toBe(type)
    }
  })

  test("every discriminant with a required field rejects an empty payload", () => {
    const required = SESSION_EVENT_TYPES.filter((type) => Object.keys(validExtra[type]).length > 0)
    expect(required.length).toBeGreaterThanOrEqual(18)
    for (const type of required) {
      expect(() => decodeSessionEvent(envelope(type, {}))).toThrow(SessionProtocolValidationError)
    }
  })

  test("approval:null is rejected before consumers dereference", () => {
    expect(() => decodeSessionEvent(envelope("approval.requested", { approval: null }))).toThrow(
      SessionProtocolValidationError,
    )
  })

  test("session.state.updated without status is refused (correlator would false-void)", () => {
    expect(() => decodeSessionEvent(envelope("session.state.updated", { state: {} }))).toThrow(
      SessionProtocolValidationError,
    )
  })

  test("snapshot state without status is refused", () => {
    const raw = JSON.stringify({
      version: "session.v1",
      kind: "snapshot",
      payload: {
        sessionId: "s1",
        revision: 1,
        seq: 1,
        state: {},
        capabilities: {},
        pendingApproval: null,
        openArtifacts: [],
      },
    })
    expect(() => decodeSessionSnapshot(raw)).toThrow(SessionProtocolValidationError)
  })
})

describe("C-F2 host-only vs public commands", () => {
  test("turn.submit is host-only and the three missing verbs are in the union", () => {
    expect(HOST_ONLY_SESSION_COMMANDS).toEqual(["turn.submit"])
    expect(SESSION_COMMAND_TYPES).toContain("session.objective.mutate")
    expect(SESSION_COMMAND_TYPES).toContain("session.posture.set")
    expect(SESSION_COMMAND_TYPES).toContain("session.skill.set_enabled")
  })

  test("wire and in-process builders expose the three verbs", () => {
    const handleVerbs = readFileSync(
      join(import.meta.dir, "../../../../src/ipc/session/handle-verbs.ts"),
      "utf8",
    )
    const adapter = readFileSync(
      join(import.meta.dir, "../../../../src/sdk/runtime/handle-adapter.ts"),
      "utf8",
    )
    expect(handleVerbs).toContain("buildObjectiveMutate")
    expect(handleVerbs).toContain("buildPostureSet")
    expect(handleVerbs).toContain("buildSkillSetEnabled")
    expect(adapter).toContain("objective.mutate")
    expect(adapter).toContain("posture.set")
    expect(adapter).toContain("skill.setEnabled")
    expect(handleVerbs.includes("buildTurnSubmit")).toBe(false)
  })
})
