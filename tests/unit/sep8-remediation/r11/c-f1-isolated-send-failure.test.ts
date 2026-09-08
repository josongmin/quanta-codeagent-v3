/**
 * C-F1 — isolated MCP send must surface typed Error (not silent drop).
 * DXT IsolatedProcess.send stays NO-THROW (existing spawner hellgate).
 */
import { describe, expect, test } from "bun:test"
import { IsolatedMcpTransport } from "@/mcp/transports/isolated"
import type { IsolatedProcess, IsolatedProcessSpawnerPort, SpawnOpts } from "@/plugin-isolation"
import { MAX_MESSAGE_BYTES } from "@/plugin-isolation"

const deadSpawner = (): IsolatedProcessSpawnerPort => ({
  spawn: async (opts: SpawnOpts) => {
    const proc: IsolatedProcess = {
      pid: 1,
      serviceName: opts.serviceName,
      send: () => {
        // DXT NO-THROW path (not used by IsolatedMcpTransport when trySend exists)
      },
      trySend: () => new Error("isolated send failed: stdin closed (dead)"),
      onMessage: () => () => {},
      kill: async () => {},
      exitPromise: new Promise(() => {}),
    }
    return proc
  },
})

const oversizeSpawner = (): IsolatedProcessSpawnerPort => ({
  spawn: async (opts: SpawnOpts) => {
    const proc: IsolatedProcess = {
      pid: 1,
      serviceName: opts.serviceName,
      send: () => {},
      trySend: (msg) => {
        const n = JSON.stringify(msg).length
        if (n > 100) return new Error(`isolated send over cap (${n} > 100 bytes)`)
        return null
      },
      onMessage: () => () => {},
      kill: async () => {},
      exitPromise: new Promise(() => {}),
    }
    return proc
  },
})

describe("C-F1 isolated MCP send failure", () => {
  test("dead stdin trySend → IsolatedMcpTransport.send returns Error", async () => {
    const t = new IsolatedMcpTransport(
      { name: "svc", command: ["bun", "x"] },
      { spawner: deadSpawner(), readyMode: "process-ready" },
    )
    await t.start()
    const err = t.send({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
    expect(err).toBeInstanceOf(Error)
    expect(err?.message).toMatch(/stdin closed|isolated send failed/)
    await t.close()
  })

  test("oversize trySend → IsolatedMcpTransport.send returns Error", async () => {
    const t = new IsolatedMcpTransport(
      { name: "svc", command: ["bun", "x"] },
      { spawner: oversizeSpawner(), readyMode: "process-ready" },
    )
    await t.start()
    const err = t.send({ jsonrpc: "2.0", id: 1, method: "x", params: { huge: "y".repeat(200) } })
    expect(err).toBeInstanceOf(Error)
    expect(err?.message).toMatch(/over cap/)
    await t.close()
  })

  test("MAX_MESSAGE_BYTES constant is the DXT cap IsolatedProcess.send still respects", () => {
    expect(MAX_MESSAGE_BYTES).toBe(10 * 1024 * 1024)
  })
})
