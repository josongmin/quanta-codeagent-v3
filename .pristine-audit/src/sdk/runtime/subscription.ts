import type { SessionEvent } from "@/protocol/session"

export class SessionSubscriptionHub {
  readonly #listeners = new Set<(event: SessionEvent) => void>()

  subscribe(listener: (event: SessionEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  publish(event: SessionEvent): void {
    for (const listener of this.#listeners) listener(event)
  }
}
