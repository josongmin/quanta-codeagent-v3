/**
 * C-F1 — factory seam: isolated transport when host policy is on; default
 * stdio/HTTP unchanged when off.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { buildMcpLoadOpts } from "@/host/mcp-composition"
import { defaultTransportFor } from "@/mcp/client/transport-factory"
import { HttpSseMcpTransport } from "@/mcp/transports/http-sse"
import { IsolatedMcpTransport } from "@/mcp/transports/isolated"
import { StdioMcpTransport } from "@/mcp/transports/stdio"

const OFFERED = "2025-11-25"
const FLAG = "MCP_USE_ISOLATED_SPAWN"

describe("C-F1 factory seam", () => {
  afterEach(() => {
    delete process.env[FLAG]
  })

  test("policy off → command config selects StdioMcpTransport", () => {
    const t = defaultTransportFor({ name: "svc", command: ["bun", "x"] }, OFFERED)
    expect(t).toBeInstanceOf(StdioMcpTransport)
    expect(t).not.toBeInstanceOf(IsolatedMcpTransport)
  })

  test("policy on → command config selects IsolatedMcpTransport process-ready", () => {
    const t = defaultTransportFor({ name: "svc", command: ["bun", "x"] }, OFFERED, undefined, true)
    expect(t).toBeInstanceOf(IsolatedMcpTransport)
    expect((t as IsolatedMcpTransport).readyModeUsed()).toBe("process-ready")
  })

  test("IsolatedMcpTransport default readyMode is dxt-ready-line", () => {
    const t = new IsolatedMcpTransport({ name: "svc", command: ["bun", "x"] })
    expect(t.readyModeUsed()).toBe("dxt-ready-line")
  })

  test("policy on does not change HTTP selection", () => {
    const t = defaultTransportFor(
      { name: "svc", command: [], url: "https://mcp.example.com/rpc" },
      OFFERED,
      undefined,
      true,
    )
    expect(t).toBeInstanceOf(HttpSseMcpTransport)
  })

  test("policy off HTTP still HttpSseMcpTransport", () => {
    const t = defaultTransportFor(
      { name: "svc", command: [], url: "https://mcp.example.com/rpc" },
      OFFERED,
    )
    expect(t).toBeInstanceOf(HttpSseMcpTransport)
  })

  test("host parses env and injects the same policy into both load paths", () => {
    process.env[FLAG] = "1"
    const slog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
    const single = buildMcpLoadOpts(slog as never, {
      autoRestart: false,
      inboundWiring: undefined,
      oauthProvider: undefined,
      opts: {},
    })
    expect(single?.isolatedSpawn).toBe(true)

    const supervised = buildMcpLoadOpts(slog as never, {
      autoRestart: true,
      inboundWiring: undefined,
      oauthProvider: undefined,
      opts: {},
    })
    const deps = supervised?.supervisorDepsFor?.({ name: "svc", command: ["bun", "x"] })
    const client = deps?.factory({ name: "svc", command: ["bun", "x"] })
    const transport = (client as unknown as { transport: unknown }).transport
    expect(transport).toBeInstanceOf(IsolatedMcpTransport)
  })

  test("host omits isolated policy when env flag is off", () => {
    const slog = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }
    const opts = buildMcpLoadOpts(slog as never, {
      autoRestart: false,
      inboundWiring: undefined,
      oauthProvider: undefined,
      opts: {},
    })
    expect(opts?.isolatedSpawn).toBeUndefined()
  })
})
