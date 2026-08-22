/**
 * `@/apps/web-daemon/server/sinks` — per-connection side-channel sinks.
 *
 * Bridges a served WebSocket to the daemon's live observability / canvas /
 * agent-state sources. Each `attach*Sink` mints a per-connection emitter (or
 * subscription) and returns a handle whose `stop()`/`detach()` MUST be called
 * on disconnect so we never write to a dead socket. All return `null` when the
 * matching port bundle is absent (gate OFF ⇒ no sink, byte-identical).
 */

import type { ContextUsageBreakdown } from "@/agent/context/usage-breakdown"
import {
  type AgentStateObservation,
  agentStateObservationToMessage,
  encodeAgentStateFrame,
} from "@/protocol/agent-state"
import type { DiffAnchorComment } from "@/protocol/canvas"
import type { ArtifactRef } from "@/protocol/session"
import { type CanvasEmitterHandle, createCanvasEmitter } from "../canvas-emitter"
import {
  createObservabilityEmitter,
  type ObservabilityEmitterHandle,
} from "../observability-emitter"
import type { WebControlRequestPortHandle } from "../web-control-request-port"
import type { WebUserInputPortHandle } from "../web-user-input-port"

/** Minimal `ServerWebSocket`-like surface the observability sink writes to.
 *  The daemon's `ServerWebSocket<WSData>` satisfies it; the hellgate passes a
 *  fake recording `.send(...)`. */
export interface ObservabilitySendable {
  send(data: string | Uint8Array): unknown
}

/**
 * ADR-0420 — observability port bundle the daemon hands to each connection so
 * it can mint a per-connection emitter. Mirrors the emitter's option names
 * (consume-only — the emitter slice is sealed). All ports optional: the
 * `index.ts` composition root only passes the ones the live facade exposes.
 */
export interface ObservabilityPorts {
  readonly objective?: ObservabilityEmitterPort<"objective">
  readonly runLedger?: ObservabilityEmitterPort<"runLedger">
  readonly approvalSM?: ObservabilityEmitterPort<"approvalSM">
  readonly threadId?: string
  readonly intervalMs?: number
  /** Test seam — deterministic timer so the hellgate drives `tick()` itself. */
  readonly timer?: ObservabilityEmitterTimer
}

// Re-derive the port option types straight from the sealed emitter options so
// this surface can never drift from what `createObservabilityEmitter` accepts.
type ObservabilityEmitterOptions = NonNullable<Parameters<typeof createObservabilityEmitter>[0]>
type ObservabilityEmitterPort<K extends keyof ObservabilityEmitterOptions> = NonNullable<
  ObservabilityEmitterOptions[K]
>
type ObservabilityEmitterTimer = NonNullable<ObservabilityEmitterOptions["timer"]>

/**
 * ADR-0420 — bridge a served WebSocket to the observability emitter.
 *
 * Returns `null` when `ports` is absent (gate OFF ⇒ no sink, byte-identical).
 * Otherwise mints a per-connection emitter whose `ws` sink forwards encoded
 * frames straight to `ws.send(...)`. The first tick is a `observability.snapshot`
 * (the emitter's contract); subsequent ticks emit `observability.delta` when
 * the live ports differ. The returned handle's `stop()` MUST be called on
 * disconnect so the emitter stops writing to a dead socket.
 *
 * NO-THROW: a throwing `ws.send` is swallowed inside the emitter; mint never
 * throws on a hostile socket.
 */
export const attachObservabilitySink = (
  ws: ObservabilitySendable,
  ports: ObservabilityPorts | undefined,
): ObservabilityEmitterHandle | null => {
  if (ports === undefined) return null
  return createObservabilityEmitter({
    ws: {
      send: (frame: string): void => {
        try {
          ws.send(frame)
        } catch {
          // Dead/throwing socket — swallow. The emitter also guards, but we
          // belt-and-brace here so a non-emitter caller is equally safe.
        }
      },
    },
    ...(ports.objective !== undefined ? { objective: ports.objective } : {}),
    ...(ports.runLedger !== undefined ? { runLedger: ports.runLedger } : {}),
    ...(ports.approvalSM !== undefined ? { approvalSM: ports.approvalSM } : {}),
    ...(ports.threadId !== undefined ? { threadId: ports.threadId } : {}),
    ...(ports.intervalMs !== undefined ? { intervalMs: ports.intervalMs } : {}),
    ...(ports.timer !== undefined ? { timer: ports.timer } : {}),
  })
}

