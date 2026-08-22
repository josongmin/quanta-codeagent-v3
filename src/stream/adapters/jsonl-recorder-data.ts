import { assertNever } from "@/shared"
import type { AgentEvent } from "../types"
import { communicationDataOf, isCommunicationDataEvent } from "./jsonl-recorder-communication-data"
import {
  llmRequestData,
  modelRouteChangedData,
  recoveryData,
  toolResultData,
  usageData,
} from "./jsonl-recorder-event-data"
import type { RecordedEvent } from "./jsonl-recorder-kind-map"

/**
 * JSONL trajectory `data` PAYLOAD projection.
 *
 * ONE responsibility: given an event the recorder has decided to keep (see
 * `jsonl-recorder-kind-map.ts` for that decision), build the plain-JSON `data`
 * object written on its line — `dataOf` is the single entry point and every
 * `*Data` helper below is one event family's payload shape. The rules the whole
 * module obeys: optional fields are CONDITIONALLY spread (no `undefined` leaks
 * into the JSON), recovery-family lines carry a `reason` discriminator so they
 * stay greppable apart from each other, and the final switch ends in
 * `assertNever` so a new recorded event type cannot ship without a payload.
 *
 * Pure: no clock, no IO, no state — the recorder's writer half owns all of that.
 *
 * Split out of `jsonl-recorder.ts` (god-module ratchet) — pure move; the
 * per-family helpers already extracted into `jsonl-recorder-event-data.ts` /
 * `jsonl-recorder-communication-data.ts` are consumed from here unchanged.
 */

/** Project an AgentEvent onto its kind-specific `data` payload. */
export const dataOf = (e: RecordedEvent): Record<string, unknown> => {
  switch (e.type) {
    case "session_start":
      // RFC-0002 §5.2 head marker — minimal payload (no fields mandated).
      return {}
    case "turn_start":
      return { turn: e.turn }
    case "llm_request":
      return llmRequestData(e)
    case "llm_continuation":
      return llmContinuationData(e)
    case "assistant_text":
      return { delta: e.delta }
    case "tool_call":
      return { id: e.id, name: e.name, input: e.input }
    case "tool_progress":
      return { id: e.id, name: e.name, message: e.message }
    case "tool_result":
      return toolResultData(e)
    case "recovery":
      return recoveryData(e)
    case "context_compacted":
      // ADR-0075: archive entry payload — fromTurnId..toTurnId + summary +
      // ts + tokens. `reason:"context_compacted"` is added so this
      // recovery-kind line is greppable apart from the legacy
      // `reason:"compact"` line that fires immediately before it.
      return {
        reason: "context_compacted",
        fromTurnId: e.fromTurnId,
        toTurnId: e.toTurnId,
        summary: e.summary,
        ts: e.ts,
        tokens: e.tokens,
      }
    case "in_progress":
      // ADR-0048: heartbeat payload. The two optional-field branches live in
      // `inProgressData` so this case stays a single statement (keeps `dataOf`
      // under the cognitive-complexity budget).
      return inProgressData(e)
    case "error":
      return { message: e.message }
    case "usage":
      return usageData(e)
    default:
      return controlDataOf(e)
  }
}

type ControlDataEvent = Extract<
  RecordedEvent,
  {
    type:
      | "response_queued"
      | "interrupted"
      | "subagent_cancel"
      | "plan_created"
      | "plan_updated"
      | "plan_snapshot"
      | "plan_user_input_requested"
      | "plan_user_input_resolved"
      | "permission_escalation_requested"
      | "permission_escalation_resolved"
      | "mode_changed"
      | "turn_diff_updated"
      | "decision"
      | "knobs_applied"
      | "progress_update"
      | "peer_message"
      | "subagent_delivery"
      | "model_route_changed"
      | "done"
  }
>

type FinalDataEvent = Extract<
  ControlDataEvent,
  {
    type: "turn_diff_updated" | "decision" | "knobs_applied" | "progress_update" | "done"
  }
