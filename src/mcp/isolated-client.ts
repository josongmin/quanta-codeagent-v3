/**
 * Alternative `McpClient` backed by the `@/plugin-isolation` spawner port
 * (ADR-0162 Phase E).
 *
 * **Default OFF** — gated by `MCP_USE_ISOLATED_SPAWN=1`. The legacy
 * {@link McpClient} (direct `Bun.spawn` in `./client.ts`) remains the default
 * code path, preserving byte-identical behavior for every existing
 * deployment. Setting the env var swaps the spawn implementation; the public
 * surface (`start` / `listTools` / `callTool` / `stop`) is identical.
 *
 * Why opt-in? The isolated client adds:
 *  - 5s typed spawn-timeout (the legacy client waits only for stdin/stdout
 *    pipes to be wired; a hung MCP server's `initialize` is bounded by
 *    `requestTimeoutMs` instead).
 *  - 5s SIGTERM→SIGKILL grace (legacy uses a single `kill()` — a
 *    `trap '' TERM` server would never exit).
 *  - ASCII-validated service name surfaced via `QUANTA_SERVICE_NAME` env.
 *
 * The trade-off is observability: the isolated path logs differently and
 * exposes the JSON-RPC layer via `PluginHost`. For most users the legacy
 * path is fine; the isolated path is for plugins that load unsigned native
 * libs or have a history of crash-looping.
 *
 * Slice contract: this module lives in `@/mcp` (alongside the legacy client)
 * and depends on `@/plugin-isolation` + `@/shared`. It does NOT export from
 * the `@/mcp` barrel by default — callers wire it explicitly via
 * `isolatedMcpEnabledFromEnv()` + `IsolatedMcpClient` import.
 */

import {
  createBunSpawner,
  DEFAULT_GRACEFUL_KILL_MS,
  DEFAULT_SPAWN_TIMEOUT_MS,
  type IsolatedProcessSpawnerPort,
  PluginHost,
  PluginHostError,
} from "@/plugin-isolation"
import { errMessage, logger, QuantaError, runtimeConfig } from "@/shared"
import { extractMedia, McpError, sanitizeAnnotations } from "./client"
import {
  isSupportedProtocolVersion,
  resolveOfferedVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "./protocol-version"
import type { McpCallResult, McpServerConfig, McpToolDef } from "./types"

const CLIENT_INFO = { name: "quanta", version: "0.1.0" }
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const MAX_TOOLS_LIST_PAGES = 256

/** Mirror of `client.ts` MAX_RESULT_CHARS — the slice-isolation rule (RFC §3.1)
 *  forbids importing from `@/tool`, so the constant is duplicated locally and
 *  kept in lockstep by code review. */
const MAX_RESULT_CHARS = 200_000

const ISOLATED_ENV_VAR = "MCP_USE_ISOLATED_SPAWN"

/** Env-flag check. Exported so wire code in `@/agent` (or apps/cli) can
 *  branch on the same source of truth, instead of re-reading the env. */
export const isolatedMcpEnabledFromEnv = (env?: Record<string, string | undefined>): boolean => {
  const source = env ?? (process.env as Record<string, string | undefined>)
  const v = source[ISOLATED_ENV_VAR]
  return v === "1" || v === "true" || v === "yes"
}

export class IsolatedMcpError extends QuantaError {
  constructor(message: string) {
    super("mcp-isolated", message)
  }
}

interface RawTool {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  /** §19.1 — server-advertised `ToolAnnotations`; sanitized at {@link mapTool}. */
  annotations?: unknown
}
interface ToolsListResult {
  tools?: RawTool[]
  nextCursor?: string
}
interface ContentBlock {
  type: string
  text?: string
  data?: string
  mimeType?: string
  resource?: unknown
}
interface ToolsCallResult {
  content?: ContentBlock[]
  isError?: boolean
}

const mapTool = (t: RawTool): McpToolDef => {
  const annotations = sanitizeAnnotations(t.annotations)
  return {
    name: t.name,
    description: t.description ?? "",
    inputSchema: t.inputSchema ?? { type: "object" },
    ...(annotations !== undefined ? { annotations } : {}),
  }
}

const joinTextBlocks = (content: ContentBlock[] | undefined): string =>
  (content ?? [])
    .filter((b) => b.type === "text" && typeof b.text === "string")
    .map((b) => b.text ?? "")
    .join("\n")

const capResultText = (text: string): string => {
  if (text.length <= MAX_RESULT_CHARS) return text
  const omitted = text.length - MAX_RESULT_CHARS
  return `${text.slice(0, MAX_RESULT_CHARS)}\n[truncated: ${omitted} bytes omitted]`
}

/** Service-name sanitiser. The MCP `config.name` is free-form (UUID, "user's
 *  server", etc.); the spawner requires ASCII [A-Za-z0-9._-]{1,64}. We
 *  sanitise + truncate, falling back to a stable hash-prefix if nothing
 *  remains so two servers with garbage names don't collide. */
const sanitiseServiceName = (name: string): string => {
  const cleaned = name.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64)
  // Spawner regex requires the first char NOT be a special char.
  if (cleaned.length === 0 || !/^[A-Za-z0-9]/.test(cleaned)) {
    return `mcp_${cleaned}`.slice(0, 64) || "mcp_anon"
  }
  return cleaned
}

