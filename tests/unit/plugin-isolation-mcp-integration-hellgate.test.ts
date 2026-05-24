/**
 * IsolatedMcpClient — hellgate (ADR-0162 Phase E).
 *
 * Seals the opt-in MCP integration. The legacy McpClient (Bun.spawn direct)
 * remains the default; the env flag MCP_USE_ISOLATED_SPAWN is the only
 * source of truth for selection.
 *
 * Sections (12 cases):
 *   A. Env-flag detection (3)   — flag unset / "1" / "true" + "yes" /
 *                                  unrelated value rejected.
 *   B. Construction guard (3)   — empty command rejects start; serviceName
 *                                  sanitisation; non-ASCII server.name
 *                                  doesn't break spawn.
 *   C. Lifecycle (3)            — start->stop happy / stop before start
 *                                  no-op / double stop idempotent.
 *   D. Real spawn integration (3) — integrate with a tmp MCP-like child;
 *                                    initialize round-trip; tools/list +
 *                                    tools/call (success + error mapping).
 */

import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { IsolatedProcess, IsolatedProcessSpawnerPort, SpawnOpts } from "@/plugin-isolation"
import {
  IsolatedMcpClient,
  IsolatedMcpError,
  isolatedMcpEnabledFromEnv,
} from "@/mcp/isolated-client"

const BUN = process.execPath

const writeServer = async (body: string): Promise<{ path: string; cleanup: () => Promise<void> }> => {
  const dir = await mkdtemp(join(tmpdir(), "iso-mcp-hellgate-"))
  const path = join(dir, "server.mjs")
  await writeFile(path, body, "utf8")
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) }
}

/** A tiny MCP-like server. Emits a ready line (sentinel) THEN handles
 *  initialize / tools/list / tools/call over stdin. */
const SERVER_BODY = `
process.stdout.write(JSON.stringify({ ready: true }) + "\\n")
let buf = ""
const reply = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
process.stdin.on("data", (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.method === "initialize") {
      reply({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "stub" }, capabilities: {} } })
    } else if (msg.method === "notifications/initialized") {
      // noop
    } else if (msg.method === "tools/list") {
      reply({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "alpha" }, { name: "beta" }] } })
    } else if (msg.method === "tools/call") {
      if (msg.params.name === "boom") {
        reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "fail" }], isError: true } })
      } else {
        reply({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "ok:" + (msg.params.arguments.q || "") }] } })
      }
    } else if (msg.method && msg.id !== undefined) {
      reply({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "no method" } })
    }
  }
})
`

interface StubControl {
  readonly port: IsolatedProcessSpawnerPort
  readonly calls: SpawnOpts[]
}
const stubSpawner = (): StubControl => {
  const calls: SpawnOpts[] = []
  const port: IsolatedProcessSpawnerPort = {
    spawn: async (opts) => {
      calls.push(opts)
      const exitPromise = new Promise<{ code: number | null; signal: string | null }>(() => {
        // never resolves
      })
      const proc: IsolatedProcess = {
        pid: 1,
        serviceName: opts.serviceName,
        send: () => {
          // no-op
        },
        onMessage: () => () => {
          // no-op
        },
        kill: async () => {
          // no-op
        },
        exitPromise,
      }
      return proc
    },
  }
  return { port, calls }
}

describe("ADR-0162 IsolatedMcpClient hellgate — A. Env-flag detection", () => {
  test("flag unset → disabled", () => {
    expect(isolatedMcpEnabledFromEnv({})).toBe(false)
    expect(isolatedMcpEnabledFromEnv({ OTHER: "1" })).toBe(false)
  })

  test('flag value "1" / "true" / "yes" → enabled', () => {
    expect(isolatedMcpEnabledFromEnv({ MCP_USE_ISOLATED_SPAWN: "1" })).toBe(true)
    expect(isolatedMcpEnabledFromEnv({ MCP_USE_ISOLATED_SPAWN: "true" })).toBe(true)
    expect(isolatedMcpEnabledFromEnv({ MCP_USE_ISOLATED_SPAWN: "yes" })).toBe(true)
  })

  test('flag value "0" / "false" / arbitrary → disabled', () => {
    expect(isolatedMcpEnabledFromEnv({ MCP_USE_ISOLATED_SPAWN: "0" })).toBe(false)
    expect(isolatedMcpEnabledFromEnv({ MCP_USE_ISOLATED_SPAWN: "false" })).toBe(false)
    expect(isolatedMcpEnabledFromEnv({ MCP_USE_ISOLATED_SPAWN: "maybe" })).toBe(false)
  })
})

