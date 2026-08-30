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
  replyToHeartbeat,
  type SessionTransport,
  tryDecodeSessionTransportMessage,
  wrapWebSocketLikeAsSessionTransport,
} from "@/ipc/session"
import { resolveReadModels, type SurfaceSubscription } from "@/protocol/session"
import type { RuntimeSession } from "@/sdk/runtime"
import { errMessage, logger } from "@/shared"
import { peekControlRequest } from "../control-request-frame"
import { peekFollowerVerb } from "../follower-verb-frame"
import { peekGoalVerify, peekGoalVerifyEnvelope } from "../goal-verify-frame"
import { peekGoalWork, peekGoalWorkEnvelope } from "../goal-work-frame"
import type { WebDaemonServerConfig } from "../server"
import type { RegisteredSession, SessionRegistry } from "../session-registry"
import { SUBAGENT_WS_TOPIC } from "../subagent-source"
import {
  type BunServerWebSocketLike,
  type BunWebSocketAdapter,
  createBunWebSocketAdapter,
} from "../ws-adapter"
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

/**
 * QUANTA_WEB_AGENT_STATE — peek + CONSUME an out-of-band `planInputAnswer`.
 * Returns `true` when the frame WAS an answer (⇒ do NOT forward it to the
 * bridge), else `false`. Gate OFF ⇒ `userInputPorts` absent ⇒ the resolve is a
 * no-op but the frame is STILL consumed — exactly as the inline version did.
 * A unit because it is one consume decision; the enclosing handler only needs
 * the boolean.
 */
const consumePlanInputAnswerFrame = (
  config: Pick<WebDaemonServerConfig, "userInputPorts">,
  raw: string,
): boolean => {
  const answer = peekPlanInputAnswer(raw)
  if (answer === null) return false
  config.userInputPorts?.handle.resolve(
    answer.promptId,
    answer.decision === "answer"
      ? { decision: "answer", text: answer.text }
      : { decision: "cancelled" },
  )
  return true
}

/**
 * T02 — peek + CONSUME a `followerVerb` frame (steer / interrupt /
 * set-queue-mode / command-approval-decision) from a 2nd client. Returns `true`
 * when the frame was a well-formed verb (⇒ do NOT forward it), else `false`.
 * Gate OFF ⇒ `followerCoControl` absent ⇒ always `false` and the frame reaches
 * the bridge (byte-identical).
 *
 * A unit because this is where the message handler's DEEPEST nesting lived: a
 * gate, then a peek, then a two-arm route — three levels below an already
 * double-nested arrow. The two arms are NOT interchangeable: an approval
 * decision rides the TIMEOUT coordinator (deadline/stale + the resolver's live
 * HARD_DENY re-check), never the FIRE path.
 */
const consumeFollowerVerbFrame = (
  config: Pick<WebDaemonServerConfig, "followerCoControl">,
  followerApproval: FollowerApprovalCoordinator | undefined,
  raw: string,
): boolean => {
  const coControl = config.followerCoControl
  if (coControl === undefined) return false
  const verb = peekFollowerVerb(raw)
  if (verb === null) return false
  if (verb.kind === "command-approval-decision") {
    followerApproval?.relay(verb.approvalId, verb.decision, verb.steer)
  } else {
    coControl.dispatch(verb)
  }
  return true
}

/**
 * GOAL-08 rail 15 (web half) — peek + CONSUME a `goalWork` frame: ONE
 * user-requested goal turn on the live session (the web `/goal work`). Returns
 * `true` when the frame was OURS (⇒ do NOT forward it to the bridge), else
 * `false`.
 *
 * Every outcome — including a refusal — is answered on the REQUESTING socket
 * (`goalWorkResult`): a request that cannot be claimed is never accepted and
 * then silently dropped.
 *
 * REVERSED (2026-08-30): this used to `return false` when no handler was
 * composed, or when the text was blank, and let the frame "fall through to the
 * bridge (byte-identical)". That reads as conservative and is not: the frame
 * carries no transport kind, so the bridge's decoder returns `undefined` and
 * drops it, and it carries no recognizable version either, so the lenient reject
 * path mints nothing. The client, whose `sendGoalWork` returns `true` on a
 * successful write and has no timeout, then waits forever. Falling through is
 * only right for a frame this daemon does not own; `kind:"goalWork"` is
 * unambiguously ours, so both cases are refusals — and a refusal is a thing you
 * say out loud.
 */