export interface IsolatedMcpClientOpts {
  /** Override the spawner port (test seam). Default = `createBunSpawner()`. */
  readonly spawner?: IsolatedProcessSpawnerPort
  /** Override the spawn timeout. Default = 5s (DXT). */
  readonly spawnTimeoutMs?: number
  /** Override the SIGTERM grace. Default = 5s (DXT). */
  readonly gracefulKillMs?: number
  /** Per-request JSON-RPC timeout. Default = 30s. */
  readonly requestTimeoutMs?: number
}

/** Public API mirrors {@link McpClient} from `./client.ts` so the two are
 *  drop-in interchangeable. Differences are internal — the isolated path
 *  delegates spawn to {@link IsolatedProcessSpawnerPort} and uses
 *  {@link PluginHost} for JSON-RPC correlation. */
export class IsolatedMcpClient {
  private readonly config: McpServerConfig
  private readonly spawner: IsolatedProcessSpawnerPort
  private readonly spawnTimeoutMs: number
  private readonly gracefulKillMs: number
  private readonly requestTimeoutMs: number

  private host: PluginHost | null = null
  private started = false
  private stopped = false
  /** Ticket misc-jun-7/01 — protocol version pinned from the `initialize` reply
   *  (the server's choice, or the offer when it omits one). `null` until
   *  `start()` completes. */
  private negotiatedVersion: string | null = null
  /** External exit subscribers (ADR-0435 auto-restart supervisor). Empty unless
   *  a supervisor wires one in — no fan-out when empty (byte-identical). */
  private readonly exitHandlers = new Set<(reason?: string) => void>()
  /** Guards against a double fan-out (host exit + explicit stop). */
  private exitNotified = false

  constructor(config: McpServerConfig, opts: IsolatedMcpClientOpts = {}) {
    this.config = config
    this.spawner = opts.spawner ?? createBunSpawner()
    this.spawnTimeoutMs = opts.spawnTimeoutMs ?? DEFAULT_SPAWN_TIMEOUT_MS
    this.gracefulKillMs = opts.gracefulKillMs ?? DEFAULT_GRACEFUL_KILL_MS
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
  }

