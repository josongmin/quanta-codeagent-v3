import type { LLMPort, Message, ModelCandidate, ResponsesContinuationStore } from "@/llm"
import type { LlmProvider } from "@/llm/providers"
import type { RoleModelResolver } from "@/llm/role-model-override"
import type { CodeActionPort, FormatPort, RenameApplyPort, SignatureHelpPort } from "@/lsp"
import type { EmbedderPort, PersistentStorePort } from "@/memory"
import type { Metrics } from "@/observability"
import type {
  DenialMemory,
  LearningSource,
  MergeStrategy,
  PatternGrantStore,
  PendingPermission,
  PermissionContext,
  PermissionStore,
  ReviewerPort,
  ReviewerTier,
  ReviewKind,
  ToolAction,
  TrustScopeRegistry,
} from "@/permission"
import type { CommitEmbedder, EmbeddingPort, RerankPort, RerankRegistry } from "@/retrieval"
import type { RulesStore } from "@/rules"
import type { LocalEnvSelection } from "@/runtime/local-env"
import type { NetworkProxyConfig, ProxyEnvInput } from "@/runtime/network-proxy"
import type { OsSandbox } from "@/runtime/os-sandbox"
import type { RedactionConfig } from "@/security"
import type { RunContext } from "@/shared"
import type { ShadowOdb } from "@/storage"
import type { DecisionEmitter, StreamPort } from "@/stream"
import type { ShellExecObserver, ToolRegistry, UserInputRequester } from "@/tool"
import type { WebSearchProvider } from "@/tool/web"
import type { ApprovalStateMachinePort } from "./approval-state-machine"
import type { AutoBackgroundConfig } from "./auto-background"
import type { BranchSearchConfig, ProgressLine } from "./branch-search"
import type { BudgetMeter, TaskBudget } from "./budget"
import type { BudgetLedger } from "./budget-ledger"
import type { CapEnforcer } from "./cap-enforcer"
import type { GranularRegistryPort } from "./checkpoint/granular-registry"
import type { CheckpointTriggerMode, DestructivenessOracle } from "./checkpoint-policy"
import type { CloseoutCriticConfig } from "./closeout-critic"
import type { ConfirmDecision } from "./confirm-decision"
import type { ConversationActionPort } from "./conversation-action"
import type { ConversationCheckpointStore } from "./conversation-checkpoint"
import type { DedupGate, DedupGateCaps } from "./dispatch-dedup"
import type { DispatchGuard } from "./dispatch-guard"
import type { EffortLevel } from "./effort"
import type { EffortClassifierPort } from "./effort-classifier"
import type { FastApplyFallbackPort, FastApplyPort } from "./fast-apply-fallback"
import type { FollowUpQueue, PausedReason } from "./follow-up-queue"
import type { SessionForker } from "./fork-session"
import type { GlobRule } from "./glob-rules"
import type { HandoffRequiredEvent } from "./hitl-tier"
import type { HookBus } from "./hooks"
import type { IdeContextProvider } from "./ide-context"
import type { LocalizePhaseConfig, LocalizePhaseState } from "./localize-phase-guard"
import type { NamedAgentResolver } from "./named-agent-registry"
import type { ObjectivePort } from "./objective"
import type { PlanStore } from "./plan/state"
import type { PlanExitOutcome } from "./plan-exit"
import type { PlanExitPort } from "./plan-exit-flow"
import type { PlanQueueStore } from "./plan-queue"
import type { AgentMode } from "./prompt"
import type { RepoRules } from "./repo-rules"
import type { RunLedgerPort } from "./run-ledger"
import type { ModePolicy } from "./run-mode"
import type { ShadowVerifyPort } from "./shadow-verify"
import type { ActiveTurnState } from "./steering"
import type { StopReasonPolicy } from "./stop-reason"
import type { BackgroundSubagentScheduler } from "./subagent-background"
import type { MailboxPort } from "./subagent-mailbox"
import type { Submission } from "./submission"
import type { SkillsBlock, SubagentBlock, WorkingStateBlock } from "./types/agent-capabilities"
import type {
  CompactionBreakerOptions,
  CompactionConfigBlock,
  OnPreCompactCallback,
  PreCompactRequestQuery,
} from "./types/compaction-config"
import type { MemoryConfigBlock, MemoryConsolidatorBlock } from "./types/memory-config"
import type { RulesConfigBlock } from "./types/rules-config"
import type { WorkMetricsSink } from "./work-metrics-collector"

// Re-export the extracted Tier-1 capability option blocks (subagent / skills /
// workingState — branchSearch already lives in `./branch-search`). The
// `from "./types"` import contract for every consumer stays byte-identical
// after this split (T3, T2 follow-up).
export type {
  SkillsBlock,
  SubagentBlock,
  WorkingStateBlock,
} from "./types/agent-capabilities"
// Outcome surface re-exported from ./types/agent-outcome (cohesion split,
// byte-identical). Keeps the `from "./types"` import contract unchanged for
// the 132 consumer files that depend on these names being on this module.
export type {
  AgentOutcome,
  MemoryCitation,
  RedactionRollup,
  StopReason,
} from "./types/agent-outcome"
// Re-export the extracted memory + compaction config types so that every
// existing consumer reading them via `from "./types"` (or the `@/agent`
// barrel) keeps working byte-for-byte after this split.
export type {
  CompactionBreakerOptions,
  CompactionConfigBlock,
  OnPreCompactCallback,
  PreCompactDecision,
  PreCompactRequestQuery,
} from "./types/compaction-config"
export type { MemoryConfigBlock, MemoryConsolidatorBlock } from "./types/memory-config"
// ADR-0233 (Wire 2) — Vendor-detector composition knobs for `AgentConfig.rules`.
export type { RulesConfigBlock } from "./types/rules-config"

// AgentConfig `extends` the three cohesion groups defined at the BOTTOM of
// this file (SafetyConfig / PermissionExtrasConfig / SteeringConfig).
// Declaration-merging keeps every field shape byte-identical to consumers;
// the inheritance documents the grouping and lets each subsystem take a
// narrow slice as its parameter type (audit #1).
/**
 * Subsystem consumers SHOULD take a narrow `Pick<AgentConfig, ...>` rather than
 * the full bag — see `RecoveryConfig`, `MemoryConfig`, `FeaturesConfig`,
 * `TurnContextConfig`, `BudgetConfig`, `AdmissibilityGateConfig` below.
 * Adding a new field here without an associated narrow Pick is an SRP
 * regression.
 */
