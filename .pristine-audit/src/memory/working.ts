import type { StoredMessage } from "./types"

/**
 * In-session message buffer (RFC §6.3). Generic over the message shape so the
 * agent layer can use `WorkingMemory<Message>` (from @/llm) for full typing
 * while this slice stays free of an @/llm import — the llm `Message` is
 * structurally assignable to {@link StoredMessage} (see types.ts comment).
 */
export interface WorkingMemory<M = StoredMessage> {
  /** Mutable backing buffer. Prefer {@link WorkingMemory.snapshot} for reads. */
  messages: M[]
  append(message: M): void
  /**
   * Read-only view of the current buffer.
   *
   * **Shallow copy by design** (R-Phase4 P3-3 clarification): the returned
   * array is a fresh allocation (so a caller can `.reverse()` / `.filter()`
   * without mutating the buffer), but the message OBJECTS inside it are SHARED
   * with the buffer. The agent loop and tool surface treat `Message` values as
   * structurally immutable (every mutation produces a new value and uses
   * `wm.append` / `wm.replace`), so the shallow copy is safe; a defensive
   * deep-copy on every snapshot would be wasted work.
   *
   * NOTE: this is intentionally distinct from `WorkingState.snapshot`
   * (`src/agent/working-state.ts:117`), which DOES deep-copy because its
   * payload (`ownerShortlist`, `blockers`, etc.) is intended to be mutated by
   * the host without aliasing the live state. The two surfaces have different
   * contracts — don't conflate them.
   */
  snapshot(): readonly M[]
  /** Drop all messages. */
  clear(): void
  /** Replace the entire buffer (defensively copied). */
  replace(messages: M[]): void
  /**
   * Cheap token estimate (chars / 4 heuristic) over JSON-serialized messages,
   * for later compaction decisions. Not a real tokenizer.
   */
  tokenEstimate(): number
}

/** Chars-per-token heuristic divisor. */
const CHARS_PER_TOKEN = 4

class WorkingMemoryImpl<M = StoredMessage> implements WorkingMemory<M> {
  messages: M[]

  constructor(initial: readonly M[] = []) {
    this.messages = [...initial]
  }

  append(message: M): void {
    this.messages.push(message)
  }

  snapshot(): readonly M[] {
    return [...this.messages]
  }

  clear(): void {
    this.messages = []
  }

  replace(messages: M[]): void {
    this.messages = [...messages]
  }

  tokenEstimate(): number {
    let chars = 0
    for (const m of this.messages) {
      // JSON.stringify can throw on circular refs; messages are plain data.
      chars += JSON.stringify(m)?.length ?? 0
    }
    return Math.ceil(chars / CHARS_PER_TOKEN)
  }
}

/** Construct an empty (or seeded) {@link WorkingMemory}. */
export const createWorkingMemory = <M = StoredMessage>(
  initial: readonly M[] = [],
): WorkingMemory<M> => new WorkingMemoryImpl<M>(initial)
