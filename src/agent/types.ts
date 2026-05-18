import type { LLMPort, Message } from "@/llm"
import type { PersistentStorePort } from "@/memory"
import type { Metrics } from "@/observability"
import type { PermissionContext, ToolAction } from "@/permission"
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
}

export type StopReason = "completed" | "max_turns" | "aborted" | "error"

export interface AgentOutcome {
  reason: StopReason
  turns: number
  /** Full transcript including tool results, for resume/inspection. */
  messages: Message[]
}
