import type { LLMPort, Message } from "@/llm"
import type { EmbedderPort, PersistentStorePort } from "@/memory"
import type { Metrics } from "@/observability"
import type { PermissionContext, ToolAction, TrustScopeRegistry } from "@/permission"
import type { RunContext } from "@/shared"
import type { StreamPort } from "@/stream"
import type { ToolRegistry } from "@/tool"
import type { CompactionBreakerCaps } from "./compaction-breaker"
import type { HookBus } from "./hooks"
import type { AgentMode } from "./prompt"
import type { RepoRules } from "./repo-rules"

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
  }
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
   * byte-identical). When present, skills are discovered from `dir` at
   * session start and the tools are registered.
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
  skills?: { dir: string; changedPaths?: string[] }
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
   * Trust-scope registry (Phase C wire-up, ADR-0050). When set, the
   * admissibility-gate's ask-branch consults `registry.hasGrant(projectKey,
   * { tool })` BEFORE invoking `onConfirm`. A positive grant skips the prompt
   * and admits the call; `once_only` grants are consumed inline by the
   * registry. Absent ⇒ no registry lookup; the gate path is byte-identical
   * to the pre-Phase-C behavior (DEFAULT OFF, opt-in). The slice rule keeps
   * the registry impl in `@/permission`; this type-import is the only seam.
   */
  trustScope?: { registry: TrustScopeRegistry; projectKey: string }
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
}

export type StopReason = "completed" | "max_turns" | "aborted" | "error"

export interface AgentOutcome {
  reason: StopReason
  turns: number
  /** Full transcript including tool results, for resume/inspection. */
  messages: Message[]
}
