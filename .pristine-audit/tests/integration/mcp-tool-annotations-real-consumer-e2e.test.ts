import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { loadMcpTools } from "@/agent/mcp-bridge"
import { buildMcpLoadOpts, resolveMcpInboundWiring } from "@/host/mcp-composition"
import type { McpServerConfig } from "@/mcp"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import type { McpTransport } from "@/mcp/transports/port"
import type { StructuredLogger } from "@/observability"
import { __resetRuntimeConfig } from "@/shared"
import type { Tool } from "@/tool"

/**
 * REAL-CONSUMER e2e for `mcp-tool-annotations-content`
 * (QUANTA_MCP_TOOL_ANNOTATIONS, §19.1).
 *
 * THE DOF-21 GAP. The two prior tests do NOT connect the real gate to the real
 * elevated predicate through a live client:
 *   - `mcp-bridge-annotations-hellgate.test.ts` HAND-FEEDS
 *     `{ annotationsHonored:true, trusted:true }` to `mcpToolToTool` — it never
 *     reads the knob, so it proves the bridge math but not the wire.
 *   - `mcp-tool-annotations-wire.test.ts` re-implements the opts spread LOCALLY
 *     (`runtimeConfig().mcpToolAnnotations ? {…} : {}`) — a MIRROR copy, so it
 *     is vacuous w.r.t. the production `buildMcpLoadOpts` and never touches a
 *     bridged tool's predicates.
 *
 * This suite drives the WHOLE production chain with ground truth:
 *
 *   QUANTA_MCP_TOOL_ANNOTATIONS (real env)
 *     → runtimeConfig().mcpToolAnnotations (real gate read)
 *       → buildMcpLoadOpts (real composition-root consumer — the ONE that spreads
 *          `annotationsHonored`)
 *         → loadMcpTools (real bridge: bindOptsFor combines `annotationsHonored`
 *            with the per-server `config.trusted` trust boundary)
 *           → scripted MCP transport advertises a tool with
 *              `annotations: { readOnlyHint:true, idempotentHint:true }`, parsed by
 *              the REAL client `sanitizeAnnotations`
 *             → the bridged Tool's isReadOnly()/isConcurrencySafe() predicates.
 *
 * GROUND TRUTH: only knob-ON + trusted-server elevates the real bridged tool's
 * predicates to true/true. Every other combination (knob OFF, untrusted server,
 * poisoned string hint) leaves them false/false — the conservative default that
 * keeps the tool inside HITL and out of parallel dispatch.
 *
 * PAIRED CONTROL (the trust boundary is load-bearing):
 *   - knob OFF ⇒ false/false EVEN for a trusted server (byte-identical default).
 *   - UNTRUSTED server ⇒ false/false EVEN with the knob ON (a self-declared
 *     `readOnlyHint` from an untrusted server can NEVER escape HITL / parallel).
 *
 * red-on-injection: if `buildMcpLoadOpts` dropped the knob read (always/never
 * spreading `annotationsHonored`), the OFF and ON assertions invert. If the
 * bridge stopped anding in `config.trusted`, the untrusted-server control fails.
 */

const KEY = "QUANTA_MCP_TOOL_ANNOTATIONS"

const noopSlog = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
} as unknown as StructuredLogger

/** A minimal real MCP server over the transport seam. Its `tools/list` answers
 *  ONE tool whose annotations are caller-supplied — so the REAL client
 *  `sanitizeAnnotations` parses them and the REAL bridge derives the predicates.
 *  `tools/call` is never exercised here (we only assert the static predicates). */
