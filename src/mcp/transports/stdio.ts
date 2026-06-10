/** Stdio transport for the MCP client (ADR-0391).
 *
 *  This is the DEFAULT carrier and a byte-identical extraction of the spawn +
 *  stdin.write + stdout-pump + proc.exited logic that previously lived inline
 *  in `../client.ts`. The encoding (`encodeMessage`) and framing (`LineReader`)
 *  coupling now lives here, behind the {@link McpTransport} port, instead of in
 *  the client core.
 *
 *  Env policy is unchanged: the full parent env is intentionally NOT inherited
 *  so host secrets never reach an arbitrary server; only PATH is kept so the
 *  command resolves, plus anything the config explicitly opted in.
 *
 *  Egress-proxy carve-out (H3): the non-inheritance above is a SECRET-leak
 *  defense — it withholds host API keys from an arbitrary server. It is NOT an
 *  egress-gating decision. When the operator turns ON `QUANTA_NETWORK_PROXY`,
 *  the loopback proxy's `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` env vars (the SAME
 *  enforcement signals bash/docker children already receive via
 *  `ToolContext.proxyEnv`) MUST also reach the MCP server child — otherwise the
 *  server's own sockets bypass the allowlist entirely. These keys carry no host
 *  secrets, only the proxy address, so injecting them preserves the secret
 *  defense. The injection is byte-identical when the proxy is OFF: an absent
 *  `proxyEnv.address` leaves `withProxyEnv` a no-op (same env, no proxy keys). */

import type { Subprocess } from "bun"
import { type ProxyEnvInput, withProxyEnv } from "@/runtime/network-proxy"
import { errMessage, logger } from "@/shared"
import { encodeMessage, LineReader } from "../jsonrpc"
import type { McpServerConfig } from "../types"
import type {
  McpTransport,
  McpTransportExitHandler,
  McpTransportMessageHandler,
  McpTransportPayload,
} from "./port"

/** Build the spawn env. The full parent env is intentionally NOT inherited so
 *  host secrets never reach an arbitrary server; only PATH is kept so the
 *  command resolves, plus anything the config explicitly opted in.
 *  (Moved verbatim from `../client.ts` — byte-identical.) */
const buildEnv = (
  configEnv?: Record<string, string>,
  proxyEnv?: ProxyEnvInput,
): Record<string, string> => {
  const base: Record<string, string> = {}
  const path = process.env.PATH
  if (path !== undefined) base.PATH = path
  const withConfig = configEnv === undefined ? base : { ...base, ...configEnv }
  // Egress-proxy carve-out (H3): inject HTTP_PROXY/HTTPS_PROXY/NO_PROXY when —
  // and ONLY when — a live proxy address is supplied. With no address (proxy
  // OFF) `withProxyEnv` returns the SAME object unchanged ⇒ byte-identical.
  // The result is narrowed back to a plain string record (these keys are always
  // string-valued; no `undefined` is introduced).
  return withProxyEnv(withConfig, proxyEnv ?? {}) as Record<string, string>
}

/** Optional spawn seam so tests can drive the transport without a real
 *  subprocess. Defaults to `Bun.spawn`. */
export type StdioSpawnFn = (
  command: string[],
  opts: {
    cwd: string
    env: Record<string, string>
    stdin: "pipe"
    stdout: "pipe"
    stderr: "pipe"
  },
) => Subprocess<"pipe", "pipe", "pipe">

const defaultSpawn: StdioSpawnFn = (command, opts) =>
  Bun.spawn(command, opts) as Subprocess<"pipe", "pipe", "pipe">

export interface StdioTransportOpts {
  /** Spawn seam (test injection). Default = `Bun.spawn`. */
  readonly spawn?: StdioSpawnFn
  /** Egress-proxy env to inject into the spawned server (H3). Supplied by the
   *  wiring site from a live {@link withEgressProxy} context. Absent / no
   *  `address` ⇒ NO proxy keys are added (byte-identical to the pre-H3
   *  transport). Carries the proxy ADDRESS only — never a host secret. */
  readonly proxyEnv?: ProxyEnvInput
}

/** Newline-delimited JSON-RPC over a spawned subprocess's stdio. */
export class StdioMcpTransport implements McpTransport {
  private readonly config: McpServerConfig
  private readonly spawnFn: StdioSpawnFn
  private readonly proxyEnv: ProxyEnvInput
  private readonly reader = new LineReader()
  private readonly messageHandlers = new Set<McpTransportMessageHandler>()
  private readonly exitHandlers = new Set<McpTransportExitHandler>()

  private proc: Subprocess<"pipe", "pipe", "pipe"> | null = null
  private readPump: Promise<void> | null = null
  private stderrPump: Promise<void> | null = null
  private exitFired = false

