import {
  type CreateSessionTransportClientOpts,
  createSessionTransportClient,
  type SessionTransportClient,
} from "./client"
import {
  type CreateSessionStdioTransportOpts,
  createSessionStdioTransport,
  type StdioReader,
  type StdioWriter,
} from "./transports/stdio"

export interface CreateSessionStdioClientOpts extends CreateSessionStdioTransportOpts {
  readonly sessionId: string
  readonly resumeFromSeq?: number
}

export const createSessionStdioClient = (
  opts: CreateSessionStdioClientOpts,
): SessionTransportClient =>
  createSessionTransportClient({
    transport: createSessionStdioTransport({
      reader: opts.reader,
      writer: opts.writer,
    }),
    sessionId: opts.sessionId,
    ...(opts.resumeFromSeq !== undefined ? { resumeFromSeq: opts.resumeFromSeq } : {}),
  } satisfies CreateSessionTransportClientOpts)

export type { StdioReader, StdioWriter }