>

const controlDataOf = (e: ControlDataEvent): Record<string, unknown> => {
  if (isCommunicationDataEvent(e)) return communicationDataOf(e)
  switch (e.type) {
    case "response_queued":
      return controlOpQueuedData(e)
    case "interrupted":
      return controlOpInterruptedData(e)
    case "subagent_cancel":
      return controlOpSubagentData(e)
    case "plan_created":
      return planCreatedData(e)
    case "plan_updated":
      return planUpdatedData(e)
    case "plan_snapshot":
      return planSnapshotData(e)
    case "plan_user_input_requested":
      return planUserInputRequestedData(e)
    case "plan_user_input_resolved":
      return planUserInputResolvedData(e)
    case "permission_escalation_requested":
      return {
        reason: "escalation_requested",
        id: e.id,
        tool: e.tool,
        risk: e.risk,
        activeSkill: e.activeSkill,
        scopeReason: e.reason,
        options: [...e.options],
        ...(e.justification !== undefined ? { justification: e.justification } : {}),
      }
    case "permission_escalation_resolved":
      return { reason: "escalation_resolved", id: e.id, decision: e.decision }
    case "mode_changed":
      return modeChangedData(e)
    case "model_route_changed":
      // RFC02-3 A8 — durable route transition (payload builder in sibling module).
      return modelRouteChangedData(e)
    default:
      return finalDataOf(e)
  }
}

const finalDataOf = (e: FinalDataEvent): Record<string, unknown> => {
  switch (e.type) {
    case "turn_diff_updated":
      return {
        reason: "turn_diff",
        turn: e.turn,
        fromSha: e.fromSha,
        toSha: e.toSha,
        filesChanged: e.filesChanged,
        insertions: e.insertions,
        deletions: e.deletions,
        unifiedDiff: e.unifiedDiff,
      }
    case "decision":
      return decisionData(e)
    case "knobs_applied":
      return knobsAppliedData(e)
    case "progress_update":
      return {
        reason: "progress_update",
        currentStep: e.currentStep,
        ...(e.finalSummary !== undefined ? { finalSummary: e.finalSummary } : {}),
        ...(e.completedSubtitle !== undefined ? { completedSubtitle: e.completedSubtitle } : {}),
        ...(e.turn !== undefined ? { turn: e.turn } : {}),
      }
    case "done":
      return { reason: e.reason, turns: e.turns }
    default:
      return assertNever(e, "AgentEvent")
  }
}

/** Debug/developer-mode (Track A, 2026-05-25): gate-decision payload.
 *  Mirrors `EventDecisionSchema` in `@/session/envelope` on the trajectory
 *  side. Optional fields are CONDITIONALLY spread so the recorded JSON is
 *  byte-identical to inputs (no `undefined` fields). `reason:"decision"`
 *  keeps this recovery-kind line greppable. Extracted from `dataOf` to keep
 *  its switch case a single statement (cognitive-complexity budget). */
const decisionData = (e: Extract<AgentEvent, { type: "decision" }>): Record<string, unknown> => ({
  reason: "decision",
  turn: e.turn,
  kind: e.kind,
  outcome: e.outcome,
  decisionReason: e.reason,
  ...(e.toolCallId !== undefined ? { toolCallId: e.toolCallId } : {}),
  ...(e.ruleId !== undefined ? { ruleId: e.ruleId } : {}),
  ...(e.hookName !== undefined ? { hookName: e.hookName } : {}),
  ...(e.metadata !== undefined ? { metadata: e.metadata } : {}),
})

/** Responses continuation-wire observation payload. Rides the existing
 *  `recovery` family because this is same-turn transport metadata, not a new
 *  top-level trajectory kind. `reason:"llm_continuation"` keeps the line
 *  greppable while `continuationReason` carries the closed decision/fallback
 *  taxonomy from the LLM surface. */
