/**
 * session.v1 connect-handshake driver (PURE).
 *
 * The daemon publishes ONE shared session over a single WS speaking session.v1.
 * A joining client does NOT know the canonical session id up front, so it
 * follows the same discovery dance the web frontend uses
 * (`apps/web-frontend/src/ws/client.ts`):
 *
 *   1. send a `connect` frame carrying a non-empty DISCOVERY SENTINEL
 *      (`"ui-session"`) — never the real id (we don't have it yet);
 *   2. the bridge rejects it with `target: "connect"`, `reason:
 *      "session_id_mismatch"`, and `sessionId: <canonical>` — we ADOPT that id
 *      and immediately re-handshake addressed to it;
 *   3. the bridge replies with a `snapshot` (and any replay tail) — the
 *      handshake is now READY and every subsequent command must carry the
 *      canonical id.
 *
 * This unit owns ONLY the frame-shaping + id-adoption decision; the transport
 * (socket I/O) lives in `attach-client.ts`. Keeping it pure makes the
 * discovery→adopt logic unit-testable without a live socket — the transport
 * client (`@/ipc/session`) deliberately does NOT replicate the frontend
 * `SessionClient`'s adoption loop, so we reproduce it here.
 */

import type { SessionTransportMessage } from "@/ipc/session"

/** Matches the frontend's discovery sentinel verbatim — the bridge keys its
 *  mismatch-reject off "not the canonical id", and the sentinel is simply a
 *  non-empty placeholder that can never equal a real (uuid-shaped) id. */
export const HANDSHAKE_DISCOVERY_SESSION_ID = "ui-session"

export interface AttachHandshake {
  /** Canonical, server-minted session id once learned; `undefined` until then. */
  readonly sessionId: string | undefined
  /** True once a snapshot has settled the handshake (commands may now flow). */
  readonly ready: boolean
  /** Highest seq observed (resume cursor); `undefined` until a seq-bearing frame. */
  readonly lastSeq: number | undefined
  /** Build the FIRST connect frame (discovery sentinel, no resume cursor). */
  initialConnect(): SessionTransportMessage
  /**
   * Feed an inbound transport message. Returns a `connect` frame to SEND when
   * the handshake must re-issue (canonical id just adopted), else `undefined`.
   */
  onMessage(message: SessionTransportMessage): SessionTransportMessage | undefined
}

const connectFrame = (sessionId: string, resumeFromSeq?: number): SessionTransportMessage => ({
  kind: "connect",
  sessionId,
  ...(resumeFromSeq !== undefined ? { resumeFromSeq } : {}),
})

export const createAttachHandshake = (): AttachHandshake => {
  let sessionId: string | undefined
  let ready = false
  let lastSeq: number | undefined

  const trackSeq = (seq: number): void => {
    if (!Number.isFinite(seq)) return
    lastSeq = lastSeq === undefined ? seq : Math.max(lastSeq, seq)
  }

  /** Re-handshake frame: carry the resume cursor only on a reconnect where we
   *  already know the canonical id AND have seen a seq (matches the frontend —
   *  the discovery bootstrap never resumes). */
  const reHandshake = (id: string): SessionTransportMessage =>
    lastSeq !== undefined ? connectFrame(id, lastSeq) : connectFrame(id)

  return {
    get sessionId() {
      return sessionId
    },
    get ready() {
      return ready
    },
    get lastSeq() {
      return lastSeq
    },
    initialConnect() {
      return connectFrame(sessionId ?? HANDSHAKE_DISCOVERY_SESSION_ID)
    },
    onMessage(message) {
      switch (message.kind) {
        case "rejected": {
          // Only a CONNECT-target reject carries the canonical id for adoption;
          // a COMMAND-target reject (dedup / revision / validation) is handled
          // elsewhere and never re-drives the handshake.
          if (
            message.target === "connect" &&
            message.sessionId.length > 0 &&
            message.sessionId !== HANDSHAKE_DISCOVERY_SESSION_ID &&
            sessionId !== message.sessionId
          ) {
            sessionId = message.sessionId
            return reHandshake(sessionId)
          }
          return undefined
        }
        case "snapshot": {
          trackSeq(message.snapshot.seq)
          // A server may answer the discovery connect with a snapshot directly
          // (no reject) — adopt the id from the snapshot in that case.
          if (sessionId === undefined || sessionId !== message.snapshot.sessionId) {
            sessionId = message.snapshot.sessionId
          }
          ready = true
          return undefined
        }
        case "event": {
          trackSeq(message.event.seq)
          return undefined
        }
        default:
          return undefined
      }
    },
  }
}
