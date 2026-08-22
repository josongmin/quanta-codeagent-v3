import type { TrajectoryKind } from "@/shared"
import type { AgentEvent } from "../types"

/**
 * JSONL recording POLICY + kind taxonomy.
 *
 * ONE responsibility: answer "which `AgentEvent`s reach the trajectory at all,
 * and which `TrajectoryKind` does each become?". The `RecordedEventType`
 * exclusion list is the durable-vs-transient decision (every excluded type is
 * documented with WHY its payload is already carried elsewhere), and `KIND_MAP`
 * is the total `Record<RecordedEventType, TrajectoryKind>` that makes a new
 * AgentEvent type a COMPILE error until someone classifies it.
 *
 * Split out of `jsonl-recorder.ts` (god-module ratchet) — pure move. The
 * recorder's `emit` skip-guards and this exclusion list must stay in lockstep,
 * exactly as they did when both lived in one file.
 */

// `output_progress` is excluded: it is a transient UI signal that `emit`
// drops before reaching `kindOf`/`dataOf` (see the early return there), so it
// has no trajectory kind or payload. Excluding it from the map type keeps that
// invariant honest rather than mapping it to a kind that is never written.
export type RecordedEventType = Exclude<
  AgentEvent["type"],
  // ADR-0512 `skill_scope_decision` is a transient render-only summary (like the
  // item-lifecycle events) — the out-of-scope outcome is already captured by the
  // tool_result trajectory line (and the DURABLE `permission_escalation_*` pair
  // IS recorded), so this summary carries no separate payload.
  | "output_progress"
  | "ratelimit_snapshot"
  | "item_started"
  | "item_updated"
  | "item_completed"
  | "skill_scope_decision"
  // jun-11 (#11) — streamed reasoning (DIM render-only); the answer is recorded
  // via `assistant_text`, so the reasoning summary carries no separate payload.
  | "assistant_thinking"
  // ALBB-21 — `budget_breach` is a transient advisory (soft/hard cost-cap
  // crossing banner); the cost totals ARE recorded via `usage`/`llm_usage`, so
  // this notice carries no separate durable payload (skipped in `emit` above).
  | "budget_breach"
  // Multi-agent-panel SUBSTRATE — `subagent_spawn`/`subagent_status` are
  // transient render-only UI signals (the SAME class as `item_*`): the DURABLE
  // subagent trajectory is already captured by the ADR-0133 subagent_start/stop
  // hooks + the parent `agent` tool_result, so these carry no separate payload.
  // Kept out of `RecordedEventType` so KIND_MAP / dataOf never see them; the
  // `emit` guard below drops them.
  | "subagent_spawn"
  | "subagent_status"
  // RFC-01 A7 — `context_headroom_crossed` is a transient advisory (the SAME
  // class as `budget_breach` / `ratelimit_snapshot`): the token totals ARE
  // recorded via `usage`/`llm_usage`, so this notice carries no separate
  // durable payload (skipped in `emit` above).
  | "context_headroom_crossed"
>
export type RecordedEvent = Extract<AgentEvent, { type: RecordedEventType }>

