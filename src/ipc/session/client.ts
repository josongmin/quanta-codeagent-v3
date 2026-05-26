import { type SessionCommand, SessionProtocolValidationError } from "@/protocol/session"
import type { SessionTransport, SessionTransportHandler, SessionTransportMessage } from "./types"

export interface CreateSessionTransportClientOpts {
  readonly transport: SessionTransport
  readonly sessionId: string
  readonly resumeFromSeq?: number
}

export interface SessionTransportClient {
  readonly sessionId: string
  readonly transport: SessionTransport
  connect(opts?: { readonly resumeFromSeq?: number }): Promise<void>
  sendCommand(command: SessionCommand): Promise<void>
  onMessage(handler: SessionTransportHandler): () => void
  currentResumeFromSeq(): number | undefined
  close(): Promise<void>
}

const nextResumeFromSeq = (
  prior: number | undefined,
  message: SessionTransportMessage,
): number | undefined => {
  switch (message.kind) {
    case "snapshot":
      return prior === undefined ? message.snapshot.seq : Math.max(prior, message.snapshot.seq)
    case "event":
      return prior === undefined ? message.event.seq : Math.max(prior, message.event.seq)
    default:
      return prior
  }
}

export const createSessionTransportClient = (
  opts: CreateSessionTransportClientOpts,
): SessionTransportClient => {
  const handlers = new Set<SessionTransportHandler>()
  let closed = false
  let resumeFromSeq = opts.resumeFromSeq

  const unsubscribe = opts.transport.onMessage((message) => {
    resumeFromSeq = nextResumeFromSeq(resumeFromSeq, message)
    for (const handler of [...handlers]) {
      try {
        const result = handler(message)
        if (result instanceof Promise) {
          void result.catch(() => undefined)
        }
      } catch {
        // Swallow per-handler errors to avoid poisoning sibling subscribers.
      }
    }
  })

  return {
    sessionId: opts.sessionId,
    transport: opts.transport,
    async connect(override) {
      if (closed) return
      const next = override?.resumeFromSeq ?? resumeFromSeq
      await opts.transport.send({
        kind: "connect",
        sessionId: opts.sessionId,
        ...(next !== undefined ? { resumeFromSeq: next } : {}),
      })
    },
    async sendCommand(command) {
      if (closed) return
      if (command.sessionId !== opts.sessionId) {
        throw new SessionProtocolValidationError("session_id_mismatch")
      }
      await opts.transport.send({ kind: "command", command })
    },
    onMessage(handler) {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    currentResumeFromSeq() {
      return resumeFromSeq
    },
    async close() {
      if (closed) return
      closed = true
      handlers.clear()
      unsubscribe()
      await opts.transport.close()
    },
  }
}