  constructor(config: McpServerConfig, opts: StdioTransportOpts = {}) {
    this.config = config
    this.spawnFn = opts.spawn ?? defaultSpawn
    this.proxyEnv = opts.proxyEnv ?? {}
  }

  async start(): Promise<void> {
    if (this.proc) return
    this.proc = this.spawnFn(this.config.command, {
      cwd: this.config.cwd ?? process.cwd(),
      // H3: thread the stored egress-proxy env into the child. With no live
      // proxy address (`proxyEnv` absent / `{}`) `withProxyEnv` is a no-op ⇒
      // byte-identical to the pre-H3 spawn. With a live address the child's own
      // sockets are forced through the loopback allowlist (no egress bypass).
      env: buildEnv(this.config.env, this.proxyEnv),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    })
    this.readPump = this.pumpStdout()
    // Drain stderr to completion so a chatty server (debug logs) can never fill
    // the OS pipe buffer (~64KB) and block its own next stderr write — which
    // would stall stdout JSON-RPC and hang every pending request to timeout.
    // We discard the bytes (no diagnostics surface here); the goal is purely to
    // keep the pipe empty. Mirrors the stdout pump's stored-promise lifecycle.
    this.stderrPump = this.drainStderr()
    this.watchExit()
  }

  onMessage(handler: McpTransportMessageHandler): () => void {
    this.messageHandlers.add(handler)
    return () => {
      this.messageHandlers.delete(handler)
    }
  }

  /** No-op: stdio carries the protocol version only in the `initialize` request
   *  BODY (which the client controls), never in a per-request header. The
   *  negotiated pin is therefore irrelevant to this carrier — byte-identical to
   *  the pre-ticket stdio transport. */
  setProtocolVersion(_version: string): void {
    // stdio stamps no header; the negotiated version has no wire effect here.
  }

  onExit(handler: McpTransportExitHandler): () => void {
    this.exitHandlers.add(handler)
    return () => {
      this.exitHandlers.delete(handler)
    }
  }

  send(payload: McpTransportPayload): Error | null {
    const stdin = this.proc?.stdin
    if (!stdin) {
      const err = new Error(`mcp server "${this.config.name}" transport unavailable: stdin closed`)
      logger.warn("mcp: failed to write to server stdin", { error: err.message })
      return err
    }
    try {
      stdin.write(encodeMessage(payload))
      return null
    } catch (e) {
      const msg = errMessage(e)
      logger.warn("mcp: failed to write to server stdin", { error: msg })
      return new Error(`mcp server "${this.config.name}" transport write failed: ${msg}`)
    }
  }

  async close(): Promise<void> {
    const proc = this.proc
    if (!proc) return
    try {
      proc.stdin?.end()
    } catch {
      // stdin may already be closed
    }
    try {
      proc.kill()
    } catch {
      // process may have already exited
    }
    await proc.exited.catch(() => undefined)
    await this.readPump?.catch(() => undefined)
    await this.stderrPump?.catch(() => undefined)
    this.proc = null
  }

  // --- internals -----------------------------------------------------------

  private async pumpStdout(): Promise<void> {
    const stdout = this.proc?.stdout
    if (!stdout) return
    try {
      for await (const chunk of stdout) {
        for (const msg of this.reader.push(chunk)) this.emitMessage(msg)
      }
    } catch (e) {
      logger.debug("mcp: stdout pump ended", { error: errMessage(e) })
    }
  }

  /** Background drain of the child's stderr. Reading to completion keeps the
   *  OS stderr pipe from filling (which would otherwise block the child's next
   *  stderr write and stall its stdout JSON-RPC). Bytes are discarded — this is
   *  a deadlock guard, not a diagnostics sink. Tolerant of a test fakeProc with
   *  no stderr (same guard as {@link pumpStdout}). */
  private async drainStderr(): Promise<void> {
    const stderr = this.proc?.stderr
    if (!stderr || typeof stderr === "number") return
    try {
      for await (const _ of stderr) {
        // discard — purpose is to keep the pipe empty so the child never blocks
      }
    } catch (e) {
      logger.debug("mcp: stderr drain ended", { error: errMessage(e) })
    }
  }

  private watchExit(): void {
    const proc = this.proc
    if (!proc) return
    const onExit = () => this.fireExit(`mcp server "${this.config.name}" exited`)
    proc.exited.then(onExit).catch(onExit)
  }

  private emitMessage(msg: Parameters<McpTransportMessageHandler>[0]): void {
    for (const handler of [...this.messageHandlers]) {
      try {
        handler(msg)
      } catch {
        // A failing handler must not poison sibling subscribers or the pump.
      }
    }
  }

  private fireExit(reason: string): void {
    if (this.exitFired) return
    this.exitFired = true
    for (const handler of [...this.exitHandlers]) {
      try {
        handler(reason)
      } catch {
        // ignore handler errors during teardown
      }
    }
  }
}