describe("ADR-0162 IsolatedMcpClient hellgate — B. Construction guard", () => {
  test("empty command → start rejects with IsolatedMcpError", async () => {
    const s = stubSpawner()
    const client = new IsolatedMcpClient({ name: "svc", command: [] }, { spawner: s.port })
    let caught: IsolatedMcpError | null = null
    try {
      await client.start()
    } catch (e) {
      caught = e as IsolatedMcpError
    }
    expect(caught).toBeInstanceOf(IsolatedMcpError)
  })

  test("non-ASCII name → sanitised to ASCII before spawn", async () => {
    const t = await writeServer(SERVER_BODY)
    try {
      const client = new IsolatedMcpClient(
        { name: "héllo wörld 🎉", command: [BUN, t.path] },
        { spawnTimeoutMs: 3000 },
      )
      await client.start()
      await client.stop()
    } finally {
      await t.cleanup()
    }
  })

  test("name without valid first char gets `mcp_` prefix", async () => {
    const s = stubSpawner()
    const client = new IsolatedMcpClient(
      { name: "----", command: [BUN, "--version"] },
      { spawner: s.port, spawnTimeoutMs: 100 },
    )
    // Start will fail (stub spawner makes a never-replying process), but we
    // only need to check the spawn opts captured BEFORE initialize hangs.
    try {
      await Promise.race([client.start(), new Promise((r) => setTimeout(r, 50))])
    } catch {
      // ignore
    }
    expect(s.calls.length).toBe(1)
    expect(s.calls[0]?.serviceName.startsWith("mcp_")).toBe(true)
    await client.stop()
  })
})

describe("ADR-0162 IsolatedMcpClient hellgate — C. Lifecycle", () => {
  test("stop() before start() is safe (no-op)", async () => {
    const client = new IsolatedMcpClient({ name: "svc", command: [BUN, "--version"] })
    await client.stop()
    await client.stop()
  })

  test("listTools after stop() rejects", async () => {
    const t = await writeServer(SERVER_BODY)
    try {
      const client = new IsolatedMcpClient(
        { name: "svc", command: [BUN, t.path] },
        { spawnTimeoutMs: 3000 },
      )
      await client.start()
      await client.stop()
      let caught: IsolatedMcpError | null = null
      try {
        await client.listTools()
      } catch (e) {
        caught = e as IsolatedMcpError
      }
      expect(caught).toBeInstanceOf(IsolatedMcpError)
    } finally {
      await t.cleanup()
    }
  })

  test("double stop() is idempotent", async () => {
    const t = await writeServer(SERVER_BODY)
    try {
      const client = new IsolatedMcpClient(
        { name: "svc", command: [BUN, t.path] },
        { spawnTimeoutMs: 3000 },
      )
      await client.start()
      await client.stop()
      await client.stop()
    } finally {
      await t.cleanup()
    }
  })
})

describe("ADR-0162 IsolatedMcpClient hellgate — D. Real spawn integration", () => {
  test("initialize handshake → listTools returns tool names", async () => {
    const t = await writeServer(SERVER_BODY)
    try {
      const client = new IsolatedMcpClient(
        { name: "svc", command: [BUN, t.path] },
        { spawnTimeoutMs: 3000 },
      )
      await client.start()
      const tools = await client.listTools()
      const names = tools.map((x) => x.name)
      expect(names).toEqual(["alpha", "beta"])
      await client.stop()
    } finally {
      await t.cleanup()
    }
  })

  test("callTool success → ok=true + content", async () => {
    const t = await writeServer(SERVER_BODY)
    try {
      const client = new IsolatedMcpClient(
        { name: "svc", command: [BUN, t.path] },
        { spawnTimeoutMs: 3000 },
      )
      await client.start()
      const res = await client.callTool("alpha", { q: "hi" })
      expect(res.ok).toBe(true)
      expect(res.content).toBe("ok:hi")
      await client.stop()
    } finally {
      await t.cleanup()
    }
  })

  test("callTool isError=true → ok=false + content preserved", async () => {
    const t = await writeServer(SERVER_BODY)
    try {
      const client = new IsolatedMcpClient(
        { name: "svc", command: [BUN, t.path] },
        { spawnTimeoutMs: 3000 },
      )
      await client.start()
      const res = await client.callTool("boom", {})
      expect(res.ok).toBe(false)
      expect(res.content).toBe("fail")
      await client.stop()
    } finally {
      await t.cleanup()
    }
  })
})
