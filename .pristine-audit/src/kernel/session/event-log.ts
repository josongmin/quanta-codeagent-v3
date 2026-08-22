import type { SessionEvent } from "@/protocol/session"
import type { KernelEventLogPort } from "./ports"

export class InMemorySessionEventLog implements KernelEventLogPort {
  readonly #events: SessionEvent[] = []

  append(event: SessionEvent): void {
    this.#events.push(event)
  }

  list(): readonly SessionEvent[] {
    return [...this.#events]
  }
}
