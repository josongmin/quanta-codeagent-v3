/**
 * §11.5 — interrupted-turn capture + restore (Claude's `INTERRUPTED_TURN`
 * pattern). When `interrupt` mode (or `/cancel`) aborts a turn mid-flight, the
 * partial work is CAPTURED into a session-scoped buffer so a later `resume` can
 * restore it — the agent picks up the interrupted task instead of losing it.
 *
 * The buffer's PRESENCE is the session-level "interrupted" signal (a single
 * slot, last-interrupt-wins). This deliberately sidesteps `steering.ts`'s
 * per-turn `isInterrupted` flag (which resets at every turn boundary and so
 * could never gate a cross-turn resume): `resume` consults the BUFFER, not the
 * transient flag.
 *
 * Pure: capture extracts text from a message list (no I/O / clock); the clock is
 * injected by the caller. NEVER throws.
 */

import type { Message } from "@/llm"

/** One captured interrupted turn. */
export interface InterruptedTurn {
  /** The user prompt that started the interrupted turn (last user message). */
  readonly userText: string
  /** Assistant text produced before the interrupt (partial progress). */
  readonly partialAssistantText: string
  /** Why it was interrupted (the cancel/interrupt reason). */
  readonly reason: string
  /** Injected wall-clock ms at interrupt time. */
  readonly interruptedAt: number
}

/** Concatenate the `text` of a message's text blocks (ignores tool/image/etc.). */
const textOf = (m: Message): string =>
  m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")

/**
 * Capture the interrupted turn from the working-memory message list. The
 * originating prompt is the LAST `user` message with NON-EMPTY text — after a
 * tools turn the loop appends a `{role:"user", content:[tool_result…]}` message
 * whose `textOf` is "" (turn-outcome.ts); picking that as the prompt silently
 * loses the task, so those pure tool_result carriers are skipped. The partial
 * progress is the concatenation of every `assistant` message AFTER the chosen
 * user message. Defensive: no user text ⇒ empty `userText`; no assistant work ⇒
 * empty `partialAssistantText`.
 */
export const captureInterruptedTurn = (
  messages: ReadonlyArray<Message>,
  reason: string,
  now: number,
): InterruptedTurn => {
  let lastUserIdx = -1
  let userText = ""
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role !== "user") continue
    const t = textOf(messages[i] as Message)
    // Skip pure tool_result carrier messages AND whitespace-only user turns — a
    // blank/steer-injected user message must not shadow the real earlier prompt
    // (else `buildResumeMessage` emits a blank task body, the same loss the fix
    // targets). Mirrors the `.trim()` gate `buildResumeMessage` uses for partials.
    if (t.trim().length === 0) continue
    lastUserIdx = i
    userText = t
    break
  }
  const partial: string[] = []
  for (let i = lastUserIdx + 1; i < messages.length; i++) {
    const m = messages[i] as Message
    if (m.role === "assistant") {
      const t = textOf(m)
      if (t.length > 0) partial.push(t)
    }
  }
  return { userText, partialAssistantText: partial.join("\n"), reason, interruptedAt: now }
}

/** Session-scoped single-slot buffer holding the most-recent interrupted turn.
 *  Presence == "there is an interrupted turn to resume". */
export interface InterruptedTurnBuffer {
  /** Store a captured turn (overwrites any prior — last-interrupt-wins). */
  capture(turn: InterruptedTurn): void
  /** The held turn WITHOUT consuming it (status), or `null`. */
  peek(): InterruptedTurn | null
  /** The held turn AND clear it (resume consumes), or `null` when empty. */
  take(): InterruptedTurn | null
  /** True iff a turn is held (the session-level interrupted signal). */
  has(): boolean
  /** Drop the held turn (e.g. the interrupted task was abandoned). */
  clear(): void
}

export const createInterruptedTurnBuffer = (): InterruptedTurnBuffer => {
  let slot: InterruptedTurn | null = null
  return {
    capture(turn: InterruptedTurn): void {
      slot = turn
    },
    peek: () => slot,
    take(): InterruptedTurn | null {
      const t = slot
      slot = null
      return t
    },
    has: () => slot !== null,
    clear(): void {
      slot = null
    },
  }
}

/** Build the user-facing message that re-injects an interrupted turn so the
 *  agent RESUMES it (frames it as a continuation, not a fresh task; appends the
 *  partial progress when there is any). Pure. */
export const buildResumeMessage = (turn: InterruptedTurn): string => {
  const head =
    `Resume the previously interrupted task (it was interrupted: ${turn.reason}). ` +
    `The task was:\n${turn.userText}`
  if (turn.partialAssistantText.trim().length === 0) return head
  return `${head}\n\nYour partial progress before the interruption:\n${turn.partialAssistantText}`
}
