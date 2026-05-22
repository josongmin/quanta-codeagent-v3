import type { LLMPort, Message, ModelCandidate } from "@/llm"
import type { EmbedderPort, PersistentStorePort } from "@/memory"
import type { Metrics, TurnTiming } from "@/observability"
import type {
  PatternGrantStore,
  PermissionContext,
  ToolAction,
  TrustScopeRegistry,
} from "@/permission"
import type { RunContext } from "@/shared"
import type { RedactionConfig, RedactionKind, RedactionOrigin } from "@/security"
import type { StreamPort } from "@/stream"
import type { ToolRegistry } from "@/tool"
import type { BudgetMeter } from "./budget"
import type { CompactionBreakerCaps } from "./compaction-breaker"
import type { ConfirmDecision } from "./confirm-decision"
import type { DedupGate, DedupGateCaps } from "./dispatch-dedup"
import type { HandoffRequiredEvent } from "./hitl-tier"
import type { HookBus } from "./hooks"
import type { IdeContextProvider } from "./ide-context"
import type { PlanExitPort } from "./plan-exit-flow"
import type { AgentMode } from "./prompt"
import type { RepoRules } from "./repo-rules"
import type { ModePolicy } from "./run-mode"
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

// AgentConfig `extends` the three cohesion groups defined at the BOTTOM of
// this file (SafetyConfig / PermissionExtrasConfig / SteeringConfig).
// Declaration-merging keeps every field shape byte-identical to consumers;
// the inheritance documents the grouping and lets each subsystem take a
// narrow slice as its parameter type (audit #1).
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
   * RFC may-22-unified-agent-runtime / Phase 0 — mode policy slot.
   *
   * The 12-lever discriminated-union vector for this run (interactive /
   * headless / batch / ci-bot). Absent ⇒ no mode policy is consulted and the
   * loop is byte-for-byte identical to the pre-RFC path (default-OFF
   * RFC §1.2 / byte-identical contract). Wired by `apps/agent/assemble.ts`
   * (Phase 4); the loop itself never reads this directly today.
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
}

/**
 * Aggregated redaction counts surfaced on {@link AgentOutcome}. Per-hit
 * detail (span / placeholder / origin file) lives in the on-disk JSONL
 * envelope; the outcome carries the rollup so a host can render "N
 * secrets hidden" without scanning the trajectory.
 */
export interface RedactionRollup {
  readonly origin: RedactionOrigin
  readonly kind: RedactionKind
  readonly count: number
}

export type StopReason =
  | "completed"
  | "max_turns"
  | "aborted"
  | "error"
  | "budget_exhausted" /* RFC may-22 — BudgetMeter cap hit before completion */

/**
 * memory_citation provenance surface (ADR-0082). A record is "cited" iff it
 * was actually placed into the prompt window for some turn of the run —
 * provenance, NOT a heuristic match of the assistant's response text.
 *
 * Closed `where` enum encodes the placement seam:
 *   - `system_prompt`         — folded into the static system prompt body.
 *   - `reminder_tail`         — appended into the per-turn trailing
 *                               `<system-reminder>` user message (the only
 *                               site quanta currently renders recall blocks,
 *                               so this is the value most citations carry).
 *   - `tool_result_injection` — wrapped into a synthetic `tool_result`
 *                               observation. Reserved for the seam; no
 *                               builder writes this value today.
 *
 * The signal is ALWAYS captured when the memory subsystem is wired (no opt-in
 * flag); the surface is the optional `AgentOutcome.memoryCitations` array.
 * With no memory recall (store absent or no entries placed) the array is
 * empty and the field is OMITTED from the outcome — byte-identical for
 * callers that ignore it.
 */
export interface MemoryCitation {
  /** Stable id of the placed memory record (matches `MemoryEntry.id`). */
  readonly recordId: string
  /** Recall score that placed the record in the prompt window. The exact
   *  weighted-sum value `rankEntries` computed; comparable across citations
   *  in the SAME turn (score scale depends on query, so cross-turn comparison
   *  is informational only). */
  readonly score: number
  /** Closed enum — where the record was rendered into the prompt window. */
  readonly where: "system_prompt" | "reminder_tail" | "tool_result_injection"
  /** Approximate token cost of the record's text contribution to the prompt
   *  (chars/4 heuristic, the same estimator the rest of the loop uses).
   *  Omitted when the prompt assembler could not size the contribution. */
  readonly tokensApprox?: number
}

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
  /**
   * memory_citation provenance surface (ADR-0082). Append-only across the
   * run: every time a recall block lands in the prompt window for some turn,
   * one {@link MemoryCitation} per placed record is appended (dedup is NOT
   * applied — a record placed across N turns surfaces N citations, so a
   * trajectory consumer can see "this record was anchored for N turns"). The
   * field is OMITTED when no citations were captured (no store wired, or no
   * recall hits across the whole run) — byte-identical for callers that
   * only read `reason`.
   */
  memoryCitations?: ReadonlyArray<MemoryCitation>
  /**
   * ADR-0077 TTFT trio — wall-clock anchors of the LAST sampling-request of
   * the run (the one that produced the final assistant message). Absent on
   * runs that never opened a stream (e.g. immediate abort) ⇒ byte-identical
   * for callers that only read `reason`. Captured by
   * `createTurnTimingCapture` and threaded through the loop's per-turn
   * sampling-request seam.
   */
  turnTiming?: TurnTiming
  /**
   * Aggregated secret-redaction hit counts (ADR-0078). Present whenever
   * redaction is enabled AND at least one hit fired during the run.
   * Absent ⇒ either no hits OR the layer is opt-out disabled. The host
   * may render the rollup as "N secrets hidden" without scanning the
   * trajectory. Per-hit detail (`RedactionHit`) lives in the JSONL
   * envelope. Closed enum keys keep the rollup audit-stable.
   */
  redactions?: ReadonlyArray<RedactionRollup>
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
  compactionBreaker?: { disabled?: boolean; caps?: Partial<CompactionBreakerCaps> }
  verifyGuard?: { maxTrips?: number }
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

