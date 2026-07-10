/**
 * `@/apps/web-daemon/server/ws-handlers` — the daemon's `websocket`
 * open/message/close handler trio + the per-connection helpers it composes.
 *
 * Extracted verbatim from `startWebDaemon` so the parent stays under the
 * god-function ceiling. The handlers close over the daemon's live locals via
 * the `WsHandlerDeps` bundle. Behaviour is byte-identical to the inline
 * version: same frame short-circuit order, same gate semantics, same teardown.
 */

import type { ServerWebSocket } from "bun"
import type { createFollowerApprovalCoordinator } from "@/agent/thread-follower"
import {
  type SessionTransport,
  tryDecodeSessionTransportMessage,
  wrapWebSocketLikeAsSessionTransport,
} from "@/ipc/session"
import { resolveReadModels, type SurfaceSubscription } from "@/protocol/session"
import type { RuntimeSession } from "@/sdk/runtime"
import { errMessage, logger } from "@/shared"
import { peekControlRequest } from "../control-request-frame"
import { peekFollowerVerb } from "../follower-verb-frame"
import type { WebDaemonServerConfig } from "../server"
import type { RegisteredSession, SessionRegistry } from "../session-registry"
import {
  type BunServerWebSocketLike,
  type BunWebSocketAdapter,
  createBunWebSocketAdapter,
} from "../ws-adapter"
import { replyToHeartbeat } from "./heartbeat"
import { attachAgentStateSink, attachCanvasSink, attachObservabilitySink } from "./sinks"
import type { WSData } from "./ws-data"

type FollowerApprovalCoordinator = ReturnType<typeof createFollowerApprovalCoordinator>

/**
 * Reconnect-replay bound (WS resume seam). When a client reconnects it sends
 * `connect{resumeFromSeq}` and the bridge replays the events with `seq >
 * resumeFromSeq` to that transport instead of a full snapshot. That replay is
 * served from the bridge's IN-MEMORY tail, whose size we cap here via
 * `replayWindow` so a long-lived daemon session never replays unbounded
 * history. A resume whose seq is older than this window falls back to a full
 * snapshot (the bridge's existing `planSessionReplay` fallback) so the client
 * resets cleanly. `128` matches the bridge's own default tail magnitude — we
 * pass it EXPLICITLY so the bound is a deliberate daemon contract rather than
 * an implicit default, and so the persisted SQLite thread store (full history)
 * stays the authority for deep transcript hydration on page reload.
 */
const WEB_DAEMON_REPLAY_WINDOW = 128

export const applySurfaceSubscription = (
  ws: ServerWebSocket<WSData>,
  config: Pick<
    WebDaemonServerConfig,
    "agentStatePorts" | "canvasPorts" | "observabilityPorts" | "supportedReadModels"
  >,
  subscription: SurfaceSubscription | undefined,
): void => {
  const resolved = resolveReadModels(config.supportedReadModels, subscription)

  ws.data.observability?.stop()
  ws.data.observability = undefined
  if (resolved.observability.status === "subscribed") {
    ws.data.observability = attachObservabilitySink(ws, config.observabilityPorts) ?? undefined
  }

  ws.data.canvas?.detach()
  ws.data.canvas = undefined
  if (resolved.canvas.status === "subscribed") {
    ws.data.canvas = attachCanvasSink(ws, config.canvasPorts) ?? undefined
  }

  ws.data.agentState?.detach()
  ws.data.agentState = undefined
  if (resolved.agentState.status === "subscribed") {
    ws.data.agentState = attachAgentStateSink(ws, config.agentStatePorts) ?? undefined
  }
}

/**
 * Multi-client shared-session mode (v2):
 *   - The daemon creates ONE session at boot via `runtime.createSession`.
 *   - Every WebSocket connection attaches its own `SessionTransport` to
 *     the SAME session, so all connected clients see the same transcript
 *     and any one of them can advance the turn.
 *   - The per-WS `RegisteredSession.session` field still points at the
 *     shared session for `registry.has/size` accounting; `drop()` MUST
 *     NOT call `session.close()` (the daemon shutdown path closes it
 *     exactly once via `runtime.close`).
 */
const buildRegisteredSession = async (
  registry: SessionRegistry,
  socketKey: object,
  socket: BunWebSocketAdapter,
  sharedSession: RuntimeSession,
): Promise<void> => {
  const transport: SessionTransport = wrapWebSocketLikeAsSessionTransport(socket.socket)
  const connected = await sharedSession.attachSessionTransport(transport, {
    replayWindow: WEB_DAEMON_REPLAY_WINDOW,
  })
  const entry: RegisteredSession = {
    session: sharedSession,
    transport,
    connected,
  }
  registry.add(socketKey, entry)
}