export interface AgentConfig extends SafetyConfig, PermissionExtrasConfig, SteeringConfig {
  llm: LLMPort
  registry: ToolRegistry
  stream: StreamPort
  /**
   * ADR-0267 (Phase 2 of ADR-0239) — narrow side-channel for gate-decision
   * events. SEPARATE from `stream` on purpose: the `decision` AgentEvent
   * variant is rendered by the stdout adapter + persisted by the JSONL
   * recorder the moment it lands on `stream`, so routing decisions through
   * `stream` by default would break the default-OFF byte-identical surface
   * invariant. The admissibility gate calls `decisionEmitter?.emit(...)` at
   * its 3 hot sites (rule / hook / permission). Absent ⇒ no emit, no
   * allocation, no visible bytes — byte-identical to the pre-Phase-2 path.
   * Composition roots wire this against the debug-tracer (NOT the main
   * stream) only when developer-mode is on.
   */
  decisionEmitter?: DecisionEmitter
  permission: PermissionContext
  /** Conversation seed (typically one user message). */
  messages: Message[]
  system: string
  cwd: string
  maxTurns: number
  signal: AbortSignal
  /**
   * Asked when the permission policy returns `ask` (or the always-confirm HITL
   * tier fires). Absent ⇒ treated as deny.
   *
   * Returns either a legacy `boolean` (`true` allow / `false` deny —
   * BYTE-IDENTICAL: every existing caller uses this form and is unchanged) or a
   * structured {@link ConfirmDecision} (ADR-0076 Gap-4). A `ConfirmDecision`
   * adds the `deny_and_steer` verb (Cursor REJECT_AND_TELL): deny the action
   * AND carry a non-empty corrective `steer` the loop injects as the next-turn
   * user message. The gate normalizes the return via `normalizeConfirm` and,
   * on `deny_and_steer`, surfaces the steer on `DispatchResult.steerInjection`.
   */
  onConfirm?: (action: ToolAction) => Promise<boolean | ConfirmDecision>
  /**
   * Long-term memory store. Absent ⇒ recall/persist are skipped entirely and
   * the loop is byte-for-byte unchanged (RFC §6.3, behavior-preserving).
   */
  store?: PersistentStorePort
  /** Stable id for the current session, used to tag persisted memory. */
  sessionId?: string
  /**
   * Embedding provider for semantic recall + dedup (long-term memory, RFC §6.3).
   * Absent ⇒ recall/consolidation degrade to lexical+tag+freshness only; the
   * loop is otherwise unchanged. Wired by the app layer (OpenAI adapter).
   */
  embedder?: EmbedderPort
  /**
   * Long-term memory tuning (RFC §6.3). Absent ⇒ all defaults;
   * with no `store` the whole block is inert. Behavior-preserving when unset.
   * See {@link MemoryConfigBlock} for the field-level docs.
   */
  memory?: MemoryConfigBlock
  /**
   * ADR-0068 2-phase memory consolidator session-end hook (L4 wire).
   * Absent ⇒ no consolidator runs at session-end (byte-identical for every
   * legacy caller — RFC §1.2 default-OFF). See {@link MemoryConsolidatorBlock}
   * for the field-level docs (enabled / forceSummarization / port / store /
   * threadId semantics).
   */
  memoryConsolidator?: MemoryConsolidatorBlock
  /**
   * Compaction tuning. Absent ⇒ compaction is skipped entirely (existing
   * suites with no compaction config are unaffected). See
   * {@link CompactionConfigBlock} for the field-level docs
   * (thresholdTokens / keepRecentTurns / summarizerLlm / archive).
   */
  compaction?: CompactionConfigBlock
  /**
   * Cursor-style pre-compact HITL hook (ADR-0075). When the proactive
   * compaction path is ABOUT to fire (token threshold crossed AND a
   * summarizable boundary exists), the loop builds a
   * {@link PreCompactRequestQuery} and awaits this callback. See
   * {@link OnPreCompactCallback} for the full semantics (approve /
   * defer_one_turn / force_now / error → defer). Absent ⇒ auto-approve,
   * byte-identical.
   */
  onPreCompact?: OnPreCompactCallback
  /**
   * In-process hook bus (RFC §13 Q1). Absent ⇒ no events emitted, zero
   * overhead, loop byte-for-byte unchanged.
   */
  hooks?: HookBus
  /**
   * Plan mode (RFC §13 Q3). When true: system prompt is augmented and any
   * non-read-only tool is blocked before permission/execute. Absent/false ⇒
   * unchanged. Superseded by `mode` (see below) — both are accepted; `mode`
   * wins when set.
   */
  planMode?: boolean
  /**
   * Agent interaction mode (Codex `mode-and-plan-process-audit.md` absorption).
   * Extends `planMode` into a typed enum: `default | plan | review | audit`.
   * `plan` matches the legacy boolean. `review` / `audit` add task-posture
   * mode notices in the per-turn reminder; tool gating for these is wired in
   * Phase 3. Absent ⇒ derived from `planMode` (byte-identical).
   */
  mode?: AgentMode
  /**
   * Plan-vs-Default collaboration mode (ADR-0036). 2-mode enum tied to the
   * DISPATCH SEAM (orthogonal to {@link mode}, which drives the per-turn
   * PROMPT posture). In `"plan"` posture every mutating tool is blocked at
   * the dispatch seam BEFORE any tool implementation runs — the block is
   * driven by an explicit per-tool table in `./mode.ts#MUTATING_TOOL_TABLE`
   * so a future tool added without classifying its mutating-kind is a hard
   * fail rather than a silent allow.
   *
   * Default-OFF: absent ⇒ derived as `"default"` (no block, byte-identical
   * for every legacy caller). The two-mode collaboration enum is INTENT-
   * DISTINCT from the 4-mode {@link mode}: a host may legitimately run a
   * `mode: "review"` posture (a read-only-by-prompt mode) without setting
   * `collaborationMode: "plan"` — the prompt posture controls what the
   * model is told; the dispatch posture controls what the registry will
   * RUN. Setting both keeps the safe direction: the dispatch seam blocks
   * mutating calls regardless of what the prompt says.
   */
  collaborationMode?: import("./mode").CollaborationMode
  /**
   * Repo-local rules to inject ahead of memory hints as repo authority (Codex
   * `repo-local-rule-ingestion-audit.md` absorption). Loaded by the caller
   * (e.g. via `loadRepoRules(cwd)`) — the loop does not auto-read so contexts
   * that should NOT adopt workspace rules (bench sandboxes, agent forks) stay
   * byte-identical. Absent ⇒ no repo-rules block.
   */
  repoRules?: RepoRules
  /**
   * Static session context block prepended into the cached system sections.
   * Caller-owned: cross-session memory, tool snapshots, or other durable
   * host context may live here. Absent ⇒ prompt stays byte-identical.
   */
  sessionCtx?: string
  /**
   * File-scoped rules (Cursor `.cursor/rules/*.mdc` parity — glob-matched +
   * always-applied kinds). Loaded by the caller (e.g. `loadGlobRules(cwd)`),
   * same opt-in posture as `repoRules`. `rules` is the FULL discovered set;
   * `changedPaths` is the per-turn file list that drives glob selection (a host
   * may pass the same list it gives `skills.changedPaths`). Each turn the loop
   * injects `alwaysApply` rules ∪ rules whose globs match a changed path.
   * Absent ⇒ no block, byte-identical (RFC §1.2 default-OFF).
   */
  globRules?: { rules: GlobRule[]; changedPaths?: string[] }
  /**
   * ADR-0233 (Wire 2) — Multi-source rules vendor-detector composition.
   *
   * When set with `vendorDetectorEnabled: true`, the caller-side
   * `loadGlobRulesWithVendors(cwd, config.rules)` helper composes the
   * legacy `loadGlobRules(cwd)` output with `DetectedRule[]` from the
   * vendor detector slice (ADR-0205). Hosts that have already wired the
   * helper into their session-start flow pass the resulting GlobRule[]
   * through {@link globRules}.rules as before — this slot is the policy
   * knob set, not a runtime store.
   *
   * Absent / `vendorDetectorEnabled !== true` ⇒ no composition, byte-
   * identical to legacy (RFC §1.2 default-OFF). See {@link RulesConfigBlock}
   * for the field-level docs (vendorDetectorEnabled / vendors / priority /
   * detector override semantics).
   */
  rules?: RulesConfigBlock
  /**
   * Metrics registry (RFC §8 Phase 3). Absent ⇒ no metrics recorded; loop
   * behavior identical.
   */
  metrics?: Metrics
  /**
   * ADR-0452 — session-startup prewarm + Time-To-First-Message (Codex
   * `session_startup_prewarm` absorption). Absent ⇒ NO prewarm call and NO
   * TTFM metric (the loop is byte-identical to the pre-slice path). Present
   * (set by the `QUANTA_PREWARM` knob at the composition root) ⇒ the loop, at
   * session start (before the first turn), best-effort warms the LLM
   * connection via {@link import("@/llm").prewarmLlm} (a no-op unless the
   * adapter implements the optional `prewarm` capability) and records TTFM on
   * the first turn's LLM-stream dispatch.
   *
   * The capability half of startup prewarm (tools / skills / classifier) is
   * ALREADY eager in `buildSessionFeatures`; this block only adds the
   * LLM-connection warm + the observability, both gated together.
   */
  prewarm?: {
    /** Master gate. Only `true` arms the prewarm call + TTFM recording. */
    readonly enabled: boolean
    /** Injected wall-clock for TTFM (epoch ms). Inject a fake clock in tests
     *  for determinism; defaults to `Date.now` when omitted. NO real timer is
     *  read in the loop body — this is the single source. */
    readonly now?: () => number
    /** Optional abort signal for a slow connection warm so it can never delay
     *  the first turn. Independent of the loop's lifetime `signal`. */
    readonly warmSignal?: AbortSignal
  }
  /**
   * jun-6 account-ratelimit-snapshot (gate `QUANTA_RATELIMIT_PROACTIVE`).
   * Optional injected collaborators for the PROACTIVE rate-limit path so the
   * loop reads no real clock and sleeps no real timer in tests.
   *   - `now` — injected wall-clock (epoch ms) fed to `parseRateLimitSnapshot`
   *     and used to time the proactive delay. Defaults to `Date.now`.
   *   - `sleep` — injected delay primitive `(ms) => Promise<void>`. Defaults to
   *     the loop's abort-aware `setTimeout` sleep. A fake lets a test assert the
   *     delay magnitude WITHOUT wall-clock waiting.
   * The block is consulted ONLY when `runtimeConfig().proactiveRateLimit` is on;
   * absent ⇒ the proactive store is never constructed, the header hook is never
   * wired, no delay is applied, no notice emitted — byte-identical to today's
   * reactive 429-retry path. */
  proactiveRateLimit?: {
    readonly now?: () => number
    readonly sleep?: (ms: number) => Promise<void>
  }
  /**
   * Subagent recursion depth of THIS agent (0 = root user session). Set by
   * the subagent runner for forked children; propagated onto `ToolContext`
   * by the dispatch seam so the `Agent` tool can enforce `maxDepth`. Absent ⇒
   * 0 (root). Subagent absorption (ADR-0011).
   */
  depth?: number
  /**
   * Enable the subagent system (Tier 1 capability, ADR-0011). Absent ⇒ the
   * `Agent`/`Task`/`TaskOutput`/`TaskStop` tools are NOT registered and the
   * loop is byte-identical. When present the loop builds a `SubagentRunner`
   * (forked `runAgent`, depth+1, filtered registry) and registers the tools.
   *
   * See {@link SubagentBlock} for the field-level docs.
   */
  subagent?: SubagentBlock
  /**
   * Enable the skill system (Tier 1 capability, ADR-0011). Absent ⇒ no skill
   * discovery and the `Skill`/`ToolSearch` tools are NOT registered (loop
   * byte-identical). When present, skills are discovered + the `Skill` /
   * `ToolSearch` tools are registered.
   *
   * `dir` (OPTIONAL — ADR-0045 follow-up): the user skills directory. When
   * OMITTED, only the BUNDLED system skills (`localize-fault`, `progress-audit`
   * — version-pinned, shipped with the framework) are discovered. This lets a
   * host enable the discipline skills WITHOUT remembering to point at a user
   * dir (the whole rationale of bundled skills). `skills: {}` ⇒ system skills
   * only; `skills: { dir }` ⇒ user dir + system skills (system wins on a name
   * collision so a user skill cannot weaken a bundled one). `skills` ABSENT ⇒
   * no Skill tool, byte-identical default-OFF (RFC §1.2).
   *
   * `changedPaths` (optional, conservative L1→L2 wiring): when set, the
   * per-turn active-skills inventory is pre-filtered via
   * `skillsActivatedFor(allSkills, changedPaths)` — a skill with `paths:` in
   * its frontmatter only appears in the inventory when one of those globs
   * matches a changed path. A skill WITHOUT `paths:` is always included
   * (unconditional). `changedPaths` UNSET ⇒ no filter, exact prior behavior
   * (byte-identical). Hosts compute this list however they want (git diff,
   * file watcher, manual hint).
   *
   * See {@link SkillsBlock} for the field-level docs.
   */
  skills?: SkillsBlock
  /**
   * Compaction circuit-breaker control (Tier 0 safety hardening, ADR-0011). The
   * breaker is ON by default with `DEFAULT_COMPACTION_BREAKER_CAPS` — it only
   * trips on pathological compaction thrash (≥N consecutive no-progress
   * compactions), so normal flows are unaffected. See
   * {@link CompactionBreakerOptions} (`disabled` opts out; `caps` overrides
   * individual thresholds).
   */
  compactionBreaker?: CompactionBreakerOptions
  /**
   * Verify-guard control (Tier 0 safety hardening). Absent ⇒ guard fully OFF and
   * the loop is byte-identical. When present, a finish attempt right after a
   * mutating tool with no test/reproduction since is blocked, forcing one more
   * turn (up to `maxTrips`, default 1 — capped to avoid infinite forcing;
   * lowered from 2 in ADR-0013 변경 이력 per the negative empirical from
   * ADR-0014 — bench callers may still explicitly override).
   *
   * `mustPass:true` (default `false`) extends the guard with the SOTA outcome-
   * gate: when set, a finish attempt is ALSO blocked when the most-recent
   * verify call after the latest edit FAILED (dispatch `ok:false` OR the
   * captured output contains an explicit per-ecosystem failure marker). Closes
   * the "ran pytest → ok:false → declared done" loophole observed in
   * skills/subagent-ON sanity runs. Aider / Agentless / SWE-agent all run an
   * outcome-gate of this shape; quanta's bench driver enables it for real
   * SWE-bench instances with `maxTrips:2`.
   */
  verifyGuard?: { maxTrips?: number; mustPass?: boolean }
  /**
   * Localize-phase guard (Agentless "localize-first" absorption — Tier 0
   * safety hardening). When set with a positive integer `phase1Turns`, the
   * dispatch seam BLOCKS mutating tools (`edit`/`write`/`scripted_replace`)
   * during the first N turns of the run — the model is forced to use
   * `read`/`grep`/`glob`/`localize` to pin down file + function FIRST. After
   * `phase1Turns` turns elapse, the gate becomes a no-op (Phase 2 — repair).
   *
   * Absent / `phase1Turns` invalid (undefined, 0, NaN, Infinity, non-integer)
   * ⇒ guard fully OFF and the loop is byte-identical. Default-OFF (RFC §1.2);
   * the bench driver opts in via `QUANTA_BENCH_LOCALIZE_PHASE=N`. See
   * `./localize-phase-guard.ts` for the pure policy + the closed mutating set.
   */
  localizePhase?: LocalizePhaseConfig
  /** Localize-phase state slot — built by `buildLocalizePhase` ONLY when
   *  `localizePhase.phase1Turns` is a positive integer. The loop bumps
   *  `state.turn` at the TOP of each turn (0-indexed). Dispatch reads this
   *  through `consultLocalizePhaseGuard`. Absent ⇒ guard never fires (the
   *  decision returns `{block:false}`, byte-identical).
   *
   *  Carried as an internal slot (not a public knob) so callers cannot
   *  hand-craft a turn counter that disagrees with the loop's. The field is
   *  PUBLIC because the dispatch seam is in a sibling module — there is no
   *  module-private channel between `loop.ts` and `dispatch.ts`. */
  localizePhaseState?: LocalizePhaseState
  /** Closeout guard (Codex CloseoutLens §4 mirror). Optional, absent ⇒ guard
   *  fully OFF and the loop is byte-identical. When `enabled` true, a single
   *  pre-finish nudge injects the closeout reminder (keep only defended claims,
   *  state if verification not run, separate fact from inference, match
   *  requested reporting shape) once per run. Single-shot by design — no
   *  maxTrips knob (multiple closeout nudges just thrash).
   *
   *  `fourRule:true` (Codex `response-assembly-and-closeout.md §5.2` verbatim
   *  absorption) replaces the single-line reminder with the full 4-rule
   *  defended-claim checklist + VerificationCloseout scaffold cue. Use when
   *  the workload demands the stricter discipline (review/audit/SWE-bench).
   *  Absent / false ⇒ legacy one-liner. */
  closeoutGuard?: { enabled?: boolean; fourRule?: boolean }
  /**
   * Working state opt-in (Codex memory L3 absorption). Absent ⇒ no working-
   * state block is rendered, the `update_working_state` tool is NOT registered,
   * and the loop is byte-identical. When set, the loop builds a session-scoped
   * `WorkingState`, plumbs it through `ToolContext.workingState`, registers the
   * `update_working_state` meta-tool, and renders the L3 block in the per-turn
   * reminder (BELOW repo-rules, ABOVE memory hints).
   *
   * See {@link WorkingStateBlock} for the field-level docs.
   */
  workingState?: WorkingStateBlock
  // §19.1 NOTE (SSOT): there is deliberately NO `mcpToolAnnotations` field here.
  // The SOLE LIVE channel for the `QUANTA_MCP_TOOL_ANNOTATIONS` knob is the
  // env var, read at the composition root via `runtimeConfig().mcpToolAnnotations`
  // and folded into the `loadMcpTools` opts (`annotationsHonored`); the bridge
  // never reads an `AgentConfig` field, so a config field here would be dead
  // (and an observability footgun). The knob's `apply` is an identity no-op.
  /** §20.2 (jun-7 gap-other-agent) — host-wired named-agent resolver. The
   *  subagent runner consults this when a spawn carries a matching `agentType`
   *  and folds the resolved definition's `{system, tools, model, mode}` into the
   *  child (narrow-only tools, explicit-request-wins). Absent ⇒ no named-agent
   *  resolution and the spawn path is byte-identical. Host builds it via
   *  `loadNamedAgents(cwd)`. */
  namedAgentResolver?: NamedAgentResolver
  /** P12 (jun-7 gap-other-agent) — closeout critic gate. Absent ⇒ OFF and the
   *  loop's completion seal is byte-identical. When `enabled` AND `critic`
   *  injected, the loop consults the critic right before sealing a completed
   *  turn; the verdict surfaces as an advisory `recovery`/`closeout` event and
   *  NEVER blocks completion. Port absent / critic throws ⇒ FAIL-OPEN. Knob:
   *  `QUANTA_CLOSEOUT_CRITIC`. */
  closeoutCritic?: CloseoutCriticConfig
  /** HITL 4-tier gate (Codex hitl-audit.md absorption). Absent ⇒ legacy
   *  single-tier behavior (byte-identical). When enabled, every dispatch
   *  computes the effective tier and routes through tier-specific gates:
   *  hand-off-required terminates, always-confirm always calls onConfirm
   *  (cannot be skipped by acceptEdits/bypass), pre-approval-ok defers to the
   *  existing mode policy, and none allows. */
  hitl?: { enabled?: boolean }
  /**
   * ADR-0047 UI integration seam. When the admissibility-gate emits a
   * hand-off-required deny (HARD_DENY hit OR an explicit/registry-
   * promoted `hand-off-required` tier), it ALSO fires this callback with
   * a structured {@link HandoffRequiredEvent}. Absent ⇒ no event emitted
   * (byte-identical legacy). The callback is wrapped in try/catch so a
   * host-side bug never propagates into dispatch — emission is best-
   * effort, the deny result is the authoritative signal.
   */
  onHandoff?: (event: HandoffRequiredEvent) => void
  /** ADR-0050 trust-scope wire-up (Phase C). DEFAULT OFF — absent ⇒ the
   *  admissibility-gate ask-branch never short-circuits on scope. When set,
   *  the gate consults `registry.hasGrant(projectKey, { tool })` before
   *  calling host `onConfirm`. */
  trustScope?: { registry: TrustScopeRegistry; projectKey: string }
  /** ADR-0030 mid-turn steering: mutable ref the loop overwrites on every
   *  turn boundary with the active {@link ActiveTurnState} (fresh
   *  `currentTurn` header per turn; `currentTurn=null` + `isInterrupted`
   *  reflecting the stop reason after finish). Absent ⇒ no state exposed
   *  (byte-identical legacy). */
  activeTurnRef?: { current: ActiveTurnState }
  /** §11.5 — interrupted-turn restore buffer. When a turn is aborted by a
   *  conversation-action `cancel` (interrupt mode / `/cancel`), the loop captures
   *  the partial turn into THIS session-scoped buffer; a later `resume` action
   *  re-injects it (the agent picks the interrupted task back up). Absent ⇒ no
   *  capture, `resume` is a no-op (byte-identical legacy). The buffer's presence
   *  is the session-level "interrupted" signal (vs the per-turn
   *  {@link ActiveTurnState.isInterrupted} which resets each boundary). */
  interruptedTurnBuffer?: import("./interrupted-turn").InterruptedTurnBuffer
  /** ADR-0030: awaited ONCE at the top of each turn (before the next LLM
   *  call) so a surface can fence a mid-turn injection into the conversation
   *  buffer before the loop snapshots it. Absent ⇒ never awaited
   *  (byte-identical legacy). */
  steerBarrier?: () => Promise<void>
  /**
   * Correlation context (RFC-0002 §5.1). Absent ⇒ the loop behaves
   * byte-identically (project-standard optional-context pattern, like
   * `metrics?`/`hooks?`). When present the loop maintains a per-turn working
   * copy (the caller's object is never mutated) used purely for trajectory
   * correlation — it never changes control flow, StopReason, emit ordering,
   * or messages.
   */
  run?: RunContext
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
  dedupGateConfig?: { disabled?: boolean; caps?: Partial<DedupGateCaps> }
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
    coordinationBroker?: import("./admissibility-gate").GateEscalationBroker
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
   * Structured plan-mode store (ADR-0095 draft). When wired, the dispatch
   * seam adapts this into a `PlanMutator` on every ToolContext and
   * `buildSessionFeatures` registers the 4 plan-mutation tools
   * (create_plan / update_todos / update_plan / remove_todos). Absent ⇒ tools
   * NOT registered; plan posture (ADR-0036) still works without structured
   * mutation (byte-identical legacy). Persistence via {@link planSnapshotStore}.
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
    load(): Promise<import("./plan/snapshot").PlanSnapshot | null>
    save(snap: import("./plan/snapshot").PlanSnapshot | null): Promise<void>
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
   * return the merged file; the `edit` tool verifies the proposal and routes it
   * through the SAME gated commit path. The composition root constructs it behind
   * `QUANTA_FAST_APPLY_MERGE=1` + a configured `QUANTA_FAST_APPLY_MODEL`
   * (`optional-ports.ts`) and the dispatch seam threads it onto
   * `ToolContext.fastApplyMerge`. Absent ⇒ no merge rung, byte-identical
   * (RFC §1.2 default-OFF).
   */
  fastApplyMerge?: FastApplyPort
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
   * tool. Read + write over the agent's own SDK posture (effort tier, identity
   * mode, tool profile, model, provider). The dispatch seam wires this
   * directly into `ToolContext.sessionConfig`. Absent ⇒ the tool returns a
   * typed `not_wired` failure to the model (the tool is still registered so
   * the LLM can give the operator a coherent reply either way; default-OFF
   * is byte-identical to pre-ADR behavior since no session previously called
   * the tool).
   *
   * The composition root (`apps/cli/host/bootstrap-session.ts`) builds the
   * concrete seam from the existing `effortStore` + `identityModeState` +
   * `toolProfileState` plus the resolved provider/model from runtime config.
   * Sliced (no `@/agent` ↔ `@/tool` cycle) via the canonical declaration in
   * `@/tool/types`.
   */
  sessionConfigPort?: import("@/tool").SessionConfigSeam
  /** ADR-0474 — OPTIONAL stale-read-guard state, threaded into every tool's
   *  `ToolContext.readFileState` by `buildToolContext`. Present ⇒ the host opted
   *  in (`staleReadGuardEnabled`); the composition root mints ONE `ReadFileState`
   *  per session so reads recorded by `read` are visible to `write`/`edit` of the
   *  same session. Absent ⇒ no tracking, no guard (byte-identical default-OFF). */
  readFileState?: import("@/tool/stale-read-guard").ReadFileState
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
    readonly exec?: import("./edit-repair-wire").ExecRunner
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
  /**
   * ADR-0428 socket-level egress proxy. When set with `enabled: true`, a
   * composition root constructs a `LoopbackEgressProxy` over this allowlist and
   * threads `withProxyEnv(baseEnv, {address})` into every child spawn so a
   * subprocess's OWN sockets are funneled through the SAME `isHostAllowed`
   * decision the tool-arg dispatch guard uses — closing the subprocess egress
   * bypass. Absent / `enabled:false` ⇒ NO proxy constructed, child env
   * byte-identical to the pre-slice path. Closed `NetworkProxyConfig` lives in
   * `@/runtime/network-proxy`; wired by the `network-proxy` knob.
   */
  networkProxy?: NetworkProxyConfig
  /**
   * ADR-0428 jun-02 wire — the LIVE, resolved proxy-env handle produced AFTER a
   * composition root (or `runAgent`) constructs + `listen()`s the
   * `LoopbackEgressProxy` from {@link networkProxy}. Carries the bound loopback
   * `address` (+ `noProxy`); `runAgent` sets it on the per-session config clone
   * so the dispatch seam can surface it on `ToolContext.proxyEnv` and the bash
   * tool injects `HTTP_PROXY`/`HTTPS_PROXY` into the child spawn. NOT operator-
   * set: `networkProxy` is the static config, this is its runtime materialization.
   * Absent ⇒ no proxy bound ⇒ child env byte-identical (legacy path).
   */
  proxyEnv?: ProxyEnvInput
  /**
   * ADR-0455 — the DECLARED local-environment selection for this session, the
   * runtime materialization of a loaded `.quanta/environment.toml`. A
   * composition root (`runAgent` / the CLI) calls `loadLocalEnvConfig(cwd, …)`
   * then `selectEnvironment(config, name?)` and sets the resulting
   * `{ vars, pathPrepend }` here; the dispatch seam surfaces it on
   * `ToolContext.localEnv` and the bash tool composes it over the scrubbed
   * child env (allowlist still governs). To SWITCH environments the operator /
   * agent re-selects a different declared name and the per-session config clone
   * carries the new selection. Absent (no config file, or no env selected) ⇒
   * child env byte-identical to the pre-slice path (default-OFF). Closed shape
   * `LocalEnvSelection` lives in `@/runtime/local-env`.
   */
  localEnv?: LocalEnvSelection
  /**
   * ADR-0116 Shadow git ODB seam (ADR-0108 keystone). When set AND
   * `branchSearch` is also wired, `buildBranchSearchTool` constructs a
   * `BranchSearchAnchor` from `shadowOdbAnchor(shadowOdb, cwd)` and threads
   * it into `runBranchSearch` so each candidate gets a quantified
   * `delta` from the parent workspace snapshot. Absent ⇒ anchor not built,
   * branch-search emits candidates with `delta` OMITTED (byte-identical to
   * pre-ADR-0116). Top-level (not nested under `branchSearch`) because
   * future consumers (review/rewind) will also read this slot.
   */
  shadowOdb?: ShadowOdb
  /**
   * ADR-0121 auto-checkpoint policy — when set AND `shadowOdb` is also wired,
   * `wireCheckpointedEffectChannel` wraps the dispatch `EffectChannel` with
   * `withAutoCheckpoint` so a configurable policy auto-anchors via
   * `ShadowOdb.registerHead` BEFORE / AFTER tool calls (Cline / Hermes /
   * Codex / Cursor patterns surfaced as a closed 4-arm enum).
   *
   * Default-OFF: absent ⇒ the wrap helper returns the inner channel
   * unchanged (byte-identical for every legacy caller). Separate from
   * `shadowOdb` so the storage port and the policy are decoupled — a
   * caller may set `shadowOdb` for `branch_search` / `shadow_rewind` /
   * `shadow_snapshots` consumers without auto-checkpointing every tool call.
   *
   * `mode` selects the policy (`"off"` | `"pre-destructive"` | `"per-mutating"`
   *  | `"per-turn"`); `oracle` overrides the default destructiveness oracle
   *  (which trusts `Tool.isReadOnly()`).
   */
  shadowCheckpoint?: {
    mode: CheckpointTriggerMode
    oracle?: DestructivenessOracle
    /** ADR-0203 — when set, the dispatch wrap uses THIS granular policy
     *  instance (instead of building a fresh `defaultCheckpointPolicy`) and
     *  calls `recordAnchorSha` with the `ShadowOdb.registerHead` SHA so the
     *  policy's `.registry` accumulates tag→SHA entries for `/rewind-tool`.
     *  Absent ⇒ byte-identical legacy turn-grain behaviour. */
    granularPolicy?: import("./per-tool-checkpoint").GranularCheckpointPolicy
  }
  /**
   * ADR-0400 Shadow Verify port slot (sibling of ADR-0396 wave-1 port). When
   * set, `buildShadowVerifyBlock` registers the `shadow_verify` LLM tool
   * bound to this port. Absent ⇒ tool NOT registered (default-OFF, byte-
   * identical for every legacy caller — RFC §1.2). The composition root
   * builds the port via `createShadowVerifyAdapters(cwd)` +
   * `createShadowVerify(deps)` (real worktree + V4A + LSP/test adapters);
   * tests may inject a fake port directly.
   */
  shadowVerify?: ShadowVerifyPort
  /**
   * ADR-0140 background-subagent caller wire (sibling to ADR-0130 helper).
   * When set, `buildSubagentBgBlock` registers the 3 `subagent_fork` /
   * `subagent_poll` / `subagent_await` tools bound to this scheduler.
   * Absent ⇒ tools NOT registered (default-OFF, byte-identical for every
   * legacy caller — RFC §1.2). Top-level (not nested under `subagent`)
   * because the background scheduler is INTENT-DISTINCT from the legacy
   * sequential subagent runner (ADR-0011): a caller may wire one without
   * the other.
   */
  subagentBackground?: { readonly scheduler: BackgroundSubagentScheduler }
  /**
   * ADR-0416 managed-subagent mailbox (Codex `multi_agents_v2.send_message`).
   * When set, `buildSubagentMailboxBlock` registers the `subagent_send_message`
   * tool bound to this port so agents can exchange messages (parent↔child,
   * sibling↔sibling, broadcast) WITHOUT teardown. Absent ⇒ tool NOT registered
   * (default-OFF, byte-identical for every legacy caller — RFC §1.2).
   */
  subagentMailbox?: MailboxPort
  /**
   * Peer teammate messaging (RFC jun-6, DELTA #2) — host-owned team registry.
   * When set, the composition root wraps {@link subagentMailbox} with the
   * team-scope decorator (cross-team `send` denied + broadcast scoped to the
   * sender's own team), the subagent runner registers each spawned child into
   * it (so siblings share a team bus), and `buildTeamBlock` registers the
   * `team_create`/`team_delete` lifecycle tools over it. Absent ⇒ no team
   * boundary (the raw global mailbox), `team_*` tools NOT registered
   * (default-OFF, byte-identical). Wired only when `QUANTA_TEAM_PEER_MSG` is on.
   * Duck-typed (structural mirror of `TeamRegistryPort` in
   * `@/subagent/team/registry`) so `@/agent` core stays slice-isolated from the
   * `@/subagent` leaf.
   */
  teamRegistry?: import("../subagent").TeamRegistryPort
  /**
   * RFC-04 / ADR-0437 — host-owned `TurnWakeRegistry`. The subagent runner
   * registers a per-child waker into THIS instance when a child loop starts;
   * `followup_task` calls `wake(agentId)` to trigger the child's turn. Absent ⇒
   * `followup_task` has no trigger substrate and is NOT registered (default-OFF).
   * Sharing one instance across the runner (writer) and the introspect tools
   * (reader) is what makes the trigger live.
   */
  subagentTurnWake?: import("../subagent").TurnWakeRegistry
  /**
   * RFC-04 §11 / ADR-0437 follow-up — per-CHILD turn gate. The subagent runner
   * mints ONE gate per forked child loop, threads it onto the CHILD config
   * here, and registers a {@link import("../subagent").Waker} (bridged to this
   * gate) into the shared {@link subagentTurnWake} so `followup_task`'s
   * `wake(childId)` finds a live receiver. The child loop PARKS on the gate at
   * its clean-completion point so a wake can trigger another turn (idle→`woke`)
   * or a pending wake runs the next turn (busy→`queued`). The ROOT session
   * NEVER carries one (root is not in the registry / never a followup_task
   * target); absent ⇒ the loop finishes immediately on completion
   * (byte-identical default-OFF, RFC §1.2).
   */
  subagentTurnGate?: import("../subagent").SubagentTurnGate
  /**
   * RFC-04 / ADR-0437 — host-owned `AgentMetaRegistry` side-table. `spawn_agent`
   * (when wired) records `{depth,label}` here; `list_agents` joins it for
   * richer rows. Absent ⇒ `list_agents` falls back to `depth=0` + a
   * description-derived label (byte-identical spawn path; the side-table is
   * purely additive). OPTIONAL even when introspect is enabled.
   */
  subagentAgentMeta?: import("../subagent").AgentMetaRegistry
  /**
   * ADR-0416 sibling-identity fix (audit H) — STABLE per-agent mailbox label
   * for THIS agent. The subagent runner mints a DETERMINISTIC child id
   * (`parentLabel/seq` — a replay-friendly ordinal counter, never a random
   * uuid / clock) and threads it here onto the forked child config; the
   * dispatch seam surfaces it onto `ToolContext.agentLabel` so the
   * subagent-mailbox tools address each sibling UNIQUELY instead of collapsing
   * every same-depth sibling onto a single `agent@depth-N` label. Absent ⇒ the
   * tools fall back to the depth-derived label (byte-identical for the root
   * session and every legacy caller). The root session leaves this UNSET; only
   * forked children carry it.
   */
  mailboxAgentId?: string
  /**
   * ADR-0416 sibling-identity fix (audit H) — the STABLE mailbox label of the
   * agent that spawned THIS one. Surfaced onto `ToolContext.parentAgentLabel`
   * so `subagent_send_message`'s `"parent"` target resolves to the EXACT parent
   * that forked this child (even when siblings share a depth) rather than depth
   * arithmetic. The runner sets this to the parent's `mailboxAgentId` (or
   * `"root"` for a depth-1 child of the root session). Absent ⇒ `"parent"`
   * falls back to depth math (byte-identical legacy).
   */
  mailboxParentId?: string
  /**
   * ADR-0437 follow-up (BUG#4 self-target guard) — THIS child's own registry
   * task id (`req.taskId`). Threaded so `followup_task` can reject a child
   * targeting its OWN loop (`input.agentId === subagentTaskId ⇒ self_target`):
   * the introspect block wires it as `ownAgentId`. Distinct from
   * `mailboxAgentId` (the disjoint mailbox-label namespace, `root/N`). The root
   * session and any non-spawned agent leave this UNSET ⇒ no self-target guard
   * (byte-identical; root is never a `followup_task` target anyway).
   */
  subagentTaskId?: string
  /**
   * ADR-0223 auto-background after 2 s — Claude Code UX absorption. When set,
   * dispatch wraps each tool `execute()` with two-line `tickToolStart` /
   * `tickToolEnd` calls into `autoBackground.detector` so a host poll can ask
   * "is this call past the threshold?" and (via `autoBackground.proposer`)
   * surface a one-shot "move to background?" prompt. Pair with
   * {@link subagentBackground} so the prompt's "yes" path actually has a
   * detached scheduler to fork into — this slot is the OBSERVER; that slot
   * is the EXECUTOR.
   *
   * Default-OFF byte-identical (RFC §1.2): when this slot OR its
   * `detector` field is absent, the two-line wiring in dispatch.ts becomes
   * an optional-chain no-op (zero allocation, zero behaviour delta). The
   * proposer is independently optional — a host may wire only the detector
   * (and render its own status-bar nudge from `isStuck`) without paying for
   * the once-per-id Map in the proposer.
   */
  autoBackground?: AutoBackgroundConfig
  /**
   * ADR-0201 fork-session slot. When set, `buildForkSessionBlock` registers
   * the `fork_session` tool wired to this forker. Absent ⇒ tool NOT registered
   * (default-OFF, byte-identical for every legacy caller — RFC §1.2). Distinct
   * from `conversationCheckpoint` so a caller may wire the store for record/
   * restore consumers WITHOUT also exposing the fork tool (the forker
   * constructs over the same store but layers lineage + UUID minting).
   */
  fork?: { readonly forker: SessionForker }
  /**
   * ADR-0125 turn-diff loop wiring — opt-in trigger for the
   * {@link wireGitObservability} composite (ADR-0110). When `enabled === true`
   * the loop constructs a per-session `TurnDiffSession` (via
   * `wireGitObservability({runner: defaultGitRunner, cwd, signal})`) and
   * calls `startTurn(turnIndex)` just before each turn's body, then
   * `endTurn(turnIndex)` after the turn span closes — emitting any returned
   * `turn_diff_updated` AgentEvent onto the loop's stream.
   *
   * Default-OFF: absent or `enabled !== true` ⇒ the loop allocates no
   * session, performs no `startTurn`/`endTurn` calls, and is byte-identical
   * to the pre-wire path (RFC §1.2). Explicit opt-in (not auto-enabled when
   * `shadowOdb` is wired) so a caller that wires the storage port for
   * `branch_search` / rewind consumers does NOT pay the per-turn `git
   * rev-parse` + `git diff` cost without asking.
   *
   * `session` (test-injection seam): when supplied, the loop uses this
   * caller-built `TurnDiffSession` verbatim instead of constructing one from
   * `defaultGitRunner`. Mirrors the `dedupGate`/`capEnforcer` patterns —
   * production code never sets it; tests inject a fake-runner-backed
   * session to assert wiring without spawning `git`.
   */
  gitObservability?: { enabled: boolean; session?: import("./git-observability").TurnDiffSession }
  /**
   * ADR-0117 progress surface — when set, `branch-search-runner` wraps the
   * tool's `onTrace` with a side-effecting adapter that calls this callback
   * with a `formatBranchTrace`'d `ProgressLine` per event. Absent ⇒ the
   * adapter is not installed, byte-identical to pre-ADR-0117 behaviour.
   * Best-effort: a throwing callback never crashes the search (the adapter
   * try/catches around it, matching the OTel sink contract).
   */
  onProgress?: (line: ProgressLine) => void
  /**
   * Track D (runtime → REPL context wire) — per-turn prompt-assembly observer.
   * When set, the loop calls this ONCE per turn, immediately after
   * `buildTurnContext` assembles the system prompt, with a
   * {@link import("./context/usage-breakdown").PromptAssembledSnapshot} carrying
   * the assembled `SystemBlock[]` + the turn's `promptPolicy` presence flags +
   * the active model id. The REPL surface retains the latest snapshot so the
   * `/context` slash can render a live segmented context-window breakdown
   * (computed with the loop's OWN `estimateTokens` — no second heuristic).
   *
   * Absent ⇒ the loop performs NO capture (no snapshot constructed, no call),
   * so the assembly path is byte-identical for every non-REPL caller (RFC §1.2).
   * Best-effort/observation-only: a throwing callback NEVER crashes the turn
   * (the call site try/catches, matching the OTel-sink + `onProgress` contract).
   */
  onPromptAssembled?: (
    snapshot: import("./context/usage-breakdown").PromptAssembledSnapshot,
  ) => void
  /**
   * OPTIONAL working-state snapshot publisher. Fired ONCE at session start
   * (right after {@link buildSessionFeatures}) with a getter over the live
   * session-scoped {@link import("./working-state").WorkingState} — or a getter
   * that returns `undefined` when `workingState.enabled !== true`. The surface
   * (`/state`) retains the getter to render the current posture/blockers panel.
   * Absent ⇒ no publish (byte-identical). Pure observation; never throws into
   * the loop (the call site try/catches).
   */
  onWorkingStateReady?: (
    getSnapshot: () => import("./working-state").WorkingState | undefined,
  ) => void
  /**
   * OPTIONAL per-turn stream-input capture sink. Fired right before each
   * provider stream call with the EXACT {@link import("@/llm").StreamInput}
   * used for that turn (messages / system / tools / thinking / toolChoice).
   * The surface (`/retry-with`) retains the latest so it can re-stream the
   * last turn against an alternate model. Absent ⇒ no capture (byte-identical,
   * no allocation). Pure observation; the call site try/catches.
   */
  onTurnStreamInput?: (input: import("@/llm").StreamInput) => void
  /**
   * ADR-0440 wire-finish — OPTIONAL tool-diff capture sink. When set, the
   * dispatch seam surfaces it (plus the dispatched `ToolUseBlock.id`) onto the
   * {@link import("@/tool").ToolContext} so a file-mutating tool (`write`/`edit`)
   * hands its pre/post file text to the sink after a SUCCESSFUL mutation. The
   * web-daemon composition root adapts its canvas emitter's `feedToolDiff` into
   * this port ONLY when `QUANTA_WEB_CANVAS=1`; the sink converts the
   * before/after into a `tool.diff` canvas frame (the line-diff math runs ONCE
   * inside the daemon, NEVER recomputed agent-side).
   *
   * Absent ⇒ the dispatch seam omits the ctx fields, NO tool captures anything,
   * and the path is byte-identical for every non-canvas caller (RFC §1.2,
   * default-OFF). Duck-typed (structural mirror of `@/tool`'s `ToolDiffSink`) so
   * neither slice imports the other's `@/apps/*` surface — the composition root
   * is the only place that bridges the daemon emitter to this port. Best-effort:
   * the sink is no-throw by contract and the tool-side helper additionally
   * try/catches, so a misbehaving sink can never crash a turn.
   */
  onToolDiff?: import("@/tool").ToolDiffSink
  /**
   * H6 (jun-3-misc §3) — OPTIONAL passive-VCS event sink. When set, the dispatch
   * seam surfaces it onto {@link import("@/tool").ToolContext}'s `vcsEventSink`
   * so the `bash` tool's post-exec hook (`maybeEmitPassiveVcs`) — gated by
   * `QUANTA_PASSIVE_VCS` — can forward a classified `VcsEvent` (raw git/gh stdout
   * → structured commit/push/branch/pr facets) to it. The composition root
   * (`agent-config-assembler#maybeWireVcsEventSink`) wires a sink that ADAPTS the
   * event onto the EXISTING `AgentEvent` stream (a `recovery` event tagged
   * `reason:"vcs_event"` carrying the serialized facets) — it does NOT invent a
   * second bus. ONLY wired when the knob is on; the loop/replay never depends on
   * it.
   *
   * Absent ⇒ the dispatch seam omits the ctx field, the hook resolves its noop,
   * and the bash post-exec path is byte-identical for every legacy caller (RFC
   * §1.2, default-OFF). Typed as the producer `PassiveVcsEventSink` (the `@/agent`
   * slice already imports `@/git/directive-emit`, so reaching the sibling
   * `@/git/passive-classify` is in-fence); the dispatch seam threads it through
   * the `@/tool` structural `VcsEventSink` mirror so `@/tool` stays a leaf.
   * Best-effort: the sink is no-throw by contract and the hook additionally
   * try/catches, so a misbehaving sink can never crash a turn.
   */
  vcsEventSink?: import("@/git/passive-classify").PassiveVcsEventSink
  /**
   * C2 (jun-4-communicate-update.md) — OPTIONAL structured-progress sink. When
   * set, the dispatch seam surfaces it onto {@link import("@/tool").ToolContext}'s
   * `progressSink` so the `communicate_update` tool can forward its typed
   * `{current_step, final_summary?, completed_subtitle?}` payload to it. The
   * composition root wires a sink that ADAPTS the mirror onto the EXISTING
   * `AgentEvent` stream as a render-only `progress_update` event — it does NOT
   * invent a second bus, and the loop never inspects the event (no control
   * authority).
   *
   * Absent ⇒ the dispatch seam omits the ctx field, the tool's `?.emit` is a
   * no-op, and the run is byte-identical for every legacy caller (RFC §1.2,
   * default-OFF). Typed via the `@/tool` structural {@link import("@/tool").ProgressSink}
   * mirror so `@/tool` stays a leaf (same discipline as `vcsEventSink` /
   * `onToolDiff`). Best-effort: the sink is no-throw by contract.
   */
  progressSink?: import("@/tool").ProgressSink
  /**
   * file_history_rewind — OPTIONAL per-file snapshot capture sink. When set, the
   * dispatch seam surfaces it onto {@link import("@/tool").ToolContext}'s
   * `fileHistory` so the `write`/`edit` tools record each new file version into
   * the session history store the `file_history_rewind` tool reads. The
   * composition root mints ONE bounded store per session (when
   * `QUANTA_FILE_HISTORY` is on) and wires BOTH this sink AND
   * `DefaultToolPorts.fileHistory` (the tool's read side) over the SAME store.
   *
   * Absent ⇒ the dispatch seam omits the ctx field, `captureFileHistory` is a
   * no-op, and the run is byte-identical for every legacy caller (RFC §1.2,
   * default-OFF). Typed via the `@/tool` structural
   * {@link import("@/tool").FileHistorySink} mirror so `@/tool` stays a leaf
   * (same discipline as `progressSink` / `vcsEventSink`). Best-effort: the sink
   * is no-throw by contract.
   */
  fileHistory?: import("@/tool").FileHistorySink
  /**
   * code-mode (RFC jun-6-code-mode, Phase 1) — OPTIONAL per-cell dispatch-port
   * FACTORY. When set (the composition root wires it ONLY when `QUANTA_CODE_MODE`
   * is on), the dispatch seam calls `codeCellDispatchFactory(callId)` for a
   * `code_cell` dispatch and surfaces the resulting port on
   * `ToolContext.codeCellDispatch`. The factory (`@/agent/codemode-wire.ts`)
   * closes over the loop's LIVE `config`/`permission`/`autoClassifier` and routes
   * every in-cell tool call through the REAL `dispatchTool` — so a cell is N
   * ordinary gated tool calls (structural no-bypass, §6.1). It is a FACTORY (not
   * a port) so each cell gets a fresh deterministic call-id sequence keyed off the
   * `code_cell` tool-call id. Absent (gate OFF / non-wiring host) ⇒ the dispatch
   * seam omits the ctx field and the `code_cell` tool is not registered
   * (byte-identical default-OFF). Typed via the `@/tool` structural
   * {@link import("@/tool").CodeCellDispatchSeam} mirror so `@/tool` stays a leaf. */
  codeCellDispatchFactory?: (callId: string) => import("@/tool").CodeCellDispatchSeam
  /**
   * code-mode (RFC jun-6-code-mode, Phase 2 — FULL tool surface). When set
   * (the composition root wires it ONLY when `QUANTA_CODE_MODE` is on, alongside
   * {@link codeCellDispatchFactory}), the dispatch seam surfaces the result on
   * `ToolContext.codeCellSurface` so the `code_cell` cell binds `tools.<name>`
   * for EVERY tool the agent has. It is a THUNK (`() => readonly string[]`) so it
   * reads the LIVE `registry.toolNames()` at cell-dispatch time — a tool
   * registered after assembly appears automatically, and a tool the agent lacks
   * is never in the list (unbound in the cell). Each bound `tools.<name>` STILL
   * re-enters the REAL `dispatchTool` via the port (the structural no-bypass
   * invariant is UNCHANGED; this only widens which NAMES are exposed). Absent
   * (gate OFF / non-wiring host) ⇒ the seam omits the ctx field and `@/codemode`
   * falls back to the Phase-1 3-tool surface (`read`/`grep`/`write`) —
   * byte-identical default-OFF. */
  codeCellSurfaceTools?: () => readonly string[]
  /**
   * jun-6 exfil-rail (a) — OPTIONAL per-turn write/edit budget. When set, the
   * dispatch seam binds the CURRENT turn ordinal (`run?.turn ?? 0`) and surfaces
   * a turn-bound {@link import("@/tool").WriteBudgetPort} onto `ToolContext` so
   * the `write`/`edit` tools tally each mutation against the per-turn counter and
   * deny once the configured cap is exceeded IN AN UNTRUSTED-INPUT TURN. The
   * composition root mints ONE session-long `SessionWriteBudget` (when
   * `QUANTA_WRITE_BUDGET=1` AND `QUANTA_WRITE_BUDGET_MAX` is set) with
   * `untrustedContext` resolved from the untrusted-envelope gate
   * (`QUANTA_UNTRUSTED_ENVELOPE`); the counter resets per turn because dispatch
   * re-binds the current turn. Absent (knob off / no cap / non-wiring host) ⇒ the
   * dispatch seam omits the ctx field and the mutating path is byte-identical
   * (default-OFF). Duck-typed via the `@/tool/_shared/write-budget`
   * `SessionWriteBudget` so `@/tool` stays a leaf. */
  writeBudget?: import("@/tool/_shared/write-budget").SessionWriteBudget
  /**
   * Codex Submission op envelope (ADR-0072, Spec A3). When set the loop
   * derives the seed user-turn from `submission.op` instead of `messages`
   * (`user_input` / `user_input_with_turn_context` only — other op variants
   * are accepted as shapes but the seed loop falls back to `messages`).
   * Absent ⇒ legacy `messages` path drives the seed (byte-identical).
   *
   * When BOTH `submission` and `messages` are set, `submission` wins for the
   * seed (the caller opted into the typed envelope explicitly); the loop
   * still uses `config.messages` for any caller-supplied history tail (e.g.
   * a resumed session), so passing both is a SUPERSET, not a contradiction.
   */
  submission?: Submission
  /**
   * ADR-0080 IDE context provider seam. Absent ⇒ no snapshot is captured per
   * turn, no `<ide-context>` block is rendered, and the loop is byte-identical
   * to the pre-ADR path. When present, the loop awaits
   * `ideContextProvider.snapshot(turnSignal)` ONCE per turn entry; a non-null
   * snapshot is deterministically rendered (see `renderIdeContext`) and
   * PREPENDED to the latest user message body (NOT inside the trailing
   * `<system-reminder>` — IDE state is user-side context, not a harness
   * reminder). Provider rejections/throws are caught at the boundary, logged
   * via `stream.emit({type:"error", ...})`, and treated as `null` — an IDE
   * bug must not crash the turn (this is a boundary, NOT a fallback for
   * missing data). The provider receives the turn's AbortSignal and is
   * responsible for honoring it.
   */
  ideContextProvider?: IdeContextProvider
  /**
   * Secret redaction (ADR-0078). DEFAULT-ON: with `redaction` absent, the
   * content-plane invariant is active — tool result text, JSONL envelope
   * writes, and memory-distill input are scrubbed through `redactSecrets`
   * (closed RedactionKind enum, deterministic regex, no confidence
   * scoring). Each match surfaces as a {@link RedactionHit} so the user
   * and audit can see WHAT was hidden.
   *
   * To DISABLE the layer the caller MUST set `disabled: true` AND supply
   * a non-empty `acknowledgedRisk` string; without the ack
   * `normalizeRedactionConfig` throws a startup error and the agent
   * refuses to start. `whitelist` is a list of structural overrides for
   * patterns the user trusts (e.g. fixture tokens). See
   * `src/security/redaction-config.ts`.
   */
  redaction?: RedactionConfig
  /**
   * The 12-lever discriminated-union vector for this run (interactive /
   * headless / batch / ci-bot). Absent ⇒ no mode policy is consulted and the
   * loop is byte-for-byte identical to the pre-RFC path. Wired by
   * `apps/agent/assemble.ts`; the LOOP itself does not read this back today,
   * but mode-preset assemble tests verify the field IS on the config, so this
   * is a CONSUMED field (not orphan) — its observability IS the contract.
   */
  modePolicy?: ModePolicy
  /**
   * RFC may-22-unified-agent-runtime / Phase 1 — budget meter slot.
   *
   * When present, the loop's tick sites (turn / model_call / tool_call /
   * shell_command / test_run / token usage) call `meter.tick(kind)` and
   * the per-turn epilogue calls `checkExhausted()`. Absent ⇒ optional-chain
   * no-op, byte-identical loop. The meter is operator-owned (clamped by
   * `ModePolicy.budgetCaps`); the loop only emits ticks.
   */
  budgetMeter?: BudgetMeter
  /**
   * jun-02 — SOFT, model-facing task token budget (Claude `task_budget` mirror).
   *
   * ORTHOGONAL to {@link budgetMeter}: this is NEVER an enforcement gate and
   * NEVER stops the run. When present with `tokens > 0`, the loop forwards it
   * (with `spent` accumulated from this session's observed token usage) into
   * `buildTurnContext`, which renders ONE advisory guidance line into the
   * trailing `<system-reminder>` so the model can self-moderate / wrap up.
   * Absent (or `tokens <= 0`) ⇒ `renderTaskBudgetBlock` returns `undefined` and
   * the dynamic context is BYTE-IDENTICAL to the pre-slice path (default-OFF).
   * Set by the `task-budget` knob (`QUANTA_TASK_BUDGET`).
   */
  taskBudget?: TaskBudget
  /**
   * RFC jun-6 §4 — bounded repo-map turn-0 injection. When present, the loop
   * calls `probeRepoMap` ON TURN 1 ONLY (caller-held latch) and merges its
   * bounded tree string into `TurnContextInput.env.repoMap`; on later turns the
   * field is absent ⇒ `renderEnvBlock` is byte-identical to the no-map path.
   * Carries the three caps (depth / file-count / char-backstop). Absent ⇒ the
   * probe never runs and the env block is byte-identical (default-OFF). Set by
   * the `repo-map` knob (`QUANTA_REPO_MAP`). Caller-side composition only — the
   * renderer never reads this slot, only the pre-rendered `env.repoMap`. */
  repoMap?: {
    readonly maxDepth: number
    readonly maxFiles: number
    readonly maxChars: number
  }
  /**
   * L4 wiring — control-op cluster (2026-05-23). Typed mid-turn
   * {@link ConversationActionPort} the loop polls at the TOP of each turn
   * (before `cfg.steerBarrier`, before the LLM stream opens). Absent ⇒ no
   * poll, no decision, byte-identical legacy. Present ⇒ exactly one
   * `port.next()` call per turn; non-undefined returns drive a single
   * `decideAction()` decision with the same caller-supplied clock the rest
   * of the loop uses.
   *
   * `accepted_injection` ⇒ pushed onto `wm` as a user message (same path as
   * `steerBarrier`), the turn continues. `accepted_control + cancel` ⇒
   * loop finishes with `aborted`. `accepted_control + cancel_subagent` ⇒
   * routed to `features.taskRegistry?.forceStop` (parent KEEPS running).
   * `rejected` ⇒ emit an observability event + skip; the turn proceeds.
   */
  conversationActionPort?: ConversationActionPort
  /**
   * L4 wiring — control-op cluster (2026-05-23). Per-thread queued follow-
   * ups (ADR-0037). When set, the loop calls
   * `followUpQueue.popReady(threadId, pausedReason(threadId))` at the TOP
   * of each turn (after steerBarrier, before the conversation-action
   * poll), and when a ready follow-up is returned its `content` is
   * appended to `wm` as the next user-turn seed. The thread id is the
   * session id ({@link AgentConfig.sessionId}) by default.
   *
   * Absent ⇒ no poll, no allocation, byte-identical legacy. Persistence
   * across restarts: callers wire {@link followUpQueueSnapshotStore} (also
   * default-OFF) to read/restore + write the queue snapshot at session
   * boundaries.
   */
  followUpQueue?: FollowUpQueue
  /**
   * Peer teammate messaging (RFC jun-6, DELTA #1) — auto-delivery drain. When
   * set, `syncQueuedTurnInputs` calls `peerInbox.drainFor(mailboxAgentId ??
   * "root")` at the turn-top seam (right after the follow-up drain) and appends
   * the rendered peer mail as a `role:"user"` message — so a teammate's message
   * auto-arrives in this agent's NEXT turn WITHOUT a manual
   * `subagent_read_messages` poll (and a wake'd idle teammate auto-receives).
   * The drain marks delivered (shares the SAME per-recipient cursor as the
   * manual poll ⇒ delivered exactly once across push+pull) and redacts each
   * body (untrusted-as-DATA). INFORMATION-only — it NEVER invokes the
   * permission decider (the peer bus is a comms channel, never a grant channel).
   *
   * Absent ⇒ `pollPeerInbox` returns null, no append, the turn loop is
   * byte-identical (default-OFF). Wired by the composition root only when
   * `QUANTA_TEAM_PEER_MSG` is on.
   */
  peerInbox?: import("./loop/control-poll").PeerInboxDrain
  /**
   * L4 wiring — control-op cluster (2026-05-23). Per-thread paused-reason
   * inspector (ADR-0037). When set, the loop calls this BEFORE each
   * `followUpQueue.popReady` so the queue knows whether the thread is
   * paused (null ⇒ ready; non-null ⇒ deferred with a `response_queued`
   * AgentEvent emitted). Absent ⇒ the loop passes `null` to popReady
   * (always ready when set without a reason source).
   */
  pausedReason?: (threadId: string) => PausedReason | null
  /**
   * ADR-0062 rule #3 — optional session-scoped cap enforcement tracker.
   * When set (built via `buildCapEnforcer`), the dispatch seam consults this
   * BEFORE executing a tool call to detect an ignored `nextAction` hint, and
   * AFTER execution to record a fresh hint from the result.
   *
   * DEFAULT-OFF: absent ⇒ no tracking, no reminder, dispatch byte-identical.
   * Enabled via `QUANTA_CAP_ENFORCE=1` env flag or `capEnforce:true` at
   * `runAgent` construction time. The `CapEnforcer` is built once per session
   * by `buildCapEnforcer(config.capEnforce)` and stored here.
   */
  capEnforcer?: CapEnforcer
  /**
   * ADR-0062 rule #3 — enable cap-as-instruction enforcement for this session.
   * When `true`, `runAgent` constructs a `CapEnforcer` (unless one was already
   * supplied via `capEnforcer`) and injects ignored-hint reminders via the
   * `AgentEvent` stream as `<system-reminder>` ToolEvents. Default: `false`.
   * Also enabled by the `QUANTA_CAP_ENFORCE=1` environment variable (checked
   * inside `buildCapEnforcer`).
   */
  capEnforce?: boolean
  /**
   * L4 wiring — control-op cluster (2026-05-23). Optional snapshot store
   * for the follow-up queue. When set, the loop calls
   * `snapshotStore.save(queue.toSnapshot())` at session-end (alongside
   * `persistSession`) AND calls `snapshotStore.load()` at session-start
   * (before the first turn) to restore queued follow-ups across restarts.
   * Absent ⇒ no save/restore, queue is process-scoped only.
   */
  followUpQueueSnapshotStore?: {
    /** Synchronous OR Promise — the loop awaits both. Throws/rejects are
     *  caught at the boundary and surface as an `error` AgentEvent. */
    load(): Promise<ReturnType<FollowUpQueue["toSnapshot"]> | undefined>
    save(snapshot: ReturnType<FollowUpQueue["toSnapshot"]>): Promise<void>
  }
  /**
   * ADR-0127 web tool slice — operator-wired `WebSearchProvider` (Brave /
   * DuckDuckGo / SerpAPI / etc.). When set, `buildSessionFeatures` (via
   * `buildWebSearchBlock`) registers the `web_search` tool bound to this
   * provider. Absent ⇒ `web_search` is NOT registered (default-OFF,
   * byte-identical for every legacy caller — RFC §1.2).
   *
   * Concrete providers live OUTSIDE the `@/tool` slice (no built-in default)
   * — shipping a default would lock the user into a specific search backend
   * + a specific API-key surface. The composition root owns the wire.
   *
   * Top-level (not nested) so future consumers (e.g. a citation surface
   * that wants to inspect query history) can read this slot directly.
   */
  webSearch?: { provider: WebSearchProvider }
  /**
   * ADR-0257 — agent-callable ADVISOR tool (consult a STRONGER / DIFFERENT
   * model for a SECOND OPINION mid-loop). When set, `buildAdvisorBlock`
   * registers the `advisor` tool; absent ⇒ tool NOT registered (default-OFF
   * byte-identical, RFC §1.2). The slot carries the host-built one-shot
   * `consult` (the composition root wraps a concrete `LLMPort` + role-model
   * resolution via the ADR-0256 'advisor' role) plus the `models` allowlist the
   * tool validates an explicit `model` argument against (empty / absent ⇒ no
   * explicit model is accepted; the consult always resolves the default).
   *
   * Top-level (not nested) and duck-typed: the `@/tool/advisor` slice owns the
   * `AdvisorConsultRequest` / `AdvisorConsultResult` shapes; this slot mirrors
   * the consult signature structurally so `@/agent` need not depend on the tool
   * slice's runtime. Caller-side composition only — the loop never reads it.
   */
  advisor?: {
    readonly consult: (req: {
      readonly question: string
      readonly context?: string
      readonly forwardHistory?: boolean
      readonly model?: string
      readonly signal?: AbortSignal
    }) => Promise<
      | { readonly ok: true; readonly analysis: string; readonly modelUsed: string }
      | {
          readonly ok: false
          readonly errorKind:
            | "model-not-allowlisted"
            | "advisor-error"
            | "timeout"
            | "cancelled"
            | "empty-analysis"
          readonly errorMessage: string
        }
    >
    readonly models?: readonly string[]
  }
  /**
   * ADR-0016 (compose seam) — diff→prose AUTHORING tools (`git_compose_commit`
   * + `git_compose_pr`, the Codex `yeet` / Cursor compose pattern). When set,
   * `buildComposeAuthoringBlock` registers the two READ-ONLY authoring tools
   * wired to this one-shot author `LLMPort`; absent ⇒ neither tool is
   * constructed nor registered (default-OFF byte-identical, RFC §1.2 —
   * proven by the compose hellgate battery). The composition root sources
   * `authorLLM` from the `compose-authoring` knob, which folds the session's
   * baseline `cfg.llm` into this slot.
   *
   * Top-level (not nested under git) so the slot mirrors the `gitTools(runner,
   * {authorLLM})` factory option directly and a future surface can read it
   * without reaching into a git-specific sub-object. Caller-side composition
   * only — the loop never reads it (it only sees the two extra tools the
   * builder adds to the registry).
   */
  composeAuthoring?: {
    readonly authorLLM: LLMPort
  }
  /**
   * ADR-0133 — typed pending-promptHook collector for subagent lifecycle
   * events. When a `subagent_start` / `subagent_stop` hook returns a
   * `promptHook` response, the subagent runner pushes it here so the
   * PARENT's next turn-context build can fold it into the system prompt.
   *
   * Today this is a simple array-like (push only) so the loop can drain it
   * once per turn-context build. A host that does NOT want subagent
   * promptHook responses to influence the parent prompt simply does NOT
   * wire this — the runner's `?.push(...)` is a no-op (RFC §1.2 default-
   * OFF, byte-identical).
   *
   * Pushed shape: the bare `HookPromptInject` (`{injectAfterSystem?,
   * injectBeforeUser?}`); the loop folds both sides into the prompt's
   * after-system / before-user slots.
   */
  subagentPendingPrompt?: {
    push: (entry: import("./hooks").HookPromptInject) => unknown
  }
  /**
   * ADR-0405 — gate for the LSP-diagnostics post-edit hook. Env-derived
   * (`QUANTA_LSP_DIAGNOSTICS_HOOK === "1"`) at the COMPOSITION ROOT and threaded
   * in as plain config so the agent slice never reads `process.env` itself
   * (slice-boundary invariant). Absent / false ⇒ the hook is not attached and
   * the loop body is byte-identical (RFC §1.2 default-OFF).
   */
  lspDiagnosticsHookEnabled?: boolean
  /**
   * ADR-0412 — gate for the `check_secrets` LLM tool. Env-derived
   * (`QUANTA_SECRET_CHECK_TOOL === "on"`) at the COMPOSITION ROOT and threaded
   * in as plain config so the agent slice never reads `process.env` itself
   * (slice-boundary invariant). Absent / false ⇒ the tool is NOT registered and
   * the tool set is byte-identical for every legacy caller (RFC §1.2 default-OFF).
   */
  secretCheckToolEnabled?: boolean
  /**
   * ADR-0136 budget-ledger slot — token × pricing → $$ + soft/hard breach
   * events at session/daily scope. When set, `buildBudgetBlock` registers the
   * `budget_status` tool wired against this ledger. Absent ⇒ the tool is NOT
   * registered (default-OFF, byte-identical for every legacy caller — RFC
   * §1.2). Top-level (not nested) so future consumers (mid-turn cost
   * surfacing, post-turn telemetry exporter) can read this slot directly.
   */
  budgetLedger?: BudgetLedger
  /**
   * ADR-0398 — Objective port slot (ADR-0394 substrate consumer wire).
   *
   * When set, `buildObjectiveBlock` (tier-1) registers the 3 LLM tools
   * `objective_set` / `objective_update` / `objective_get` bound to this
   * port so the agent can declare its own per-thread objective (goal /
   * success criteria / blockers / next actions / budget) and surface them
   * to the user. Absent ⇒ the 3 tools are NOT registered, the loop is
   * byte-identical for every legacy caller (RFC §1.2 default-OFF).
   *
   * Caller-wire (typically the composition root) constructs the port via
   * `createObjectiveStore()` (in-memory reference impl) — a future ADR
   * may add a persistent backing. Top-level (not nested) so future
   * consumers (compaction-preserve-objective, subagent-result attribution)
   * can read this slot directly.
   */
  readonly objective?: ObjectivePort
  /**
   * ADR-0415 — Run Ledger port slot (ADR-0395 substrate consumer wire).
   *
   * When set, the composition-root observability wire (ADR-0406) injects the
   * shared `RunLedgerPort` here so surface consumers (web-daemon
   * observability-emitter, future UI) + the run-ledger-attribution hook
   * subscriber (ADR-0401) read/write ONE unified long-running-work model.
   * Absent ⇒ no ledger; byte-identical default-OFF (RFC §1.2). Promoted from
   * the wire handle (Wave-3 deliberate hold) so it is reachable as a
   * first-class AgentConfig slot, not just inside the wire closure.
   */
  readonly runLedger?: RunLedgerPort
  /**
   * ADR-0415 — Approval state-machine port slot (ADR-0403 substrate consumer
   * wire). When set, the approval-gate wire (ADR-0407) records HITL approvals
   * here (attributing to Objective.blockers + Run Ledger.waiting) so the user
   * sees "why stopped / resume-from-step". Absent ⇒ legacy HITL passthrough,
   * byte-identical default-OFF. Promoted from the Wave-3 wire handle.
   */
  readonly approvalStateMachine?: ApprovalStateMachinePort
  /**
   * ADR-0124 conversation-checkpoint slot (helper-only). When set, callers
   * (apps/agent bootstrap, future `/rewind` slash command, future
   * auto-recovery hook) record/restore the `messages[]` history through this
   * store. Absent ⇒ no checkpoint store; the loop is byte-identical (no field
   * exists on AgentConfig in absent state under exactOptional). NOT consumed
   * by the loop itself today — slot exists for caller-side composition.
   */
  conversationCheckpoint?: { store: ConversationCheckpointStore }
  /**
   * OpenAI Responses continuation store (helper-only). Session composition
   * roots wire one lane-scoped store and execution-plane wrappers inject it
   * into `StreamInput.responsesContinuation` so continuation state remains
   * session-owned even when one boot-time `LLMPort` is shared across multiple
   * sessions. Absent ⇒ no explicit store; adapters may fall back to their
   * local default.
   */
  responsesContinuation?: { store: ResponsesContinuationStore }
  /**
   * ADR-0300 — per-tool granular checkpoint registry. Sibling of
   * {@link conversationCheckpoint} for ADR-0124's conversation face:
   * this slot owns per-tool-call file+task snapshots that the
   * rewind-tool slash + future auto-recovery hook consume. Absent ⇒
   * slot OMITTED (default-OFF byte-identical). Caller-side composition
   * only — loop NEVER reads it.
   */
  granularRegistry?: GranularRegistryPort
  /**
   * ADR-0143 OS-sandbox port slot (helper-only). When set, future
   * shell/exec consumers wire through this port (Seatbelt on macOS / Landlock
   * on Linux). Absent ⇒ the consumers fall back to the legacy unsandboxed
   * spawner (byte-identical default-OFF). NOT consumed by the loop itself
   * today — slot exists for caller-side composition.
   */
  osSandbox?: OsSandbox
  /**
   * ADR-0139 LLM-provider port slot (helper-only). When set, future
   * factory-resolving consumers (BYO-key / Bedrock / Vertex / Foundry routes)
   * consult this port instead of the legacy `@/llm/factory` direct path.
   * Absent ⇒ the legacy path is byte-identical. NOT consumed by the loop
   * itself today — slot exists for caller-side composition.
   */
  llmProvider?: LlmProvider
  /**
   * ADR-0141 LSP sibling ports slot. Closed-port DI for the four LSP
   * sub-surfaces (code-action / format / signature-help / rename-apply). When
   * wired, future tools that need these surfaces consume them through this
   * slot. Absent ⇒ the consumers fall back to their null adapters or skip
   * registration entirely (byte-identical default-OFF). Caller-wire of these
   * tools to `extraTools` is a separate ADR; for now just the slot.
   */
  lspPorts?: {
    readonly codeAction?: CodeActionPort
    readonly format?: FormatPort
    readonly signatureHelp?: SignatureHelpPort
    readonly renameApply?: RenameApplyPort
  }
  /**
   * ADR-0159 retrieval-stack slot (composition-root wire). When set,
   * consumers downstream of the loop (memory recall via
   * `rankWithRetrievalStack`, localize hybrid via `runLocalizeHybrid`,
   * future `hybrid_localize` tool) may route their candidate lists through
   * the 3-stage retrieval funnel (BM25 → embedding → reranker).
   *
   * Default-OFF: absent ⇒ the loop is byte-identical for every legacy
   * caller (no consumer constructs the stack itself; the bridge functions
   * return identity behavior when this slot is undefined). The slot is
   * caller-side composition only — the agent loop NEVER reads it directly.
   *
   * The concrete builder lives at
   * `@/runner/assemble/retrieval.ts#buildRetrievalStackCore`. `RerankRegistry`
   * + `RerankPort` are owned by `@/retrieval` (leaf primitive slice — every
   * other slice may reach IN; the slice may NOT reach out, see ADR-0159
   * biome fence). Importing them here is the conventional direction.
   */
  retrievalStack?: {
    readonly registry: RerankRegistry
    readonly defaultReranker: RerankPort
    readonly embedding?: EmbeddingPort
    readonly commitEmbedder?: CommitEmbedder
  }
  /**
   * ADR-0278 search-pipeline slot (composition-root wire). Sibling of
   * {@link retrievalStack}: where `retrievalStack` exposes the reranker
   * registry for memory recall and localize, this slot exposes a
   * populated `SearchPipeline` for the `search_codebase` tool and any
   * future caller that wants pipeline-shaped search.
   *
   * Surface-default product behavior now wires lexical repo search on the
   * main agent/CLI surfaces and upgrades to hybrid when `QUANTA_INDEX=on`;
   * `QUANTA_PIPELINE=none` is the explicit kill-switch. The slot remains
   * helper-only — the loop / dispatch still never reads it directly.
   *
   * The slot is caller-side composition only — the agent loop NEVER
   * reads it directly. See `src/apps/agent/index.ts` for the wire and
   * ADR-0278 for the closed truth table.
   */
  searchPipeline?: import("@/retrieval/pipeline").SearchPipeline
  /**
   * ADR-0200 stream idle/total timeout watchdog slot. When BOTH this and
   * {@link streamTimeoutPolicy} are set, the loop wraps each LLM stream
   * with `streamWatchdog.wrap(src, policy, signal)` so hung providers
   * surface as a typed `StreamIdleError`/`StreamTotalError`/`StreamAbortError`
   * instead of parking the turn forever.
   *
   * Default-OFF: either slot absent ⇒ the loop yields the raw source
   * verbatim (byte-identical for every legacy caller). The composition
   * root MAY default this to `noOpWatchdog()` so dynamic enablement is a
   * pure policy swap; the loop tolerates either no-op-with-no-policy or
   * undefined.
   */
  streamWatchdog?: import("./stream-timeout").StreamWatchdog
  /**
   * ADR-0200 stream timeout policy. Holds `idleMs` / `totalMs` / `action`
   * and (optionally) a `SnoozeController` instance owned by the CLI repl.
   * Consumed only when {@link streamWatchdog} is also set.
   */
  streamTimeoutPolicy?: import("./stream-timeout").TimeoutPolicy
  /**
   * ADR-0203 wire (helper-only slot) — typed error classifier + 5-arm retry
   * router. Caller-side composition: when set, the CLI/host wires the slot
   * into `RetryingLLM({ errorRouting: cfg.errorRouting, ... })` so the
   * retry decorator may shortcut on `abort`/`hitl`. Absent ⇒ no consumer
   * touches it (byte-identical default-OFF — RFC §1.2). The loop itself
   * never reads this slot directly.
   */
  errorRouting?: {
    readonly classifier: import("./error-routing").ErrorClassifier
    readonly router: import("./error-routing").RetryRouter
  }
  /**
   * ADR-0206 wire (helper-only slot) — per-thread dynamic tool registry.
   * Caller-side composition: when set, the dispatch/composition root may
   * call `composeTools(globalRegistryTools, registry.list(threadId).map(...))`
   * to merge per-thread MCP tools on top of the global registry. Absent ⇒
   * no consumer reaches into this slot (byte-identical default-OFF — RFC
   * §1.2). The loop never reads this slot directly today.
   */
  threadToolRegistry?: import("./thread-tools").ThreadToolRegistry
  /**
   * ADR-0207 wire (helper-only slot) — per-thread Stage-1 distillation
   * usage/selection cache. SIBLING to `memoryConsolidator.store` (which
   * owns the watermark/promotion surface); this slot owns the
   * `get/put/touch/markSelectedForPhase2/list/prune` surface so future
   * phase1-completion hooks can mirror the entry and Phase 2 candidate
   * selectors can read across runs. Absent ⇒ no consumer touches it
   * (byte-identical default-OFF — RFC §1.2). The loop never reads this
   * slot directly today.
   */
  stage1OutputsStore?: import("../memory/stage1-store").Stage1OutputsStore
  /**
   * ADR-0235 — per-turn shell-snapshot wire (caller-side composition).
   * Sibling to ADR-0204 (the snapshot primitive). When set, the loop
   * captures a snapshot at turn-start (`captureAtTurnStart`, default `true`)
   * and threads the resulting handle into `ToolContext.shellSnapshot` so
   * shell-class tools (`bash` today) forward it to `runShell` — which
   * augments the spawned argv to `source <path>; <user-cmd>`. The same
   * `snapshotPath` is reused for every `runShell` call within that turn.
   *
   * Default-OFF: absent ⇒ no capture, `ctx.shellSnapshot` omitted, every
   * `runShell` call byte-identical to the pre-ADR path (RFC §1.2). When
   * present but `port.capture` fails (shell-missing / capture-timeout /
   * write-failed / empty-capture / invalid-id), the loop continues WITHOUT
   * a snapshot for that turn and emits a single `error` AgentEvent — the
   * loop is no-throw at this boundary.
   *
   * Knobs:
   *  - `port`: REQUIRED. The {@link ShellSnapshotPort} (build via
   *    `createShellSnapshotPort(spawner)` at the composition root). Tests
   *    inject the headless stub.
   *  - `shell` (default `"auto"`): which adapter to use. `"auto"` reads
   *    `$SHELL` and picks `"zsh"` when the basename is `zsh`, else `"bash"`
   *    (every other supported shell falls through to bash since the bash
   *    adapter handles the broadest POSIX surface). Explicit `"zsh"` /
   *    `"bash"` force the adapter.
   *  - `captureAtTurnStart` (default `true`): when `true`, capture runs at
   *    the TOP of every turn (after `steerBarrier`, before `runTurn`). When
   *    `false`, capture runs ONCE at session start and the same handle is
   *    reused for every turn (operator decision — explicit opt-in to less
   *    work + stale-env risk).
   *  - `cleanupOlderThanMs` (default `864e5 * 10` = 10 days): how often to
   *    prune old snapshot files. Pruned ONCE at session start
   *    (best-effort; failures emit a single `error` AgentEvent).
   *  - `maxSizeBytes` (default `100 * 1024 * 1024` = 100MB): SOFT cap for
   *    the snapshot directory; consulted at session-start prune.
   */
  shellSnapshot?: {
    readonly port: import("@/runtime/shell-snapshot").ShellSnapshotPort
    readonly shell?: "auto" | "zsh" | "bash"
    readonly captureAtTurnStart?: boolean
    readonly cleanupOlderThanMs?: number
    readonly maxSizeBytes?: number
    /** Resolved SHELL env literal — composition root passes `process.env.SHELL`.
     *  Slice invariant (ADR-0144): no process.env in @/agent. Absent ⇒ "bash" fallback. */
    readonly shellEnv?: string
  }
  /**
   * ADR-0235 (internal slot) — populated by the loop at session start when
   * `shellSnapshot` is wired. Dispatch reads `currentSeam()` here to thread
   * the active restore handle into `ToolContext.shellSnapshot`. Mutable on
   * `cfg` (not the caller's `config`) because the loop rebinds a fresh
   * session per `runAgent` invocation; the caller's object is never touched
   * (see `runAgentInner`'s `cfg` copy discipline). Public-typed so the
   * dispatch module (separate file, no module-private channel) can read it.
   */
  shellSnapshotSession?: import("./shell-snapshot-session").ShellSnapshotSession
  /**
   * ADR-0236 — composition-root mega-wire (this slot). Mode-typed delegation
   * port (ADR-0218). When set, the subagent fork path may route mode-typed
   * delegations through this port (parent → child mode-typed subtask,
   * isolated context, boomerang result). Caller-side composition only —
   * the loop never reads it directly today; surfaces (Agent tool, future
   * `/delegate` slash) opt in by reading this slot. Absent ⇒ slot omitted,
   * byte-identical legacy (RFC §1.2 default-OFF).
   */
  delegation?: {
    readonly delegator: import("./subagent-typed").DelegationPort
    readonly modes?: ReadonlyArray<import("./subagent-typed").AgentMode>
  }
  /**
   * ADR-0236 / ADR-0219 — Focus Chain auto-reinject (Cline absorption). When
   * set, the loop advances the tracker once per turn (after steerBarrier /
   * conversation-action poll) and drains `getInjection()` into the per-turn
   * working memory tail so the next LLM call sees the rendered todo list.
   * Absent ⇒ no allocation, no `tickTurn`, no injection — byte-identical
   * legacy (RFC §1.2). `reinjectEveryN` is a documentation slot mirroring
   * what the host passed when constructing the tracker.
   */
  focusChain?: {
    readonly tracker: import("./focus-chain").FocusChainPort
    readonly reinjectEveryN?: number
  }
  /**
   * ADR-0236 / ADR-0226 — rich fork-session port (composition-root wire).
   * Sibling to the base {@link fork} slot (ADR-0201 sync `SessionForker`):
   * this slot exposes the richer async port (`Promise<Result>` + signal
   * cancel + optional branch label + shadow-ODB tag). Caller-side; loop
   * does not consume directly. Absent ⇒ slot omitted, byte-identical.
   */
  forkSession?: { readonly forker: import("./fork-session").ForkSessionPort }
  /**
   * ADR-0236 / ADR-0224 — text-inbox sink (composition-root wire). Caller-
   * side slot — the surface (REPL / Tauri / Web) drains through its own
   * `PromptSource.next()` and concatenates to the next user-turn body. The
   * slot exists so the composition root can publish the inbox handle to
   * other subsystems (e.g. a `/web` slash enqueueing for a different
   * surface). The loop NEVER drains this slot directly. Absent ⇒ omitted.
   */
  textInbox?: { readonly sink: import("../apps/cli/text-inbox").TextInbox }
  /**
   * ADR-0236 / ADR-0225 — plan-edit port (composition-root wire). Caller-
   * side; `/edit-plan` slash reads it via `SlashContext.planEdit`. Loop
   * does not consume. Absent ⇒ slash prints "not wired in this surface".
   */
  planEdit?: { readonly port: import("../apps/cli/edit-plan-cmd").PlanEditPort }
  /**
   * ADR-0236 / ADR-0225 — composer-edit port (composition-root wire).
   * Sibling to {@link planEdit}: drives `/edit-message`. Default-OFF.
   */
  composerEdit?: { readonly port: import("../apps/cli/edit-message-cmd").ComposerEditPort }
  /**
   * ADR-0236 / ADR-0212 — sticky-model-per-mode store (composition-root
   * wire). Caller-side slot consumed by the model-resolver (`/status` may
   * surface the current preference; future `--sticky-model` CLI flag
   * activates an fs-backed store at composition root). Absent ⇒ slot
   * omitted; the global default model wins for every mode.
   */
  stickyModelStore?: { readonly store: import("./sticky-model").StickyModelStore }
  /**
   * ADR-0236 / ADR-0213 — tool-profile preset resolver (composition-root
   * wire). Caller-side slot — the admissibility gate (Wave-B follow-up)
   * may compose the profile's per-tool admissibility on top of the legacy
   * permission stack; `/profile` slash mutates the active name in place
   * via the host-supplied callback in `SlashContext.profile`. `defaultName`
   * is the initial profile applied at session start. Absent ⇒ no profile
   * layer, byte-identical.
   */
  toolProfile?: {
    readonly resolver: import("./tool-profile").ToolProfileResolver
    readonly defaultName?: import("./tool-profile").ToolProfileName
    /** Live active profile accessor. When present, the admissibility gate
     *  re-reads it per call so `/profile` mutations apply on the next turn
     *  without reassembling the session. Absent ⇒ `defaultName` remains the
     *  fixed active profile for the whole run. */
    readonly activeName?: () => import("./tool-profile").ToolProfileName
  }
  /**
   * ADR-0236 / ADR-0211 — system-prompt mode-variant registry (composition-
   * root wire). The composition root threads the variant for the active
   * mode through `buildSystemPrompt({ identity: variant.identity })` BEFORE
   * constructing the session. Loop never re-reads this slot mid-session
   * for the cached system prompt.
   *
   * ADR-0239 — when `perTurnReminderEnabled` is `true`, the loop ALSO
   * splices the variant's identity lines into the per-turn working memory
   * as a trailing `<system-reminder>` user message — Codex `ARCHITECT_NOTICE`
   * / `EDITOR_NOTICE` pattern. The reminder is independent from (and rides
   * AFTER) the existing prompt.ts `modeNotice` rendering: that one fires
   * unconditionally on architect/editor/plan/review/audit modes (and ships
   * the FULL multi-line notice from prompt.ts); this slice's per-turn
   * reminder rides the variant's IDENTITY lines (the one-sentence
   * `DEFAULT_MODE_VARIANTS[mode]`) so a host that overrode the registry's
   * identity gets THAT line splicea every turn, keeping the variant and the
   * reminder consistent. Default-OFF when explicitly `false`;
   * mode-conditional auto-ON when undefined (architect | editor only — the
   * two modes that benefit most from the per-turn nudge; legacy plan /
   * review / audit already get the fuller modeNotice and a 2nd reminder
   * would dilute it).
   */
  identityModeVariant?: {
    readonly registry: import("./system-prompt").SystemPromptVariantRegistry
    /** ADR-0239 — per-turn reminder splice opt-in. `true` ⇒ splice every
     *  turn for the active mode (regardless of mode). `false` ⇒ never
     *  splice. `undefined` ⇒ mode-conditional auto-ON for
     *  `architect | editor`; off for every other mode (matches the
     *  prompt.ts modeNotice cadence — architect/editor get the per-turn
     *  identity reminder; the other modes already ship a full modeNotice
     *  every turn). */
    readonly perTurnReminderEnabled?: boolean
    /** Live active mode accessor. When present, both the per-turn reminder
     *  splice and any surface-owned system-prompt source re-read the current
     *  mode each turn so `/identity` mutations apply immediately on the next
     *  turn. Absent ⇒ callers fall back to the loop's own effective mode. */
    readonly activeMode?: () => import("./system-prompt").ModeVariantKey
  }
  /**
   * ADR-0236 / ADR-0203 / ADR-0240 — inline-trigger watcher (composition-
   * root wire).
   *
   * Caller-side: the composition root may bind the watcher at session start
   * via {@link import("@/skill/playbook").startPlaybookAutoDispatch} and
   * stop it at session end (`.stop()`). Loop does NOT consume directly.
   *
   * Pre-ADR-0240 contract (just `{ watcher }`): the composition root owned
   * registry iteration + sink wiring. Kept for byte-identical back-compat.
   *
   * ADR-0240 additions (`enabled` / `watchGlobs` / `debounceMs` / `registry`
   * / `planQueueSink`): when the host wires the new fields, the orchestrator
   * does the iteration + dispatch. Default-OFF: absent or `enabled !== true`
   * ⇒ no watcher started.
   *
   * The two paths are compatible (the host MAY supply just `watcher` and
   * call the orchestrator itself; or supply the full block and let
   * `startPlaybookAutoDispatch` wire everything).
   */
  playbookTrigger?: {
    readonly watcher: import("@/skill/playbook").InlineTriggerWatcherPort
    /** ADR-0240 master switch — default `false` (opt-in). When `true`, the
     *  host's `startPlaybookAutoDispatch` call wires the registry + sink. */
    readonly enabled?: boolean
    /** ADR-0240 — registered playbooks the orchestrator iterates. Each
     *  must carry a non-empty `trigger` to actually wire. */
    readonly registry?: import("@/skill/playbook").PlaybookRegistry
    /** ADR-0240 — sink the dispatcher hands the `/play <name>` follow-up
     *  to. Absent ⇒ fires are detected but NOT enqueued. */
    readonly planQueueSink?: import("@/skill/playbook").PlaybookPlanQueueSink
    /** ADR-0240 — per-watcher debounce window (ms). Default 200ms when
     *  omitted (matches the watcher's intrinsic default). */
    readonly debounceMs?: number
    /** ADR-0240 — restricting glob list applied IN ADDITION to each
     *  registration's `trigger.watchGlob`. When set, only paths matching
     *  ANY of these globs AND the per-playbook glob fire. Default
     *  `["**" + "/*"]` (no extra restriction). */
    readonly watchGlobs?: readonly string[]
  }
  /**
   * ADR-0236 / ADR-0215 — RRULE automation engine (composition-root wire).
   * Caller-side: a host's background tick may drain due automations via
   * `tickScheduler({ engine, now, handler })`. Loop does not consume
   * directly. Absent ⇒ scheduler runs without automation drain.
   *
   * ADR-0239 — when `handler` is also wired AND `tickIntervalMs > 0`, the
   * loop starts a `setInterval`-backed background drain at session-start and
   * stops it in `finish`. Each tick consults `engine.next(now)` and fires
   * the soonest-due automation via `tickScheduler`. Default-OFF byte-
   * identical: absent `handler` OR `tickIntervalMs` ⇒ no timer is armed
   * (RFC §1.2). `handler` MAY be sync or async; throws are absorbed by
   * `tickScheduler` and surface as `kind: "errored"` outcomes via the
   * optional `onTick` observer.
   */
  automationEngine?: {
    readonly engine: import("@/scheduler/automation-engine").AutomationEnginePort
    /** ADR-0239 — host-supplied fire callback. When set with a positive
     *  `tickIntervalMs`, the loop arms a setInterval that calls
     *  `tickScheduler({ engine, now: Date.now(), handler })` every interval.
     *  Absent ⇒ no timer (the slot stays helper-only, matching the original
     *  ADR-0215 default-OFF posture). */
    readonly handler?: import("@/scheduler/automation-engine").AutomationHandler
    /** ADR-0239 — tick cadence in ms. Absent / 0 / negative / NaN ⇒ no
     *  timer (the loop short-circuits at the optional-chain). The loop has
     *  NO baked-in default; callers must opt in explicitly. */
    readonly tickIntervalMs?: number
    /** ADR-0239 — optional observer fired AFTER each `tickScheduler` returns
     *  (idle / fired / errored / engine-error). Tests and ops surfaces wire
     *  this to count ticks / forward to OTel / surface errored automations
     *  to an inbox UI. Throws are absorbed (the timer keeps ticking). */
    readonly onTick?: (outcome: import("@/scheduler/automation-engine").TickOutcome) => void
    /** ADR-0239 — injected clock for tests + replay. Default `Date.now`. */
    readonly now?: () => number
    /** ADR-0453 — OPTIONAL autorun-eligibility gate threaded into
     *  `tickScheduler` (the scheduler-path 4th guard). Consulted BEFORE the
     *  claim; a not-eligible verdict skips the fire (no claim, no anchor
     *  advance). Absent ⇒ ticks byte-identical. Built at the composition root
     *  over the pure `evaluateAutorunEligibility` (closed `QUANTA_AUTORUN_POLICY`
     *  knob). */
    readonly eligibility?: () => import("@/scheduler/automation-engine").TickEligibilityVerdict
  }
  /**
   * ADR-0234 — git-directive emit wire (turn-scoped collector pattern).
   * Closes the gap between ADR-0221 (phase-guarded emitter) and the
   * mutating git tools (`git_commit`, `git_branch_switch`, future
   * `gh_pr_create`). Tools call `collector.record(directive)` during
   * their intermediate-phase execution; the loop calls `collector.flush()`
   * at the turn boundary, draining each entry through the wired emitter
   * with `phase: "final-answer"` — the natural moment that satisfies the
   * ADR-0221 phase invariant without forcing call sites to lie about
   * phase.
   *
   * Default-OFF: absent or `enabled !== true` ⇒ no collector built, no
   * emit wire installed, the loop is byte-identical to the pre-ADR-0234
   * path (RFC §1.2). When `enabled: true` the loop wires the collector
   * into the per-session `git_commit` / `git_branch_switch` factories
   * (via `gitTools({ gitDirectiveCollector })` at the composition root)
   * AND calls `flush()` once per turn end (after `gitObservability`
   * endTurn, before `emitWorkMetrics` — same "post-turn-body" boundary).
   *
   * `sink`: where the emitter writes the wire line. `"stdout"` (default)
   * matches the Codex protocol (UI consumers grep `^::git-` from the
   * agent's stdout); `"stderr"` is for hosts that frame structured
   * channels separately; the inline function form lets tests + Tauri
   * hosts intercept without process I/O.
   *
   * `includeIntermediate`: when `true`, the collector emits at record
   * time AS WELL AS at flush time (for live-progress surfaces that need
   * mid-turn visibility). Default `false` — strict final-answer-only
   * discipline.
   *
   * `emitter`: optional pre-built emitter override (test-injection seam,
   * mirrors `dedupGate`/`gitObservability.session`). When set, `sink`
   * is ignored (the caller supplied a complete port).
   *
   * `collector`: optional pre-built collector override (test-injection
   * seam). When set, the loop uses this collector verbatim instead of
   * constructing one — the same surface the tool wire passes to git
   * tools. `emitter` is ignored in this branch (the collector already
   * owns its emitter).
   */
  gitDirectiveEmit?: {
    readonly enabled: boolean
    readonly sink?: "stdout" | "stderr" | ((line: string) => void)
    readonly includeIntermediate?: boolean
    readonly emitter?: import("../git/directive-emit").DirectiveEmitterPort
    readonly collector?: import("../git/directive-emit").GitDirectiveCollector
  }

  // ─── ADR-0327 Codex-r2 wire seam ──────────────────────────────────────────
  //
  // Three optional slots that the loop forwards to `buildTurnContext` when
  // present. ALL ABSENT ⇒ loop is byte-identical to pre-ADR-0327. The slots
  // are intentionally narrow function/port shapes — caller (composition
  // root / session setup) constructs and threads them, holding any cursor
  // / detector / store state in its own closure. Default-OFF (RFC §1.2).

  /** ADR-0326 — session-scoped system-prompt cache port. When set together
   *  with {@link systemPromptCacheKey}, the loop forwards both to
   *  `buildTurnContext` so the default `buildSystemPrompt()` factory is
   *  memoized per key. `system` (caller-provided prefix) bypasses the cache.
   *  Absent ⇒ per-turn rebuild (byte-identical). */
  systemPromptCache?: import("@/llm/system-prompt-cache").SystemPromptCachePort

  /** ADR-0326 — opaque session key for {@link systemPromptCache}. When the
   *  cache is set but the key is absent (or vice-versa), the cache stays
   *  DISENGAGED (legacy build path) — both slots are required to wire. */
  systemPromptCacheKey?: import("@/llm/system-prompt-cache").SystemPromptCacheKey

  /** ADR-0321 — per-turn context-change events producer. Called once per
   *  `buildTurnContext` build. The producer owns its own cursor / detector /
   *  store state (closure pattern); the loop forwards the returned array
   *  verbatim to `contextChangeEvents`. NO-THROW invariant: a thrown error
   *  is logged and converted to an empty array so a misconfigured producer
   *  cannot break the turn. Absent / empty ⇒ no splice (byte-identical). */
  contextEventsForTurn?: () => readonly import("@/agent/context-change").ContextEvent[]

  /** ADR-0325 / ADR-0418 — mention-injection runner. When set, the loop
   *  extracts the latest user-role text content, `await`s the runner, and
   *  forwards the returned messages to `mentionInjectionMessages`. ASYNC
   *  (ADR-0418 supersedes ADR-0325's sync shape) so `@file` / `@symbol`
   *  resolvers can do I/O. NO-THROW invariant: a thrown / rejected runner is
   *  converted to `[]`. Absent ⇒ no parse, no injection (byte-identical). */
  mentionInjector?: (userInputText: string) => Promise<readonly import("@/llm").Message[]>

  /** ADR-0418 — declarative DI knobs for the `@file` / `@symbol` mention
   *  resolvers. A composition root reads `QUANTA_MENTION_FILE*` /
   *  `QUANTA_MENTION_SYMBOL*` env into this bag (or a host injects it
   *  directly) and threads it into `createCompositeMentionResolver`. This is
   *  the DATA shape only — the wire from this bag to a built `mentionInjector`
   *  is the composition root's job. Absent ⇒ file/symbol mentions resolve to
   *  `null` (skipped), byte-identical to the legacy 3-kind path. */
  mentionInjection?: {
    /** Pre-built `@file` resolver (e.g. from `createFileResolver`). */
    readonly fileResolver?: (target: string) => Promise<{ readonly bodyText: string } | null>
    /** Pre-built `@symbol` resolver (e.g. from `createSymbolResolver`). */
    readonly symbolResolver?: (target: string) => Promise<{ readonly bodyText: string } | null>
    /** File read cap before truncation (default 256 KiB). */
    readonly maxFileBytes?: number
    /** Fraction of the cap reserved for the file tail (0..1, default 0). */
    readonly tailRatio?: number
    /** `@symbol` lookup strategy: `lsp` | `semantic` | `auto` (default auto). */
    readonly symbolPriority?: "lsp" | "semantic" | "auto"
    /** Per-strategy `@symbol` lookup timeout in ms (default 5000). */
    readonly symbolTimeoutMs?: number
  }

  /** ADR-0324 — typed compaction-event emitter. Called when a proactive
   *  (top-of-turn `maybeCompact`) compaction succeeds. The callback is
   *  expected to push the event onto a `TypedHistoryEventStore` (ADR-0320)
   *  so consumers (typically a context-events producer fed by the SAME
   *  store) can surface compaction as a typed-history narrative event.
   *  NO-THROW: callback errors are swallowed so an emitter glitch cannot
   *  break the turn. Absent ⇒ no emit (byte-identical). */
  compactionEventEmit?: (event: import("@/memory/typed-event").CompactionEventVariant) => void

  /** ADR-0340 — plugin activation closure. When set, the loop / surface
   *  hook may call `activatePlugins(parsedMentions, { turnId })` once per
   *  turn after `parseMentions` to spawn each plugin's declared MCP
   *  servers (ADR-0338) and resolve its declared skills (ADR-0339). The
   *  returned `AggregatedActivation.resolvedSkills` is intended to be
   *  unioned into `TurnContextInput.activeSkills` via
   *  `unionActiveSkills`; the returned `handles` are session-scoped
   *  (the composition root retains the `PluginMcpRegistry` lifetime and
   *  calls `shutdownAll()` on session end).
   *
   *  NO-THROW: thrown errors degrade to `{ handles: [], resolvedSkills: [] }`
   *  so a misconfigured plugin handler cannot break the turn. Absent ⇒
   *  no activation, no spawn, byte-identical legacy behaviour. */
  activatePlugins?: (
    mentions: readonly import("@/agent/mention-injection").ParsedMention[],
    opts?: { readonly turnId?: string },
  ) => Promise<import("@/agent/plugin-activation-handler").AggregatedActivation>
  /** jun-6 (RFC jun-6-ai-session-title) — fire-and-forget AI session titler.
   *  Duck-typed (NO `@/runner` import) so `@/agent` stays free of the
   *  composition root. When set (the root built it because
   *  `QUANTA_SESSION_AUTO_TITLE` is on AND `QUANTA_SESSION_TITLE_MODEL` resolved
   *  a cheap `LLMPort`), `runSessionStartSequence` calls
   *  `maybeTitle(sessionId, firstPrompt)` ONCE on the first turn AFTER the
   *  `session_start` emit, when the first prompt is non-empty. The call returns
   *  IMMEDIATELY (the work runs on a detached promise the turn never awaits; all
   *  failures swallowed; a human rename is never clobbered). Absent ⇒ the branch
   *  is dead (byte-identical default-OFF, RFC §1.2). */
  autoTitlePort?: { maybeTitle(sessionId: string, firstPrompt: string): void }
}

