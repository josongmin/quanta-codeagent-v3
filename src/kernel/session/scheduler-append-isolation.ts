import type { SessionEvent } from "@/protocol/session"
import { errMessage } from "@/shared"
import { writeStderr } from "@/shared/terminal-io"
import type { KernelCommittedEvents, KernelDispatchContext } from "./ports"

/**
 * Kernel dispatch PERSISTENCE + OBSERVER isolation.
 *
 * ONE responsibility: keep a side-effect failure — an `onCommitted` observer
 * throw, or an `eventLog.append` rejection — from redefining a turn's outcome.
 * It owns the three symmetric no-throw diagnostic sinks (observer / stream
 * append / TERMINAL append), their process-global failure counters, and the
 * three append+notify primitives every dispatch arm writes through
 * (`appendEvents`, `appendTerminalEvents`, `notifyCommitted`).
 *
 * The sinks and the counters they arm are ONE unit of module-private mutable
 * state, which is why they live together here rather than beside their call
 * sites: `recordStreamAppendFailure` is the seam `runTurn`'s per-event catch
 * uses so the counter has exactly one home (its two statements moved verbatim
 * out of that catch).
 *
 * Split out of `scheduler.ts` (god-module ratchet) — pure move, no logic change.
 */
/**
 * T03 (audit L5 M-5) — observer no-throw sink. `onCommitted` is a persistence /
 * subscriber notification; a throw from it is DIAGNOSTIC and must NEVER be
 * mistaken for a turn failure. We isolate the call so its rejection cannot
 * bubble into the turn try/catch that classifies terminal outcome. There is no
 * silent swallow: the error is surfaced via the kernel-global observer-error
 * sink (defaulting to the ADR-0303 injected `writeStderr` terminal sink) so it
 * stays visible without redefining turn success/failure.
 */
let observerErrorSink: (error: unknown) => void = (error) => {
  // Documented diagnostic surface — routed through the ADR-0303 injected terminal
  // sink (default NOOP) so this kernel module owns no raw terminal; overridable
  // via `setKernelObserverErrorSink` to route into structured telemetry.
  const detail = error instanceof Error ? (error.stack ?? error.message) : errMessage(error)
  writeStderr(
    `[kernel.session] onCommitted observer threw (diagnostic, not a turn failure): ${detail}\n`,
  )
}

/** Override the observer-error sink (e.g. to route into structured telemetry).
 *  Returns the previous sink so callers can restore it. */
export const setKernelObserverErrorSink = (
  sink: (error: unknown) => void,
): ((error: unknown) => void) => {
  const previous = observerErrorSink
  observerErrorSink = sink
  return previous
}

/**
 * ALBB-04 — stream-append-error sink, SYMMETRIC with {@link observerErrorSink}.
 * An `eventLog.append` failure while persisting a per-turn STREAM event is a
 * persistence-only fault: it must NOT (a) poison the chained-promise stream so
 * later stream events are silently dropped, nor (b) reclassify a
 * host-successful turn as `turn.failed`. Instead the error is routed HERE
 * (diagnostic, no-throw) and the chain CONTINUES so a later event still attempts
 * its append — exactly how `notifyCommitted` already isolates observer throws.
 * The only new observable is the monotonic `streamAppendFailures` counter
 * (measure-first — diagnostic, never a gate).
 */
let streamAppendErrorSink: (error: unknown) => void = (error) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : errMessage(error)
  writeStderr(
    `[kernel.session] stream eventLog.append rejected (diagnostic, not a turn failure): ${detail}\n`,
  )
}

/** Override the stream-append-error sink (e.g. to route into structured
 *  telemetry). Returns the previous sink so callers can restore it. */
export const setKernelStreamAppendErrorSink = (
  sink: (error: unknown) => void,
): ((error: unknown) => void) => {
  const previous = streamAppendErrorSink
  streamAppendErrorSink = sink
  return previous
}

/** Monotonic count of stream `eventLog.append` rejections isolated by the
 *  per-event try/catch in `runTurn` (ALBB-04). Diagnostic-only, process-global;
 *  exposed for measurement, NOT consulted by any control-flow gate. */
let streamAppendFailures = 0

/** Read the current process-global stream-append failure count (ALBB-04). */
export const getKernelStreamAppendFailures = (): number => streamAppendFailures