export const consumeGoalWorkFrame = (
  ws: Pick<ServerWebSocket<WSData>, "send"> & { readonly data?: Pick<WSData, "registered"> },
  config: Pick<WebDaemonServerConfig, "goalWork">,
  raw: string,
): boolean => {
  const envelope = peekGoalWorkEnvelope(raw)
  if (envelope === null) return false
  const request = peekGoalWork(raw)
  const requestId = request?.requestId ?? envelope.requestId
  const handler = config.goalWork
  const answer = (result: Record<string, unknown>): void => {
    // A dead socket must not take the daemon down with it.
    try {
      ws.send(
        JSON.stringify({
          kind: "goalWorkResult",
          ...(requestId !== undefined ? { requestId } : {}),
          ...result,
        }),
      )
    } catch (error) {
      logger.warn("web-daemon: goalWorkResult send failed", { error: errMessage(error) })
    }
  }
  // This verb STARTS A BILLED TURN. A connection that is not yet a registered
  // session (Bun delivers `message` while the async `open()` is still awaiting
  // registration) is told to retry rather than served.
  if (ws.data !== undefined && ws.data.registered !== true) {
    answer({
      ok: false,
      reason: "the session is not ready yet — retry after the connect handshake",
    })
    return true
  }
  if (handler === undefined) {
    answer({
      ok: false,
      reason:
        "goal work is not composed on this daemon " +
        "(no objective authority — QUANTA_OBJECTIVE_TOOLS is off, so there is no goal to work on)",
    })
    return true
  }
  if (request === null) {
    answer({ ok: false, reason: "goal work needs an instruction — the request was empty" })
    return true
  }
  // NO-THROW at the Bun boundary: `request` reads live domain state, and a
  // throw out of `message()` takes the WHOLE daemon down (every peer with it).
  try {
    handler.request(request.text, answer)
  } catch (error) {
    logger.warn("web-daemon: goal work request failed", { error: errMessage(error) })
    answer({ ok: false, reason: `goal work failed: ${errMessage(error)}` })
  }
  return true
}

/** Consume and answer the correlated `/goal verify` request on its socket. */
export const consumeGoalVerifyFrame = (
  ws: Pick<ServerWebSocket<WSData>, "send"> & { readonly data?: Pick<WSData, "registered"> },
  config: Pick<WebDaemonServerConfig, "goalVerify">,
  raw: string,
): boolean => {
  const envelope = peekGoalVerifyEnvelope(raw)
  if (envelope === null) return false
  const request = peekGoalVerify(raw)
  const requestId =
    request?.requestId ?? (typeof envelope.requestId === "string" ? envelope.requestId : undefined)
  const answer = (result: Record<string, unknown>): void => {
    try {
      ws.send(
        JSON.stringify({
          kind: "goalVerifyResult",
          ...(requestId !== undefined ? { requestId } : {}),
          ...result,
        }),
      )
    } catch (error) {
      logger.warn("web-daemon: goalVerifyResult send failed", { error: errMessage(error) })
    }
  }
  if (ws.data !== undefined && ws.data.registered !== true) {
    answer({
      status: "refused",
      outcome: { kind: "rejected", reason: "session-not-ready" },
    })
    return true
  }
  if (request === null) {
    answer({
      status: "refused",
      outcome: { kind: "rejected", reason: "malformed-request" },
    })
    return true
  }
  const handler = config.goalVerify
  if (handler === undefined) {
    answer({
      status: "refused",
      outcome: { kind: "rejected", reason: "verifier-unavailable" },
    })
    return true
  }
  try {
    handler.request(request.expectedObjectiveRevision, answer)
  } catch (error) {
    answer({
      status: "refused",
      outcome: { kind: "rejected", reason: `verifier-failed:${errMessage(error)}` },
    })
  }
  return true
}

