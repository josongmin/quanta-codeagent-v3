import type { LLMPort, Message } from "@/llm"
import type { EmbedderPort, PersistentStorePort } from "@/memory"
import type { Metrics } from "@/observability"
import type { PermissionContext, ToolAction } from "@/permission"
import type { RunContext } from "@/shared"
import type { StreamPort } from "@/stream"
import type { ToolRegistry } from "@/tool"
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