// ─────────────────────────────────────────────────────────────────────────
// AgentConfig cohesion groups (Round-3 audit #1 — additive seam).
// AgentConfig `extends` these so the flat field set on the public type is
// byte-identical (consumers reading `config.verifyGuard` etc. are unchanged),
// but each subsystem can now take the narrow slice it actually needs as its
// parameter type — turning the 53-field god-config into a documented
// composition of cohesive sub-configs without a breaking restructure.
//
// Field types here MUST stay byte-identical to the AgentConfig body
// declarations above; declaration-merging requires identical signatures.
// ─────────────────────────────────────────────────────────────────────────

/** Safety / guard knobs. Each member is default-OFF when absent. */
export interface SafetyConfig {
  compactionBreaker?: CompactionBreakerOptions
  verifyGuard?: { maxTrips?: number; mustPass?: boolean }
  localizePhase?: LocalizePhaseConfig
  localizePhaseState?: LocalizePhaseState
  closeoutGuard?: { enabled?: boolean; fourRule?: boolean }
  /** P12 — closeout critic gate (mirrors `closeoutGuard` placement on both
   *  AgentConfig and SafetyConfig). See AgentConfig.closeoutCritic. */
  closeoutCritic?: CloseoutCriticConfig
  dedupGate?: DedupGate
  dedupGateConfig?: { disabled?: boolean; caps?: Partial<DedupGateCaps> }
}

