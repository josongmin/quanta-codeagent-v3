import { mkdir, unlink } from "node:fs/promises"
import { connect, createServer, type Server, type Socket } from "node:net"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ProactiveTrigger, TriggerEvidence, TriggerReason } from "@/reactor"
import { sanitizeId } from "@/session"
import { isRecord } from "@/shared"

const REACTOR_WATCH_PROTOCOL = "quanta.reactor_watch.v1" as const

interface ReactorWatchTriggerWire {
  readonly reason: TriggerReason
  readonly evidence: TriggerEvidence
  readonly simulatedMessage: string
}

interface ReactorWatchEnvelope {
  readonly protocol: typeof REACTOR_WATCH_PROTOCOL
  readonly sessionId: string
  readonly trigger: ReactorWatchTriggerWire
}

export interface ReactorWatchBridgeServer {
  readonly socketPath: string
  close(): Promise<void>
}

export interface StartReactorWatchBridgeOpts {
  readonly sessionId: string
  readonly onTrigger: (trigger: ProactiveTrigger) => Promise<void> | void
  readonly socketPath?: string
  readonly onError?: (message: string) => void
}

export interface PublishReactorWatchTriggerOpts {
  readonly sessionId: string
  readonly trigger: ProactiveTrigger
  readonly socketPath?: string
}

const normalizeSocketPath = (home: string, sessionId: string): string =>
  join(home.replace(/\/+$/, ""), ".quanta", `reactor-${sanitizeId(sessionId)}.sock`)

export const reactorWatchSocketPath = (sessionId: string, home = homedir()): string =>
  normalizeSocketPath(home, sessionId)

const unlinkIfExists = async (path: string): Promise<void> => {
  try {
    await unlink(path)
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") {
      throw error
    }
  }
}

export const parseReactorWatchEnvelope = (raw: string): ReactorWatchEnvelope | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (!isRecord(parsed)) return undefined
  if (parsed.protocol !== REACTOR_WATCH_PROTOCOL) return undefined
  if (typeof parsed.sessionId !== "string" || parsed.sessionId.length === 0) return undefined
  if (!isRecord(parsed.trigger)) return undefined
  const trigger = parsed.trigger
  if (typeof trigger.reason !== "string") return undefined
  if (typeof trigger.simulatedMessage !== "string") return undefined
  if (!isRecord(trigger.evidence)) return undefined
  const evidence = trigger.evidence
  if (
    (evidence.kind !== "url" && evidence.kind !== "sha" && evidence.kind !== "log_path") ||
    typeof evidence.value !== "string"
  ) {
    return undefined
  }
  return {
    protocol: REACTOR_WATCH_PROTOCOL,
    sessionId: parsed.sessionId,
    trigger: {
      reason: trigger.reason as TriggerReason,
      evidence: { kind: evidence.kind, value: evidence.value },
      simulatedMessage: trigger.simulatedMessage,
    },
  }
}

export const toDetachedReactorWatchTrigger = (wire: ReactorWatchTriggerWire): ProactiveTrigger =>
  Object.freeze({
    reason: wire.reason,
    evidence: Object.freeze(wire.evidence),
    simulatedMessage: wire.simulatedMessage,
    abortSignal: new AbortController().signal,
  })

const safeMessage = (error: unknown): string =>
  error instanceof Error ? error.message : typeof error === "string" ? error : "unknown"

export const deliverReactorWatchEnvelope = async (args: {
  readonly raw: string
  sessionId: string
  onTrigger: (trigger: ProactiveTrigger) => Promise<void> | void
  onError?: (message: string) => void
}): Promise<void> => {
  const envelope = parseReactorWatchEnvelope(args.raw)
  if (envelope === undefined) {
    args.onError?.("reactor-watch bridge: dropped malformed envelope")
    return
  }
  if (envelope.sessionId !== args.sessionId) return
  try {
    await args.onTrigger(toDetachedReactorWatchTrigger(envelope.trigger))
  } catch (error) {
    args.onError?.(`reactor-watch bridge: onTrigger failed: ${safeMessage(error)}`)
  }
}

const attachSocketReader = (
  socket: Socket,
  sessionId: string,
  onTrigger: (trigger: ProactiveTrigger) => Promise<void> | void,
  onError?: (message: string) => void,
): void => {
  let buffer = ""
  socket.setEncoding("utf8")
  socket.on("data", (chunk: string) => {
    buffer += chunk
    let nl = buffer.indexOf("\n")
    while (nl !== -1) {
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 1)
      void deliverReactorWatchEnvelope({
        raw: line,
        sessionId,
        onTrigger,
        ...(onError !== undefined ? { onError } : {}),
      })
      nl = buffer.indexOf("\n")
    }
  })
  socket.on("error", (error) => {
    onError?.(`reactor-watch bridge: socket error: ${safeMessage(error)}`)
  })
}

export const startReactorWatchBridge = async (
  opts: StartReactorWatchBridgeOpts,
): Promise<ReactorWatchBridgeServer> => {
  const sessionId = sanitizeId(opts.sessionId)
  const socketPath = opts.socketPath ?? reactorWatchSocketPath(sessionId)
  await mkdir(dirname(socketPath), { recursive: true })
  await unlinkIfExists(socketPath)
  const server = createServer((socket) =>
    attachSocketReader(socket, sessionId, opts.onTrigger, opts.onError),
  )
  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off("listening", onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off("error", onError)
      resolve()
    }
    server.once("error", onError)
    server.once("listening", onListening)
    server.listen(socketPath)
  })
  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()))
      await unlinkIfExists(socketPath)
    },
  }
}

export const buildReactorWatchEnvelope = (
  sessionId: string,
  trigger: ProactiveTrigger,
): ReactorWatchEnvelope => ({
  protocol: REACTOR_WATCH_PROTOCOL,
  sessionId,
  trigger: {
    reason: trigger.reason,
    evidence: trigger.evidence,
    simulatedMessage: trigger.simulatedMessage,
  },
})

export const encodeReactorWatchEnvelope = (sessionId: string, trigger: ProactiveTrigger): string =>
  `${JSON.stringify(buildReactorWatchEnvelope(sessionId, trigger))}\n`

export const publishReactorWatchTrigger = async (
  opts: PublishReactorWatchTriggerOpts,
): Promise<void> => {
  const sessionId = sanitizeId(opts.sessionId)
  const socketPath = opts.socketPath ?? reactorWatchSocketPath(sessionId)
  const payload = encodeReactorWatchEnvelope(sessionId, opts.trigger)
  await new Promise<void>((resolve, reject) => {
    const socket = connect(socketPath)
    let settled = false
    const finish = (cb: () => void): void => {
      if (settled) return
      settled = true
      cb()
    }
    socket.once("connect", () => {
      socket.write(payload)
      socket.end()
    })
    socket.once("error", (error) => {
      finish(() => reject(error))
    })
    socket.once("close", (hadError) => {
      if (hadError) return
      finish(resolve)
    })
  })
}