/**
 * ADR-0440 — canvas data source the daemon shares across connections.
 *
 * The agent loop's `onPromptAssembled` seam already computes the per-category
 * `ContextUsageBreakdown` (the SAME view the CLI `/context` renders); the
 * composition root pushes each new view into this source. Every connection
 * subscribes so its per-connection emitter forwards a `context.usage` frame.
 * `latest()` lets a fresh connection render the current usage immediately
 * (snapshot-on-connect) without waiting for the next turn.
 *
 * Diff frames (`tool.diff`) ride the SAME per-connection emitter; the live
 * agent-seam binding that surfaces a tool's before/after text is a documented
 * deferral (see canvas-emitter.ts / ADR-0440) — the emitter method + protocol
 * + frontend consumer are fully wired so the channel lights up the moment a
 * before/after seam exists.
 */
export interface CanvasUsageSource {
  /** Subscribe to subsequent usage views. Returns an unsubscribe closure. */
  subscribe(handler: (view: ContextUsageBreakdown) => void): () => void
  /** The most recently computed view, or undefined before the first turn. */
  latest(): ContextUsageBreakdown | undefined
}

/**
 * ADR-0440 wire-finish — a captured tool mutation a connection renders as a
 * `tool.diff` frame. Carries the full pre/post file text the agent's dispatch
 * seam handed the daemon (no recompute — `feedToolDiff` runs the line-diff
 * once). Structural mirror of `canvas-tool-diff-source.ts#CapturedToolDiff`.
 */
export interface CanvasToolDiff {
  readonly toolCallId: string
  readonly before: string
  readonly after: string
  readonly path?: string
  /** RFC-12 (deferred) SURFACE B — anchored review comments already projected
   *  from the diff's `ReviewFinding` anchors (`reviewFindingsToAnchors` in
   *  `canvas-tool-diff-source.ts`) onto the render-side new line. ADDITIVE +
   *  OPTIONAL: absent (the common `write`/`edit` capture) ⇒ the emitter carries
   *  NO `anchors` key (byte-identical). Structural mirror of
   *  `canvas-tool-diff-source.ts#CapturedToolDiff.anchors`. */
  readonly anchors?: readonly DiffAnchorComment[]
}

/**
 * ADR-0440 wire-finish — canvas tool-diff source. Subscribe-only (unlike the
 * usage source there is NO `latest()` snapshot-on-connect: a diff is a
 * point-in-time mutation event, not retained state). Each connection's emitter
 * forwards every subsequent capture as a `tool.diff` frame.
 */
export interface CanvasToolDiffSource {
  /** Subscribe to subsequent tool mutations. Returns an unsubscribe closure. */
  subscribe(handler: (diff: CanvasToolDiff) => void): () => void
}

/**
 * A2 wire-finish — canvas artifact source. Subscribe-only (like the tool-diff
 * source: an `artifact.ready` is a point-in-time event, not retained state).
 * Fed by a server-boot bridge that maps every session `artifact.ready` event
 * into `capture(ref)`. Each connection's emitter forwards every subsequent ref
 * as an `artifact.ready` Canvas frame. Structural mirror of
 * `canvas-artifact-source.ts#CanvasArtifactSourceHandle.subscribe`.
 */
export interface CanvasArtifactSource {
  /** Subscribe to subsequent ready artifacts. Returns an unsubscribe closure. */
  subscribe(handler: (ref: ArtifactRef) => void): () => void
}

/**
 * ADR-0440 — canvas port bundle handed to each connection. All optional: the
 * `index.ts` composition root only passes what the live facade exposes. Gate
 * OFF ⇒ `index.ts` never builds this ⇒ no sink, byte-identical.
 */
