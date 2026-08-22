/**
 * WS-G item 11 (UUX-6-22) — the MCP lifecycle pill was BOOT-ONCE: bootstrap
 * derived `[mcp: ✓ …]` from the bridged tools exactly once, so a server dying
 * mid-session stayed ✓ forever and NOTHING told the operator.
 *
 * Fix (three seams, each pinned here):
 *   1. `McpHealthHolder` + `overlayServerHealth` — pure down-registry the
 *      exit/load-error callbacks write and the pill overlay reads.
 *   2. `loadMcpTools({ onServerExit })` — the bridge subscribes the SINGLE-
 *      client path's `McpClient.onExit` (supervised path is intentionally
 *      skipped: the supervisor owns restarts) and reports `{server, reason}`.
 *   3. `composeTurnSinks(...).flushLifecyclePills()` — re-derives the MCP pill
 *      per flush from the live tools + health overlay (boot-once no more).
 *
 * Plus the CLI wiring: `buildMcpLoadOpts` routes exit/load-error into the
 * health holder AND the operator-notice bus (error severity — a dead server
 * makes its tools fail).
 */

import { afterEach, describe, expect, test } from "bun:test"
import { loadMcpTools } from "@/agent/mcp-bridge"
import type { JsonRpcMessage } from "@/mcp/jsonrpc"
import type { McpTransport } from "@/mcp/transports/port"
import {
  __resetOperatorNoticeSinkForTest,
  installOperatorNoticeSink,
  type OperatorNotice,
} from "@/shared"
import { createMcpHealthHolder, overlayServerHealth } from "../../../src/apps/cli/mcp-health"
import type { SessionSetupResult } from "../../../src/apps/cli/repl/session-setup"
import {
  composeTurnSinks,
  createSurfaceState,
} from "../../../src/apps/cli/repl/surface-compose/turn-sinks"

const flush = async (): Promise<void> => {
  for (let i = 0; i < 64; i++) await Promise.resolve()
}

const notices: OperatorNotice[] = []

afterEach(() => {
  __resetOperatorNoticeSinkForTest()
  notices.length = 0
})

describe("McpHealthHolder + overlay (pure)", () => {
  test("a down server flips its derived pill row to ✗ and unknown downs are appended", () => {
    const holder = createMcpHealthHolder()
    holder.markDown("fs", "transport exit")
    holder.markDown("never-bridged", "spawn failed")
    const overlaid = overlayServerHealth(
      [
        { name: "fs", status: "connected", toolCount: 3 },
        { name: "playwright", status: "connected", toolCount: 5 },
      ],
      holder.downServers(),
    )
    expect(overlaid.find((s) => s.name === "fs")?.status).toBe("down")
    expect(overlaid.find((s) => s.name === "playwright")?.status).toBe("connected")
    // Appended rows carry the SANITIZED key — the same vocabulary the derived
    // pill rows use (`mcp__<sanitized>__` join).
    expect(overlaid.find((s) => s.name === "never_bridged")?.status).toBe("down")
  })

  test("raw config names match sanitized pill keys (mcp__<sanitized>__ join)", () => {
    const holder = createMcpHealthHolder()
    holder.markDown("my-server.v2", "exit") // sanitizes to my_server_v2
    const overlaid = overlayServerHealth(
      [{ name: "my_server_v2", status: "connected", toolCount: 1 }],
      holder.downServers(),
    )
    expect(overlaid).toHaveLength(1)
    expect(overlaid[0]?.status).toBe("down")
  })
})

