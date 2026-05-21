import type { LLMPort, Message, ModelCandidate } from "@/llm"
import type { EmbedderPort, PersistentStorePort } from "@/memory"
import type { Metrics } from "@/observability"
import type {
  PatternGrantStore,
  PermissionContext,
  ToolAction,
  TrustScopeRegistry,
} from "@/permission"
import type { RunContext } from "@/shared"
import type { StreamPort } from "@/stream"
import type { ToolRegistry } from "@/tool"
import type { CompactionBreakerCaps } from "./compaction-breaker"
import type { DedupGate, DedupGateCaps } from "./dispatch-dedup"
import type { HandoffRequiredEvent } from "./hitl-tier"
import type { HookBus } from "./hooks"
import type { PlanExitPort } from "./plan-exit-flow"
import type { AgentMode } from "./prompt"
import type { RepoRules } from "./repo-rules"
import type { ActiveTurnState } from "./steering"
import type { StopCategory } from "./stop-category"
import type { Submission } from "./submission"
import type { WorkMetricsSink } from "./work-metrics-collector"

/**
 * Cursor-style pre-compact HITL query payload (ADR-0075). Built by the loop at
 * the moment a proactive compaction is about to fire and passed to
 * `AgentConfig.onPreCompact`. Fields are POST-decision proposals — `proposedKeep`
 * is the keepRecentTurns that will be used, `proposedSummaryTokens` is a
 * heuristic estimate based on the summarizable prefix size (so a UI can warn
 * "this will summarize ~12k tokens of history").
 *
 * `turnId` is the canonical turn identifier (the loop already stamps
 * `RunContext.turn` per turn; the query uses a stringified form to stay
 * stable across an eventual id-shape change). When no `RunContext` is wired,
 * the loop synthesizes a deterministic `t<n>` id from the turn counter so the
 * surface always sees a string.
 */
export interface PreCompactRequestQuery {
  /** Stable identifier for the turn whose top is firing the compaction. */
  turnId: string
  /** Estimated tokens of the current transcript (chars/4 heuristic) — the
   *  signal that crossed the threshold. */
  currentTokens: number
  /** The configured / resolved threshold that was crossed. */
  threshold: number
  /** keepRecentTurns proposed by the loop — typically the configured value. */
  proposedKeep: number
  /** Heuristic estimate of how much transcript will be folded into the
   *  summary, in tokens — i.e. the size of the SUMMARIZABLE PREFIX (not the
   *  size of the produced summary, which is typically a fraction of this).
   *  Surfaced for UI prompts like "this will summarize up to ~Nk tokens of
   *  history". Not used by the loop. */
  proposedSummaryTokens: number
}

/**
 * User decision returned from `AgentConfig.onPreCompact`:
 *   - `"approve"` — proceed with this compaction normally;
 *   - `"defer_one_turn"` — skip the compaction this turn; re-evaluate next turn;
 *   - `"force_now"` — proceed (same loop effect as `approve`) but with an
 *     explicit "user forced" marker that downstream emit/log layers may surface
 *     differently. The loop itself treats `force_now` and `approve` identically.
 */
export type PreCompactDecision = "approve" | "defer_one_turn" | "force_now"

