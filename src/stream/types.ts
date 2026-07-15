import type {
  LlmSurfaceId,
  LlmTransportId,
  ResponsesContinuationMode,
  ResponsesContinuationPhase,
  ResponsesContinuationReason,
} from "@/shared/llm-route-types"
import type { TurnPolicySnapshot } from "@/shared/turn-policy-types"

/**
 * Cross-slice mirror — keep in sync with @/agent/plan/types.ts; adding fields
 * there MUST also add here. RFC §3.1 slice isolation forbids the import.
 *
 * Plan + PlanDelta are the host-facing observation shapes for the plan-mode
 * P3 events (`plan_created` / `plan_updated` / `plan_snapshot`). They are
 * STRUCTURALLY identical to the agent-slice types (same field names + same
 * shapes); we duplicate them here so the stream slice does not back-reference
 * the agent slice (slice isolation invariant). A future P4 cluster that lands
 * `@/agent/plan/types.ts` MUST re-shape both sites in lock-step.
 */

/**
 * Cross-slice mirror — keep in sync with `Surface` in `@/runner/knobs/types.ts`.
 * The stream slice depends on `@/shared` only (biome.json enforces — but
 * `@/runner` is not in the blocklist; we still mirror to follow the same
 * pattern as `PlanReadonlyMirror` above and avoid forcing a deeper coupling).
 * Adding a surface there MUST extend this union or the `knobs_applied`
 * exhaustiveness pin in adapters will not break.
 */
// jul-4 F1: derived from the @/shared SSOT (was one of THREE copy-pasted identical unions). The
// "mirror" intent (avoid importing knobs) is preserved — @/shared is the lowest layer, no new coupling.
export type SurfaceMirror = import("@/shared/execution-surface").ExecutionSurface

/** Closed taxonomy for a todo's status — mirrors `TodoStatus` in
 *  `@/agent/plan/types.ts`. Closed-union; no other value is valid. */
export type TodoStatusMirror = "pending" | "in_progress" | "completed" | "cancelled" | "blocked"

/**
 * ADR-0512 P3 — coarse risk class shown on the escalation card. STRUCTURAL
 * MIRROR of `ToolRisk` in `@/tool/surface/manifest.ts`: slice isolation
 * (RFC §3.1) forbids `@/stream` importing `@/tool`, so we duplicate the closed
 * union here and pin the two together in `tests/unit/cross-slice-mirrors.test.ts`
 * (a `tsc --noEmit` drift guard fires if either side adds a member). The card
 * itself only DISTINGUISHES read-only-vs-mutating per the ADR mock, but we mirror
 * the full union so the event contract is `risk: ToolRisk`-faithful.
 */
export type ToolRiskMirror =
  | "read-only"
  | "mutating"
  | "exec"
  | "network"
  | "spawns-subagent"
  | "meta"

/** ADR-0512 P3 — the 4 verbs offered on the escalation approval card. 1:1 with
 *  the surface's resolution decision; `allow_session` widens the skill scope so
 *  the SAME tool is not re-asked (prompt-fatigue guard). */
export type EscalationOption = "allow_once" | "allow_session" | "deny" | "deny_and_steer"

/** Single todo entry inside a plan — mirrors `TodoReadonly` in
 *  `@/agent/plan/types.ts`.
 *
 *  S2 unified-observability (jul-03, append-only): `dependencies` (the DAG
 *  blocked-by edges — todo ids this one waits on), `assignee` (the owner —
 *  ADR-0042 subagent nickname), and `activeForm` (present-tense in-progress
 *  label) are OPTIONAL mirrors of the canonical {@link TodoItem} fields so the
 *  folded `plan` item core carries the DAG + owner + active label. Absent ⇒ the
 *  legacy 3-field wire shape (byte-stable). Adding one here MUST extend
 *  `todoToMirror` in `@/agent/plan/stream-mirror.ts`. */
export interface TodoReadonlyMirror {
  readonly id: string
  readonly title: string
  readonly status: TodoStatusMirror
  readonly dependencies?: readonly string[]
  readonly assignee?: string
  readonly activeForm?: string
}

/** Read-only plan snapshot — mirrors `PlanReadonly` in
 *  `@/agent/plan/types.ts`. Carried by `plan_created` and `plan_snapshot`. */
