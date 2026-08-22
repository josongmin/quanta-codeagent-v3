import type { ConnectedSessionTransport, SessionTransportBridge } from "./bridge"
import type { SessionTransport } from "./types"

export interface BindSessionTransportServerOpts {
  readonly bridge: SessionTransportBridge
  readonly transport: SessionTransport
}

export interface SessionTransportServer {
  readonly transport: SessionTransport
  close(): Promise<void>
}

export const bindSessionTransportServer = async (
  opts: BindSessionTransportServerOpts,
): Promise<SessionTransportServer> => {
  let closed = false
  const peer: ConnectedSessionTransport = await opts.bridge.connect(opts.transport)

  return {
    transport: opts.transport,
    async close() {
      if (closed) return
      closed = true
      await peer.close()
    },
  }
}