export interface CanvasPorts {
  readonly usageSource?: CanvasUsageSource
  /**
   * ADR-0440 wire-finish — live tool-diff source (the agent dispatch seam feeds
   * it via `AgentConfig.onToolDiff`). Present only when `QUANTA_WEB_CANVAS=1`.
   * Absent ⇒ a connection forwards no `tool.diff` frames (byte-identical).
   */
  readonly toolDiffSource?: CanvasToolDiffSource
  /**
   * A2 wire-finish — live artifact source (a server-boot bridge feeds it every
   * session `artifact.ready` ref). Present only when `QUANTA_WEB_CANVAS=1`.
   * Absent ⇒ a connection forwards no `artifact.ready` Canvas frames
   * (byte-identical; the session event itself is gated on
   * `QUANTA_ARTIFACT_STORE`).
   */
  readonly artifactSource?: CanvasArtifactSource
}

/**
 * ADR-0440 — bridge a served WebSocket to a per-connection canvas emitter.
 *
 * Returns `null` when `ports` is absent (gate OFF ⇒ no sink, byte-identical).
 * Otherwise mints an emitter whose `ws` sink forwards encoded canvas frames to
 * `ws.send(...)`, subscribes it to the shared usage source (immediately
 * forwarding the latest view as a snapshot-on-connect), and returns the handle
 * plus a `detach` closure that unsubscribes + stops the emitter. The caller
 * MUST call `detach()` on disconnect so we never emit to a dead socket.
 *
 * NO-THROW: a throwing `ws.send` is swallowed inside the emitter; mint never
 * throws on a hostile socket.
 */
export const attachCanvasSink = (
  ws: ObservabilitySendable,
  ports: CanvasPorts | undefined,
): { handle: CanvasEmitterHandle; detach: () => void } | null => {
  if (ports === undefined) return null
  const handle = createCanvasEmitter({
    ws: {
      send: (frame: string): void => {
        try {
          ws.send(frame)
        } catch {
          // Dead/throwing socket — swallow (emitter also guards internally).
        }
      },
    },
  })
  let unsubscribe: (() => void) | undefined
  const source = ports.usageSource
  if (source !== undefined) {
    // Snapshot-on-connect: render the current usage without waiting a turn.
    const current = source.latest()
    if (current !== undefined) handle.feedUsage(current)
    unsubscribe = source.subscribe((view) => handle.feedUsage(view))
  }
  // ADR-0440 wire-finish — subscribe this connection's emitter to the live
  // tool-diff source so a file-mutating tool's before/after becomes a
  // `tool.diff` frame. NO snapshot-on-connect (a diff is a point-in-time
  // mutation, not retained state) — diffs render from the next mutation
  // forward. `feedToolDiff` runs the line-diff math once + applies the caps.
  let unsubscribeDiffs: (() => void) | undefined
  const diffSource = ports.toolDiffSource
  if (diffSource !== undefined) {
    unsubscribeDiffs = diffSource.subscribe((diff) =>
      handle.feedToolDiff({
        toolCallId: diff.toolCallId,
        before: diff.before,
        after: diff.after,
        ...(diff.path !== undefined ? { path: diff.path } : {}),
        // SURFACE B — thread the already-projected anchors additively; absent ⇒
        // the emitter serializes no `anchors` key (byte-identical non-review diff).
        ...(diff.anchors !== undefined ? { anchors: diff.anchors } : {}),
      }),
    )
  }
  // A2 wire-finish — subscribe this connection's emitter to the live artifact
  // source so a drained session `artifact.ready` ref becomes an `artifact.ready`
  // Canvas frame. NO snapshot-on-connect (a ready is a point-in-time event, not
  // retained state) — artifacts render from the next ready forward.
  let unsubscribeArtifacts: (() => void) | undefined
  const artifactSource = ports.artifactSource
  if (artifactSource !== undefined) {
    unsubscribeArtifacts = artifactSource.subscribe((ref) => handle.feedArtifactReady(ref))
  }
  return {
    handle,
    detach: () => {
      unsubscribe?.()
      unsubscribeDiffs?.()
      unsubscribeArtifacts?.()
      handle.stop()
    },
  }
}

