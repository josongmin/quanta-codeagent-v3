/** Generation-scoped HTTP OAuth reauthorization (C-F9 / W0.5 freeze).
 *
 *  Replacement order: create → start → initialize → initialized notification
 *  → negotiated state publish. Handshake uses a raw RPC (no 401→refresh) so an
 *  initialize-in-flight 401 cannot recurse into the same refresh.
 *
 *  Replay is allow-listed: idempotent initialize/list that failed with a proven
 *  auth rejection. `tools/call` whose completion is unknown is NEVER auto-replayed.
 *  Old pending requests fail (they must not hang on the rebuilt carrier). */

import { errMessage, logger } from "@/shared"
import type { JsonRpcMessage } from "../jsonrpc"
import type { McpTransport } from "../transports/port"
import type { McpServerConfig } from "../types"
import { isUnauthorizedError, McpError } from "./errors"
import { initializeWithDowngrade, pinNegotiatedVersion } from "./negotiate"
import { asRecord } from "./result-folding"

const REPLAYABLE_EXACT = new Set([
  "initialize",
  "tools/list",
  "resources/list",
  "prompts/list",
  "resources/templates/list",
])

/** Idempotent initialize/list only. Side-effecting `tools/call` is forbidden. */
export const isReplayableAfterReauth = (method: string): boolean => REPLAYABLE_EXACT.has(method)

export interface HandshakeResult {
  readonly capabilities: Record<string, unknown>
  readonly negotiatedVersion: string
}

export const handshakeOnTransport = async (opts: {
  offeredVersion: string
  getTransport: () => McpTransport
  sendInitialize: (version: string) => Promise<unknown>
  notifyInitialized: () => void
  serverName: string
}): Promise<HandshakeResult> => {
  const { result: initResult, offered } = await initializeWithDowngrade(
    opts.offeredVersion,
    opts.getTransport(),
    opts.sendInitialize,
  )
  const capabilities = asRecord(initResult)?.capabilities
    ? (asRecord(asRecord(initResult)?.capabilities) ?? {})
    : {}
  const negotiatedVersion = pinNegotiatedVersion(
    initResult,
    offered,
    opts.getTransport(),
    opts.serverName,
  )
  opts.notifyInitialized()
  return { capabilities, negotiatedVersion }
}

export interface ReauthSession {
  readonly oauthActive: boolean
  readonly serverName: string
  readonly offeredVersion: string
  stoppedOrExited(): boolean
  hasFactory(): boolean
  invalidate(): Promise<void>
  tokenFor(): Promise<string | undefined>
  failOldPending(reason: Error): void
  unwire(): void
  takeOldTransport(): McpTransport | null
  buildCandidate(token: string): McpTransport
  installCandidate(transport: McpTransport, generation: number): void
  restoreTransport(transport: McpTransport | null, generation: number): void
  bumpGeneration(): number
  sendInitializeRaw(version: string): Promise<unknown>
  notifyInitialized(): void
  publishHandshake(result: HandshakeResult): void
  closeQuiet(transport: McpTransport | null): Promise<void>
  setRefreshing(value: boolean): void
}

/** Private McpClient surface the binder reads. Not a public API. */
export interface ReauthBindTarget {
  oauthActive: boolean
  config: { readonly name: string } & McpServerConfig
  offeredVersion: string
  stopped: boolean
  exited: boolean
  transportFactory: ((config: McpServerConfig) => McpTransport) | null
  transport: McpTransport | null
  oauthProvider: {
    invalidate(serverName: string): Promise<void>
    tokenFor(serverName: string): Promise<string | undefined>
  }
  unsubscribeMessage: (() => void) | null
  unsubscribeExit: (() => void) | null
  dispatchGeneration: number
  refreshing: boolean
  serverCapabilities: Record<string, unknown> | null
  negotiatedVersion: string | null
  failAllPending(reason: Error): void
  withBearer(config: McpServerConfig, token: string | undefined): McpServerConfig
  requestRpc(method: string, params: unknown): Promise<unknown>
  notify(method: string, params: unknown): void
  dispatch(msg: JsonRpcMessage): void
  onTransportExit(): void
  initializeParams(version: string): Record<string, unknown>
}