export interface PlanReadonlyMirror {
  readonly id: string
  readonly name: string
  readonly version: number
  readonly todos: readonly TodoReadonlyMirror[]
}

/** Closed taxonomy for plan-delta kinds — mirrors `PlanDeltaKind` in
 *  `@/agent/plan/types.ts`. Closed-union; a new kind must extend both sites. */
export type PlanDeltaKindMirror =
  | "todo_added"
  | "todo_removed"
  | "todo_status_changed"
  | "todo_renamed"
  | "plan_renamed"

/** All {@link PlanDeltaKindMirror} values as a runtime list. SSOT for the
 *  producer↔consumer fold contract: the web frontend's `applyPlanDelta`
 *  dispatch (`apps/web-frontend/src/ws/plan-reducer.ts`) MUST fold exactly these
 *  kinds — a kind added here but unhandled there is silently dropped by the
 *  reducer's forward-compat fallback. The `satisfies` clause pins this list to
 *  the union so the two cannot drift; the cross-toolchain fold-coverage drift is
 *  guarded by `web-frontend-plan-delta-fold-contract-hellgate.test.ts`. */
export const ALL_PLAN_DELTA_KIND_MIRROR = Object.freeze([
  "todo_added",
  "todo_removed",
  "todo_status_changed",
  "todo_renamed",
  "plan_renamed",
] as const satisfies readonly PlanDeltaKindMirror[])

/** Read-only plan-delta — mirrors `PlanDeltaReadonly` in
 *  `@/agent/plan/types.ts`. Carried by `plan_updated`. */
export interface PlanDeltaReadonlyMirror {
  readonly kind: PlanDeltaKindMirror
  readonly todoId?: string
  readonly todoTitle?: string
  readonly fromStatus?: TodoStatusMirror
  readonly toStatus?: TodoStatusMirror
  readonly fromName?: string
  readonly toName?: string
}

export const AGENT_EVENT_TYPES = [
  "session_start",
  "turn_start",
  "llm_request",
  "llm_continuation",
  "assistant_text",
  "assistant_thinking",
  "in_progress",
  "tool_call",
  "tool_progress",
  "tool_result",
  "skill_scope_decision",
  "permission_escalation_requested",
  "permission_escalation_resolved",
  "recovery",
  "context_compacted",
  "error",
  "usage",
  "output_progress",
  "response_queued",
  "interrupted",
  "subagent_cancel",
  "subagent_spawn",
  "subagent_status",
  "peer_message",
  "plan_created",
  "plan_updated",
  "plan_snapshot",
  "item_started",
  "item_updated",
  "item_completed",
  "plan_user_input_requested",
  "plan_user_input_resolved",
  "mode_changed",
  "turn_diff_updated",
  "decision",
  "knobs_applied",
  "progress_update",
  "ratelimit_snapshot",
  "budget_breach",
  "done",
] as const

export type AgentEventType = (typeof AGENT_EVENT_TYPES)[number]

export const isAgentEventType = (value: unknown): value is AgentEventType =>
  typeof value === "string" && (AGENT_EVENT_TYPES as readonly string[]).includes(value)

