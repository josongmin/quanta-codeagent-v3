/**
 * §11.5 — interrupted-turn capture + restore (Claude's `INTERRUPTED_TURN`
 * pattern). When ANY abort exit fires mid-flight — the conversation-action
 * `/cancel` verb OR a plain `AbortController.abort()` on the threaded signal
 * (the Ctrl+C / Esc-Esc keystroke cancel the REPL actually hits), at every one
 * of the loop's abort exits — the partial work is CAPTURED into a session-scoped
 * buffer so a later `resume` can restore it — the agent picks up the interrupted
 * task instead of losing it. (ALBB-06 broadened this from the single `/cancel`
 * site to all abort exits via the shared {@link captureAbortedTurn} helper.)
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

/** A single in-flight tool_use summary — ids/names ONLY. ALBB-06 deliberately
 *  drops `input` (the tool args): a resume note only needs to tell the model
 *  WHICH call was in flight, and args can carry secrets / bloat the payload. */
export interface InFlightToolRef {
  readonly id: string
  readonly name: string
}

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
  /** ALBB-06 (Claude Code / Codex baseline) — the tool_use blocks that were
   *  in flight on the last assistant message when the turn was interrupted, so
   *  `resume` can RE-ANCHOR a mid-tool-call turn instead of silently dropping or
   *  double-issuing it. Ids/names ONLY — never the args (no secret leak, no
   *  bloat). Absent/empty ⇒ no tool was in flight (byte-identical text path). */
  readonly inFlightTools?: readonly InFlightToolRef[]
}

/** Concatenate the `text` of a message's text blocks (ignores tool/image/etc.). */
const textOf = (m: Message): string =>
  m.content
    .filter((b): b is { type: "text"; text: string } => b.type === "text")
    .map((b) => b.text)
    .join("")

/** Every `tool_use_id` that a message at or after index `from` ANSWERS with a
 *  `tool_result`. Its own unit because it is a full forward re-scan that used
 *  to sit INSIDE the reverse scan below — two nested loop levels whose surcharge
 *  taxed every branch under them. Scanning only from `from` is load-bearing: a
 *  result can only close a call that came BEFORE it, so an earlier
 *  `tool_result` must never be read as answering a later `tool_use`. */
const answeredToolUseIds = (
  messages: ReadonlyArray<Message>,
  from: number,
): ReadonlySet<string> => {
  const answered = new Set<string>()
  for (let j = from; j < messages.length; j++) {
    const later = messages[j]
    if (later === undefined) continue
    for (const b of later.content) {
      if (b.type === "tool_result") answered.add(b.tool_use_id)
    }
  }
  return answered
}

/** The `tool_use` blocks on ONE message that nothing later answered — ids and
 *  names ONLY. Its own unit because this is the SECRET-SAFETY boundary: the
 *  single place a `tool_use` block is projected, and the projection deliberately
 *  drops `input` (the tool args). */
const unansweredToolUses = (m: Message, answered: ReadonlySet<string>): InFlightToolRef[] => {
  const tools: InFlightToolRef[] = []
  for (const b of m.content) {
    if (b.type === "tool_use" && !answered.has(b.id)) tools.push({ id: b.id, name: b.name })
  }
  return tools
}

/** Extract the in-flight `tool_use` refs (id + name ONLY — no `input`/args) from
 *  the LAST assistant message in the turn. Empty when the turn ended on text or
 *  a non-assistant message.
 *
 *  ALBB-06 P2 fix — a `tool_use` is in flight ONLY if NO later `tool_result`
 *  answers it (correlated by `tool_use_id`). On a turn-boundary signal_abort
 *  (Ctrl+C between turns) the prior turn's tools already COMPLETED and the loop
 *  appended a `{role:"user", content:[tool_result…]}` carrier — so those blocks
 *  are done, NOT in flight. Reporting them would tell the model to re-issue a
 *  landed side-effecting call. A completed tool is excluded; the genuine
 *  mid-tool-call case (tool_use with no result) is byte-identical to before.
 *
 *  This function is now only the REVERSE SCAN — "find the last assistant
 *  message" — with the two inner scans hoisted above.
 *
 *  Pure; NEVER reads the tool args (secret-safe). */