/**
 * The whole INBOUND TEXT-FRAME pipeline: every connection-layer consumer that
 * gets a look at a string frame BEFORE the session bridge does, in the ONE
 * order that matters. Returns `true` when some consumer took the frame (⇒ the
 * bridge never sees it), `false` when it must fall through to the adapter.
 *
 * A unit because the `message` handler was paying a nesting surcharge on every
 * line of this: an arrow (`buildWebSocketHandlers`) → an object literal → the
 * `message` arrow → a `typeof raw === "string"` wrapper — four levels before
 * the first real decision. Hoisting the pipeline to module scope prices each
 * gate at its true cost of one.
 *
 * ORDER IS THE CONTRACT and is preserved exactly:
 *   1. heartbeat — answered with a `pong` and consumed, so the bridge's 5-kind
 *      contract never sees a keepalive.
 *   2. `connect` — re-applies the surface subscription and then FALLS THROUGH
 *      (the bridge still needs the connect frame); it is the only non-consuming
 *      step here.
 *   3. `planInputAnswer` / `controlRequest` / `followerVerb` — each is peeked
 *      and CONSUMED (none is a `SessionCommand`; none reaches the kernel
 *      reducer). They are mutually exclusive on the envelope's `kind`.
 */
const consumeInboundTextFrame = (
  ws: ServerWebSocket<WSData>,
  raw: string,
  config: WebDaemonServerConfig,
  followerApproval: FollowerApprovalCoordinator | undefined,
): boolean => {
  const decoded = tryDecodeSessionTransportMessage(raw)
  // A heartbeat is consumed here (pong reply / terminal) so the bridge never
  // sees it — its 5-kind contract is unchanged.
  if (replyToHeartbeat(ws, decoded)) return true
  if (decoded?.kind === "connect") {
    applySurfaceSubscription(ws, config, decoded.surfaceSubscription)
  }
  // QUANTA_WEB_AGENT_STATE — the OUT-OF-BAND INBOUND answer frame (mirror of
  // the agent-state OUTBOUND channel). Peeked BEFORE the session bridge: it
  // resolves a paused agent's `request_user_input` prompt.
  if (consumePlanInputAnswerFrame(config, raw)) return true
  // QUANTA_CONTROL_REQUEST (ADR-0496 A1) — set_model / set_permission_mode /
  // set_thinking / get_context_usage, enqueued onto the live session's
  // control-request port so the turn loop's `pollControlRequests` applies it.
  if (consumeControlRequestFrame(config.controlRequestPorts, raw)) return true
  // T02 — a follower verb from a 2nd client, routed to the co-control
  // dispatcher (approvals ride approval.respond via the coordinator).
  if (consumeFollowerVerbFrame(config, followerApproval, raw)) return true
  if (consumeGoalVerifyFrame(ws, config, raw)) return true
  // GOAL-08 rail 15 — the web `/goal work` verb (one user-requested goal turn,
  // answered on this socket). Absent handler ⇒ falls through unchanged.
  if (consumeGoalWorkFrame(ws, config, raw)) return true
  return false
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
      // QUANTA_WEB_SUBAGENTS — join the Sub-Agents broadcast topic so this
      // connection receives every `subagent` frame the source publishes. Gate
      // OFF ⇒ `config.subagentSource` absent ⇒ no subscribe (byte-identical).
      if (config.subagentSource !== undefined) ws.subscribe(SUBAGENT_WS_TOPIC)
      try {
        await buildRegisteredSession(registry, ws, adapter, sharedSession)
        ws.data.registered = true
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
      // App-level keepalive + the other connection-layer consumers get a look
      // at a TEXT frame before the session bridge does; a binary/undecodable
      // frame (and any frame no consumer took) falls through to the adapter
      // exactly as before. The pipeline lives at module scope so its gates are
      // not priced through three enclosing arrows — see
      // `consumeInboundTextFrame` for the order contract.
      if (typeof raw === "string" && consumeInboundTextFrame(ws, raw, config, followerApproval)) {
        return
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