/** Permission-stack add-ons orthogonal to the core {@link AgentConfig.permission}
 *  context. Each is default-OFF. */
export interface PermissionExtrasConfig {
  hitl?: { enabled?: boolean }
  trustScope?: { registry: TrustScopeRegistry; projectKey: string }
  permissionStack?: { enabled?: boolean; hostId?: string }
  permissionPatternStore?: PatternGrantStore
  permissionAllowDangerous?: boolean
}

/** Mid-turn steering wiring (ADR-0030). Default-OFF when absent. */
export interface SteeringConfig {
  activeTurnRef?: { current: ActiveTurnState }
  steerBarrier?: () => Promise<void>
}

/** Narrow contract for {@link runAdmissibilityGate} — Round-3 audit #9
 *  ("feature envy on AgentConfig"). The gate reads exactly these fields;
 *  taking the narrow type instead of the whole `AgentConfig` documents the
 *  surface and prevents accidental growth. `AgentConfig` is assignable to
 *  it, so existing callers (`dispatch.ts`) need no change. */
export type AdmissibilityGateConfig = Pick<
  AgentConfig,
  | "cwd"
  | "decisionEmitter"
  | "hitl"
  | "hooks"
  | "mode"
  | "onConfirm"
  | "onHandoff"
  | "permissionAllowDangerous"
  | "permissionPatternStore"
  | "permissionStack"
  | "planMode"
  | "registry"
  | "run"
  | "sessionId"
  | "toolProfile"
  | "trustScope"
