import {
  type CreateSessionTransportClientOpts,
  createSessionTransportClient,
  type SessionTransportClient,
} from "./client"
import {
  type SessionWebSocketLike,
  wrapWebSocketLikeAsSessionTransport,
} from "./transports/websocket"

export interface CreateSessionWebSocketClientOpts {
  readonly socket: SessionWebSocketLike
  readonly sessionId: string
  readonly resumeFromSeq?: number
  /** S5 — typed `rejected` surfacing, forwarded to the transport client. */
  readonly onRejected?: CreateSessionTransportClientOpts["onRejected"]
}

export const createSessionWebSocketClient = (
  opts: CreateSessionWebSocketClientOpts,
): SessionTransportClient =>
  createSessionTransportClient({
    transport: wrapWebSocketLikeAsSessionTransport(opts.socket),
    sessionId: opts.sessionId,
    ...(opts.resumeFromSeq !== undefined ? { resumeFromSeq: opts.resumeFromSeq } : {}),
    ...(opts.onRejected !== undefined ? { onRejected: opts.onRejected } : {}),
  } satisfies CreateSessionTransportClientOpts)

export type { SessionWebSocketLike }
