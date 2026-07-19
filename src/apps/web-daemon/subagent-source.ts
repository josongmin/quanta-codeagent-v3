/**
 * QUANTA_WEB_SUBAGENTS — subagent source (web-daemon side).
 *
 * FAITHFUL PARALLEL of `agent-state-source.ts`. The multi-agent orchestration
 * SUBSTRATE (commit 6109bcddf) fires `subagent_spawn` / `subagent_status`
 * observations on `AgentConfig.onSubagentEvent` (parallel to `onAgentState`);
 * the registry emit boundary hands each ALREADY-PROJECTED + bounded
 * {@link SubagentObservation} to this source's sink. Every WS connection is
 * subscribed (via a topic broadcast), so a spawn/settle transition ships a
 * `subagent` frame the browser Sub-Agents panel renders as a live spawn TREE.
 *
 * NO replay: a subagent event is a point-in-time transition (a node enters the
 * tree / a node settles). A fresh connection renders from the next event
 * forward — same posture as the agent-state / canvas-tool-diff sources.
 *
 * DEFENSE-IN-DEPTH redaction: the upstream projector already bounds + scrubs
 * the UI-crossing strings, but the port is duck-typed (any producer could hand
 * a raw observation), so this source RE-SCRUBS `description` / `finalTextPreview`
 * / `error` via the `@/security` SoT before framing. Bounded upstream; scrubbed
 * again here — a raw producer still cannot leak.
 *
 * Default-OFF: the composition root only wires this when
 * `QUANTA_WEB_SUBAGENTS` is set (see {@link wireSubagentSourceIfGated}). Absent
 * that, `onSubagentEvent` is never wired ⇒ the registry never installs its
 * emitter ⇒ NO observation is captured ⇒ NO `subagent` frame ⇒ chat UI
 * unchanged, byte-identical.
 *
 * Slice fence: this module lives in `@/apps/web-daemon` and references only the
 * `@/protocol/subagent(-frame)` shapes + the `@/security` redactor; it never
 * imports `@/agent/loop` or `@/apps/cli`. The `@/agent` slice never imports this
 * — the composition root is the only bridge (ONE import + ONE call).
 */

import type { SubagentObservation } from "@/protocol/subagent"
import { encodeSubagentFrame, subagentObservationToMessage } from "@/protocol/subagent-frame"
import { redactSecrets } from "@/security"
import { sliceWholeChars } from "@/shared"
import { gateOn } from "@/shared/env-flag"

/** The Bun `Server` pub/sub topic every connection subscribes to so a single
 *  `publish` fans a `subagent` frame out to all live sockets. */
export const SUBAGENT_WS_TOPIC = "subagent" as const

/** Min surface a Bun `Server` satisfies — recorded here so `installSubagentSource`
 *  is unit-testable with a fake publisher (no real socket). */
export interface SubagentPublisher {
  publish(topic: string, data: string | Uint8Array): number
}

export interface SubagentSourceHandle {
  /** Wire into `AgentConfig.onSubagentEvent`. Fans each capture to subscribers. */
  readonly sink: { capture(observation: SubagentObservation): void }
  /** Subscribe to subsequent captures. Returns an unsubscribe closure. */
  readonly subscribe: (handler: (observation: SubagentObservation) => void) => () => void
}

/** Max chars a UI-crossing preview carries — bounded FIRST, then scrubbed.
 *  Mirrors the projector's `PREVIEW_CAP` (defense-in-depth belt-and-braces). */
const PREVIEW_CAP = 240

/** Bound + secret-scrub a UI-crossing string via the `@/security` SoT. */
const boundedRedact = (s: string | undefined): string | undefined => {
  if (s === undefined) return undefined
  const bounded = s.length > PREVIEW_CAP ? sliceWholeChars(s, PREVIEW_CAP) : s
  return redactSecrets(bounded, { origin: "tool_result" }).text
}

/**
 * Re-scrub every UI-crossing string on an observation (defense-in-depth). Pure;
 * preserves the arm + all non-string fields. A spawn's `description`, a status'
 * `finalTextPreview` / `error` are the only strings that cross to a UI.
 */
export const redactSubagentObservation = (o: SubagentObservation): SubagentObservation => {
  if (o.type === "subagent_spawn") {
    return { ...o, description: boundedRedact(o.description) ?? "" }
  }
  // `boundedRedact` returns `string | undefined`; under `exactOptionalPropertyTypes`
  // the optional fields must be OMITTED (not set to `undefined`) when absent.
  const finalTextPreview = boundedRedact(o.finalTextPreview)
  const error = boundedRedact(o.error)
  return {
    ...o,
    ...(finalTextPreview !== undefined ? { finalTextPreview } : {}),
    ...(error !== undefined ? { error } : {}),
  }
}

/** Create a fresh subagent source. One per daemon (shared across the daemon's
 *  connections, like the agent-state + canvas sources). */
export const createSubagentSource = (): SubagentSourceHandle => {
  const subscribers = new Set<(o: SubagentObservation) => void>()
  return {
    sink: {
      capture: (observation) => {
        // Defense-in-depth re-scrub BEFORE fan-out (a raw producer cannot leak).
        const safe = redactSubagentObservation(observation)
        for (const fn of subscribers) {
          try {
            fn(safe)
          } catch {
            // A throwing subscriber must not break the fan-out to siblings or
            // the spawn/settle transition (the registry additionally guards).
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

/**
 * Bridge a subagent source to a Bun `Server`: each capture is mapped to a wire
 * message, encoded, and PUBLISHED on {@link SUBAGENT_WS_TOPIC} (every connection
 * subscribed to that topic receives it). NO-THROW at fan-out (a dead socket /
 * encode edge is swallowed; the source's `capture` additionally guards each
 * handler). Returns an unsubscribe closure (call on shutdown).
 */
export const installSubagentSource = (
  source: SubagentSourceHandle,
  publisher: SubagentPublisher,
): (() => void) =>
  source.subscribe((observation) => {
    try {
      publisher.publish(
        SUBAGENT_WS_TOPIC,
        encodeSubagentFrame(subagentObservationToMessage(observation)),
      )
    } catch {
      // Dead/throwing publisher or encode edge — swallow (byte-identical safety).
    }
  })

/**
 * Composition-root helper — the SINGLE call the daemon makes. Gate OFF (knob
 * absent) ⇒ returns `undefined` ⇒ the caller wires NO `onSubagentEvent` sink
 * (byte-identical). Gate ON ⇒ creates the source, installs the broadcast bridge
 * over `publisher`, and returns the handle whose `.sink` the caller threads into
 * `AgentConfig.onSubagentEvent`.
 */
export const wireSubagentSourceIfGated = (
  env: Record<string, string | undefined>,
  publisher: SubagentPublisher,
): SubagentSourceHandle | undefined => {
  if (!gateOn(env, "QUANTA_WEB_SUBAGENTS")) return undefined
  const source = createSubagentSource()
  installSubagentSource(source, publisher)
  return source
}