  async start(): Promise<void> {
    if (this.started) return
    this.started = true
    // Ticket misc-jun-7/01 R4 — re-arm the exit fan-out for THIS attempt. A prior
    // fail-closed start set `exitNotified` to suppress its rollback teardown; a
    // fresh start wires a NEW host/exitPromise, so a real exit on this attempt
    // must fan out again. (No-op on a first start; `stopped` is never reset here,
    // so a deliberately-stopped client stays stopped.)
    if (!this.stopped) this.exitNotified = false
    if (this.config.command.length === 0) {
      throw new IsolatedMcpError(`mcp server "${this.config.name}" has empty command`)
    }
    const entry = this.config.command[0]
    if (entry === undefined) {
      throw new IsolatedMcpError(`mcp server "${this.config.name}" has empty command`)
    }
    const args = this.config.command.slice(1)
    const spawnOpts: Parameters<IsolatedProcessSpawnerPort["spawn"]>[0] = {
      entry,
      args,
      serviceName: sanitiseServiceName(this.config.name),
      spawnTimeoutMs: this.spawnTimeoutMs,
      gracefulKillMs: this.gracefulKillMs,
      cwd: this.config.cwd ?? process.cwd(),
    }
    if (this.config.env !== undefined) Object.assign(spawnOpts, { env: this.config.env })

    const proc = await this.spawner.spawn(spawnOpts)
    const host = new PluginHost(proc, { defaultCallTimeoutMs: this.requestTimeoutMs })
    this.host = host
    // Fan-out the process exit to external subscribers (auto-restart supervisor,
    // ADR-0435). No subscribers ⇒ no effect; we also skip when the supervisor is
    // not wired, keeping the default path byte-identical. A `stop()`-driven exit
    // is suppressed by `stopped`/`exitNotified` so a deliberate teardown is not
    // mistaken for a crash.
    void host.exitPromise.then(
      () => this.notifyExit("process exit"),
      () => this.notifyExit("process exit"),
    )
    try {
      // Ticket misc-jun-7/01 — offer the SSOT version (knob-resolved), the SAME
      // source the in-process client uses. The isolated spawner has no JSON-RPC
      // error/retry surface to drive the §4.c bounded re-offer, so it offers the
      // resolved version directly; operators who know a peer chokes on the bump
      // pin it back via `QUANTA_MCP_PROTOCOL_MAX`.
      const offered = resolveOfferedVersion(runtimeConfig().mcpProtocolMax)
      const initResult = await this.host.call("initialize", {
        protocolVersion: offered,
        clientInfo: CLIENT_INFO,
        capabilities: {},
      })
      // Read the server's chosen version (previously discarded). Accept iff in
      // the SSOT; a version we do not implement fails closed with a typed
      // `McpError` (Codex `UNSUPPORTED_PROTOCOL` parity); an absent/malformed
      // slot is legacy-tolerant (pin the offer) — never throws on shape.
      this.pinNegotiatedVersion(initResult, offered)
      this.host.notify("notifications/initialized", {})
    } catch (e) {
      // Ticket misc-jun-7/01 R4 — suppress the exit fan-out for this DELIBERATE
      // teardown BEFORE `host.stop()` resolves `exitPromise`. The fan-out wired
      // above (`host.exitPromise.then(notifyExit)`) would otherwise emit a
      // spurious `"process exit"` to the ADR-0435 auto-restart supervisor for a
      // client-initiated rollback (e.g. an unsupported negotiated version — a
      // permanent, NOT-restartable condition), crash-looping a server that will
      // fail-close again. `exitNotified` short-circuits `notifyExit`; a follow-up
      // `start()` re-arms it (reset at the top of `start()`), so a retry's REAL
      // exit still fans out.
      this.exitNotified = true
      // Roll back partial start so a follow-up start() can be reattempted.
      void this.host.stop().catch(() => undefined)
      this.host = null
      this.started = false
      throw new IsolatedMcpError(
        `mcp server "${this.config.name}" initialize failed: ${errMessage(e)}`,
      )
    }
  }

