/**
 * AgentConfig wire slots — dispatch / permission-stack / plan / feature-port cluster (dedupGate … branchSearch).
 *
 * EXTRACTED from `src/agent/types.ts` (god-module split, fix-on-sight per
 * AGENTS.md SE-metrics). `AgentConfig` `extends` this interface so every
 * field below stays on the public `AgentConfig` surface BYTE-IDENTICALLY via
 * declaration-merging — no consumer of `@/agent/types` changes. Field shapes
 * MUST stay byte-identical to the prior inline declarations; adding/renaming a
 * field here is a CONTRACT CHANGE. All members are default-OFF when absent
 * (RFC §1.2).
 */

import type { ModelCandidate } from "@/llm"
import type { RoleModelResolver } from "@/llm/role-model-override"
import type {
  DenialMemory,
  LearningSource,
  MergeStrategy,
  PatternGrantStore,
  PendingPermission,
  PermissionStore,
  ReviewerPort,
  ReviewerTier,
  ReviewKind,
} from "@/permission"
import type { RulesStore } from "@/rules"
import type { UserQuestionBroker } from "@/session/user-question"
import type { ShellExecObserver, UserInputRequester } from "@/tool"
import type { BranchSearchConfig } from "../branch-search"
import type { BriefStore } from "../brief"
import type { DedupGate, DedupGateCaps } from "../dispatch-dedup"
import type { DispatchGuard, QuestionAvailabilityReader } from "../dispatch-guard"
import type { EffortLevel } from "../effort"
import type { EffortClassifierPort } from "../effort-classifier"
import type { FastApplyFallbackPort, FastApplyPort } from "../fast-apply-fallback"
import type { PlanStore } from "../plan/state"
import type { PlanExitOutcome } from "../plan-exit"
import type { PlanExitPort } from "../plan-exit-flow"
import type { PlanQueueStore } from "../plan-queue"
import type { StopReasonPolicy } from "../stop-reason"
import type { WorkMetricsSink } from "../work-metrics-collector"