export interface AgentConfig {
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
  /** Asked when the permission policy returns `ask`. Absent ⇒ treated as deny. */
  onConfirm?: (action: ToolAction) => Promise<boolean>
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
   */
  memory?: {
    /** Max entries folded into the recall context block. Default 5. */
    recallLimit?: number
    /**
     * LLM-distill the finished transcript into structured records on session
     * end (vs. the heuristic final-text dump). Default `true` when `llm` can
     * serve it; ignored if it fails (graceful degrade to the heuristic).
     */
    distill?: boolean
    /**
     * Consolidate each new record against near-duplicates (LLM-arbitrated
     * merge/supersede). Default `true` when `embedder` is present.
     */
    consolidate?: boolean
    /** Per-tier caps for the post-persist eviction sweep. Defaults: see eviction.ts. */
    evictionCaps?: { semanticMax?: number; episodicMax?: number }
    /** Register the self-edit memory tools (memory_search/write/update). Default `true` when `store` is present. */
    selfEditTools?: boolean
    /**
     * Restrict per-turn recall to these tiers (long-term memory, RFC §6.3).
     * Absent ⇒ recall spans all tiers (behavior-preserving). e.g.
     * `["semantic"]` recalls only durable distilled knowledge.
     */
    recallTiers?: ("episodic" | "semantic")[]
  }
  /**
   * Compaction tuning. Absent ⇒ compaction is skipped entirely (existing
   * suites with no compaction config are unaffected).
   */
  compaction?: {
    thresholdTokens?: number
    keepRecentTurns?: number
    /**
     * Dedicated LLM for the compaction SUMMARY turn (cost/latency,
     * ADR-0011). Summarization is a bounded, low-stakes task — a cheaper/
     * faster model is usually sufficient and avoids spending the main model
     * on every 120k-token compaction. Absent ⇒ uses `config.llm` (the main
     * model), so behavior is byte-identical when unset. Tradeoff: a weaker
     * summarizer can degrade resumed-context fidelity — opt in deliberately.
     */
    summarizerLlm?: LLMPort
    /**
     * Cursor-style sliding-window archive of per-compaction summaries
     * (ADR-0075). When `true`, the loop builds a session-scoped
     * {@link ConversationSummaryArchive} and appends a
     * {@link ConversationSummaryEntry} after every proactive compaction; an
     * `event_msg:context_compacted` AgentEvent is emitted at the same seam so
     * a session jsonl recorder / UI can render the compaction history.
     * Absent/`false` ⇒ no archive constructed, no event emitted, the loop is
     * byte-for-byte identical to the pre-archive path.
     */
    archive?: boolean
  }
  /**
   * Cursor-style pre-compact HITL hook (ADR-0075). When the proactive
   * compaction path is ABOUT to fire (token threshold crossed AND a
   * summarizable boundary exists), the loop builds a
   * {@link PreCompactRequestQuery} and awaits this callback. Decisions:
   *   - `"approve"` (default when this callback is ABSENT, preserving
   *      byte-identical legacy) — proceed with the compaction;
   *   - `"defer_one_turn"` — skip THIS turn's compaction; the proactive path
   *      will be re-evaluated next turn (the breaker still observes the no-op);
   *   - `"force_now"` — proceed regardless of any host-side deferral logic
   *      (the loop treats it like `approve`; the distinct value is kept so a
   *      UI can record "user explicitly forced it").
   * Errors thrown from the callback are caught and surfaced as an `error`
   * AgentEvent, then the compaction is deferred this turn (fail-safe: never
   * fold history without an answer). Absent ⇒ auto-approve, byte-identical.
   */
  onPreCompact?: (query: PreCompactRequestQuery) => Promise<PreCompactDecision>
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
   * Repo-local rules to inject ahead of memory hints as repo authority (Codex
   * `repo-local-rule-ingestion-audit.md` absorption). Loaded by the caller
   * (e.g. via `loadRepoRules(cwd)`) — the loop does not auto-read so contexts
   * that should NOT adopt workspace rules (bench sandboxes, agent forks) stay
   * byte-identical. Absent ⇒ no repo-rules block.
   */
  repoRules?: RepoRules
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
   */
  subagent?: { maxDepth?: number }
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
   */
  skills?: { dir?: string; changedPaths?: string[] }
  /**
   * Compaction circuit-breaker control (Tier 0 safety hardening, ADR-0011). The
   * breaker is ON by default with `DEFAULT_COMPACTION_BREAKER_CAPS` — it only
   * trips on pathological compaction thrash (≥N consecutive no-progress
   * compactions), so normal flows are unaffected. `disabled:true` opts out;
   * `caps` overrides individual thresholds.
   */
  compactionBreaker?: { disabled?: boolean; caps?: Partial<CompactionBreakerCaps> }
  /**
   * Verify-guard control (Tier 0 safety hardening). Absent ⇒ guard fully OFF and
   * the loop is byte-identical. When present, a finish attempt right after a
   * mutating tool with no test/reproduction since is blocked, forcing one more
   * turn (up to `maxTrips`, default 1 — capped to avoid infinite forcing;
   * lowered from 2 in ADR-0013 변경 이력 per the negative empirical from
   * ADR-0014 — bench callers may still explicitly override).
   */
  verifyGuard?: { maxTrips?: number }
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
   */
  workingState?: { enabled: boolean }
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
}

export type StopReason = "completed" | "max_turns" | "aborted" | "error"

export interface AgentOutcome {
  reason: StopReason
  turns: number
  /** Full transcript including tool results, for resume/inspection. */
  messages: Message[]
  /**
   * Structured stop category (ADR-0063, Spec B3). Optional add-on; when
   * present a surface can render a richer "why" than the 4-element
   * {@link StopReason} can express. Default-OFF (absent on every legacy
   * outcome) ⇒ byte-identical for callers that only read `reason`.
   */
  stopCategory?: StopCategory
}
