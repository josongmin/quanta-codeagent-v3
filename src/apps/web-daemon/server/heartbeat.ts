/**
 * `@/apps/web-daemon/server/heartbeat` — app-level keepalive short-circuit.
 *
 * Clients send a `heartbeat` `ping` on a ~25s timer to keep an otherwise-idle
 * WS path warm past a proxy's idle timeout; the daemon answers each ping with a
 * pre-encoded `pong`. `replyToHeartbeat` consumes the frame before it reaches
 * the session bridge so the bridge's 5-kind contract stays unchanged.
 */

import { encodeSessionTransportMessage, type SessionTransportMessage } from "@/ipc/session"

/**
 * App-level keepalive (ADR — comms heartbeat). Clients send a `heartbeat`
 * `ping` on a ~25s timer to keep an otherwise-idle WS path warm past a
 * proxy's idle timeout; the daemon answers each ping with a `pong` so the
 * client's liveness deadline is reset. Pre-encoded once — every reply is the
 * SAME byte string, so there is no per-ping allocation on the hot path.
 *
 * The interval lives client-side (the daemon is purely reactive: one pong per
 * ping). It is named here as the documented contract rather than scattered as
 * a magic literal in the frontend timer.
 */
export const HEARTBEAT_INTERVAL_MS = 25_000
const HEARTBEAT_PONG_FRAME = encodeSessionTransportMessage({ kind: "heartbeat", phase: "pong" })

/** Minimal `ws.send`-only surface the heartbeat reply writes to. */
interface HeartbeatSendable {
  send(data: string | Uint8Array): unknown
}

/**
 * Pure heartbeat short-circuit. Returns `true` when `decoded` is a heartbeat
 * frame the message pump should consume (a `ping` is answered with a `pong`; a
 * `pong` — or our own reply — is terminal and never forwarded), `false` when
 * the frame is NOT a heartbeat and must fall through to the session bridge.
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