/**
 * QUANTA_WEB_AGENT_STATE — peek an inbound text frame for an OUT-OF-BAND
 * `planInputAnswer` (the mirror of the agent-state OUTBOUND frame). Returns the
 * `{promptId, decision, text}` triple when the frame is a well-formed answer,
 * else `null` (so the frame falls through to the session bridge unchanged).
 *
 * NO-THROW: a non-JSON / non-matching frame returns `null` rather than throwing.
 * This is NOT a `SessionCommand` — it never reaches the kernel reducer.
 */
export const peekPlanInputAnswer = (
  raw: string,
): { promptId: string; decision: "answer" | "cancelled"; text: string } | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null
  const obj = parsed as Record<string, unknown>
  if (obj.kind !== "planInputAnswer") return null
  if (typeof obj.promptId !== "string") return null
  const decision = obj.decision === "answer" ? "answer" : "cancelled"
  return {
    promptId: obj.promptId,
    decision,
    text: typeof obj.text === "string" ? obj.text : "",
  }
}

/**
 * QUANTA_CONTROL_REQUEST (ADR-0496 A1) — peek + CONSUME a `controlRequest` frame
 * onto the wired control-request port. Returns `true` when the frame was a
 * well-formed control request (enqueued + consumed — do NOT forward it to the
 * bridge), else `false` (fall through to the adapter). Gate OFF ⇒ `ports` absent
 * ⇒ always `false` (byte-identical: the frame reaches the bridge as before).
 * Extracted so the `message` handler stays under the cognitive-complexity cap.
 */
export const consumeControlRequestFrame = (
  ports: WebDaemonServerConfig["controlRequestPorts"],
  raw: string,
): boolean => {
  if (ports === undefined) return false
  const req = peekControlRequest(raw)
  if (req === null) return false
  ports.handle.enqueue(req)
  return true
}

export interface WsHandlerDeps {
  readonly config: WebDaemonServerConfig
  readonly registry: SessionRegistry
  readonly sharedSession: RuntimeSession
  readonly followerApproval: FollowerApprovalCoordinator | undefined
  /** P1 Phase 2 (jul-11) — swap the live session onto the opened thread. Absent
   *  ⇒ no swap (byte-identical). Injected by `startWebDaemon` (loadSessionById +
   *  sharedSession.transcript.replace + the transcript-persistence repoint). */
  readonly onAttachThread?: (threadId: string) => Promise<void>
}

interface WsHandlers {
  open(ws: ServerWebSocket<WSData>): Promise<void>
  message(ws: ServerWebSocket<WSData>, raw: string | Buffer): void
  close(ws: ServerWebSocket<WSData>): Promise<void>
}