export const bindReauthSession = (client: ReauthBindTarget): ReauthSession => ({
  oauthActive: client.oauthActive,
  serverName: client.config.name,
  offeredVersion: client.offeredVersion,
  stoppedOrExited: () => client.stopped || client.exited,
  hasFactory: () => client.transportFactory !== null,
  invalidate: () => client.oauthProvider.invalidate(client.config.name),
  tokenFor: () => client.oauthProvider.tokenFor(client.config.name),
  failOldPending: (reason) => client.failAllPending(reason),
  unwire: () => {
    client.unsubscribeMessage?.()
    client.unsubscribeMessage = null
    client.unsubscribeExit?.()
    client.unsubscribeExit = null
  },
  takeOldTransport: () => client.transport,
  buildCandidate: (token) => {
    const factory = client.transportFactory
    if (factory === null) {
      throw new McpError(`mcp server "${client.config.name}" has no transport factory`)
    }
    return factory(client.withBearer(client.config, token))
  },
  installCandidate: (transport, generation) => {
    client.transport = transport
    client.unsubscribeMessage = transport.onMessage((msg) => {
      if (client.dispatchGeneration !== generation) return
      client.dispatch(msg)
    })
    client.unsubscribeExit = transport.onExit(() => client.onTransportExit())
  },
  restoreTransport: (transport, generation) => {
    client.transport = transport
    if (transport === null) return
    client.unsubscribeMessage = transport.onMessage((msg) => {
      if (client.dispatchGeneration !== generation) return
      client.dispatch(msg)
    })
    client.unsubscribeExit = transport.onExit(() => client.onTransportExit())
  },
  bumpGeneration: () => {
    client.dispatchGeneration += 1
    return client.dispatchGeneration
  },
  sendInitializeRaw: (version) => client.requestRpc("initialize", client.initializeParams(version)),
  notifyInitialized: () => client.notify("notifications/initialized", {}),
  publishHandshake: (result) => {
    client.serverCapabilities = result.capabilities
    client.negotiatedVersion = result.negotiatedVersion
  },
  closeQuiet: async (transport) => {
    // Best-effort, but NOT silent: a transport that cannot be closed during
    // reauthorization leaks a connection, and swallowing the reason is how a
    // leak becomes unattributable. There is nothing to do about it here — the
    // reauth path must continue — so it is recorded and dropped deliberately.
    await transport?.close().catch((error: unknown) => {
      logger.debug(`mcp reauthorize: transport close failed: ${errMessage(error)}`)
    })
  },
  setRefreshing: (value) => {
    client.refreshing = value
  },
})

const closeFailed = async (
  session: ReauthSession,
  transport: McpTransport | null,
): Promise<void> => {
  await session.closeQuiet(transport)
}

export const runReauthTransaction = async (session: ReauthSession): Promise<boolean> => {
  if (session.stoppedOrExited()) return false
  if (!session.hasFactory()) return false
  await session.invalidate()
  const token = await session.tokenFor()
  if (token === undefined || session.stoppedOrExited()) return false

  session.setRefreshing(true)
  const old = session.takeOldTransport()
  session.unwire()
  session.failOldPending(
    new McpError(`mcp server "${session.serverName}" reauthorizing; pending request cancelled`),
  )
  const generation = session.bumpGeneration()
  const candidate = session.buildCandidate(token)
  session.installCandidate(candidate, generation)

  try {
    await candidate.start()
    if (session.stoppedOrExited()) {
      session.unwire()
      await closeFailed(session, candidate)
      await session.closeQuiet(old)
      return false
    }
    const handshake = await handshakeOnTransport({
      offeredVersion: session.offeredVersion,
      getTransport: () => candidate,
      sendInitialize: (version) => session.sendInitializeRaw(version),
      notifyInitialized: () => session.notifyInitialized(),
      serverName: session.serverName,
    })
    if (session.stoppedOrExited()) {
      session.unwire()
      await closeFailed(session, candidate)
      await session.closeQuiet(old)
      return false
    }
    session.publishHandshake(handshake)
    await session.closeQuiet(old)
    return true
  } catch {
    session.unwire()
    await closeFailed(session, candidate)
    const generation = session.bumpGeneration()
    session.restoreTransport(old, generation)
    return false
  } finally {
    session.setRefreshing(false)
  }
}

export const recoverUnauthorized = async (
  session: ReauthSession,
  method: string,
  err: unknown,
  refreshing: boolean,
  reauthorize: () => Promise<boolean>,
  retry: () => Promise<unknown>,
): Promise<unknown> => {
  if (!session.oauthActive || !isUnauthorizedError(err)) throw err
  // Handshake 401 must not recurse into the same refresh (deadlock / nested rebuild).
  if (refreshing) throw err
  const reauthed = await reauthorize()
  if (!reauthed) throw err
  if (!isReplayableAfterReauth(method)) throw err
  return retry()
}
