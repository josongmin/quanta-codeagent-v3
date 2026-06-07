/**
 * IsolatedMcpClient protocol-version negotiation hellgate (ticket misc-jun-7/01).
 *
 * The isolated spawn path (default-OFF, `MCP_USE_ISOLATED_SPAWN=1`) must consume
 * the SAME version SSOT as the in-process client — one source, both clients —
 * and apply the same accept / legacy-tolerant / fail-closed read on the
 * `initialize` reply it previously DISCARDED.
 *
 * Drives `IsolatedMcpClient` through a programmable in-memory `IsolatedProcess`
 * (no real subprocess) that echoes a scripted `initialize` reply.
 */
import { describe, expect, test } from "bun:test"
import {
  isSupportedProtocolVersion,
  LATEST_PROTOCOL_VERSION,
  resolveOfferedVersion,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@/mcp"
import { IsolatedMcpClient } from "@/mcp/isolated-client"
import type { IsolatedProcess, IsolatedProcessSpawnerPort } from "@/plugin-isolation"

/** A programmable in-memory process whose `onMessage` replies to `initialize`
 *  with the supplied outcome, echoing the request id. Records every offered
 *  version so the SSOT consumption is observable. */
const scriptedSpawner = (
  reply: (
    offered: string,
  ) => Record<string, unknown> | { error: { code: number; message: string } },
  offers: string[],
): IsolatedProcessSpawnerPort => ({
  spawn: async (opts) => {
    let handler: ((msg: unknown) => void) | null = null
    const proc: IsolatedProcess = {
      pid: 1,
      serviceName: opts.serviceName,
      send: (msg: unknown) => {
        const m = msg as { id?: number; method?: string; params?: { protocolVersion?: string } }
        if (m.method === "initialize" && typeof m.id === "number") {
          const offered = m.params?.protocolVersion ?? "<missing>"
          offers.push(offered)
          const out = reply(offered)
          const id = m.id
          queueMicrotask(() => {
            if ("error" in out) {
              handler?.({ jsonrpc: "2.0", id, error: out.error })
            } else {
              handler?.({ jsonrpc: "2.0", id, result: out })
            }
          })
        }
      },
      onMessage: (h: (msg: unknown) => void) => {
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

const mkClient = (
  reply: (
    offered: string,
  ) => Record<string, unknown> | { error: { code: number; message: string } },
): { client: IsolatedMcpClient; offers: string[] } => {
  const offers: string[] = []
  const client = new IsolatedMcpClient(
    { name: "iso", command: ["bun", "x"] },
    { spawner: scriptedSpawner(reply, offers), requestTimeoutMs: 2000 },
  )
  return { client, offers }
}

describe("IsolatedMcpClient — SSOT consumption (one source, both clients)", () => {
  test("re-exports the SAME negotiation primitives the in-process client uses", () => {
    expect(LATEST_PROTOCOL_VERSION).toBe("2025-11-25")
    expect(isSupportedProtocolVersion("2025-11-25")).toBe(true)
    expect(resolveOfferedVersion(undefined)).toBe(LATEST_PROTOCOL_VERSION)
    expect(SUPPORTED_PROTOCOL_VERSIONS.length).toBe(5)
  })

  test("offers the SSOT newest version on initialize (not a hardcoded floor)", async () => {
    const { client, offers } = mkClient(() => ({
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
    }))
    await client.start()
    expect(offers).toEqual([LATEST_PROTOCOL_VERSION])
    expect(client.pinnedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION)
    await client.stop()
  })

  test("accepts + pins the server's chosen (older) version", async () => {
    const { client } = mkClient(() => ({ protocolVersion: "2025-06-18", capabilities: {} }))
    await client.start()
    expect(client.pinnedProtocolVersion()).toBe("2025-06-18")
    await client.stop()
  })

  test("legacy-tolerant: server omits protocolVersion ⇒ pins the offer, no throw", async () => {
    const { client } = mkClient(() => ({ capabilities: {} }))
    await expect(client.start()).resolves.toBeUndefined()
    expect(client.pinnedProtocolVersion()).toBe(LATEST_PROTOCOL_VERSION)
    await client.stop()
  })
})

describe("IsolatedMcpClient — fail-closed on unsupported server version", () => {
  test("server picks a version NOT in the set ⇒ start() rejects (no silent proceed)", async () => {
    const { client } = mkClient(() => ({ protocolVersion: "1999-01-01", capabilities: {} }))
    let caught: Error | null = null
    try {
      await client.start()
    } catch (e) {
      caught = e as Error
    }
    expect(caught).not.toBeNull()
    // The unsupported-version reason survives the IsolatedMcpError wrap.
    expect(caught?.message).toContain("unsupported protocolVersion")
    expect(caught?.message).toContain("1999-01-01")
    await client.stop()
  })
})