>

/** Narrow contract for the loop's recovery seam (recovery.ts decisions +
 *  reactive compaction surface). Recovery itself uses internal SAME-TURN
 *  budget constants; the loop wires the decision into the actual transcript /
 *  compaction path via `llm`, `stream`, `signal`, and the `compaction` block
 *  (summarizer + thresholds). `compactionBreaker` short-circuits pathological
 *  compaction thrash. ISP slice for the recovery / compaction co-operators. */
export type RecoveryConfig = Pick<
  AgentConfig,
  "llm" | "stream" | "signal" | "compaction" | "compactionBreaker" | "onPreCompact"
>

/** Narrow contract for the long-term memory subsystem (RFC §6.3; memory.ts /
 *  memory-distill.ts / memory-consolidate.ts seams). Recall + persist + distill
 *  read `store` / `embedder` / `memory` knobs; `sessionId` tags persisted
 *  records; `llm` powers distill + consolidate. Absent fields ⇒ the subsystem
 *  degrades exactly as it does on the full `AgentConfig`. */
export type MemoryConfig = Pick<AgentConfig, "store" | "embedder" | "memory" | "sessionId" | "llm">

/** Narrow contract for `buildSessionFeatures` (features.ts). Turns the
 *  optional Tier-1 toggles into wired services (skills inventory, subagent
 *  runner, working-state, branch-search tool, plan-exit). Reads `registry` +
 *  `llm` + `permission` for the per-feature wiring, plus the feature
 *  toggles themselves. */