describe("bridge — loadMcpTools onServerExit subscription", () => {
  class ExitableTransport implements McpTransport {
    private messageHandler: ((msg: JsonRpcMessage) => void) | null = null
    private exitHandlers = new Set<(reason?: string) => void>()
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
    onExit(handler: (reason?: string) => void): () => void {
      this.exitHandlers.add(handler)
      return () => this.exitHandlers.delete(handler)
    }
    close(): Promise<void> {
      return Promise.resolve()
    }
    emit(msg: JsonRpcMessage): void {
      this.messageHandler?.(msg)
    }
    fireExit(): void {
      for (const h of this.exitHandlers) h()
    }
  }

  test("server death mid-session reaches the onServerExit callback with the server name", async () => {
    const transport = new ExitableTransport()
    const exits: Array<{ server: string; reason?: string }> = []
    const loadP = loadMcpTools([{ name: "s1", command: ["x"] }], undefined, {
      transportFor: () => transport,
      onServerExit: (info) => exits.push(info),
    })
    await flush()
    const init = transport.sent.find((m) => m.method === "initialize") as { id: number } | undefined
    if (init !== undefined) {
      transport.emit({ jsonrpc: "2.0", id: init.id, result: { protocolVersion: "2025-06-18" } })
    }
    await flush()
    const list = transport.sent.find((m) => m.method === "tools/list") as { id: number } | undefined
    if (list !== undefined) {
      transport.emit({ jsonrpc: "2.0", id: list.id, result: { tools: [] } })
    }
    const { clients } = await loadP
    expect(clients).toHaveLength(1)
    expect(exits).toHaveLength(0) // alive — no false positive

    transport.fireExit() // the server dies mid-session
    expect(exits).toHaveLength(1)
    expect(exits[0]?.server).toBe("s1")
    await Promise.all(clients.map((c) => c.stop()))
  })
})

describe("turn-sinks — MCP pill re-derived per flush with health overlay", () => {
  const buildSetup = (
    mcpHealth: ReturnType<typeof createMcpHealthHolder>,
    updates: unknown[],
  ): SessionSetupResult =>
    ({
      model: "m",
      slog: { info: () => {} },
      metrics: undefined,
      turnSummary: { render: () => "", reset: () => {} },
      statusBar: { transient: () => {} },
      lifecycleTaskRegistry: undefined,
      lifecycleFollowUpQueue: undefined,
      lifecyclePills: {
        update: (patch: unknown) => updates.push(patch),
        flush: () => {},
      },
      mcpTools: [{ name: "mcp__fs__read" }, { name: "mcp__fs__write" }],
      mcpHealth,
    }) as unknown as SessionSetupResult

  test("a server marked down AFTER boot appears ✗ on the NEXT flush", () => {
    const holder = createMcpHealthHolder()
    const updates: Array<{ mcp?: { servers: Array<{ name: string; status: string }> } }> = []
    const sinks = composeTurnSinks(
      buildSetup(holder, updates),
      createSurfaceState({ imageQueue: undefined, rewindState: undefined, history: [] }),
    )
    sinks.flushLifecyclePills()
    const before = updates.filter((u) => u.mcp !== undefined).at(-1)
    expect(before?.mcp?.servers.find((s) => s.name === "fs")?.status).toBe("connected")

    holder.markDown("fs", "transport exit") // mid-session death
    sinks.flushLifecyclePills()
    const after = updates.filter((u) => u.mcp !== undefined).at(-1)
    expect(after?.mcp?.servers.find((s) => s.name === "fs")?.status).toBe("down")
  })

  test("no MCP tools and no downs ⇒ no mcp pill patch (threshold parity)", () => {
    const holder = createMcpHealthHolder()
    const updates: Array<{ mcp?: unknown }> = []
    const setup = buildSetup(holder, updates)
    ;(setup as unknown as { mcpTools: unknown[] }).mcpTools = []
    const sinks = composeTurnSinks(
      setup,
      createSurfaceState({ imageQueue: undefined, rewindState: undefined, history: [] }),
    )
    sinks.flushLifecyclePills()
    expect(updates.filter((u) => u.mcp !== undefined)).toHaveLength(0)
  })
})

describe("CLI wiring — exit/load-error route to holder + notice bus", () => {
  test("buildMcpLoadOpts onServerExit marks down AND emits an error notice", async () => {
    installOperatorNoticeSink((n) => notices.push(n))
    const { buildMcpLoadOpts } = await import("../../../src/apps/cli/internal/mcp")
    const holder = createMcpHealthHolder()
    const slog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
    const opts = buildMcpLoadOpts(slog as never, {
      autoRestart: false,
      inboundWiring: undefined,
      oauthProvider: undefined,
      opts: {},
      mcpHealth: holder,
    })
    opts?.onServerExit?.({ server: "fs", reason: "transport exit" })
    expect(holder.downServers().has("fs")).toBe(true)
    const errs = notices.filter((n) => n.source === "mcp" && n.severity === "error")
    expect(errs).toHaveLength(1)
    expect(errs[0]?.message).toContain("fs")

    opts?.onServerLoadError?.({ server: "pw", error: new Error("spawn failed") })
    expect(holder.downServers().has("pw")).toBe(true)
    expect(notices.filter((n) => n.source === "mcp" && n.severity === "error")).toHaveLength(2)
  })
})