const llmContinuationData = (
  e: Extract<AgentEvent, { type: "llm_continuation" }>,
): Record<string, unknown> => ({
  reason: "llm_continuation",
  ...(e.provider !== undefined ? { provider: e.provider } : {}),
  surfaceId: e.surfaceId,
  transportId: e.transportId,
  phase: e.phase,
  mode: e.mode,
  continuationReason: e.reason,
  ...(e.statusCode !== undefined ? { statusCode: e.statusCode } : {}),
})

/** Knob telemetry (2026-05-26): per-run resolved knob posture payload. The
 *  carrier event is emitted once per run; the recorder writes it as one
 *  JSONL line with `kind:"recovery"` (no new TrajectoryKind needed) and
 *  `reason:"knobs_applied"` for grep. `preset` is intentionally serialised
 *  even when `null` (the type uses `string | null`, NOT optional) so a
 *  consumer can distinguish "knob system live but no preset" from "absent
 *  field". `knobs` is a plain object — same shape the bench report uses
 *  (`knobsForReport(...)`), so two artifacts (jsonl trajectory line +
 *  report.json `knobs` block) can be cross-correlated trivially. */
const knobsAppliedData = (
  e: Extract<AgentEvent, { type: "knobs_applied" }>,
): Record<string, unknown> => ({
  reason: "knobs_applied",
  surface: e.surface,
  knobs: e.knobs,
  preset: e.preset,
  costMultiplier: e.costMultiplier,
})

/** ADR-0048: heartbeat payload — receive-side timestamp + the optional
 *  provider-supplied status/percentage. `reason:"in_progress"` keeps this
 *  recovery-kind line greppable apart from real recovery points. Extracted from
 *  `dataOf` so its switch case stays a single statement. */
const inProgressData = (
  e: Extract<AgentEvent, { type: "in_progress" }>,
): Record<string, unknown> => ({
  reason: "in_progress",
  timestamp: e.timestamp,
  ...(e.message !== undefined ? { message: e.message } : {}),
  ...(e.progress !== undefined ? { progress: e.progress } : {}),
})

/** ADR control-op cluster (L3→L4 promotion 2026-05-23): back-pressure event
 *  payload. `reason` discriminator matches the canonical PausedReason
 *  taxonomy (extended with `control_op_pending`/`safety_review` per
 *  `@/agent/control-op-handler`). Extracted from `dataOf` to keep its switch
 *  case a single statement (cognitive-complexity budget). */
const controlOpQueuedData = (
  e: Extract<AgentEvent, { type: "response_queued" }>,
): Record<string, unknown> => ({
  reason: "response_queued",
  pauseReason: e.reason,
  ...(e.hint !== undefined ? { hint: e.hint } : {}),
})

/** ADR control-op cluster: typed-interrupt observation payload. `reason`
 *  field doubles as discriminator + verbatim cancel reason carrier. */
const controlOpInterruptedData = (
  e: Extract<AgentEvent, { type: "interrupted" }>,
): Record<string, unknown> => ({
  reason: "interrupted",
  source: e.source,
  ...(e.reason !== undefined ? { detail: e.reason } : {}),
})

/** ADR control-op cluster: subagent cancel routing result. Parent turn
 *  KEEPS running — this is observation only, not a finish trigger. */
const controlOpSubagentData = (
  e: Extract<AgentEvent, { type: "subagent_cancel" }>,
): Record<string, unknown> => ({
  reason: "subagent_cancel",
  subagentId: e.subagentId,
  outcome: e.outcome,
  source: e.source,
})

/** Plan-mode cluster (P3): plan_created payload. Inline the plan as a plain
 *  JSON object so consumers can rebuild a `PlanReadonlyMirror` without
 *  re-importing the type. `reason:"plan_created"` matches the recovery-family
 *  discriminator pattern used by response_queued/interrupted/subagent_cancel. */
const planCreatedData = (
  e: Extract<AgentEvent, { type: "plan_created" }>,
): Record<string, unknown> => ({
  reason: "plan_created",
  plan: planToJson(e.plan),
})

