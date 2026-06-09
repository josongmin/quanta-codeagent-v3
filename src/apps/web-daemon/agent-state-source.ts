/**
 * QUANTA_WEB_AGENT_STATE — agent-state source (web-daemon side).
 *
 * The out-of-band stream tap (`wireAgentStateTap`, `@/agent/optional-ports`)
 * wraps `config.stream.emit` so each of the 9 agent-state events is ALSO handed
 * to an `AgentStateSink` AFTER the base stream emits it verbatim. This source is
 * the daemon-side concrete sink: the composition root wires its `sink` into
 * `AgentConfig.onAgentState`, and every WS connection subscribes so its
 * forwarder ships an `agentState` frame.
 *
 * NO replay: an agent-state event is a point-in-time observation (a plan delta,
 * a mode flip, a progress line). A fresh connection renders agent-state from the
 * next event forward — it does NOT replay history (same posture as the canvas
 * tool-diff source; unlike the usage source there is no `latest()`).
 *
 * Default-OFF: the composition root only constructs this when
 * `QUANTA_WEB_AGENT_STATE=1`. Absent that, `onAgentState` is never wired ⇒ the
 * stream tap is never installed ⇒ no event is captured ⇒ no `agentState` frame
 * ⇒ chat UI unchanged, byte-identical.
 *
 * Slice fence: this module lives in `@/apps/web-daemon` and references only the
 * `@/protocol/agent-state` codec shapes (`AgentStateObservation`); it never
 * imports `@/agent/loop` or `@/apps/cli`. The `@/agent` slice never imports this
 * — the composition root is the only bridge.
 */

import type { AgentStateObservation } from "@/protocol/agent-state"

export interface AgentStateSourceHandle {
  /** Wire into `AgentConfig.onAgentState`. Fans the capture out to subscribers. */
  readonly sink: { capture(event: AgentStateObservation): void }
  /** Subscribe to subsequent captures. Returns an unsubscribe closure. */
  readonly subscribe: (handler: (event: AgentStateObservation) => void) => () => void
}

/** Create a fresh agent-state source. One per daemon (shared across the
 *  daemon's connections, like the shared session + canvas sources). */
export const createAgentStateSource = (): AgentStateSourceHandle => {
  const subscribers = new Set<(event: AgentStateObservation) => void>()
  return {
    sink: {
      capture: (event) => {
        for (const fn of subscribers) {
          try {
            fn(event)
          } catch {
            // A throwing subscriber must not break the fan-out to siblings or
            // the turn (the base stream already emitted this event verbatim).
          }
        }
      },
    },
    subscribe: (handler) => {
      subscribers.add(handler)
      return () => {
        subscribers.delete(handler)
      }
    },
  }
}
