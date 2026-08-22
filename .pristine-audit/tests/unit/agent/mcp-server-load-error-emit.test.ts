/**
 * ALBB-09 site 4 — MCP configured-server load-failure observability.
 *
 * Before: a configured server whose `start()` / `listTools()` throws is caught
 * with a bare `logger.warn` and dropped (`return null`) — the operator sees "no
 * tools from server X" IDENTICALLY whether X was un-configured or FAILED to
 * start. There is no stream/counter reach: the failure is invisible to any
 * surface that consumes structured events.
 *
 * Fix: `LoadMcpToolsOpts` gains an optional
 *   `onServerLoadError?: (info: { server: string; error: unknown }) => void`
 * invoked in BOTH catch sites (single-client + supervised) alongside the
 * existing `logger.warn`. A composition root can bridge it to
 * `stream.emit({type:"error", ...})`. ABSENT ⇒ byte-identical (warn-only).
 *
 * These are red-on-injection mutation guards:
 *   - drop the sink invocation in the catch ⇒ the "sink fires" case goes RED.
 *   - the "absent-sink byte-identical" case pins that a load with NO sink still
 *     drops the failed server + loads the healthy one (unchanged behaviour).
 */

import { describe, expect, it } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LoadMcpToolsOpts } from "@/agent"
import { loadMcpTools } from "@/agent"

/** Minimal healthy stdio MCP server (initialize + tools/list). */
const MOCK_SERVER = `
const reply = (m) => process.stdout.write(JSON.stringify(m) + "\\n")
let buf = ""
process.stdin.on("data", (c) => {
  buf += c
  let nl
  while ((nl = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, nl).trim()
    buf = buf.slice(nl + 1)
    if (!line) continue
    const msg = JSON.parse(line)
    if (msg.method === "initialize") {
      reply({ jsonrpc: "2.0", id: msg.id, result: {
        protocolVersion: "2025-06-18",
        serverInfo: { name: "mock", version: "0.0.1" },
        capabilities: { tools: {} },
      } })
    } else if (msg.method === "notifications/initialized") {
      // notification — no reply
    } else if (msg.method === "tools/list") {
      reply({ jsonrpc: "2.0", id: msg.id, result: {
        tools: [ { name: "ping", description: "ping", inputSchema: { type: "object" } } ],
      } })
    }
  }
})
`

describe("ALBB-09 — MCP configured-server load-error sink", () => {
  it("throwing server start → onServerLoadError fires with {server,error}; healthy server still loads", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-load-err-"))
    try {
      const serverPath = join(dir, "mock-server.mjs")
      await writeFile(serverPath, MOCK_SERVER)

      const seen: Array<{ server: string; error: unknown }> = []
      const opts: LoadMcpToolsOpts = {
        onServerLoadError: (info) => seen.push(info),
      }
      const { tools, clients } = await loadMcpTools(
        [
          // A command that cannot start (missing entrypoint) → start()/listTools throws.
          { name: "broken", command: [process.execPath, join(dir, "no-such-xyz.mjs")] },
          { name: "healthy", command: [process.execPath, serverPath] },
        ],
        undefined,
        opts,
      )

      // The sink fired EXACTLY for the broken server, carrying its name + error.
      const brokenHit = seen.find((s) => s.server === "broken")
      expect(brokenHit).toBeDefined()
      expect(brokenHit?.error).toBeDefined()
      // The healthy server still loaded its tool — the failed one dropped clean.
      expect(tools.some((t) => t.name.startsWith("mcp__healthy__"))).toBe(true)
      expect(tools.some((t) => t.name.startsWith("mcp__broken__"))).toBe(false)
      // The sink is NEVER invoked for the healthy server (only failures).
      expect(seen.some((s) => s.server === "healthy")).toBe(false)

      for (const c of clients) await c.stop()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it("absent sink → byte-identical: failed server dropped, healthy loads, no throw", async () => {
    const dir = await mkdtemp(join(tmpdir(), "mcp-load-err-none-"))
    try {
      const serverPath = join(dir, "mock-server.mjs")
      await writeFile(serverPath, MOCK_SERVER)

      // No `onServerLoadError` ⇒ warn-only, exactly as today.
      const { tools, clients } = await loadMcpTools([
        { name: "broken", command: [process.execPath, join(dir, "no-such-xyz.mjs")] },
        { name: "healthy", command: [process.execPath, serverPath] },
      ])
      expect(tools.some((t) => t.name.startsWith("mcp__healthy__"))).toBe(true)
      expect(tools.some((t) => t.name.startsWith("mcp__broken__"))).toBe(false)
      for (const c of clients) await c.stop()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
