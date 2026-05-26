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
}

export const createSessionWebSocketClient = (
  opts: CreateSessionWebSocketClientOpts,
): SessionTransportClient =>
  createSessionTransportClient({
    transport: wrapWebSocketLikeAsSessionTransport(opts.socket),
    sessionId: opts.sessionId,
    ...(opts.resumeFromSeq !== undefined ? { resumeFromSeq: opts.resumeFromSeq } : {}),
  } satisfies CreateSessionTransportClientOpts)

export type { SessionWebSocketLike }