const KIND_MAP: Record<RecordedEventType, TrajectoryKind> = {
  session_start: "session_start",
  turn_start: "turn_start",
  llm_request: "llm_request",
  llm_continuation: "recovery",
  assistant_text: "assistant_text",
  tool_call: "tool_call",
  tool_progress: "tool_progress",
  tool_result: "tool_result",
  recovery: "recovery",
  // ADR-0075: the dedicated `context_compacted` AgentEvent maps onto the
  // existing trajectory `recovery` kind (same family — a same-turn no-progress
  // recovery point) so we DON'T need a new TrajectoryKind (which would
  // ripple through the redaction policy + every probe consumer). The
  // archive-payload fields (fromTurnId/toTurnId/summary/ts/tokens) ride in
  // `data` via `dataOf` and stay 1st-class JSON. The legacy
  // `recovery:{reason:"compact",detail:"proactive"}` line is emitted FIRST
  // at the same loop seam, so a consumer that only watches the legacy
  // channel still sees compactions byte-identically.
  context_compacted: "recovery",
  // ADR-0048: the transient `in_progress` heartbeat maps onto the existing
  // trajectory `recovery` kind (same rationale as `context_compacted` — a
  // same-turn observation point that does NOT warrant a new TrajectoryKind
  // rippling through the redaction policy + every probe consumer). The
  // heartbeat payload (timestamp + optional message/progress) rides in `data`
  // via `dataOf`, tagged `reason:"in_progress"` so it stays greppable.
  in_progress: "recovery",
  // ADR control-op cluster (L3→L4 promotion 2026-05-23): back-pressure +
  // typed-interrupt + subagent-cancel ride the existing `recovery` family
  // — they are same-turn observation points, not new top-level trajectory
  // kinds. Greppable via `reason` discriminant in `data`.
  response_queued: "recovery",
  interrupted: "recovery",
  subagent_cancel: "recovery",
  // Plan-mode cluster (P3, 2026-05-23): plan-lifecycle + user-input
  // checkpoint + mode-transition events all ride the existing `recovery`
  // family — same rationale as `response_queued` / `interrupted` /
  // `subagent_cancel` (same-turn observation point, no new TrajectoryKind
  // rippling through redaction/probe code paths). Greppable via the
  // discriminating `reason` field added in `dataOf`.
  plan_created: "recovery",
  plan_updated: "recovery",
  plan_snapshot: "recovery",
  plan_user_input_requested: "recovery",
  plan_user_input_resolved: "recovery",
  // ADR-0512 P3 — the interactive escalation pair rides the `recovery` family
  // for the SAME reason as the plan/control-op events (a same-turn observation
  // checkpoint, no new TrajectoryKind). Unlike the transient
  // `skill_scope_decision` render-hint (SKIPPED), this pair is DURABLE audit
  // state — a Codex-style auditable permission request + its resolution — so it
  // IS recorded. Greppable via the `reason` discriminant in `dataOf`.
  permission_escalation_requested: "recovery",
  permission_escalation_resolved: "recovery",
  mode_changed: "recovery",
  // ADR-0102 turn-diff cluster: rides the existing `recovery` family for
  // the same reason as the plan/control-op events (same-turn observation
  // point, no new TrajectoryKind rippling through redaction). The diff
  // payload + per-file stats ride in `data` via `dataOf`.
  turn_diff_updated: "recovery",
  // Debug/developer-mode (Track A, 2026-05-25): gate-decision tracer. Same
  // rationale as plan/control-op/turn_diff — same-turn observation point,
  // no new TrajectoryKind. `reason:"decision"` in `data` keeps it greppable.
  decision: "recovery",
  // Knob telemetry (2026-05-26): per-run resolved knob posture. Rides the
  // existing `recovery` family for the same rationale as `decision` /
  // `plan_*` / `turn_diff_updated` — a same-turn observation point, no new
  // TrajectoryKind rippling through redaction / probe / consumer code paths.
  // `reason:"knobs_applied"` keeps the line greppable apart from other
  // recovery-kind events.
  knobs_applied: "recovery",
  // C2 (jun-4-communicate-update.md): structured progress report. Rides the
  // existing `recovery` family for the same rationale as `decision` / `plan_*`
  // / `turn_diff_updated` — a same-turn observation point, no new TrajectoryKind
  // rippling through redaction / probe / consumer code paths. Unlike
  // `output_progress` (a transient token tick the recorder SKIPS), this event
  // IS recorded: it is durable agent intent. `reason:"progress_update"` keeps
  // the line greppable apart from other recovery-kind events.
  progress_update: "recovery",
  // Peer/side-agent message surfacing (jul-15 W2): rides the existing `recovery`
  // family (same rationale as `progress_update` / `plan_*` — a same-turn
  // observation point, no new TrajectoryKind). RECORDED (not skipped like the
  // transient render-only signals): peer mail is content-bearing and its durable
  // copy is otherwise CONDITIONAL on the recipient later draining it into working
  // memory, so the trajectory is the only guaranteed record. `reason:"peer_message"`
  // in `dataOf` keeps it greppable; the body is already redacted at the emit boundary.
  peer_message: "recovery",
  subagent_delivery: "recovery",
  // RFC02-3 A8 — durable route transition (OQ2); rides `recovery`, greppable via `reason:"model_route_changed"`.
  model_route_changed: "recovery",
  error: "error",
  usage: "llm_usage",
  done: "session_end",
}

/** AgentEvent.type → TrajectoryEvent.kind (RFC §5.2 mapping). */
export const kindOf = (e: RecordedEvent): TrajectoryKind => KIND_MAP[e.type]
