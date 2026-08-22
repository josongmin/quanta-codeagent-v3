import type { AgentEvent } from "./types"

export interface StreamPort {
  emit(event: AgentEvent): void
}