export type FeaturesConfig = Pick<
  AgentConfig,
  | "registry"
  | "llm"
  | "permission"
  | "skills"
  | "subagent"
  | "workingState"
  | "branchSearch"
  | "shadowCheckpoint"
  | "shadowOdb"
  | "shadowVerify"
  | "subagentBackground"
  | "subagentMailbox"
  | "delegation"
  | "fork"
  | "onProgress"
  | "planExitPort"
  | "modelCandidates"
  | "planQueue"
  | "webSearch"
  | "advisor"
  // ─── P0/P1 wire-audit closeout (new slots reachable from features.ts) ───
  // `budgetLedger` is consumed TODAY (builds `budget_status` tool).
  // The remaining 6 are helper-only slots: their presence on the FeaturesConfig
  // Pick documents that future caller-wire-time consumers in features.ts will
  // read them, and keeps the Pick union from drifting away from AgentConfig.
  | "budgetLedger"
  | "objective"
  | "runLedger"
  | "approvalStateMachine"
  | "conversationCheckpoint"
  | "responsesContinuation"
  | "llmProvider"
  | "lspPorts"
  | "metrics"
  | "osSandbox"
  // ─── ADR-0417 (ports-only, consumer wire deferred) ───
  | "effortClassifier"
  | "fastApplyFallback"
  | "fastApplyMerge"
>

/** Narrow contract for per-turn prompt / context assembly (the loop's
 *  reminder-builder + IDE-context snapshot + redaction-config consult). These
 *  are the fields read at the TOP of each turn to compose what the model
 *  sees, distinct from the recovery / dispatch fields read inside the turn. */
export type TurnContextConfig = Pick<
  AgentConfig,
  | "cwd"
  | "system"
  | "mode"
  | "planMode"
  | "repoRules"
  | "globRules"
  | "ideContextProvider"
  | "redaction"
  | "run"
  | "sessionId"
>

/** Narrow contract for the budget / mode-policy slot (RFC may-22 Phase 0/1).
 *  The loop's tick sites emit through `budgetMeter`; `modePolicy` clamps the
 *  meter caps and parametrizes the dispatch posture; `maxTurns` is the hard
 *  upper bound the loop enforces independently of any meter. */
export type BudgetConfig = Pick<AgentConfig, "budgetMeter" | "modePolicy" | "maxTurns">