/** Plan-mode cluster (P3): plan_updated payload. `version` is the monotonic
 *  plan version after the delta has been applied (so a consumer can detect
 *  out-of-order deliveries by comparing against the previous `plan_updated` /
 *  `plan_snapshot`). */
const planUpdatedData = (
  e: Extract<AgentEvent, { type: "plan_updated" }>,
): Record<string, unknown> => ({
  reason: "plan_updated",
  version: e.version,
  delta: deltaToJson(e.delta),
})

/** Plan-mode cluster (P3): plan_snapshot payload (late-attach surface). Same
 *  shape as plan_created; the `reason` discriminator is what tells the two
 *  apart. */
const planSnapshotData = (
  e: Extract<AgentEvent, { type: "plan_snapshot" }>,
): Record<string, unknown> => ({
  reason: "plan_snapshot",
  plan: planToJson(e.plan),
})

/** Plan-mode cluster (P3): user-input request. Emit `choices` only when
 *  provided (exactOptionalPropertyTypes-safe). */
const planUserInputRequestedData = (
  e: Extract<AgentEvent, { type: "plan_user_input_requested" }>,
): Record<string, unknown> => ({
  reason: "plan_user_input_requested",
  promptId: e.promptId,
  prompt: e.prompt,
  ...(e.choices !== undefined ? { choices: [...e.choices] } : {}),
})

/** Plan-mode cluster (P3): user-input resolved. `text` is emitted only when
 *  present (a `"cancelled"` decision carries no text). */
const planUserInputResolvedData = (
  e: Extract<AgentEvent, { type: "plan_user_input_resolved" }>,
): Record<string, unknown> => ({
  reason: "plan_user_input_resolved",
  promptId: e.promptId,
  decision: e.decision,
  ...(e.text !== undefined ? { text: e.text } : {}),
})

/** Plan-mode cluster (P3): collaboration-mode transition. `reason` is emitted
 *  only when present. The finer `fromAgentMode` / `toAgentMode` posture fields
 *  ride through unchanged when the emitter supplied them. */
const modeChangedData = (
  e: Extract<AgentEvent, { type: "mode_changed" }>,
): Record<string, unknown> => ({
  reason: "mode_changed",
  from: e.from,
  to: e.to,
  ...(e.fromAgentMode !== undefined ? { fromAgentMode: e.fromAgentMode } : {}),
  ...(e.toAgentMode !== undefined ? { toAgentMode: e.toAgentMode } : {}),
  ...(e.reason !== undefined ? { transitionReason: e.reason } : {}),
})

/** Project a PlanReadonlyMirror to a plain JSON object. Pure — no clock, no
 *  IO. Used by `plan_created` and `plan_snapshot` payloads. */
const planToJson = (
  plan: Extract<AgentEvent, { type: "plan_created" }>["plan"],
): Record<string, unknown> => ({
  id: plan.id,
  name: plan.name,
  version: plan.version,
  todos: plan.todos.map((t) => ({ id: t.id, title: t.title, status: t.status })),
})

/** Project a PlanDeltaReadonlyMirror to a plain JSON object. Conditional-set
 *  on every optional field so absent fields don't leak as `undefined` into
 *  the JSON line. */
const deltaToJson = (
  delta: Extract<AgentEvent, { type: "plan_updated" }>["delta"],
): Record<string, unknown> => ({
  kind: delta.kind,
  ...(delta.todoId !== undefined ? { todoId: delta.todoId } : {}),
  ...(delta.todoTitle !== undefined ? { todoTitle: delta.todoTitle } : {}),
  ...(delta.fromStatus !== undefined ? { fromStatus: delta.fromStatus } : {}),
  ...(delta.toStatus !== undefined ? { toStatus: delta.toStatus } : {}),
  ...(delta.fromName !== undefined ? { fromName: delta.fromName } : {}),
  ...(delta.toName !== undefined ? { toName: delta.toName } : {}),
})
