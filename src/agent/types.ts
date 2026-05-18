import type { LLMPort, Message } from "@/llm"
import type { PermissionContext, ToolAction } from "@/permission"
import type { StreamPort } from "@/stream"
import type { ToolRegistry } from "@/tool"

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
}

export type StopReason = "completed" | "max_turns" | "aborted" | "error"

export interface AgentOutcome {
  reason: StopReason
  turns: number
  /** Full transcript including tool results, for resume/inspection. */
  messages: Message[]
}
