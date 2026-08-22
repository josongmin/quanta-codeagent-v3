/** H19 roots + B1 supervised LIVE wire — e2e hellgate at the
 *  `loadFeatures`/`internal.ts` producer seam.
 *
 *  Where the sibling `mcp-roots-supervised-wire-hellgate` proves the
 *  `mcp-bridge` CONSUMER + the supervisor factory in isolation, this proves the
 *  surface PRODUCER: `loadFeatures` (the CLI feature loader the host bootstrap
 *  calls right after it builds the `LLMPort`) computes the unified
 *  advertise-iff-able bundle (`{ negotiator, handler?, rootsProvider? }`) from the
 *  sampling + roots gates and threads it down such that it reaches BOTH:
 *
 *   (A) a SINGLE client (`QUANTA_MCP_AUTORESTART` unset): advertises `roots` +
 *       answers an inbound `roots/list` with the session-cwd workspace root.
 *   (B) a SUPERVISED client (`QUANTA_MCP_AUTORESTART=1`): the supervisor's
 *       restart factory bakes the SAME bundle in, so the first supervised client
 *       ALSO advertises `roots` (+ `sampling` when wired) — the bundle reaches
 *       the supervised path identically.
 *   (C) default-OFF (`QUANTA_MCP_ROOTS` unset): no `roots` advertised, but an
 *       inbound `roots/list` is STILL answered empty (never -32601).
 *
 *  Driven through `loadFeatures` directly with its injectable test seams (an MCP
 *  config via env + a scripted transport) — the closest seam to the real CLI
 *  boot that does not spawn a process.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import { MCP_ROOTS_LIST_METHOD } from "@/mcp/resources"
import type { McpTransport } from "@/mcp/transports/port"
import type { StructuredLogger } from "@/observability"
import { __resetRuntimeConfig } from "@/shared"
import { loadFeatures } from "../../src/apps/cli/internal"

const flush = async (): Promise<void> => {
  for (let i = 0; i < 64; i++) await Promise.resolve()
}
const tick = async (): Promise<void> => {
  await new Promise((r) => setTimeout(r, 0))
  await flush()
}

class ScriptedTransport implements McpTransport {
  private messageHandler: ((msg: JsonRpcMessage) => void) | null = null
  readonly sent: Array<Record<string, unknown>> = []
  start(): Promise<void> {
    return Promise.resolve()
  }
  send(payload: unknown): Error | null {
    this.sent.push(payload as Record<string, unknown>)
    return null
  }
  onMessage(handler: (msg: JsonRpcMessage) => void): () => void {
    this.messageHandler = handler
    return () => {
      this.messageHandler = null
    }
  }
  onExit(_handler: () => void): () => void {
    return () => {}
  }
  close(): Promise<void> {
    return Promise.resolve()
  }
  emit(msg: JsonRpcMessage): void {
    this.messageHandler?.(msg)
  }
}

const noopLog: StructuredLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
} as unknown as StructuredLogger

let configPath: string
const savedEnv: Record<string, string | undefined> = {}
const setEnv = (k: string, v: string | undefined): void => {
  if (!(k in savedEnv)) savedEnv[k] = process.env[k]
  if (v === undefined) delete process.env[k]
  else process.env[k] = v
}

beforeEach(async () => {
  configPath = `${process.cwd()}/.tmp-mcp-roots-e2e-${Date.now()}-${Math.random().toString(36).slice(2)}.json`
  await Bun.write(configPath, JSON.stringify({ servers: [{ name: "s1", command: ["x"] }] }))
  setEnv("QUANTA_MCP_CONFIG", configPath)
})

afterEach(async () => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const k of Object.keys(savedEnv)) delete savedEnv[k]
  __resetRuntimeConfig()
  await Bun.file(configPath)
    .unlink()
    .catch(() => undefined)
})

const loadAndHandshake = async (
  transport: ScriptedTransport,
  opts: Parameters<typeof loadFeatures>[1],
): Promise<{ clients: { stop: () => Promise<void> }[] }> => {
  __resetRuntimeConfig()
  const loadP = loadFeatures(noopLog, { ...opts, mcpTransportFor: () => transport })
  const waitFor = async (method: string): Promise<{ id: number } | undefined> => {
    for (let i = 0; i < 50; i++) {
      const m = transport.sent.find((s) => s.method === method) as { id: number } | undefined
      if (m !== undefined) return m
      await tick()
    }
    return undefined
  }
  const init = await waitFor("initialize")
  if (init !== undefined) transport.emit({ jsonrpc: "2.0", id: init.id, result: {} })
  const list = await waitFor("tools/list")
  if (list !== undefined) transport.emit({ jsonrpc: "2.0", id: list.id, result: { tools: [] } })
  const features = await loadP
  return { clients: features.mcpClients }
}

const initCaps = (t: ScriptedTransport): Record<string, unknown> => {
  const init = t.sent.find((m) => m.method === "initialize") as {
    params: { capabilities: Record<string, unknown> }
  }
  return init.params.capabilities
}
const lastSend = (t: ScriptedTransport): Record<string, unknown> =>
  t.sent[t.sent.length - 1] as Record<string, unknown>

describe("H19 e2e — loadFeatures threads the roots provider to the SINGLE client", () => {
  it("(A) roots knob ON ⇒ advertises roots + answers roots/list with the session-cwd workspace root", async () => {
    setEnv("QUANTA_MCP_CAPS", "full")
    setEnv("QUANTA_MCP_ROOTS", "1")
    const transport = new ScriptedTransport()
    const { clients } = await loadAndHandshake(transport, {})

    expect(initCaps(transport).roots).toEqual({ listChanged: false })

    transport.emit({ jsonrpc: "2.0", id: 5, method: MCP_ROOTS_LIST_METHOD, params: {} })
    await flush()
    const reply = lastSend(transport)
    expect(reply.id).toBe(5)
    expect(reply.error).toBeUndefined()
    const roots = (reply.result as { roots: { uri: string; name?: string }[] }).roots
    expect(roots).toHaveLength(1)
    expect(roots[0]?.uri.startsWith("file://")).toBe(true)
    expect(roots[0]?.name).toBe("workspace")
    await Promise.all(clients.map((c) => c.stop()))
  })
})

describe("B1+H19 e2e — the bundle reaches the SUPERVISED path too", () => {
  it("(B) auto-restart ON + roots knob ON ⇒ the supervised client ALSO advertises roots", async () => {
    setEnv("QUANTA_MCP_CAPS", "full")
    setEnv("QUANTA_MCP_ROOTS", "1")
    setEnv("QUANTA_MCP_AUTORESTART", "1")
    const transport = new ScriptedTransport()
    const { clients } = await loadAndHandshake(transport, {})

    // The supervisor's restart factory baked the bundle in ⇒ the FIRST supervised
    // client advertised roots (the bundle reached the supervised path identically
    // to the single-client path).
    expect(initCaps(transport).roots).toEqual({ listChanged: false })

    transport.emit({ jsonrpc: "2.0", id: 6, method: MCP_ROOTS_LIST_METHOD, params: {} })
    await flush()
    const reply = lastSend(transport)
    expect(reply.error).toBeUndefined()
    expect((reply.result as { roots: unknown[] }).roots).toHaveLength(1)
    await Promise.all(clients.map((c) => c.stop()))
  })
})

describe("H19 e2e — default-OFF (roots knob unset)", () => {
  it("(C) no roots advertised, but roots/list still answered empty (never -32601)", async () => {
    setEnv("QUANTA_MCP_ROOTS", undefined)
    const transport = new ScriptedTransport()
    const { clients } = await loadAndHandshake(transport, {})

    expect("roots" in initCaps(transport)).toBe(false)

    transport.emit({ jsonrpc: "2.0", id: 7, method: MCP_ROOTS_LIST_METHOD, params: {} })
    await flush()
    const reply = lastSend(transport)
    expect(reply.id).toBe(7)
    expect(reply.error).toBeUndefined()
    expect(reply.result).toEqual({ roots: [] })
    await Promise.all(clients.map((c) => c.stop()))
  })
})
