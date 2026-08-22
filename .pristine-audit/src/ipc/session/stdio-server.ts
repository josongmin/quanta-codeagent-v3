import type { SessionTransportBridge } from "./bridge"
import { bindSessionTransportServer, type SessionTransportServer } from "./server"
import {
  type CreateSessionStdioTransportOpts,
  createSessionStdioTransport,
  type StdioReader,
  type StdioWriter,
} from "./transports/stdio"

export interface CreateSessionStdioServerOpts extends CreateSessionStdioTransportOpts {
  readonly bridge: SessionTransportBridge
}

export const createSessionStdioServer = async (
  opts: CreateSessionStdioServerOpts,
): Promise<SessionTransportServer> =>
  await bindSessionTransportServer({
    bridge: opts.bridge,
    transport: createSessionStdioTransport({
      reader: opts.reader,
      writer: opts.writer,
    }),
  })

export type { StdioReader, StdioWriter }
