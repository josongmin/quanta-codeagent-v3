/**
 * Per-discriminant session event payload validation (C-F11).
 * Kernel/domain policy is not imported — protocol owner only.
 */

import { SessionProtocolValidationError } from "./errors"
import { isSessionEventType, SESSION_EVENT_TYPES, type SessionEventType } from "./events"
import { isSessionStateStatus } from "./snapshot"

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const requireString = (value: Record<string, unknown>, key: string, issue: string): void => {
  if (typeof value[key] !== "string") throw new SessionProtocolValidationError(issue)
}

const requireObject = (value: Record<string, unknown>, key: string, issue: string): void => {
  if (!isPlainObject(value[key])) throw new SessionProtocolValidationError(issue)
}

const validators: Record<SessionEventType, (p: Record<string, unknown>) => void> = {
  "approval.requested": (p) => {
    if (p.approval === null) throw new SessionProtocolValidationError("bad_event_approval_null")
    requireObject(p, "approval", "bad_event_approval")
    const approval = p.approval as Record<string, unknown>
    requireString(approval, "approvalId", "bad_event_approvalId")
  },
  "approval.resolved": (p) => {
    requireString(p, "approvalId", "bad_event_approvalId")
    if (p.decision !== "approve" && p.decision !== "deny") {
      throw new SessionProtocolValidationError("bad_event_decision")
    }
  },
  "artifact.ready": (p) => requireObject(p, "artifact", "bad_event_artifact"),
  "budget.breach": (p) => {
    if (p.severity !== "soft" && p.severity !== "hard") {
      throw new SessionProtocolValidationError("bad_event_severity")
    }
    requireString(p, "scope", "bad_event_scope")
  },
  "context.compacted": (p) => {
    requireString(p, "fromTurnId", "bad_event_fromTurnId")
    requireString(p, "toTurnId", "bad_event_toTurnId")
  },
  "item.completed": (p) => requireString(p, "itemId", "bad_event_itemId"),
  "item.delta": (p) => requireString(p, "itemId", "bad_event_itemId"),
  "item.started": (p) => requireString(p, "itemId", "bad_event_itemId"),
  "session.closed": () => undefined,
  "session.created": (p) => requireObject(p, "capabilityManifest", "bad_event_capabilityManifest"),
  "session.state.updated": (p) => {
    requireObject(p, "state", "bad_event_state")
    const state = p.state as Record<string, unknown>
    if (!isSessionStateStatus(state.status)) {
      throw new SessionProtocolValidationError("bad_event_state_status")
    }
  },
  "skill.scope.decision": (p) => {
    requireString(p, "tool", "bad_event_tool")
    requireString(p, "activeSkill", "bad_event_activeSkill")
  },
  "tool.completed": (p) => {
    requireString(p, "toolCallId", "bad_event_toolCallId")
    requireString(p, "toolName", "bad_event_toolName")
  },
  "tool.invoked": (p) => {
    requireString(p, "toolCallId", "bad_event_toolCallId")
    requireString(p, "toolName", "bad_event_toolName")
  },
  "tool.progress": (p) => {
    requireString(p, "toolCallId", "bad_event_toolCallId")
    requireString(p, "toolName", "bad_event_toolName")
    requireString(p, "message", "bad_event_message")
  },
  "turn.aborted": (p) => requireString(p, "message", "bad_event_message"),
  "turn.completed": (p) => requireString(p, "outcomeReason", "bad_event_outcomeReason"),
  "turn.failed": (p) => requireString(p, "message", "bad_event_message"),
  "turn.llm.continuation": (p) => requireString(p, "surfaceId", "bad_event_surfaceId"),
  "turn.llm.request": (p) => requireString(p, "model", "bad_event_model"),
  "turn.output.delta": (p) => requireString(p, "delta", "bad_event_delta"),
  "turn.recovery": (p) => requireString(p, "reason", "bad_event_reason"),
  "turn.started": (p) => requireString(p, "prompt", "bad_event_prompt"),
}

const validatorCount = Object.keys(validators).length
if (validatorCount !== SESSION_EVENT_TYPES.length) {
  throw new Error(
    `session event validator table drifted: ${validatorCount} vs ${SESSION_EVENT_TYPES.length}`,
  )
}

export const assertSessionEventPayload = (payload: Record<string, unknown>): void => {
  if (!isSessionEventType(payload.type)) {
    throw new SessionProtocolValidationError("bad_event_type")
  }
  validators[payload.type](payload)
}