const extractInFlightTools = (messages: ReadonlyArray<Message>): InFlightToolRef[] => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m === undefined || m.role !== "assistant") continue
    // Only messages AFTER this assistant turn can close its calls.
    return unansweredToolUses(m, answeredToolUseIds(messages, i + 1))
  }
  return []
}

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
  const inFlightTools = extractInFlightTools(messages)
  return {
    userText,
    partialAssistantText: partial.join("\n"),
    reason,
    interruptedAt: now,
    // Spread-by-presence: omit the field entirely when no tool was in flight so
    // a text-only interrupted turn is byte-identical to the pre-ALBB-06 shape.
    ...(inFlightTools.length > 0 ? { inFlightTools } : {}),
  }
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

/** Render the "you had a tool call in flight" re-anchor note, or "" when none.
 *  Ids/names ONLY (from {@link InterruptedTurn.inFlightTools}) — no args. */
const inFlightToolNote = (turn: InterruptedTurn): string => {
  const tools = turn.inFlightTools
  if (tools === undefined || tools.length === 0) return ""
  const list = tools.map((t) => `${t.name} (id ${t.id})`).join(", ")
  return (
    `\n\nYou had started a tool call that did not complete: ${list}. ` +
    "Check whether its effect already landed; complete or re-issue it as needed " +
    "rather than silently dropping it."
  )
}

/** Build the user-facing message that re-injects an interrupted turn so the
 *  agent RESUMES it (frames it as a continuation, not a fresh task; appends the
 *  partial progress when there is any, plus an in-flight tool re-anchor note when
 *  a tool call was cut off). Pure. */
export const buildResumeMessage = (turn: InterruptedTurn): string => {
  const head =
    `Resume the previously interrupted task (it was interrupted: ${turn.reason}). ` +
    `The task was:\n${turn.userText}`
  const withPartial =
    turn.partialAssistantText.trim().length === 0
      ? head
      : `${head}\n\nYour partial progress before the interruption:\n${turn.partialAssistantText}`
  return `${withPartial}${inFlightToolNote(turn)}`
}

/** ALBB-06 — the SINGLE shared abort-capture path. Mirrors the historical
 *  `turn-iteration.ts:81` call shape EXACTLY (`cfg.interruptedTurnBuffer?.capture(
 *  captureInterruptedTurn(wm.snapshot(), reason, Date.now()))`) so `/cancel` and
 *  the two signal-driven abort exits share ONE code path — no logic drift.
 *
 *  Default-OFF byte-identical: no `interruptedTurnBuffer` wired ⇒ `?.capture` is
 *  a no-op (no allocation beyond the snapshot the caller already has). NEVER
 *  throws (capture is pure; the buffer's `capture` is a plain slot write). The
 *  `cfg`/`wm` are STRUCTURAL (not `AgentConfig`/`WorkingMemory`) so this leaf
 *  module stays decoupled from `@/agent` types and the `@/memory` slice. */
export const captureAbortedTurn = (
  cfg: { readonly interruptedTurnBuffer?: InterruptedTurnBuffer },
  wm: { snapshot(): ReadonlyArray<Message> },
  reason: string,
  // Injected clock so the persisted `interruptedAt` (a replay-compared sort key
  // in session/crash-resume.ts) is pinnable under test/replay — same
  // `(now ?? Date.now)()` seam as the sibling runner/orchestrate/crash-resume-wire.ts.
  // Default `Date.now` keeps production byte-identical.
  now: () => number = Date.now,
): void => {
  cfg.interruptedTurnBuffer?.capture(captureInterruptedTurn(wm.snapshot(), reason, now()))
}