/**
 * QUANTA_WEB_AGENT_STATE — live agent-state source (subscribe-only, fed by the
 * session's `onAgentState` stream tap). Structural mirror of
 * `agent-state-source.ts#AgentStateSourceHandle.subscribe`. Present only when
 * `QUANTA_WEB_AGENT_STATE=1`; absent ⇒ a connection forwards no `agentState`
 * frames (byte-identical).
 */
export interface AgentStateSource {
  /** Subscribe to subsequent agent-state captures. Returns an unsubscribe. */
  subscribe(handler: (event: AgentStateObservation) => void): () => void
}

/**
 * QUANTA_WEB_AGENT_STATE — agent-state port bundle handed to each connection.
 * Optional: the `index.ts` composition root only passes it when the live facade
 * exposes the source. Gate OFF ⇒ `index.ts` never builds this ⇒ no sink,
 * byte-identical.
 */
export interface AgentStatePorts {
  readonly source: AgentStateSource
}

/**
 * QUANTA_WEB_AGENT_STATE — the OUT-OF-BAND INBOUND port bundle handed to the
 * server. Lets an inbound `planInputAnswer` frame resolve a paused agent's
 * `request_user_input` prompt (`handle.resolve`) and `handle.cancelAll()` every
 * pending request on disconnect so a pending resolver never leaks (the agent's
 * `await` never hangs past the socket). Shared across the daemon's connections
 * (the inbound port lives on the single facade). Optional: the `index.ts`
 * composition root only passes it when the facade exposes the inbound port. Gate
 * OFF ⇒ `index.ts` never builds this ⇒ the tool was never registered ⇒ no answer
 * can arrive (byte-identical).
 */
export interface UserInputPorts {
  readonly handle: WebUserInputPortHandle
}

/**
 * QUANTA_CONTROL_REQUEST (ADR-0496 A1) — the OUT-OF-BAND INBOUND control-request
 * port bundle handed to the server. Lets a peeked `controlRequest` frame
 * `enqueue` a runtime-control request onto the live session's port (which the
 * turn loop drains + applies — `set_permission_mode` lands on the live gate).
 * Shared across the daemon's connections (the port lives on the single facade).
 * Optional: the `index.ts` composition root only passes it when the facade
 * exposes the port. Gate OFF ⇒ `index.ts` never builds this ⇒ no enqueue target
 * ⇒ a stray control frame falls through to the session bridge (byte-identical).
 */
export interface ControlRequestPorts {
  readonly handle: WebControlRequestPortHandle
}

/**
 * QUANTA_WEB_AGENT_STATE — bridge a served WebSocket to the agent-state source.
 *
 * Returns `null` when `ports` is absent (gate OFF ⇒ no sink, byte-identical).
 * Otherwise subscribes this connection to the shared source: each capture is
 * projected (`agentStateObservationToMessage`) + encoded
 * (`encodeAgentStateFrame`) and `ws.send`-ed. NO snapshot-on-connect (an
 * agent-state event is a point-in-time
 * observation, not retained state) — frames render from the next event forward.
 * The caller MUST call `detach()` on disconnect so we never forward to a dead
 * socket.
 *
 * NO-THROW at every fan-out: the mapper is pure, but the encode + `ws.send` are
 * wrapped in try/catch so a hostile / dead socket can never break the
 * subscriber fan-out (the source's `capture` additionally guards each handler).
 */
export const attachAgentStateSink = (
  ws: ObservabilitySendable,
  ports: AgentStatePorts | undefined,
): { detach: () => void } | null => {
  if (ports === undefined) return null
  const unsubscribe = ports.source.subscribe((event) => {
    try {
      ws.send(encodeAgentStateFrame(agentStateObservationToMessage(event)))
    } catch {
      // Dead/throwing socket or mapper edge — swallow (the source also guards
      // each handler so a throw here never breaks the fan-out to siblings).
    }
  })
  return {
    detach: () => {
      unsubscribe()
    },
  }
}
