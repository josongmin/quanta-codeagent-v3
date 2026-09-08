/**
 * C-F1 — IsolatedMcpClient is a delegating facade over McpClient.
 * listTools still works (same hellgate contract) via the inner core.
 */
import { describe, expect, test } from "bun:test"
import { IsolatedMcpClient, IsolatedMcpError } from "@/mcp/isolated-client"
import type { IsolatedProcess, IsolatedProcessSpawnerPort } from "@/plugin-isolation"

const scriptedSpawner = (tools: string[]): IsolatedProcessSpawnerPort => ({
  spawn: async (opts) => {
    let handler: ((msg: unknown) => void) | null = null
    const proc: IsolatedProcess = {
      pid: 1,
      serviceName: opts.serviceName,
      send: (msg: unknown) => {
        const m = msg as { id?: number; method?: string }
        if (typeof m.id !== "number") return
        if (m.method === "initialize") {
          queueMicrotask(() =>
            handler?.({
              jsonrpc: "2.0",
              id: m.id,
              result: { protocolVersion: "2025-11-25", capabilities: { tools: {} } },
            }),
          )
          return
        }
        if (m.method === "tools/list") {
          queueMicrotask(() =>
            handler?.({
              jsonrpc: "2.0",
              id: m.id,
              result: { tools: tools.map((name) => ({ name, description: "", inputSchema: {} })) },
            }),
          )
        }
      },
      onMessage: (h) => {
        handler = h
        return () => {
          handler = null
        }
      },
      kill: async () => {},
      exitPromise: new Promise(() => {}),
    }
    return proc
  },
})

describe("C-F1 IsolatedMcpClient facade delegates to McpClient", () => {
  test("listTools returns inner McpClient tools/list result", async () => {
    const client = new IsolatedMcpClient(
      { name: "svc", command: ["bun", "x"] },
      { spawner: scriptedSpawner(["alpha", "beta"]) },
    )
    await client.start()
    const listed = await client.listTools()
    expect(listed.map((t) => t.name)).toEqual(["alpha", "beta"])
    expect(client.pinnedProtocolVersion()).toBe("2025-11-25")
    await client.stop()
  })

  test("empty command still IsolatedMcpError (facade wrap)", async () => {
    const client = new IsolatedMcpClient(
      { name: "svc", command: [] },
      { spawner: scriptedSpawner([]) },
    )
    await expect(client.start()).rejects.toBeInstanceOf(IsolatedMcpError)
  })
})
