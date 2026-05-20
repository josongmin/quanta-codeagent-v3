import type { LLMPort, Message } from "@/llm"
import type { EmbedderPort, PersistentStorePort } from "@/memory"
import type { Metrics } from "@/observability"
import type { PermissionContext, ToolAction } from "@/permission"
import type { RunContext } from "@/shared"
import type { StreamPort } from "@/stream"
import type { ToolRegistry } from "@/tool"
import type { CompactionBreakerCaps } from "./compaction-breaker"
import type { HookBus } from "./hooks"

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
   * Embedding provider for semantic recall + dedup (SOTA++ memory, RFC §6.3).
   * Absent ⇒ recall/consolidation degrade to lexical+tag+freshness only; the
   * loop is otherwise unchanged. Wired by the app layer (OpenAI adapter).
   */
  embedder?: EmbedderPort
  /**
   * Long-term memory tuning (SOTA++ memory, RFC §6.3). Absent ⇒ all defaults;
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
     * Restrict per-turn recall to these tiers (SOTA++ memory, RFC §6.3).
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
     * Dedicated LLM for the compaction SUMMARY turn (SOTA++ cost/latency,
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
   * unchanged.
   */
  planMode?: boolean
  /**
   * Metrics registry (RFC §8 Phase 3). Absent ⇒ no metrics recorded; loop
   * behavior identical.
   */
  metrics?: Metrics
  /**
   * Subagent recursion depth of THIS agent (0 = root user session). Set by
   * the subagent runner for forked children; propagated onto `ToolContext`
   * by the dispatch seam so the `Agent` tool can enforce `maxDepth`. Absent ⇒
   * 0 (root). SOTA++ subagent absorption (ADR-0011).
   */
  depth?: number
  /**
   * Enable the subagent system (SOTA++ Tier 1, ADR-0011). Absent ⇒ the
   * `Agent`/`Task`/`TaskOutput`/`TaskStop` tools are NOT registered and the
   * loop is byte-identical. When present the loop builds a `SubagentRunner`
   * (forked `runAgent`, depth+1, filtered registry) and registers the tools.
   */
  subagent?: { maxDepth?: number }
  /**
   * Enable the skill system (SOTA++ Tier 1, ADR-0011). Absent ⇒ no skill
   * discovery and the `Skill`/`ToolSearch` tools are NOT registered (loop
   * byte-identical). When present, skills are discovered from `dir` at
   * session start and the tools are registered.
   */
  skills?: { dir: string }
  /**
   * Compaction circuit-breaker control (SOTA++ Tier 0 safety, ADR-0011). The
   * breaker is ON by default with `DEFAULT_COMPACTION_BREAKER_CAPS` — it only
   * trips on pathological compaction thrash (≥N consecutive no-progress
   * compactions), so normal flows are unaffected. `disabled:true` opts out;
   * `caps` overrides individual thresholds.
   */
  compactionBreaker?: { disabled?: boolean; caps?: Partial<CompactionBreakerCaps> }
  /**
   * Verify-guard control (SOTA++ Tier 0 safety). Absent ⇒ guard fully OFF and
   * the loop is byte-identical. When present, a finish attempt right after a
   * mutating tool with no test/reproduction since is blocked, forcing one more
   * turn (up to `maxTrips`, default 2 — capped to avoid infinite forcing).
   */
  verifyGuard?: { maxTrips?: number }
  /** Closeout guard (Codex CloseoutLens §4 mirror). Optional, absent ⇒ guard
   *  fully OFF and the loop is byte-identical. When `enabled` true, a single
   *  pre-finish nudge injects the closeout reminder (keep only defended claims,
   *  state if verification not run, separate fact from inference, match
   *  requested reporting shape) once per run. Single-shot by design — no
   *  maxTrips knob (multiple closeout nudges just thrash). */
  closeoutGuard?: { enabled?: boolean }
  /**
   * Correlation context (RFC-0002 §5.1). Absent ⇒ the loop behaves
   * byte-identically (project-standard optional-context pattern, like
   * `metrics?`/`hooks?`). When present the loop maintains a per-turn working
   * copy (the caller's object is never mutated) used purely for trajectory
   * correlation — it never changes control flow, StopReason, emit ordering,
   * or messages.
   */
  run?: RunContext
}

export type StopReason = "completed" | "max_turns" | "aborted" | "error"

export interface AgentOutcome {
  reason: StopReason
  turns: number
  /** Full transcript including tool results, for resume/inspection. */
  messages: Message[]
}