export const buildWebSocketHandlers = (deps: WsHandlerDeps): WsHandlers => {
  const { config, registry, sharedSession, followerApproval, onAttachThread } = deps

  return {
    async open(ws: ServerWebSocket<WSData>) {
      const adapter = createBunWebSocketAdapter(ws as unknown as BunServerWebSocketLike)
      // Attach adapter immediately so a fast inbound frame is buffered to
      // the right adapter; the registered session is filled in below.
      ws.data.adapter = adapter
      // Backward-compat default: a raw/legacy socket that has not sent the
      // explicit `connect.surfaceSubscription` handshake still receives the
      // historical full side-channel fan-out. A later `connect` frame can
      // narrow this set intentionally via `applySurfaceSubscription(...)`.
      applySurfaceSubscription(ws, config, undefined)
      try {
        await buildRegisteredSession(registry, ws, adapter, sharedSession)
        // P1 Phase 2 — swap the live session onto the opened thread (hydrate
        // from its lossless SavedSession). No thread / no handler ⇒ join the
        // current live session unchanged. Never fatal: a swap failure logs but
        // the connection still serves the live session.
        if (ws.data.threadId !== undefined && onAttachThread !== undefined) {
          await onAttachThread(ws.data.threadId).catch((error) =>
            logger.warn("web-daemon: thread swap on attach failed", {
              threadId: ws.data.threadId,
              error: errMessage(error),
            }),
          )
        }
      } catch (error) {
        logger.error("web-daemon: failed to create runtime session", {
          error: errMessage(error),
        })
        adapter.handleClose()
        try {
          ws.close(1011, "session_init_failed")
        } catch {
          // ignore double-close
        }
      }
    },
    message(ws: ServerWebSocket<WSData>, raw) {
      // App-level keepalive: a client `heartbeat` ping is answered with a
      // `pong` BEFORE the frame reaches the session bridge. Heartbeats are
      // connection-level (no handshake / session state), so we short-circuit
      // them here — the bridge never sees them and its 5-kind contract is
      // unchanged. Any non-heartbeat frame (and any binary/undecodable
      // frame) falls through to the adapter exactly as before.
      if (typeof raw === "string") {
        const decoded = tryDecodeSessionTransportMessage(raw)
        // A heartbeat is consumed here (pong reply / terminal) so the bridge
        // never sees it — its 5-kind contract is unchanged. Any non-heartbeat
        // frame falls through to the adapter exactly as before.
        if (replyToHeartbeat(ws, decoded)) return
        if (decoded?.kind === "connect") {
          applySurfaceSubscription(ws, config, decoded.surfaceSubscription)
        }
        // QUANTA_WEB_AGENT_STATE — the OUT-OF-BAND INBOUND answer frame
        // (mirror of the agent-state OUTBOUND channel). Peek BEFORE the
        // session bridge: a `planInputAnswer` resolves a paused agent's
        // `request_user_input` prompt and is CONSUMED here (NOT a
        // `SessionCommand`, never reaches the kernel reducer). Gate OFF ⇒
        // `userInputPorts` absent ⇒ the resolve is a no-op (and the tool was
        // never registered, byte-identical). A frame that is not an answer
        // falls through to the adapter exactly as before.
        const answer = peekPlanInputAnswer(raw)
        if (answer !== null) {
          config.userInputPorts?.handle.resolve(
            answer.promptId,
            answer.decision === "answer"
              ? { decision: "answer", text: answer.text }
              : { decision: "cancelled" },
          )
          return
        }
        // QUANTA_CONTROL_REQUEST (ADR-0496 A1) — a `controlRequest` frame
        // (set_model / set_permission_mode / set_thinking / get_context_usage)
        // is CONSUMED here (NOT a SessionCommand, never reaches the kernel
        // reducer): enqueue it onto the live session's control-request port so
        // the turn loop's `pollControlRequests` drains + applies it (the
        // load-bearing `set_permission_mode` lands on the live gate). Gate OFF ⇒
        // `controlRequestPorts` absent ⇒ the frame falls through to the bridge
        // (and the drain slot is unwired, byte-identical). Extracted to a helper
        // so this handler stays under the cognitive-complexity cap.
        if (consumeControlRequestFrame(config.controlRequestPorts, raw)) return
        // T02 — a `followerVerb` frame (steer/interrupt/set-queue-mode) from a
        // 2nd client is CONSUMED here (NOT a SessionCommand): route it to the
        // co-control dispatcher whose sinks drive the live conversation-action
        // surface. Gate OFF ⇒ `followerCoControl` absent ⇒ the frame falls
        // through to the bridge (byte-identical). Approvals ride approval.respond.
        if (config.followerCoControl !== undefined) {
          const verb = peekFollowerVerb(raw)
          if (verb !== null) {
            if (verb.kind === "command-approval-decision") {
              // Approval decisions ride the TIMEOUT coordinator (deadline/stale
              // + the resolver's live HARD_DENY re-check), NOT the FIRE path.
              followerApproval?.relay(verb.approvalId, verb.decision, verb.steer)
            } else {
              config.followerCoControl.dispatch(verb)
            }
            return
          }
        }
      }
      ws.data.adapter?.pushMessage(raw)
    },
    async close(ws: ServerWebSocket<WSData>) {
      ws.data.adapter?.handleClose()
      // ADR-0420 — detach the observability sink before evicting so the
      // emitter timer stops and no further frames target the dead socket.
      ws.data.observability?.stop()
      ws.data.observability = undefined
      // ADR-0440 — detach the canvas sink (unsubscribe from the usage source
      // + stop the emitter) before evicting so no frame targets a dead socket.
      ws.data.canvas?.detach()
      ws.data.canvas = undefined
      // QUANTA_WEB_AGENT_STATE — unsubscribe from the agent-state source
      // before evicting so no frame targets a dead socket.
      ws.data.agentState?.detach()
      ws.data.agentState = undefined
      // QUANTA_WEB_AGENT_STATE — cancel every pending `request_user_input` so
      // a paused agent's `await` settles with `{decision:"cancelled"}` instead
      // of hanging forever for an answer this (now-dead) socket can never
      // deliver. The inbound port is SHARED across connections, so this
      // resolves ALL pending requests — for the v1 shared-session daemon there
      // is one logical client, so a disconnect means no one can answer.
      // RESIDUAL EDGE: a turn-abort WITHOUT a socket disconnect leaves the
      // resolver lingering until the NEXT close or answer (the close path is
      // the only cancel trigger; an in-band turn cancel does not reach here).
      try {
        config.userInputPorts?.handle.cancelAll()
      } catch {
        // NO-THROW: a cancel must never break socket teardown / eviction.
      }
      await registry.evict(ws)
    },
  }
}