  async listTools(): Promise<McpToolDef[]> {
    const host = this.ensureReady()
    const tools: McpToolDef[] = []
    let cursor: string | undefined
    const seenCursors = new Set<string>()
    try {
      for (let page = 0; page < MAX_TOOLS_LIST_PAGES; page += 1) {
        const params = cursor === undefined ? {} : { cursor }
        const res = (await host.call("tools/list", params)) as ToolsListResult
        for (const t of res.tools ?? []) tools.push(mapTool(t))
        const nextCursor = res.nextCursor
        if (nextCursor === undefined || nextCursor === "") return tools
        if (seenCursors.has(nextCursor)) {
          throw new IsolatedMcpError(
            `mcp server "${this.config.name}" tools/list returned a repeated cursor "${nextCursor}"`,
          )
        }
        seenCursors.add(nextCursor)
        cursor = nextCursor
      }
      throw new IsolatedMcpError(
        `mcp server "${this.config.name}" tools/list exceeded ${MAX_TOOLS_LIST_PAGES} pages`,
      )
    } catch (e) {
      if (e instanceof IsolatedMcpError) throw e
      if (e instanceof PluginHostError) {
        throw new IsolatedMcpError(`mcp tools/list failed (${e.kind}): ${e.message}`)
      }
      throw e
    }
  }

  async callTool(name: string, args: unknown): Promise<McpCallResult> {
    const host = this.ensureReady()
    let res: ToolsCallResult
    try {
      res = (await host.call("tools/call", {
        name,
        arguments: args ?? {},
      })) as ToolsCallResult
    } catch (e) {
      if (e instanceof PluginHostError) {
        throw new IsolatedMcpError(`mcp call "${name}" failed (${e.kind}): ${e.message}`)
      }
      throw e
    }
    // §19.3 — mirror the in-process client: surface non-text media alongside the
    // joined text. Empty ⇒ `media` omitted (byte-identical text-only result).
    const media = extractMedia(res.content)
    return {
      ok: res.isError !== true,
      content: capResultText(joinTextBlocks(res.content)),
      ...(media.length > 0 ? { media } : {}),
    }
  }

  /** Subscribe to a one-shot process-exit notification (ADR-0435). Returns an
   *  unsubscribe. No-op for the default code path (no subscriber registered). */
  onExit(handler: (reason?: string) => void): () => void {
    this.exitHandlers.add(handler)
    return () => this.exitHandlers.delete(handler)
  }

  /** Fan-out exit once. A deliberate `stop()` does not count as a crash. */
  private notifyExit(reason: string): void {
    if (this.exitNotified || this.stopped) return
    this.exitNotified = true
    for (const h of this.exitHandlers) h(reason)
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    const host = this.host
    this.host = null
    if (host) {
      try {
        await host.stop()
      } catch (e) {
        logger.debug("isolated-mcp: stop encountered error", { error: errMessage(e) })
      }
    }
  }

  // --- internals -----------------------------------------------------------

  private ensureReady(): PluginHost {
    if (!this.started || this.stopped || !this.host) {
      throw new IsolatedMcpError(`mcp server "${this.config.name}" is not running`)
    }
    return this.host
  }

  /** Ticket misc-jun-7/01 — accept/legacy-tolerant/fail-closed the server's
   *  chosen `protocolVersion`, mirroring the in-process client. Same SSOT, one
   *  source. The isolated path stamps no header, so there is nothing to re-pin;
   *  the pinned value is recorded for diagnostics + parity. */
  private pinNegotiatedVersion(initResult: unknown, offered: string): void {
    const replied =
      typeof initResult === "object" && initResult !== null && !Array.isArray(initResult)
        ? (initResult as Record<string, unknown>).protocolVersion
        : undefined
    if (typeof replied !== "string") {
      this.negotiatedVersion = offered
      return
    }
    if (!isSupportedProtocolVersion(replied)) {
      throw new McpError(
        `mcp server "${this.config.name}" replied with unsupported protocolVersion "${replied}"; supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")}`,
      )
    }
    this.negotiatedVersion = replied
  }

  /** Ticket misc-jun-7/01 — the protocol version pinned for this session. */
  pinnedProtocolVersion(): string | null {
    return this.negotiatedVersion
  }
}