export type AgentEvent =
  // RFC-0002 §5.2 `session_start` — emitted once at run start so the trajectory
  // has a head marker (recorder maps it to kind:"session_start").
  | { type: "session_start" }
  | { type: "turn_start"; turn: number }
  // RFC-0002 §5.2/§9 `llm_request` — emitted immediately BEFORE the model
  // stream so the recorder can pair it (same span) with the trailing
  // `llm_usage`, completing the §11 llm_request↔llm_usage span-pair golden.
  | {
      type: "llm_request"
      model: string
      /** Optional provider id (`anthropic` / `openai` / `chatgpt-oauth`).
       *  Absent on legacy callers / tests — the renderer paints just the
       *  model when missing. Used downstream to distinguish a BYOK
       *  (API-key) call from a ChatGPT-subscription (OAuth) call so the
       *  user can see which billing line they're hitting. */
      provider?: string
      /** Optional wire-surface id (`anthropic-messages`,
       *  `openai-chat-completions`, `openai-responses`). */
      surfaceId?: LlmSurfaceId
      /** Optional transport id (`public`, `bedrock`, `vertex`, `foundry`,
       *  `mantle`, `chatgpt-oauth`). */
      transportId?: LlmTransportId
      /** Optional human-readable auth-mode label
       *  ("ChatGPT subscription" / "OpenAI BYOK" / …). The renderer paints
       *  this verbatim — keep it short and unambiguous. */
      authMode?: string
      /** Effective prompt/turn policy at the request boundary. Observability
       *  only: names/counts/booleans, never prompt text. */
      policy?: TurnPolicySnapshot
    }
  // OpenAI Responses continuation-wire observation. Emitted when a stateful
  // Responses surface chooses full-vs-resume input shaping or self-heals after
  // a failed `previous_response_id` attempt. Closed union: a new continuation
  // decision / failure mode must extend every consumer explicitly.
  | {
      type: "llm_continuation"
      provider?: string
      surfaceId: "openai-responses"
      transportId: LlmTransportId
      phase: ResponsesContinuationPhase
      mode: ResponsesContinuationMode
      reason: ResponsesContinuationReason
      statusCode?: number
    }
  | { type: "assistant_text"; delta: string }
  // jun-11 (#11) — a streamed extended-thinking / reasoning-summary delta. Only
  // produced when `QUANTA_REASONING_SUMMARY` is on (the LLM then emits
  // `thinking_delta`s); the stdout adapter renders these DIM, distinct from the
  // assistant's answer. Before this, thinking_delta was consumed only for TTFT
  // timing + the token counter and never shown (pay-without-display).
  | { type: "assistant_thinking"; delta: string }
  // ADR-0048 in-progress heartbeat — surfaced from a provider's
  // `response.in_progress` event so a UI can paint a "thinking…" indicator.
  // Mirrors the `InProgressIndicator` the streaming engine produces: a stable
  // receive-side `timestamp` plus the optional provider-supplied `message` /
  // `progress`. Emitted ONLY when the loop wires `onInProgress` (which it now
  // does unconditionally — but the provider must actually yield the event AND
  // the configured stream must be non-null for it to surface). NullStream
  // swallows it, so the default-OFF byte-identical contract holds.
  | { type: "in_progress"; timestamp: number; message?: string; progress?: number }
  | { type: "tool_call"; id: string; name: string; input: unknown }
  | { type: "tool_progress"; id: string; name: string; message: string }
  // RFC-0002 §5.2 `tool_result` data contract: `preview` is the stdout tail;
  // the optional fields carry the rest of the mandated evidence (durationMs,
  // stderrTail, exitCode, executedCommand, fullLogPath, timedOut) when the
  // tool produced them.
  | {
      type: "tool_result"
      id: string
      name: string
      ok: boolean
      preview: string
      durationMs?: number
      stderrTail?: string
      exitCode?: number
      executedCommand?: string
      fullLogPath?: string
      /** B1 (RFC jul-3): the run was killed by a wall-clock deadline — exit code is a kill
       *  sentinel, output partial. Inspectors must not treat it as a completed observation. */
      timedOut?: boolean
    }
  // ADR-0512 — a tool call OUTSIDE the active skill's allowlist (skill-scope v2),
  // surfaced as a DISTINCT timeline item so a surface renders an "outside skill
  // scope" card / lock — NOT a red tool error. `decision` is the escalation
  // outcome; `reason` + `isReadOnly` drive the card. `id` is the tool-call id
  // (correlates with the `tool_call` that triggered it). The `blocked` decision
  // is the gray HARD-LOCK (hand-off-required security boundary). Emitted ONLY when
  // `QUANTA_SKILL_SCOPE_V2` is on (v2 OFF ⇒ no emit, byte-identical legacy).
  | {
      type: "skill_scope_decision"
      id: string
      tool: string
      activeSkill: string
      reason: string
      isReadOnly: boolean
      decision: "allowed" | "declined" | "steered" | "blocked"
    }
  // ADR-0512 P3 — the INTERACTIVE escalation pair (mirrors the `plan_user_input`
  // pair above). When skill-scope v2 is ON and a tool OUTSIDE the active skill's
  // allowlist is called, the surface must render an APPROVAL CARD — NOT a red
  // `✕ skill-scoped` error. `permission_escalation_requested` fires when (and
  // only when) the path actually ASKS the user: it carries everything the card
  // needs (which `tool`, its `risk` read-only-vs-mutating, the `activeSkill`,
  // the human `reason`, the model's one-line `justification`, and the 4
  // `options`). `permission_escalation_resolved` fires after the user decides.
  // SECURITY INVARIANT (hellgate): a `hand-off-required` security-boundary tool
  // is NON-escalatable — it hard-denies WITHOUT ever emitting a request (the
  // card seam is unreachable for a security boundary). Emitted ONLY when
  // `QUANTA_SKILL_SCOPE_V2` is on (v2 OFF ⇒ ADR-0011 flat deny, no emit,
  // byte-identical legacy). `id` correlates the pair with the triggering
  // `tool_call`.
  | {
      type: "permission_escalation_requested"
      id: string
      tool: string
      risk: ToolRiskMirror
      activeSkill: string
      reason: string
      justification?: string
      options: readonly EscalationOption[]
    }
  | {
      type: "permission_escalation_resolved"
      id: string
      decision: EscalationOption
    }
  // RFC-0002 §5.2 `recovery` — backoff/compact/nudge/empty/malformed traces.
  | { type: "recovery"; reason: string; detail?: string }
  // ADR-0075: Cursor-style proactive-compaction marker. Emitted ALONGSIDE the
  // existing `recovery:{reason:"compact"}` event (so legacy consumers stay
  // working byte-identically — the recovery emit precedes this one in the
  // same call site) when `compaction.archive:true` is configured. Carries the
  // archive entry payload (fromTurnId..toTurnId + summary + ts + tokens) so a
  // session jsonl recorder / UI can render the compaction history without
  // re-parsing the synthetic `<conversation summary>` user message.
  | {
      type: "context_compacted"
      fromTurnId: string
      toTurnId: string
      summary: string
      ts: number
      tokens: number
    }
  | { type: "error"; message: string }
  | {
      type: "usage"
      inputTokens: number
      outputTokens: number
      cacheReadTokens?: number
      // ADR-0182 — cache_creation (cache-WRITE) bucket, forwarded from the
      // adapter `usage` StreamEvent when the provider reported it. OPTIONAL
      // (exactOptionalPropertyTypes): OMITTED for non-caching providers so the
      // default-OFF byte-identical contract holds (OpenAI never sets it).
      cacheCreationTokens?: number
      // S3 (jul-03) — OpenAI-Responses-ONLY reasoning-token split, forwarded
      // from the adapter `usage` StreamEvent when the provider reported it (the
      // portion of `outputTokens` spent on hidden reasoning). OPTIONAL
      // (exactOptionalPropertyTypes): OMITTED for providers with no split
      // (Anthropic bills thinking as output ⇒ absent, byte-identical). `0` is a
      // real provider datum and is forwarded verbatim, distinct from omission.
      reasoningTokens?: number
      model: string
    }
  // Live output-token progress for the in-flight response — the rising
  // "· N tokens" the CLI spinner renders (Claude-Code parity). Mirrors the
  // `output_progress` StreamEvent the `LiveUsageLLM` decorator synthesizes
  // (vendor-agnostic: from normalized text/thinking deltas, upgraded to exact
  // when an adapter streams incremental usage). Transient UI signal, NOT
  // billing: the loop forwards it WITHOUT folding into the recorder/budget
  // (terminal `usage` owns accounting), and the trajectory recorder SKIPS it.
  // `exact:false` ⇒ locally estimated (UI may render `~N`). NullStream
  // swallows it, so the default-OFF byte-identical contract holds.
  | { type: "output_progress"; outputTokens: number; exact: boolean }
  // ADR control-op cluster (L3→L4 promotion 2026-05-23): back-pressure
  // signal. Emitted when the loop encountered a control-op or follow-up
  // dequeue request and DEFERRED it because the thread is paused or the
  // submission/action is not yet ready. Mirrors Codex's
  // `response.queued` event variant. Closed `reason` enum (additive). A
  // surface paints "queued — waiting on user approval" / "queued — rate
  // limited" without re-classifying error/recovery emits. NullStream
  // swallows it (default-OFF byte-identical). Adding a new reason MUST
  // extend `RESPONSE_QUEUED_REASONS` in `@/agent/follow-up-queue` or the
  // matching control-op handler — never inline a literal.
  | {
      type: "response_queued"
      /** Closed reason: matches the {@link PausedReason} taxonomy from
       *  `@/agent/follow-up-queue` extended with the two control-op-
       *  pending reasons documented in the handler. The value is a
       *  string-literal-union encoded as a plain string here to avoid an
       *  import cycle (stream → agent); the agent layer asserts the
       *  literal at the emit site. */
      reason: string
      /** Optional human hint (analytics / UI). Never used for control flow. */
      hint?: string
    }
  // ADR control-op cluster (L3→L4 promotion 2026-05-23): submission /
  // conversation-action interrupt observed. Fired BEFORE the loop unwinds
  // to its `aborted` finish path so a surface knows "the abort came from
  // a typed control-op, not a raw signal trip". Closed `source` enum.
  | {
      type: "interrupted"
      source: "submission_interrupt" | "conversation_action_cancel"
      /** Optional human reason (verbatim from `cancel.reason` when the
       *  source is `conversation_action_cancel`). */
      reason?: string
    }
  // ADR control-op cluster (L3→L4 promotion 2026-05-23): a typed
  // cancel_subagent op was routed to the subagent registry. `outcome`
  // mirrors `TaskRegistry.forceStop` return values plus an
  // `unknown_subagent` for the case where the registry has no record of
  // the id. The parent turn KEEPS running — this is observation only, not
  // a finish trigger.
  | {
      type: "subagent_cancel"
      subagentId: string
      outcome: "stopped" | "not_found" | "registry_absent"
      source: "submission_op" | "conversation_action"
    }
  // Multi-agent orchestration SUBSTRATE — subagent lifecycle events for the CLI
  // `/agents --tree` + web Sub-Agents panel (later waves). Emitted where the
  // shared `TaskRegistry` TRANSITIONS: `register()` ⇒ `subagent_spawn`;
  // `complete()`/`fail()`/`stop()` ⇒ `subagent_status`. Additive + OPT-IN:
  // emitted ONLY when the host wired `AgentConfig.onSubagentEvent` (mirror of
  // `onAgentState`); absent ⇒ never emitted (byte-identical). Render-only — the
  // loop never inspects them (no control authority). These arms STRUCTURALLY
  // mirror `@/subagent`'s duck-declared `SubagentLifecycleEvent` (the leaf slice
  // may not import `@/stream`); the `@/protocol/subagent` projection is the seam
  // the web-daemon (Wave 2) taps. `description` / `finalTextPreview` / `error`
  // are ALREADY bounded + secret-scrubbed at the registry emit boundary (this
  // data crosses to a UI). The recorder SKIPS both (transient render-only, like
  // `item_*` — the durable subagent trajectory rides ADR-0133 hooks + the parent
  // `agent` tool_result), so neither reaches `KIND_MAP` / `dataOf`.
  | {
      type: "subagent_spawn"
      taskId: string
      parentTaskId?: string
      depth: number
      description: string
      agentType?: string
      at: number
    }
  | {
      type: "subagent_status"
      taskId: string
      status: "running" | "completed" | "failed" | "stopped"
      at: number
      turns?: number
      finalTextPreview?: string
      error?: string
    }
  // Peer/side-agent message surfacing (jul-15 W2 — Codex "Sent from another task"
  // parity). Emitted by the `surfaceNotifyMailbox` decorator at ENQUEUE time for
  // a mailbox `send` addressed to the SESSION OWNER (`to === recipientId` or a
  // broadcast) — so the USER sees inter-agent mail the moment it is queued, while
  // the MODEL still receives it at its next turn-top drain (no forced turn, exactly
  // Codex `send_message` semantics). Additive + OPT-IN: emitted ONLY when
  // `QUANTA_PEER_MSG_SURFACE` is on AND `QUANTA_SUBAGENT_MAILBOX` supplies a
  // mailbox; absent ⇒ never emitted (byte-identical). Render-only — the loop never
  // inspects it (no control authority), and it is INFORMATION, never a grant.
  // `body` is ALREADY redacted + control-sanitized at the emit boundary (secrets
  // removed, ANSI/control/bidi stripped per line, newlines preserved for a
  // multi-line finding) — this data crosses to a UI + the trajectory recorder, so
  // it is safe to render/record verbatim. `provenance` distinguishes peer mail from a
  // side-agent daemon finding (both ride the same mailbox rail). RECORDED by the
  // jsonl recorder (content-bearing, low-frequency; its durable copy is otherwise
  // conditional on the recipient later draining).
  | {
      type: "peer_message"
      /** Sender mailbox label (`root/1`, a daemon id, …) — untrusted, DATA only. */
      from: string
      /** Recipient this send was addressed to (the session owner id, or `"*"`). */
      to: string
      kind: "request" | "response" | "broadcast"
      /** Redacted + control-sanitized body — safe to render/record verbatim. */
      body: string
      correlationId?: string
      sentAt: number
      provenance: { source: "peer" } | { source: "side-agent"; daemonId: string }
    }
  // Plan-mode cluster (P3, 2026-05-23): plan created / updated / late-attach
  // snapshot. Carries the structural mirror of @/agent/plan/types.ts (see top
  // of file). NullStream swallows by virtue of the closed AgentEvent union; a
  // surface that does not implement these branches falls through the
  // exhaustive switch's `never` default (compile-time hellgate). All three
  // map to the `recovery` trajectory family in jsonl-recorder with a
  // discriminating `reason` field — same posture as `response_queued` /
  // `interrupted` / `subagent_cancel`.
  | { type: "plan_created"; plan: PlanReadonlyMirror }
  | { type: "plan_updated"; delta: PlanDeltaReadonlyMirror; version: number }
  | { type: "plan_snapshot"; plan: PlanReadonlyMirror }
  // gap-other-agent GAP 10 — per-output-item lifecycle (Codex
  // ItemStarted/Updated/Completed parity). Additive + OPT-IN: emitted only when
  // `QUANTA_ITEM_LIFECYCLE` is on (the loop wraps `stream.emit` with the
  // item-lifecycle projector). Absent ⇒ never emitted, byte-identical — every
  // existing consumer ignores unknown event types (no exhaustive `assertNever`
  // over `AgentEvent`). Lets an SDK/UI show granular per-item progress
  // (text run / tool call / thinking) WITHOUT waiting for the full turn.
  | { type: "item_started"; itemId: string; itemKind: "text" | "tool" | "thinking"; index: number }
  | { type: "item_updated"; itemId: string; delta: string }
  | { type: "item_completed"; itemId: string }
  // Plan-mode cluster (P3): user-input checkpoint. `plan_user_input_requested`
  // fires when the plan flow pauses to ask a user a clarifying question
  // (e.g., "approve this plan?"); `plan_user_input_resolved` fires when the
  // host answers (or cancels). `choices` is OPTIONAL: when present the host
  // SHOULD constrain the response to one of them; when absent the answer is
  // free-form text. `decision: "cancelled"` carries no `text`.
  | {
      type: "plan_user_input_requested"
      promptId: string
      prompt: string
      choices?: readonly string[]
    }
  | {
      type: "plan_user_input_resolved"
      promptId: string
      decision: "answer" | "cancelled"
      text?: string
    }
  // Plan-mode cluster (P3): collaboration-mode transition. Closed 2-mode
  // enum mirrors `CollaborationMode` in `@/agent/mode.ts`. `reason` is
  // optional human/analytics hint (free-form string; never used for control
  // flow). Equal-mode transitions are still emitted so a host that wants to
  // log "developer message reaffirmed plan mode" sees the event.
  //
  // `fromAgentMode`/`toAgentMode` (jul-04 observability widening) carry the FINER
  // AgentMode axis (`default`/`editor`/`plan`/`review`/`audit`/`architect`, the
  // output of `resolveAgentMode` in `@/agent/mode.ts`) so a host distinguishes
  // "entered plan from an editor subagent" from "entered plan from default" — a
  // distinction the 2-value collaboration `from`/`to` erases (both project to
  // `default`). Free-form string (like `reason`) to avoid an `@/agent` slice edge;
  // absent when the emitter has no AgentMode context (e.g. legacy paths). */
  | {
      type: "mode_changed"
      from: "default" | "plan"
      to: "default" | "plan"
      fromAgentMode?: string
      toAgentMode?: string
      reason?: string
    }
  // ADR-0102 turn-diff cluster (Codex `turn/diff/updated` absorption). Emitted
  // at turn end when the turn-diff emitter is wired with a `GitRunner` (opt-in
  // — absent runner ⇒ no event, byte-identical). Carries the cumulative
  // unified diff between the turn-start SHA snapshot and the current HEAD /
  // worktree state so a host (UI / replay / session jsonl recorder) sees the
  // SHAPE of what the turn changed without parsing assistant text. `fromSha`
  // is the SHA captured at turn start; `toSha` is the SHA at turn end (may
  // equal `fromSha` when the turn made no commit — in that case the unified
  // diff still carries working-tree edits). `filesChanged` / `insertions` /
  // `deletions` mirror `git diff --shortstat` for cheap UI rendering;
  // `unifiedDiff` is the full body, truncated at the emitter's
  // `maxUnifiedBytes` with a marker when the diff is huge.
  | {
      type: "turn_diff_updated"
      turn: number
      fromSha: string
      toSha: string
      filesChanged: number
      insertions: number
      deletions: number
      unifiedDiff: string
    }
  // Debug/developer-mode cluster (Track A, 2026-05-25): gate-decision event.
  // Emitted by the tool-call gate stack (permission / rule / hook / cap / jail /
  // budget) immediately BEFORE the tool invocation so the CLI tracer + session
  // JSONL recorder can both see WHICH gate produced the allow/deny/ask outcome
  // and WHY. Default-OFF: nobody emits it yet — the emit sites live in
  // Phase 2 (Track B). Closed `kind` × closed `outcome` enums (3-state outcome).
  // Optional fields stay absent when not relevant. `metadata` carries kind-
  // specific context — the CALLER is responsible for sanitisation (secret/PII
  // scrubbing). The shape mirrors `EventDecisionSchema` in
  // `@/session/envelope` (envelope side validates the wire form).
  | {
      type: "decision"
      turn: number
      /** Which gate produced the decision. */
      kind: "permission" | "rule" | "hook" | "cap" | "jail" | "budget"
      /** 3-state outcome. */
      outcome: "allow" | "deny" | "ask"
      /** Short human-readable reason (non-empty by convention). */
      reason: string
      /** Tool-call id this decision applies to — pairs with `tool_call.id`. */
      toolCallId?: string
      /** Matched rule id (only meaningful for kind="rule"). */
      ruleId?: string
      /** Hook name (only meaningful for kind="hook"). */
      hookName?: string
      /** Kind-specific extra context. CALLER sanitises (secret/PII scrub). */
      metadata?: Readonly<Record<string, unknown>>
    }
  // Knob telemetry (2026-05-26): per-run resolved knob posture. Emitted ONCE
  // per agent run (before `done`) when the surface entry resolves a
  // `KnobValueMap` and forwards it as an event. Carries the closed-port
  // projection of the registry: surface (closed enum), id → { value, source }
  // map, optional preset name, and the multiplicative cost estimate (Σ of
  // active knobs' `costMultiplier`, falling back to 1). All four fields are
  // populated by the emitter — the recorder is a transparent forwarder.
  //
  // `knobs` is a plain `Record` (not a `Map`) so JSON.stringify is a no-op
  // serialiser; `preset` is `string | null` (NOT optional) to make the
  // null-vs-unset distinction explicit on the wire. The `surface` mirror
  // matches `Surface` in `@/runner/knobs/types.ts` — see `SurfaceMirror`
  // above for the contract. Optional / unknown adapters (stdout, sse, tee)
  // graceful-skip (the closed-union exhaustiveness pin requires they at
  // least DECLARE the case; the no-op render is the documented behavior).
  | {
      type: "knobs_applied"
      surface: SurfaceMirror
      knobs: Readonly<
        Record<
          string,
          { value: unknown; unit: string | undefined; display: string; source: string }
        >
      >
      preset: string | null
      costMultiplier: number
    }
  // C2 (jun-4-communicate-update.md): structured progress report. Emitted when
  // the model calls the `communicate_update` tool MID-TURN to surface a typed
  // progress triple — absorbed from Cursor 3.5.33's `agent.v1.CommunicateUpdateArgs`.
  // The tool forwards a `ProgressUpdateMirror` to a host-wired `ProgressSink`
  // (duck-typed on `ToolContext`); the host adapts it onto THIS stream as
  // `progress_update`. RENDER-ONLY — carries no loop-control authority (the loop
  // never inspects it). Default-OFF: the sink is wired ONLY when
  // `AgentConfig.progressSink` is set; absent ⇒ no event, byte-identical (and
  // NullStream swallows it regardless). Distinct from `output_progress` (token
  // counter, transient, un-recorded) and `tool_progress` (free-text, keyed by a
  // tool-call id): this carries the typed `{currentStep, finalSummary?,
  // completedSubtitle?}` triple and IS recorded (durable agent intent).
  //
  // camelCase here matches the wire-internal AgentEvent convention (`fromSha`,
  // `outputTokens`); the tool's snake_case input is the model-facing contract,
  // transformed at the adapter boundary.
  | {
      type: "progress_update"
      /** Live "what step am I on" line — updated whenever the subtask changes. */
      currentStep: string
      /** Set-once-per-turn executive summary (optional until the turn ends). */
      finalSummary?: string
      /** Set-once 4-6-word past-tense agent subtitle (optional). */
      completedSubtitle?: string
      /** Turn index for ordering / UI anchoring (mirrors Cursor's `message_index`
       *  intent — lets a surface anchor / coalesce updates within a turn). */
      turn?: number
    }
  // jun-6 account-ratelimit-snapshot (gate `QUANTA_RATELIMIT_PROACTIVE`). A
  // transient UI signal mirroring the slice's `RateLimitNotice` (numbers + the
  // constant type tag ONLY — never a header VALUE string, no org-id leak). Like
  // `output_progress` it is NON-accounting: the loop forwards it without folding
  // it into the recorder / budget meter. Emitted ONLY when the loop applied a
  // proactive empty-bucket delay (knob ON); NullStream swallows it, so the
  // default-OFF byte-identical contract holds. Fields mirror
  // `src/llm/ratelimit-snapshot/notice.ts` structurally (slice isolation).
  | {
      type: "ratelimit_snapshot"
      requestsRemaining?: number
      requestsResetMs?: number
      tokensRemaining?: number
      tokensResetMs?: number
      observedAt: number
    }
  // ALBB-21 — advisory soft/hard budget-cap crossing (Claude Code / Codex cost-
  // warning UX). Emitted by the L4 ledger sink in `emitUsage` when a configured
  // `BudgetPolicy` limit is crossed (one event per crossed `BudgetBreach`). This
  // is a NON-FATAL ADVISORY: it NEVER stops the run — the HARD *stop* still fires
  // via `ledgerHardBreachCondition` at the turn epilogue; this event is pure
  // observability (a rendered-but-non-mutating notice, the SAME class as
  // `ratelimit_snapshot` / `output_progress`: the recorder SKIPS it, the stdout
  // adapter renders a one-line banner). `severity` is the soft/hard axis and
  // `scope` is the sessionId (`session-*`) or day key (`daily-*`); `observed` +
  // `limit` are the USD cumulative-at-crossing and the configured cap, derived
  // VERBATIM from the typed `BudgetBreach` — no invented threshold. Default-OFF:
  // no `budgetLedger` ⇒ no breach ⇒ no emit, byte-identical (NullStream swallows).
  | {
      type: "budget_breach"
      severity: "soft" | "hard"
      scope: string
      observed: number
      limit: number
    }
  | { type: "done"; reason: string; turns: number }

/**
 * Retention policy for jsonl recorder files (ADR-0035). Public surface in the
 * stream slice so callers in `@/agent` can declare a single policy object and
 * pass it both to a scheduled retention job and to dashboards that inspect
 * the same threshold. No defaults — caller MUST provide.
 */
export interface RetentionPolicy {
  /** Cumulative-bytes sliding window. Must be a finite positive number. */
  maxCumulativeBytes: number
  /**
   * If set, the recommended cadence at which a wiring layer should call
   * `applyRetention`. The retention function itself is one-shot — it never
   * polls. This field is metadata for the caller's scheduler.
   */
  intervalMs?: number
}
