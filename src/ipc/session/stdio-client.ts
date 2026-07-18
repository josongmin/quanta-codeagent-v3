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
  /** S5 — typed `rejected` surfacing, forwarded to the transport client. */
  readonly onRejected?: CreateSessionTransportClientOpts["onRejected"]
  /** Ticket 04 — request wire full fidelity, forwarded to the transport client. */
  readonly requestedFidelity?: CreateSessionTransportClientOpts["requestedFidelity"]
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
    ...(opts.onRejected !== undefined ? { onRejected: opts.onRejected } : {}),
    ...(opts.requestedFidelity !== undefined ? { requestedFidelity: opts.requestedFidelity } : {}),
  } satisfies CreateSessionTransportClientOpts)

export type { StdioReader, StdioWriter }
