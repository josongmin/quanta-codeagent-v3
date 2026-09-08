/**
 * C-F1 — factory seam: isolated transport when MCP_USE_ISOLATED_SPAWN is on;
 * default stdio/HTTP unchanged when off.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { defaultTransportFor } from "@/mcp/client/transport-factory"
import { HttpSseMcpTransport } from "@/mcp/transports/http-sse"
import { IsolatedMcpTransport } from "@/mcp/transports/isolated"
import { StdioMcpTransport } from "@/mcp/transports/stdio"

const OFFERED = "2025-11-25"
const FLAG = "MCP_USE_ISOLATED_SPAWN"

const withFlag = (value: string | undefined, fn: () => void): void => {
  const prev = process.env[FLAG]
  if (value === undefined) delete process.env[FLAG]
  else process.env[FLAG] = value
  try {
    fn()
  } finally {
    if (prev === undefined) delete process.env[FLAG]
    else process.env[FLAG] = prev
  }
}

describe("C-F1 factory seam", () => {
  afterEach(() => {
    delete process.env[FLAG]
  })

  test("flag off → command config selects StdioMcpTransport", () => {
    withFlag(undefined, () => {
      const t = defaultTransportFor({ name: "svc", command: ["bun", "x"] }, OFFERED)
      expect(t).toBeInstanceOf(StdioMcpTransport)
      expect(t).not.toBeInstanceOf(IsolatedMcpTransport)
    })
  })

  test("flag on → command config selects IsolatedMcpTransport process-ready", () => {
    withFlag("1", () => {
      const t = defaultTransportFor({ name: "svc", command: ["bun", "x"] }, OFFERED)
      expect(t).toBeInstanceOf(IsolatedMcpTransport)
      expect((t as IsolatedMcpTransport).readyModeUsed()).toBe("process-ready")
    })
  })

  test("IsolatedMcpTransport default readyMode is dxt-ready-line", () => {
    const t = new IsolatedMcpTransport({ name: "svc", command: ["bun", "x"] })
    expect(t.readyModeUsed()).toBe("dxt-ready-line")
  })

  test("flag on does not change HTTP selection", () => {
    withFlag("1", () => {
      const t = defaultTransportFor(
        { name: "svc", command: [], url: "https://mcp.example.com/rpc" },
        OFFERED,
      )
      expect(t).toBeInstanceOf(HttpSseMcpTransport)
    })
  })

  test("flag off HTTP still HttpSseMcpTransport", () => {
    withFlag(undefined, () => {
      const t = defaultTransportFor(
        { name: "svc", command: [], url: "https://mcp.example.com/rpc" },
        OFFERED,
      )
      expect(t).toBeInstanceOf(HttpSseMcpTransport)
    })
  })
})