class AnnotatingServer implements McpTransport {
  private handler: ((msg: JsonRpcMessage) => void) | null = null
  constructor(private readonly annotations: Record<string, unknown> | undefined) {}
  start(): Promise<void> {
    return Promise.resolve()
  }
  send(payload: unknown): Error | null {
    const msg = payload as Record<string, unknown>
    if (typeof msg.id === "number" && typeof msg.method === "string") {
      queueMicrotask(() => this.answer(msg.id as number, msg.method as string))
    }
    return null
  }
  onMessage(handler: (msg: JsonRpcMessage) => void): () => void {
    this.handler = handler
    return () => {
      this.handler = null
    }
  }
  onExit(_handler: () => void): () => void {
    return () => {}
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
  private emit(msg: JsonRpcMessage): void {
    this.handler?.(msg)
  }
  private answer(id: number, method: string): void {
    if (method === "initialize") {
      this.emit({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          serverInfo: { name: "annot", version: "1.0" },
          capabilities: { tools: {} },
        },
      })
      return
    }
    if (method === "tools/list") {
      this.emit({
        jsonrpc: "2.0",
        id,
        result: {
          tools: [
            {
              name: "do_thing",
              description: "d",
              inputSchema: { type: "object" },
              ...(this.annotations !== undefined ? { annotations: this.annotations } : {}),
            },
          ],
        },
      })
      return
    }
    this.emit({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found" } })
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 16; i++) await Promise.resolve()
}

/** Run the REAL production chain: buildMcpLoadOpts (reads the live knob) →
 *  loadMcpTools over a scripted transport. Returns the bridged `do_thing` tool. */
const loadBridgedTool = async (opts: {
  trusted: boolean
  annotations: Record<string, unknown> | undefined
}): Promise<{ tool: Tool; stop: () => Promise<void> }> => {
  const server = new AnnotatingServer(opts.annotations)
  const config: McpServerConfig = {
    name: "annot",
    command: ["x"],
    ...(opts.trusted ? { trusted: true } : {}),
  }
  // REAL composition-root consumer: this is what reads runtimeConfig().
  // mcpToolAnnotations and decides whether to spread annotationsHonored.
  const inboundWiring = resolveMcpInboundWiring(undefined, undefined)
  const loadOpts = buildMcpLoadOpts(noopSlog, {
    autoRestart: false,
    inboundWiring,
    oauthProvider: undefined,
    // Thread the scripted transport through the SAME field production uses
    // (opts.mcpTransportFor → loadMcpTools transportFor), so nothing but the
    // subprocess is faked.
    opts: { mcpTransportFor: () => server as never },
  })
  const p = loadMcpTools([config], undefined, loadOpts)
  for (let i = 0; i < 8; i++) await flush()
  const res = await p
  // The bridge sanitizes the name to `mcp__<server>__<tool>` (mcpToolName).
  const tool = res.tools.find((t) => t.name.endsWith("do_thing"))
  if (tool === undefined)
    throw new Error(`bridged tool not registered (saw: ${res.tools.map((t) => t.name).join(",")})`)
  return {
    tool,
    stop: async () => {
      for (const c of res.clients) await c.stop().catch(() => undefined)
    },
  }
}

const HONORING_ANN = { readOnlyHint: true, idempotentHint: true }

describe("mcp-tool-annotations — real knob → real buildMcpLoadOpts → real bridge predicates", () => {
  let saved: string | undefined
  beforeEach(() => {
    saved = process.env[KEY]
    delete process.env[KEY]
    __resetRuntimeConfig()
  })
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY]
    else process.env[KEY] = saved
    __resetRuntimeConfig()
  })

  test("knob ON + TRUSTED server ⇒ the REAL bridged tool ELEVATES to isReadOnly/isConcurrencySafe true", async () => {
    process.env[KEY] = "1"
    __resetRuntimeConfig()
    const { tool, stop } = await loadBridgedTool({ trusted: true, annotations: HONORING_ANN })
    try {
      // GROUND TRUTH: the real knob flowed through buildMcpLoadOpts into the real
      // bridge and elevated the ACTUAL registered tool's predicates.
      expect(tool.isReadOnly()).toBe(true)
      expect(tool.isConcurrencySafe({})).toBe(true)
    } finally {
      await stop()
    }
  })

  test("PAIRED CONTROL — knob OFF ⇒ false/false EVEN for a trusted server (byte-identical default)", async () => {
    // KEY left unset by beforeEach ⇒ runtimeConfig().mcpToolAnnotations is false
    // ⇒ buildMcpLoadOpts OMITS annotationsHonored ⇒ honored is false for every
    // tool. If the knob read were dropped (always-on), this would be true/true.
    const { tool, stop } = await loadBridgedTool({ trusted: true, annotations: HONORING_ANN })
    try {
      expect(tool.isReadOnly()).toBe(false)
      expect(tool.isConcurrencySafe({})).toBe(false)
    } finally {
      await stop()
    }
  })

  test("PAIRED CONTROL — knob ON + UNTRUSTED server ⇒ false/false (trust boundary: self-declared hint cannot escape HITL)", async () => {
    process.env[KEY] = "1"
    __resetRuntimeConfig()
    // Same honoring annotations, same ON knob — but the server config is NOT
    // trusted. bindOptsFor ands in config.trusted, so honored is false. This is
    // the security crux: an untrusted server's readOnlyHint:true is inert.
    const { tool, stop } = await loadBridgedTool({ trusted: false, annotations: HONORING_ANN })
    try {
      expect(tool.isReadOnly()).toBe(false)
      expect(tool.isConcurrencySafe({})).toBe(false)
    } finally {
      await stop()
    }
  })

  test("knob ON + trusted + POISONED string readOnlyHint:'true' ⇒ false/false (sanitizeAnnotations dropped the non-boolean at parse)", async () => {
    process.env[KEY] = "1"
    __resetRuntimeConfig()
    // A hostile server sends readOnlyHint as a STRING. The REAL client
    // sanitizeAnnotations drops it (only real JSON booleans survive), so the
    // bridge sees no readOnlyHint and the tool stays mutating.
    const { tool, stop } = await loadBridgedTool({
      trusted: true,
      annotations: { readOnlyHint: "true", idempotentHint: "true" },
    })
    try {
      expect(tool.isReadOnly()).toBe(false)
      expect(tool.isConcurrencySafe({})).toBe(false)
    } finally {
      await stop()
    }
  })

  test("knob ON + trusted + readOnlyHint:true but idempotentHint:false ⇒ read-only YES, concurrency NO (through the real chain)", async () => {
    process.env[KEY] = "1"
    __resetRuntimeConfig()
    const { tool, stop } = await loadBridgedTool({
      trusted: true,
      annotations: { readOnlyHint: true, idempotentHint: false },
    })
    try {
      expect(tool.isReadOnly()).toBe(true)
      expect(tool.isConcurrencySafe({})).toBe(false)
    } finally {
      await stop()
    }
  })
})