export interface WireSlotsCoreConfig {
  /**
   * Pre-flight dispatch dedup gate (T3, SOTA++ structural fix for bench
   * Type F "Verify-Loop Stuck on Env"). When a {@link DedupGate} instance is
   * present the dispatch seam consults it BEFORE the admissibility gate and
   * short-circuits a too-frequently-repeated identical call with a synthetic
   * tool_result observation. Absent ⇒ no gate, no allocation, dispatch is
   * byte-identical to the pre-gate path. Constructed per-session by
   * `runAgent` (one gate per run); `caps` overrides the default thresholds.
   * The gate needs the current `turn` — read from `run.turn` (stamped per
   * turn by the loop). With no `run` context the gate is bypassed (no turn
   * source ⇒ no dedup window).
   */
  dedupGate?: DedupGate
  /** Dedup-gate caps override (only consulted when `runAgent` constructs the
   *  gate itself, i.e. caller did not pre-build `dedupGate`). Absent ⇒
   *  {@link DEFAULT_DEDUP_GATE_CAPS}. Set `disabled:true` to opt out entirely
   *  (gate not constructed, no consult cost). */
  dedupGateConfig?: {
    disabled?: boolean
    caps?: Partial<DedupGateCaps>
    /** aug-23 priority 2 — OPT-IN no-progress ceiling. After this many blocked
     *  verdicts against ONE bucket the run ends (`loop.no_progress`). Absent ⇒
     *  the gate only steers, byte-identical to before. Deliberately NOT on
     *  `DedupGateCaps` (a total interface whose defaults would force a value). */
    hardStopAfter?: number
  }
  /**
   * ADR-0229 — pre-flight dispatch guard composing three already-shipped pure
   * detectors (`gitWriteProtectReason` / `decideBranchOnly` / `isHostAllowed`)
   * behind one closed `DispatchGuard` port. Consulted by the dispatch seam
   * BEFORE the admissibility gate; a `deny` short-circuits with preview tag
   * `"guard-deny"` (hardDeny:true ⇒ terminal, no retry) and an `ask`
   * collapses to `"guard-ask"` (HITL re-routing is a deferred follow-up).
   *
   * Absent ⇒ dispatch is BYTE-IDENTICAL to the pre-ADR path (single optional-
   * chain `undefined` check, zero allocation). The default impl
   * (`defaultDispatchGuard`) takes its options at construction; pass the
   * already-built instance here.
   */
  dispatchGuard?: DispatchGuard
  /**
   * ADR-0242 — Cursor 8-arm `stop_reason` typed router. Consulted at the
   * same point as the legacy `decideOnAssembled` mapping in `runTurn`
   * BEFORE the existing 3-stage fallback. When the policy returns
   * `{ kind: "continue" }` (or is absent), the legacy mapping retains the
   * final word — byte-identical to the pre-ADR path. Non-`continue`
   * actions short-circuit the turn:
   *   - `surface` → terminal `error` outcome carrying `reason`.
   *   - `abort`   → terminal `error` outcome tagged `stop-abort`.
   *   - `hitl`    → terminal `error` outcome tagged `stop-hitl`
   *                 (HITL queue routing deferred to a follow-up).
   *
   * Absent ⇒ zero allocation (single optional-chain check). The default
   * impl (`defaultStopReasonPolicy()`) is the Cursor 3.2.16 routing table
   * verbatim; pass the already-built policy here.
   */
  stopReasonPolicy?: StopReasonPolicy
  /**
   * Permission stack opt-in (ADR-0046 — per-thread + per-host + post-denial
   * precedence). Absent / `enabled:false` ⇒ admissibility-gate skips the
   * stack consultation and the loop is byte-identical. When `enabled:true`,
   * the gate consults the stack BEFORE the legacy mode-policy:
   *   1. post-denial user override beats every rule below;
   *   2. per-thread record (keyed by `sessionId`) decides next;
   *   3. per-host mode (`hostId`, defaults to `resolveHostId()`) decides next;
   *   4. fall through to the legacy mode-policy.
   *
   * The store is the process singleton unless the composition root injects
   * `admissibility.permissionStore`; the gate falls back only when that
   * nested slot is absent (kept for backward compatibility).
   */
  permissionStack?: { enabled?: boolean; hostId?: string }
  /**
   * ADR-0061 (absorb #2) permission pattern-grant store — session-scoped
   * cache of patterns the user has granted, used by the admissibility-gate
   * to auto-pass actions whose `rememberPatterns` are fully covered.
   * Default-OFF; see ADR-0061.
   */
  permissionPatternStore?: PatternGrantStore
  /**
   * ADR-0061 hardening — operator override allowing the pattern auto-pass
   * to fire even when the action self-flags `isMaybeDangerous: true`.
   * Absent/false ⇒ dangerous actions ALWAYS go through the reviewer.
   */
  permissionAllowDangerous?: boolean
  /**
   * Layered-policy merge strategy (`policy-merge` knob /
   * `QUANTA_POLICY_MERGE_STRATEGY`). Selects how layered named permission
   * profiles (per-user / per-repo / team-admin) are folded into the effective
   * profile at the composition root via `mergeProfileLayers`:
   *   - `source-precedence` — most-authoritative present source wins each field
   *     (team-admin > per-repo > per-user > default). This is the CURRENT
   *     semantics — selecting it is byte-identical to the legacy single-profile
   *     wire when only one layer is present.
   *   - `most-restrictive`  — the SAFER value wins each field regardless of
   *     source authority (per `PROFILE_RESTRICTIVENESS`).
   *
   * Absent ⇒ the composition root treats it as `source-precedence` (the
   * pre-existing precedence), so an unset knob preserves current behavior
   * byte-identically. Read by `buildBaseFromArgs`; not consumed by the loop.
   */
  policyMergeStrategy?: MergeStrategy
  /**
   * Wave-A admissibility bundle (ADR-0029/0031/0046/0061). Groups the
   * optional reviewer / rule-store / injected permission-store knobs under
   * ONE slot so new gate options do not keep expanding the top-level config.
   * Absent ⇒ dispatch passes no Wave-A overrides and the gate stays on its
   * legacy path (byte-identical).
   */
  admissibility?: {
    permissionStore?: PermissionStore
    rulesStore?: RulesStore
    noMatchPolicy?: "deny" | "fallthrough"
    reviewerPort?: ReviewerPort
    defaultReviewer?: ReviewerTier
    priorDenials?: ReadonlyArray<DenialMemory>
    decidedAt?: () => number
    pendingPermissions?: ReadonlyArray<PendingPermission>
    onPatternCascade?: (info: {
      grantedPatterns: readonly string[]
      cascadedToolCallIds: readonly string[]
      learningSource: LearningSource
      suggestedAllowlistEntry: string | null
    }) => void
    allowlistEscalated?: Set<string>
    reviewKindOverride?: ReviewKind
    /**
     * Capability B (multi-agent coordination) — leader-mediated escalation port.
     * Injected by the composition root ONLY for a worker subagent when
     * `QUANTA_TEAM_BROKER` is on. A SOFT-denied tool escalates to the leader's
     * HITL authority; HARD_DENY is structurally never escalatable. Absent ⇒
     * byte-identical legacy deny. See `coordination-broker-wire.ts`.
     */
    coordinationBroker?: import("../admissibility-gate").GateEscalationBroker
    /**
     * §3.2 (ticket-04a) — tool-switch CIRCUMVENTION tracker. The session-scoped
     * accumulator of prior soft-denies; the gate consults it (`opts.turn` from
     * `run.turn`, write-effects auto-extracted) to catch a Bash command that
     * writes a file an Edit/Write deny-rule protects. The detection + gate +
     * classifier prompt were fully built but DEAD (never instantiated); the
     * comp-root mints this ONLY when `QUANTA_CIRCUMVENT_DETECT` is on. Absent ⇒
     * the gate's circumvention precheck never arms (byte-identical legacy).
     */
    circumventionTracker?: import("@/permission").CircumventionTracker
  }
  /**
   * Plan-exit port (ADR-0062). Host-supplied I/O seam that surfaces a plan
   * and returns a {@link PlanExitOutcome}. Absent ⇒ plan-exit flow never
   * invoked (legacy plan-mode posture unchanged). See `./plan-exit-flow.ts`.
   */
  planExitPort?: PlanExitPort
  /**
   * Within-run plan-exit lifecycle callback. When the `request_plan_exit`
   * tool resolves through {@link planExitPort}, dispatch calls this with the
   * exact plan text and validated outcome so the loop can apply mode/store
   * changes at the NEXT agent-turn boundary. Absent ⇒ the tool still relays
   * the decision text, but no lifecycle follow-through runs (legacy partial
   * wire from ADR-0086).
   */
  onPlanExitOutcome?: (event: { readonly plan: string; readonly outcome: PlanExitOutcome }) => void
  /**
   * Within-run plan-ENTRY callback — the inverse of {@link onPlanExitOutcome}.
   * When the `enter_plan_mode` tool fires, dispatch calls this with the model's
   * reason so the loop can flip collaboration mode to `plan` at the NEXT
   * agent-turn boundary (see `applyPendingPlanEntry`). Absent ⇒ the tool relays
   * its ack text but no flip runs (byte-identical off).
   */
  onPlanEnterRequest?: (event: { readonly reason: string }) => void
  /**
   * Plan-queue helper (ADR-0128). Pure in-memory queue of follow-up user
   * inputs captured WHILE a turn is in progress, replayed at turn
   * boundary. Codex's unique `queued-follow-ups` pattern. Helper-only —
   * default-OFF; nothing in the loop instantiates this slot today. Future
   * consumer wiring (mode.ts mid-turn-steering, CLI typed-while-running)
   * is a separate ADR. Sibling to `followUpQueue` (ADR-0037) which is the
   * WIRED follow-up queue; this slot is the SOTA++ typed-shape primitive
   * for future surfaces.
   */
  planQueue?: { store: PlanQueueStore }
  /**
   * Structured plan store (ADR-0095 draft). When wired, the dispatch seam
   * adapts this into a `PlanMutator` on every ToolContext and
   * `buildSessionFeatures` registers the 5 structured plan tools
   * (`current_plan` / `create_plan` / `update_todos` / `update_plan` /
   * `remove_todos`). Absent ⇒ those tools are NOT registered; collaboration
   * plan posture (ADR-0036) still works without structured plan state
   * (byte-identical legacy). Persistence via {@link planSnapshotStore}.
   */
  planStore?: PlanStore
  /**
   * Optional persistence backing for {@link planStore} (ADR-0097 P7).
   * Mirrors `followUpQueueSnapshotStore` discipline:
   *   - session-start: load() → planStore.restore(snap) → emit plan_snapshot
   *   - session-end:   planStore.snapshot() → save(snap)
   * Errors at either boundary collapse to an `error` AgentEvent — they
   * MUST NOT crash session-start or block session-end. Absent ⇒ the plan
   * is session-scoped only (default-OFF byte-identical).
   */
  planSnapshotStore?: {
    load(): Promise<import("../plan/snapshot").PlanSnapshot | null>
    save(snap: import("../plan/snapshot").PlanSnapshot | null): Promise<void>
  }
  /**
   * Operator-side user-input port (ADR-0097 draft, ADR-0086 sister). When
   * wired, the `request_user_input` tool is registered + dispatched via
   * `ToolContext.requestUserInput`. Absent ⇒ tool NOT registered (default-OFF
   * byte-identical). Surface (CLI / IDE modal / RPC) supplies the
   * answer/cancelled decision asynchronously.
   */
  userInputPort?: UserInputRequester
  /**
   * RFC-01 A3 attention PRODUCER — the per-session pending-question authority
   * (`@/session/user-question`). When wired (composition resolves it ONLY under
   * the `QUANTA_ATTENTION_NAV` gate, from the same `buildSessionAuthorities`
   * instance A2's `AttentionReader` reads), the dispatch seam routes
   * `request_user_input` THROUGH the broker instead of the legacy
   * {@link userInputPort}, binding the owner from the explicit
   * {@link spawnedAsTaskId}. This publishes a pending record the attention
   * projection surfaces, and the subagent runner propagates the SAME broker down
   * the spawn tree so every child shares one authority.
   *
   * PRESENT ⇒ broker supersedes `userInputPort` (the CLI inline surface becomes
   * the broker's answer adapter in A4). ABSENT ⇒ byte-identical legacy path
   * (`userInputPort` used verbatim; NO broker interaction) — the gate is the
   * broker's presence, INDEPENDENT of the subagent-panel gate
   * (`QUANTA_WEB_SUBAGENTS`), so panel-ON + attention-OFF leaks nothing.
   */
  questionBroker?: UserQuestionBroker
  /**
   * RFC-05 E5 — the AGENT-owned `request_user_input` availability reader. A
   * narrow, duck-typed capability the composition binds from the live posture
   * authority (`livePostureQuestionReader`): `askOutsidePlan()` re-reads the
   * bound question knob on every call. It is the ONE reader that drives BOTH the
   * model tool-SPEC projection (`buildUserInputBlock` omits the tool when denied)
   * AND the pre-DISPATCH admission consult (`consultQuestionAvailability` rejects
   * a stale handle when denied) — so visibility and execution never diverge.
   *
   * Duck-typed / agent-owned on purpose (RFC-05 hard rule): the `@/tool` slice
   * MUST NOT import `@/permission`. The permission-slice predicate
   * (`canRequestUserInput`) is reached ONLY through this agent-side reader.
   *
   * Default-OFF: ABSENT ⇒ question available by default (no posture denies) —
   * byte-identical to the pre-E5 spec/dispatch path.
   */
  questionGuard?: QuestionAvailabilityReader
  /**
   * ADR-0296 PROMPT-mode consent port. When wired AND the effective bash
   * `timeout_behavior` is `prompt`, the bash tool calls this AT the deadline to
   * surface a one-keystroke "move to background?" prompt (mapped onto
   * `ToolContext.requestBackgroundConsent`): `true` ⇒ detach into the bg
   * registry, `false` ⇒ kill (legacy timeout). Absent ⇒ `prompt` degrades to
   * plain `background` (auto-detach, no prompt) — byte-identical to the
   * unwired path. The host surface (CLI mid-turn approval channel / IDE modal /
   * RPC) supplies the decision asynchronously.
   */
  backgroundConsentPort?: (info: {
    readonly command: string
    readonly elapsedMs: number
  }) => Promise<boolean>
  /**
   * Per-turn work-metrics sink (ADR-0064). Absent ⇒ the loop instantiates no
   * collector and emits nothing (byte-identical default-OFF). Present ⇒ one
   * collector per turn; `emit(metrics, { turnId })` at turn end.
   */
  workMetricsSink?: WorkMetricsSink
  /**
   * ADR-0065 model-swap retry — opt-in ordered list of alternate models a
   * surface (e.g. CLI `/retry-with`) can escalate to or jump to by id.
   * Absent / empty ⇒ the slash command is a no-op. Order is significant
   * (defines escalation sequence). Wired by the surface layer.
   */
  modelCandidates?: readonly ModelCandidate[]
  /**
   * ADR-0328 — image sanitization retry options. When `enabled: true`, the
   * loop wraps `llm` with `withImageSanitizationRetry(llm, port)` (where
   * `port = createWorkingMemoryHistorySanitization(wm)` is bound to the
   * loop's WorkingMemory). On an `LLMError("invalid_image", ...)` thrown by
   * the wrapped adapter, the port scrubs the LAST message's image/document
   * blocks and re-streams.
   *
   * Default-OFF: absent (or `enabled !== true`) ⇒ no wrap, byte-identical
   * legacy behavior — an `invalid_image` 400 propagates as `fatal` via the
   * Codex-spec router (same policy as `bad_request`).
   *
   * Knobs (all exactOptional):
   *   - `enabled`     turn the wrap on. Default: `false`.
   *   - `maxAttempts` sanitize-and-retry budget per stream() call. Default:
   *                   `1` (Codex parity). Clamped to [0, 5].
   *   - `placeholder` text written into the sanitized text block. Default:
   *                   `"[invalid image removed]"`. Observable in the
   *                   transcript; hosts may rebrand without changing
   *                   semantics.
   *
   * STATUS — production wire is a follow-up. The wrapping function ships
   * here (`src/llm/image-sanitization-retry/`); hooking it into
   * `createRunAgentContext` (`src/agent/loop.ts:~2049`) after `wm` is
   * constructed is the next step. Until then this slot is shape-only —
   * present so the schema is stable when the wire lands. See ADR-0328
   * §Wire for the hookup TODO.
   */
  imageSanitizationRetry?: {
    readonly enabled?: boolean
    readonly maxAttempts?: number
    readonly placeholder?: string
  }
  /**
   * Session-level reasoning-effort accessor. Read once per turn by
   * `resolveSkillTurnOverride` to derive the `thinking:{enabled,budget_tokens}`
   * field on the per-turn LLMInput. Precedence: skill > session > default.
   *
   * A FUNCTION (not a value) so a surface-owned store (`/effort` slash) can
   * mutate it across turns without re-assembling AgentConfig. Returning
   * `undefined` (or the `"default"` tier) ⇒ no `thinking` field on LLMInput
   * (byte-identical to today, RFC §1.2 default-OFF). A skill's own `effort:`
   * override still wins when present.
   */
  sessionEffort?: () => EffortLevel | undefined
  /**
   * #17 (C3, jun-4-brief-mode RFC) — session-level brief-mode read accessor.
   * Read once per turn by `assembleTurnContext` to splice {@link BRIEF_NOTICE}
   * into the per-turn DYNAMIC `<system-reminder>` tail (never the cached
   * prefix). A FUNCTION (mirrors {@link sessionEffort}) so a surface-owned
   * `BriefStore` (`/brief` slash) can flip it across turns without
   * re-assembling AgentConfig. Returning `undefined`/`false` ⇒ no notice
   * (byte-identical default-OFF). ORTHOGONAL to `sessionEffort` — both compose.
   */
  sessionBrief?: () => boolean | undefined
  /**
   * #17 — backing {@link BriefStore} for the `set_brief` CONTROL-OP write path
   * (`handleSubmissionControlOp` → {@link applyBriefTransition}). The SAME store
   * `sessionBrief` reads, threaded so a host/model-initiated `set_brief`
   * submission mutates the live posture the next turn observes. Absent ⇒ the
   * control-op is observed-and-ignored (byte-identical; the parent turn keeps
   * running). The `/brief` slash writes the store directly on the surface, so
   * this is ONLY needed for the submission-envelope path.
   */
  briefStore?: BriefStore
  /**
   * ADR-0417 (absorption gap A1) — prompt-keyword + tool-failure effort
   * escalation classifier. Session-scoped advisory: it watches user prompts
   * for "think harder" style keywords and accumulates per-tool failures,
   * surfacing a recommended {@link EffortLevel}. ADVISORY ONLY — this slot is
   * a pure port; the consumer wire (loop / prompt-pipeline folding the
   * recommendation into per-turn effort) is DEFERRED to a later wave. Absent
   * ⇒ no classification, byte-identical (RFC §1.2 default-OFF).
   */
  effortClassifier?: EffortClassifierPort
  /**
   * ADR-0417 (absorption gap A2) — apply-patch fast-apply fallback. When
   * `apply_patch` rejects a V4A patch (anchor drift / parse error), one
   * focused side-conversation attempt re-emits the patch given the failure
   * reason. This slot is a pure port; the consumer wire (apply-patch.ts
   * invoking it on a typed failure before surfacing the error) is DEFERRED to
   * a later wave. Absent ⇒ no fallback attempt, byte-identical (RFC §1.2
   * default-OFF).
   */
  fastApplyFallback?: FastApplyFallbackPort
  /**
   * jun-7-misc 06 (ADR ≥0497) — model-based fast-apply MERGE rung. When the
   * deterministic edit ladder (exact + fuzzy) misses, this port asks a dedicated
   * apply model to fold a terse edit sketch into the full original file and
   * return the merged file; the `edit` tool verifies the proposal but requires a
   * separate host-owned FastApplyMergeReviewSeam before commit. The composition root constructs the producer behind
   * `QUANTA_FAST_APPLY_MERGE=1` + a configured `QUANTA_FAST_APPLY_MODEL`
   * (`optional-ports.ts`) and the dispatch seam threads it onto
   * `ToolContext.fastApplyMerge`. The normal host intentionally does not invent
   * review authority from a post-write diff observer, so without an explicit
   * reviewer the tool fails closed before provider dispatch.
   */
  fastApplyMerge?: FastApplyPort
  /**
   * Host-owned review authority for a whole-file fast-apply merge. The dispatch
   * seam forwards this exact port to `ToolContext.fastApplyMergeReview`; it is
   * never inferred from a diff observer or environment variable. Missing,
   * rejecting, or throwing review remains a fail-closed typed mismatch before
   * provider dispatch and before any write.
   */
  fastApplyMergeReview?: import("@/tool").FastApplyMergeReviewSeam
  /**
   * Session-scoped role→model override carrier (ADR-0256). Surfaces that need a
   * live executor/default model resolver thread the SAME resolver instance here
   * so helper wires (for example fast-apply fallback) do not mint private
   * per-consumer state. Absent ⇒ no role override state is available and
   * consumers must degrade to their default-model path.
   */
  roleModelResolver?: RoleModelResolver
  /**
   * Self-inspection / self-mutation seam consumed by the `session_config`
   * tool. Read + write over the agent's own SDK posture (effort tier,
   * permission mode, identity mode, tool profile, model, provider). The
   * dispatch seam wires this directly into `ToolContext.sessionConfig`.
   * Absent ⇒ the tool returns a typed `not_wired` failure to the model (the
   * tool is still registered so the LLM can give the operator a coherent
   * reply either way; default-OFF is byte-identical to pre-ADR behavior since
   * no session previously called the tool).
   *
   * The composition root (`apps/cli/host/bootstrap-session.ts`) builds the
   * concrete seam from the existing `effortStore` + `permissionModeState` +
   * `identityModeState` + `toolProfileState` plus the resolved provider/model
   * from runtime config. Sliced (no `@/agent` ↔ `@/tool` cycle) via the
   * canonical declaration in `@/tool/types`.
   */
  sessionConfigPort?: import("@/tool").SessionConfigSeam
  /** ADR-0474 — OPTIONAL stale-read-guard state, threaded into every tool's
   *  `ToolContext.readFileState` by `buildToolContext`. Present ⇒ the host opted
   *  in (`staleReadGuardEnabled`); the composition root mints ONE `ReadFileState`
   *  per session so reads recorded by `read` are visible to `write`/`edit` of the
   *  same session. Absent ⇒ no tracking, no guard (byte-identical default-OFF). */
  readFileState?: import("@/tool/stale-read-guard").ReadFileState
  /** ticket-11 (P8 git-worktree agent tools) — OPTIONAL session-scoped active-
   *  worktree slot. The composition root mints ONE mutable holder per session
   *  (carrying the immutable session `repoRoot` / `sessionCwd`) ONLY when
   *  `QUANTA_WORKTREE_TOOL` is on; the `enter`/`exit`/`worktree_status` tools are
   *  registered alongside it and read+mutate it through `ToolContext.worktreeSlot`,
   *  while `bash`/`edit` read its current value through `ToolContext.activeWorktree`
   *  (the relative-cwd override / edit-fence). Absent ⇒ the worktree tools are NOT
   *  registered and `bash`/`edit` cwd is byte-identical to today (default-OFF).
   *  Duck-typed via the canonical `@/tool` declaration so `@/agent` need not
   *  redeclare the handle shape. */
  activeWorktreeSlot?: import("@/tool").WorktreeSlotHandle
  /** ADR-0182 — OPTIONAL prompt-cache observer. When the host wires one (gate
   *  `QUANTA_PROMPT_CACHE_STATUS`), `emitUsage` records each completion's
   *  cache-read / cache-creation token buckets into it, and the SAME instance
   *  backs the `prompt_cache_status` tool so the agent can answer "is prompt
   *  caching actually working?". The composition root mints ONE observer per
   *  session and passes it BOTH here (loop feed) and to
   *  `DefaultToolPorts.promptCacheObserver` (tool). Absent ⇒ no record call, no
   *  tool — byte-identical default-OFF. */
  promptCacheObserver?: import("@/observability/prompt-cache").PromptCacheObserver
  /** N1 — OPTIONAL background side-agent daemon registry. When the host wires one
   *  (gate `QUANTA_SIDE_AGENT`, constructed in the assembler with the real
   *  subagent runner / mailbox / timers per the `@/side-agent` Phase-2 note), the
   *  tier1 `buildSideAgentBlock` exposes the `side_agent_*` tools over it.
   *  Absent ⇒ no tools (byte-identical default-OFF). Duck-typed
   *  (`@/tool/side-agent` `SideAgentDaemonPort`) so `@/agent` need not import
   *  `@/side-agent` concretely. */
  sideAgentDaemons?: import("@/tool/side-agent").SideAgentDaemonPort
  /** Session-scoped background-shell registry teardown seam. The composition
   *  root wires the host singleton; the loop only needs the narrow killAll port,
   *  which keeps session-end disposal testable and slice-local. */
  bgShellRegistry?: { killAll(): Promise<void> }
  /** ADR-0144 slice-boundary — pre-computed OTLP span-content capture gate.
   *  Set at the composition root via `gateOn(env, CONTENT_CAPTURE_ENV)` so the
   *  @/agent core slice never reads `process.env` directly. Absent ⇒ false
   *  (content attributes are never attached — byte-identical default-OFF). */
  contentCaptureEnabled?: boolean
  /** ADR-0472 — OPTIONAL diagnostics provider for the edit-repair lint-delta.
   *  When present (host wired an LSP diagnostics source) AND
   *  `runtimeConfig().editRepairLoop` is on, the dispatch seam brackets a
   *  path-bearing edit (`edit`/`write`) with a pre/post diagnostics snapshot and
   *  appends the INTRODUCED-lint delta to the tool's model-facing output, so the
   *  model sees exactly what its edit broke. Absent ⇒ no bracket (byte-identical
   *  default-OFF). Duck-typed via inline import so this slice's type surface does
   *  not grow a new top-of-file dependency. */
  diagnosticsProvider?: import("@/tool").DiagnosticsProvider
  /** ADR-0472 / H1 — OPTIONAL edit-repair tuning + LoopOnCommand wiring (Cursor
   *  `ComposerCapabilityRequest.{LoopOnLints,LoopOnTests,LoopOnCommand}` parity).
   *  All fields default-OFF / byte-identical when absent:
   *   - `maxIters`           — repair iteration cap (default 2 when absent / < 1).
   *   - `customInstructions` — appended to every repair prompt (e.g. "keep the
   *                            public signature"). Absent ⇒ "".
   *   - `command` + `exec`   — when BOTH set AND `editRepairLoop` is on AND a
   *                            fast `llm` is wired, a path-bearing edit (`edit`/
   *                            `write`) is followed by a bounded `checkKind:
   *                            "command"` repair loop that runs `command` (a test
   *                            / build / lint script) and re-drives the fast model
   *                            until exit 0 or `maxIters`. Independent of the
   *                            diagnostics provider (LoopOnCommand needs no LSP).
   *                            Absent `command`/`exec` ⇒ no command loop. */
  editRepair?: {
    readonly maxIters?: number
    readonly customInstructions?: string
    readonly command?: string
    readonly exec?: import("../edit-repair-wire").ExecRunner
  }
  /**
   * ADR-0476 skill→MCP auto-attach session. ONE per-session coordinator the
   * composition root mints (assembler `maybeWireSkillMcp`) when
   * `QUANTA_SKILL_MCP_DEPS=1`, wired to `@/agent/plugin-mcp-launcher` (stdio) +
   * `@/mcp` HTTP-SSE (ADR-0391) via the dual-transport attach adapter. The loop
   * calls `reconcileSkillMcpForTurn` per turn over the active skills and
   * `shutdownAll()` at session end. Absent ⇒ both are pure no-ops (byte-
   * identical default-OFF). Duck-typed via inline import (slice surface stays
   * lean; the loop reaches it through the `SkillMcpReconcileConfigLike` view). */
  skillMcpSession?: import("@/skill/skill-mcp-deps").SkillMcpSession
  /**
   * ADR-0081 shell output delta streaming — opt-in observer for the typed
   * `ShellExecEvent` stream. The dispatch seam forwards this to
   * `ToolContext.onShellEvent` so the `bash` tool (and any future shell-
   * funnel tool) can stream incremental stdout/stderr without re-buffering.
   *
   * Absent ⇒ legacy buffered path is byte-identical (`runShell` skips event
   * emission entirely, no allocation). Present ⇒ start/stdout/stderr/exit|
   * aborted events fire in canonical order; the consumer MUST handle all
   * five `ShellExecEvent.kind` variants (exhaustive switch with `never`
   * default — adding a variant becomes a compile error at every caller).
   *
   * Use cases: CLI streaming TUI (paint output as it arrives), OTel span
   * exporter (chunk counter / bytes-attribute on the bash span), web/Tauri
   * surface (server-sent events).
   */
  onShellEvent?: ShellExecObserver
  /**
   * ADR-0084 speculative branch search — opt-in N-best verifier-prover. When
   * set, `buildSessionFeatures` registers the `branch_search` tool (the model
   * may call it on hard edits). Absent ⇒ tool unregistered, no scoring
   * overhead, byte-identical legacy single-trajectory path. Per-mode wiring in
   * `apps/agent/mode-presets`; closed `BranchSearchConfig` in
   * `@/agent/branch-search`. ci-bot leaves it unset (unattended N-best risk).
   */
  branchSearch?: BranchSearchConfig
}
