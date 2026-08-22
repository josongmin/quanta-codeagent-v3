import type { SessionTransportBridge } from "./bridge"
import { bindSessionTransportServer, type SessionTransportServer } from "./server"
import {
  type SessionWebSocketLike,
  wrapWebSocketLikeAsSessionTransport,
} from "./transports/websocket"

export interface CreateSessionWebSocketServerOpts {
  readonly bridge: SessionTransportBridge
  readonly socket: SessionWebSocketLike
}

export const createSessionWebSocketServer = async (
  opts: CreateSessionWebSocketServerOpts,
): Promise<SessionTransportServer> =>
  await bindSessionTransportServer({
    bridge: opts.bridge,
    transport: wrapWebSocketLikeAsSessionTransport(opts.socket),
  })

export type { SessionWebSocketLike }
