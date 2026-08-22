/**
 * `@/ipc/session/heartbeat` — app-level keepalive short-circuit (jul-16 hoist
 * from `@/apps/web-daemon/server/heartbeat`; re-exported there for the WS pump).
 *
 * Clients send a `heartbeat` `ping` on a ~25s timer to keep an otherwise-idle
 * path (WS proxy idle-timeout, or a stdio sidecar's parent) warm; a session
 * server answers each ping with a `pong`. Hoisting this here lets EVERY
 * session.v1 server respond — the web daemon's WS pump (raw `ws.send`, via
 * {@link replyToHeartbeat}) AND the transport bridge (`serve --stdio` and any
 * attached transport, via {@link replyToHeartbeatOnTransport}) — instead of the
 * pong living only in the web-daemon slice.
 */

import { encodeSessionTransportMessage } from "./codec"
import type { SessionTransport, SessionTransportMessage } from "./types"

/**
 * App-level keepalive (ADR — comms heartbeat). Clients send a `heartbeat`
 * `ping` on a ~25s timer to keep an otherwise-idle path warm past a proxy's
 * idle timeout; the server answers each ping with a `pong` so the client's
 * liveness deadline is reset. Pre-encoded once — every reply is the SAME byte
 * string, so there is no per-ping allocation on the hot path.
 *
 * The interval lives client-side (the server is purely reactive: one pong per
 * ping). It is named here as the documented contract rather than scattered as
 * a magic literal in the frontend timer.
 */
export const HEARTBEAT_INTERVAL_MS = 25_000

/** The single pong reply, pre-encoded once (raw-`ws.send` path). */
const HEARTBEAT_PONG_FRAME = encodeSessionTransportMessage({ kind: "heartbeat", phase: "pong" })

/** The typed pong message (typed `SessionTransport.send` path — the transport
 *  encodes it itself). */
const HEARTBEAT_PONG_MESSAGE: SessionTransportMessage = { kind: "heartbeat", phase: "pong" }

/** Minimal `ws.send`-only surface the heartbeat reply writes to. */
interface HeartbeatSendable {
  send(data: string | Uint8Array): unknown
}

/**
 * Pure heartbeat short-circuit for a RAW `ws.send` pump (web-daemon). Returns
 * `true` when `decoded` is a heartbeat frame the message pump should consume (a
 * `ping` is answered with a `pong`; a `pong` — or our own reply — is terminal
 * and never forwarded), `false` when the frame is NOT a heartbeat and must fall
 * through to the session bridge.
 *
 * NO-THROW: a `ws.send` on a closing/dead socket can throw — we swallow it so a
 * hostile socket never crashes the message pump (the close callback evicts the
 * dead peer). Extracted + exported so this guard has direct test teeth:
 * removing the try/catch leaves the e2e tests green, so it needs a unit that
 * injects a throwing `ws` and asserts the NO-THROW + `true` consume contract.
 */
export const replyToHeartbeat = (
  ws: HeartbeatSendable,
  decoded: SessionTransportMessage | undefined,
): boolean => {
  if (decoded?.kind !== "heartbeat") return false
  if (decoded.phase === "ping") {
    try {
      ws.send(HEARTBEAT_PONG_FRAME)
    } catch {
      // Dead socket — the close callback evicts it; swallow so a bad send never
      // crashes the message pump.
    }
  }
  // A `pong` (or our own reply) is terminal: consumed, never forwarded.
  return true
}

/**
 * Same heartbeat short-circuit, over a typed {@link SessionTransport} (the
 * transport-bridge intake path used by `serve --stdio` and every non-WS
 * attach). Returns `true` when the frame was a heartbeat the intake should
 * consume — a `ping` is answered with a typed `pong` via `transport.send`; a
 * `pong` is terminal — and `false` when the frame is NOT a heartbeat and must
 * fall through to the bridge's connect/command handling.
 *
 * NO-THROW async fan-and-forget: `transport.send` returns a Promise (a dead
 * peer's writer throw is a rejected Promise); we swallow it so a hostile peer
 * never poisons the intake. The pong is fire-and-forget — the intake handler is
 * synchronous and one reply per ping is the contract.
 */
export const replyToHeartbeatOnTransport = (
  transport: Pick<SessionTransport, "send">,
  decoded: SessionTransportMessage | undefined,
): boolean => {
  if (decoded?.kind !== "heartbeat") return false
  if (decoded.phase === "ping") {
    void transport.send(HEARTBEAT_PONG_MESSAGE).catch(() => undefined)
  }
  return true
}