/**
 * B1 (jul-18 release-blocker) — TERMINAL-append-error sink, SYMMETRIC with
 * {@link streamAppendErrorSink}. ALBB-04 isolated the per-turn STREAM append
 * path, but the TERMINAL append (`turn.completed` / `turn.aborted` /
 * `turn.failed` + their trailing `session.state.updated`) was still a bare
 * `await appendEvents(...)`: a durable-log ENOSPC / read-only-dir throw there
 * propagated out of the terminal handler → out of `dispatchSessionCommand`
 * BEFORE the engine ever published the terminal events. The turn's LLM cost was
 * already spent, yet no terminal event reached the subscriber/bridge, so a wire
 * client's `awaitTurnEnd()` hung forever and the completed turn was silently
 * lost.
 *
 * The INVARIANT this restores: a turn's terminal event MUST reach the
 * subscriber/bridge regardless of persistence success — persistence is a
 * side-effect, never the gate on delivery. So the terminal append is routed
 * HERE (diagnostic, no-throw) and the handler CONTINUES to RETURN its events,
 * which the engine then publishes via `publishPendingEvents`; `awaitTurnEnd`
 * always settles. The failure is NOT swallowed: it is surfaced on this sink
 * (default `writeStderr`) AND counted (`terminalAppendFailures`) so an operator
 * knows persistence degraded. Only durable logs can throw here — the default
 * InMemory log never does, so the default path is byte-identical.
 */
let terminalAppendErrorSink: (error: unknown) => void = (error) => {
  const detail = error instanceof Error ? (error.stack ?? error.message) : errMessage(error)
  writeStderr(
    `[kernel.session] terminal eventLog.append rejected (diagnostic — terminal event still delivered to subscribers so awaitTurnEnd settles; persistence DEGRADED): ${detail}\n`,
  )
}

/** Override the terminal-append-error sink (e.g. to route into structured
 *  telemetry). Returns the previous sink so callers can restore it. */
export const setKernelTerminalAppendErrorSink = (
  sink: (error: unknown) => void,
): ((error: unknown) => void) => {
  const previous = terminalAppendErrorSink
  terminalAppendErrorSink = sink
  return previous
}

/** Monotonic count of TERMINAL `eventLog.append` rejections isolated by
 *  {@link appendTerminalEvents} (B1). Diagnostic-only, process-global; exposed
 *  for measurement, NOT consulted by any control-flow gate. */
let terminalAppendFailures = 0

/** Read the current process-global terminal-append failure count (B1). */
export const getKernelTerminalAppendFailures = (): number => terminalAppendFailures

export const notifyCommitted = async (
  ctx: KernelDispatchContext,
  args: KernelCommittedEvents,
): Promise<void> => {
  if (ctx.onCommitted === undefined) return
  try {
    await ctx.onCommitted(args)
  } catch (error) {
    observerErrorSink(error)
  }
}

export const appendEvents = async (
  eventLog: KernelDispatchContext["eventLog"],
  events: readonly SessionEvent[],
): Promise<void> => {
  for (const event of events) await eventLog.append(event)
}

/**
 * B1 — isolate the TERMINAL persistence write. A terminal turn event
 * (`turn.completed` / `turn.aborted` / `turn.failed` and their trailing
 * `session.state.updated`) MUST be RETURNED (and thus published to the
 * subscriber/bridge by the engine's `publishPendingEvents`) even if the durable
 * event-log `append` rejects — otherwise the turn (whose LLM cost was already
 * spent) is silently lost and a wire client's `awaitTurnEnd()` hangs forever.
 *
 * This wraps {@link appendEvents} so a persistence throw is routed to the
 * no-throw {@link terminalAppendErrorSink} (default stderr) + counted, and the
 * caller CONTINUES to its `return`. It NEVER swallows silently and it NEVER
 * reclassifies the terminal — the turn's outcome was already decided upstream;
 * persistence is a side-effect, not the gate on delivery. Symmetric with the
 * per-stream-event isolation `runTurn` already applies (ALBB-04).
 */
export const appendTerminalEvents = async (
  eventLog: KernelDispatchContext["eventLog"],
  events: readonly SessionEvent[],
): Promise<void> => {
  try {
    await appendEvents(eventLog, events)
  } catch (error) {
    terminalAppendFailures += 1
    terminalAppendErrorSink(error)
  }
}

/**
 * ALBB-04 — the `runTurn` per-stream-event catch's settle, extracted VERBATIM
 * so {@link streamAppendFailures} (module-private, alongside the sink it arms)
 * keeps a single home. Count the isolated rejection, then surface it on the
 * no-throw diagnostic sink; the caller's chain continues, exactly as before.
 */
export const recordStreamAppendFailure = (error: unknown): void => {
  streamAppendFailures += 1
  streamAppendErrorSink(error)
}
