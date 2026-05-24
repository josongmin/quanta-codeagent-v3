import type { LLMPort, Message, ModelCandidate } from "@/llm"
import type { EmbedderPort, PersistentStorePort } from "@/memory"
import type { Metrics } from "@/observability"
import type {
  PatternGrantStore,
  PermissionContext,
  ToolAction,
  TrustScopeRegistry,
} from "@/permission"
import type { RedactionConfig } from "@/security"
import type { RunContext } from "@/shared"
import type { ShadowOdb } from "@/storage"
import type { StreamPort } from "@/stream"
import type { ShellExecObserver, ToolRegistry, UserInputRequester } from "@/tool"
import type { WebSearchProvider } from "@/tool/web"
import type { BranchSearchConfig, ProgressLine } from "./branch-search"
import type { BudgetMeter } from "./budget"
import type { CapEnforcer } from "./cap-enforcer"
import type { CheckpointTriggerMode, DestructivenessOracle } from "./checkpoint-policy"
import type { ConfirmDecision } from "./confirm-decision"
import type { ConversationActionPort } from "./conversation-action"
import type { DedupGate, DedupGateCaps } from "./dispatch-dedup"
import type { FollowUpQueue, PausedReason } from "./follow-up-queue"
import type { GlobRule } from "./glob-rules"
import type { HandoffRequiredEvent } from "./hitl-tier"
import type { HookBus } from "./hooks"
import type { IdeContextProvider } from "./ide-context"
import type { LocalizePhaseConfig, LocalizePhaseState } from "./localize-phase-guard"
import type { PlanStore } from "./plan/state"
import type { PlanExitPort } from "./plan-exit-flow"
import type { PlanQueueStore } from "./plan-queue"
import type { AgentMode } from "./prompt"
import type { RepoRules } from "./repo-rules"
import type { ModePolicy } from "./run-mode"
import type { ActiveTurnState } from "./steering"
import type { Submission } from "./submission"
import type { SkillsBlock, SubagentBlock, WorkingStateBlock } from "./types/agent-capabilities"
import type {
  CompactionBreakerOptions,
  CompactionConfigBlock,
  OnPreCompactCallback,
  PreCompactRequestQuery,
} from "./types/compaction-config"
import type { MemoryConfigBlock, MemoryConsolidatorBlock } from "./types/memory-config"
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
   * Metrics registry (RFC §8 Phase 3). Absent ⇒ no metrics recorded; loop
   * behavior identical.
   */
  metrics?: Metrics
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
   * Permission stack opt-in (ADR-0046 — per-thread + per-host + post-denial
   * precedence). Absent / `enabled:false` ⇒ admissibility-gate skips the
   * stack consultation and the loop is byte-identical. When `enabled:true`,
   * the gate consults the stack BEFORE the legacy mode-policy:
   *   1. post-denial user override beats every rule below;
   *   2. per-thread record (keyed by `sessionId`) decides next;
   *   3. per-host mode (`hostId`, defaults to `resolveHostId()`) decides next;
   *   4. fall through to the legacy mode-policy.
   *
   * The store is the process singleton unless tests inject one via the
   * `store` option (handled inside the `admissibility-gate` wrapper, not
   * here, to keep this config type IO-free).
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
   * Plan-exit port (ADR-0062). Host-supplied I/O seam that surfaces a plan
   * and returns a {@link PlanExitOutcome}. Absent ⇒ plan-exit flow never
   * invoked (legacy plan-mode posture unchanged). See `./plan-exit-flow.ts`.
   */
  planExitPort?: PlanExitPort
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
  shadowCheckpoint?: { mode: CheckpointTriggerMode; oracle?: DestructivenessOracle }
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
  | "onProgress"
  | "planExitPort"
  | "modelCandidates"
  | "planQueue"
  | "webSearch"
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
