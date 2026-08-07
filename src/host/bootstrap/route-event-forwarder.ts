import { errMessage, logger, runtimeConfigFromEnv } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"

/** RFC02-3 (A8) — build the PRODUCTION route sink forwarder + its late-bind
 *  hook, gated by `QUANTA_MODEL_REROUTE_EVENT`. The LLM stack is built BEFORE the
 *  stream exists, so we hand `deps.buildLlm` a forwarder that closes over a
 *  mutable target (a single deferred pointer — NOT a bus/store: it holds ZERO
 *  events, only the eventual `emit`). `bindRouteEventTarget` sets that target to
 *  the live `stream.emit` once `buildStreaming` has run. A transition that fires
 *  before the bind (there is none — the first turn streams after bootstrap
 *  completes) is dropped by the no-op default target. Gate OFF ⇒ returns
 *  `undefined` for BOTH ⇒ no sink reaches `FallbackLLM` (byte-identical). */
export const buildRouteEventForwarder = (
  env: NodeJS.ProcessEnv,
): {
  readonly sink: ((ev: AgentEvent) => void) | undefined
  readonly bind: ((emit: (ev: AgentEvent) => void) => void) | undefined
} => {
  if (!runtimeConfigFromEnv(env).modelRerouteEvent) return { sink: undefined, bind: undefined }
  // Deferred target — defaults to a no-op until the stream is bound.
  let target: (ev: AgentEvent) => void = () => {}
  return {
    // RFC02-3 (A8, feeder) — the sink SWALLOWS a throwing bound target itself.
    // FallbackLLM guards `onTransition`, but the `/retry-with` + scheduler feeders
    // call `onModelReroute` DIRECTLY, so a throwing `stream.emit` would propagate
    // into the operator swap / scheduler fire. Isolating here makes the ONE shared
    // sink safe for ALL THREE causes (observability never breaks its subject).
    sink: (ev: AgentEvent): void => {
      try {
        target(ev)
      } catch (e) {
        // best-effort: a bound-target throw is dropped (observability never
        // breaks its subject), but ATTRIBUTED — a throwing sink is a real defect,
        // just a non-fatal one, so surface it at warn (never stranded work).
        logger.warn(`route-event-forwarder: bound target threw: ${errMessage(e)}`)
      }
    },
    bind: (emit: (ev: AgentEvent) => void): void => {
      target = emit
    },
  }
}

/** RFC02-3 (A8) — bind the deferred route sink forwarder to the live stream's
 *  `emit` once the stream exists. No-op when the forwarder was not built (gate
 *  OFF ⇒ `bind` is undefined ⇒ byte-identical). The `stream.emit` is wrapped in a
 *  stable arrow so the sink closure survives across turns. */
export const bindRouteSinkToStream = (
  bind: ((emit: (ev: AgentEvent) => void) => void) | undefined,
  stream: StreamPort,
): void => {
  bind?.((ev) => {
    stream.emit(ev)
  })
}
