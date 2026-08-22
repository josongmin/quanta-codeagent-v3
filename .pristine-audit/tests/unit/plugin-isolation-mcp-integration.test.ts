/**
 * IsolatedMcpClient — happy-path unit (ADR-0162 Phase E).
 *
 * Backwards-compat checks: env-flag is the only switch, the legacy McpClient
 * stays intact, and the isolated client mirrors the legacy public surface.
 */

import { describe, expect, test } from "bun:test"
import { McpClient } from "@/mcp"
import { IsolatedMcpClient, isolatedMcpEnabledFromEnv } from "@/mcp/isolated-client"

describe("ADR-0162 IsolatedMcpClient — backwards compat", () => {
  test("legacy McpClient export is still reachable from @/mcp barrel", () => {
    expect(typeof McpClient).toBe("function")
  })

  test("IsolatedMcpClient mirrors the legacy public surface", () => {
    const inst = new IsolatedMcpClient({ name: "x", command: ["bun"] })
    expect(typeof inst.start).toBe("function")
    expect(typeof inst.listTools).toBe("function")
    expect(typeof inst.callTool).toBe("function")
    expect(typeof inst.stop).toBe("function")
  })

  test("flag detection defaults to the process.env (when no arg passed)", () => {
    // Real env-access verification: clear the documented key, then call
    // with no arg — the result must be `false` (defaults are off-by-default).
    // This proves the no-arg overload genuinely consults process.env.
    const prev = process.env.MCP_USE_ISOLATED_SPAWN
    process.env.MCP_USE_ISOLATED_SPAWN = undefined
    try {
      const cleared = isolatedMcpEnabledFromEnv()
      expect(cleared).toBe(false)
      process.env.MCP_USE_ISOLATED_SPAWN = "1"
      const set = isolatedMcpEnabledFromEnv()
      expect(set).toBe(true)
    } finally {
      process.env.MCP_USE_ISOLATED_SPAWN = prev
    }
  })

  test("flag detection is pure (no env mutation)", () => {
    const before = process.env.MCP_USE_ISOLATED_SPAWN
    // Trap Proxy that throws if isolatedMcpEnabledFromEnv mutates the env
    // object it was handed (it should only read).
    const trap = new Proxy({ MCP_USE_ISOLATED_SPAWN: "1" } as Record<string, string | undefined>, {
      set() {
        throw new Error("env mutation forbidden — flag-detection must be pure")
      },
      deleteProperty() {
        throw new Error("env mutation (delete) forbidden")
      },
    })
    expect(() => isolatedMcpEnabledFromEnv(trap)).not.toThrow()
    isolatedMcpEnabledFromEnv({ MCP_USE_ISOLATED_SPAWN: "1" })
    isolatedMcpEnabledFromEnv({ MCP_USE_ISOLATED_SPAWN: "0" })
    expect(process.env.MCP_USE_ISOLATED_SPAWN).toBe(before)
  })

  test("opts.spawnTimeoutMs / gracefulKillMs / requestTimeoutMs overridable", () => {
    // Construction must accept the overrides without throwing — full
    // semantic coverage is in the hellgate. This catches a regression where
    // an interface field is renamed.
    const inst = new IsolatedMcpClient(
      { name: "y", command: ["bun"] },
      { spawnTimeoutMs: 1000, gracefulKillMs: 1000, requestTimeoutMs: 1000 },
    )
    expect(inst).toBeInstanceOf(IsolatedMcpClient)
  })
})
