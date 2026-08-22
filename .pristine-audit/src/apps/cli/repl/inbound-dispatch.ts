/**
 * Inbound dispatch — execute a pure {@link InboundDecision} (from
 * `routeInbound`, `@/agent/inbound-mode`) against the CLI's three side-effect
 * sinks, returning a human ack the surface renders. Pure aside from the injected
 * sinks (testable with fakes).
 *
 * Channel map (reuses the EXISTING wired seams):
 *   - queue / queue_fallback → `enqueue` (the `externalPromptQueue.push`) ⇒ runs
 *     as the next turn. A fallback is a weave/interrupt that could not apply mid-
 *     turn — still enqueued so the message is NEVER lost.
 *   - weave → `weave` (the conversation-action `pushUserMessage`) ⇒ injected into
 *     the current turn by the loop's `decideAction`/§steer poll.
 *   - interrupt → `interrupt` (the conversation-action `pushCancel`) to abort the
 *     active turn, THEN `enqueue` the replacement text so it runs as the fresh
 *     turn right after the abort unwinds (overwrite-and-restart).
 *   - rejected → nothing (empty / oversized input).
 */

import { type InboundDecision, type InboundMode, routeInbound } from "@/agent/inbound-mode"
import type { ActiveTurnState, SteerConfig } from "@/agent/steering"
import type { ConversationActionSurface } from "./conversation-action-surface"

export interface InboundSinks {
  /** Enqueue text to run as the next turn (`externalPromptQueue.push`). */
  readonly enqueue: (text: string) => void
  /** Inject text into the current turn (`conversationActionSurface.pushUserMessage`). */
  readonly weave: (input: string) => void
  /** Abort the active turn (`conversationActionSurface.pushCancel`). */
  readonly interrupt: (reason: string) => void
}

export type InboundAckKind = "queued" | "woven" | "interrupting" | "queued_fallback" | "ignored"

export interface InboundAck {
  readonly kind: InboundAckKind
  /** Human one-liner for the surface to render inline. */
  readonly message: string
}

/** Reason text for the interrupt's `pushCancel` (non-empty — `decideAction`
 *  throws on an empty cancel reason). */
const INTERRUPT_REASON = "user barge-in (interrupt mode): restarting with a new message"

export const dispatchInbound = (decision: InboundDecision, sinks: InboundSinks): InboundAck => {
  switch (decision.kind) {
    case "queue":
      sinks.enqueue(decision.text)
      return { kind: "queued", message: "⤷ queued — runs after the current turn" }
    case "weave":
      sinks.weave(decision.injection.content)
      return { kind: "woven", message: "⤷ woven into the current turn" }
    case "interrupt":
      // Abort FIRST, then queue the replacement so it runs as the next turn the
      // moment the abort unwinds.
      sinks.interrupt(INTERRUPT_REASON)
      sinks.enqueue(decision.text)
      return { kind: "interrupting", message: "⤷ interrupting — restarting with your message" }
    case "queue_fallback":
      sinks.enqueue(decision.text)
      return {
        kind: "queued_fallback",
        message: `⤷ queued (could not ${decision.from} now: ${decision.reason})`,
      }
    case "rejected":
      return { kind: "ignored", message: `(ignored: ${decision.reason})` }
  }
}

/** End-to-end handling of ONE mid-turn line: pure-decide ({@link routeInbound})
 *  then execute ({@link dispatchInbound}). The session loop's in-turn reader
 *  calls this with the live mode + turn snapshot + sinks and renders the ack.
 *  Pure aside from the injected sinks. */
export const handleInboundLine = (args: {
  readonly line: string
  readonly mode: InboundMode
  readonly state: ActiveTurnState
  readonly config: SteerConfig
  readonly now: number
  readonly sinks: InboundSinks
}): InboundAck =>
  dispatchInbound(
    routeInbound({
      mode: args.mode,
      input: args.line,
      state: args.state,
      config: args.config,
      now: args.now,
    }),
    args.sinks,
  )

export interface MidTurnLineDeps {
  /** The live inbound delivery mode (read per line — `/inbound` may mutate it). */
  readonly mode: InboundMode
  /** The conversation-action surface for weave/interrupt. Absent ⇒ every mode
   *  degrades to the queue capture path (byte-identical). */
  readonly surface: ConversationActionSurface | undefined
  /** The existing queue path (plan-queue capture + next-turn drain). Used for
   *  `queue` mode AND whenever `surface` is absent. */
  readonly captureLine: (line: string) => void
  /** `externalPromptQueue.push` — the next-turn drain (weave/interrupt fallbacks
   *  + the interrupt replacement land here). */
  readonly enqueue: (text: string) => void
  /** §steer `maxInputBytes` ceiling for one mid-turn line. */
  readonly maxInputBytes: number
  /** Injected clock (the CLI passes `() => Date.now()`). */
  readonly now: () => number
}

/** Route ONE mid-turn line by mode — the tested core of the session loop's
 *  in-turn `onLine` handler. `queue` (default) OR no surface ⇒ the existing
 *  capture path (byte-identical). weave/interrupt ⇒ decide+dispatch against the
 *  live turn snapshot via {@link handleInboundLine}. Returns the {@link InboundAck}
 *  (the caller renders or discards it); the capture path returns a `queued` ack. */
export const routeMidTurnLine = (line: string, deps: MidTurnLineDeps): InboundAck => {
  const surface = deps.surface
  if (deps.mode === "queue" || surface === undefined) {
    deps.captureLine(line)
    return { kind: "queued", message: "⤷ queued — runs after the current turn" }
  }
  return handleInboundLine({
    line,
    mode: deps.mode,
    state: surface.activeTurnRef.current,
    config: { maxInputBytes: deps.maxInputBytes },
    now: deps.now(),
    sinks: {
      enqueue: deps.enqueue,
      weave: (t) => surface.pushUserMessage(t),
      interrupt: (r) => surface.pushCancel(r),
    },
  })
}
