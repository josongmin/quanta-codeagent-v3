/**
 * ADR-0338 — `launchPluginMcpServers` hellgate.
 *
 * Coverage:
 *   A. manifest has no mcpServers ⇒ []                        (1)
 *   B. mcpServers is {} ⇒ []                                  (1)
 *   C. one server ⇒ port.launch called once + handle tracked  (1)
 *   D. N servers ⇒ all launched, deterministic order          (1)
 *   E. port throws ⇒ ready:false handle (NO-THROW)            (1)
 *   F. one launch fails, others succeed ⇒ all returned        (1)
 *   G. already-tracked serverId ⇒ skip spawn, reuse handle    (1)
 *   H. port returns wrong serverId ⇒ rewrap with canonical id (1)
 *   I. registry.track throws ⇒ handle still returned          (1)
 *   J. shutdownAll then re-launch ⇒ fresh spawn               (1)
 *   K. composeServerId is `${pluginId}::${serverName}`        (1)
 *
 * Total ≥ 11 cases.
 */

import { describe, expect, test } from "bun:test"
import type { MCPServerSpec, PluginManifest } from "@/skill/plugin-manifest"
import { composeServerId, launchPluginMcpServers } from "../launcher"
import { createInMemoryPluginMcpRegistry } from "../registry"
import type { McpLauncherPort, McpLaunchOpts, McpServerHandle, PluginMcpRegistry } from "../types"

const VALID_INTERFACE = {
  displayName: "Demo",
  shortDescription: "d",
  longDescription: "dd",
  developerName: "X",
  category: "developer-tools",
  capabilities: ["Read"] as const,
  websiteURL: "https://example.com",
  privacyPolicyURL: "https://example.com/p",
  termsOfServiceURL: "https://example.com/t",
  logo: "logo.png",
  defaultPrompt: ["hi"],
  brandColor: "#fff",
  screenshots: [] as string[],
}

const makeManifest = (name: string, mcpServers?: Record<string, MCPServerSpec>): PluginManifest => {
  const m: PluginManifest = {
    name,
    version: "1.0.0",
    description: "d",
    author: { name: "X" },
    license: "MIT",
    keywords: [],
    interface: { ...VALID_INTERFACE, capabilities: [...VALID_INTERFACE.capabilities] },
  }
  if (mcpServers !== undefined) m.mcpServers = mcpServers
  return m
}

const makeSpec = (command = "node", args: string[] = []): MCPServerSpec => ({
  command,
  args,
})

interface PortCall {
  pluginId: string
  serverName: string
  spec: MCPServerSpec
}

const collectingPort = (
  shape: (opts: McpLaunchOpts) => Partial<McpServerHandle> | Error = () => ({
    ready: true,
  }),
): { port: McpLauncherPort; calls: PortCall[] } => {
  const calls: PortCall[] = []
  const port: McpLauncherPort = {
    launch: async (spec, opts) => {
      calls.push({ pluginId: opts.pluginId, serverName: opts.serverName, spec })
      const r = shape(opts)
      if (r instanceof Error) throw r
      const id = composeServerId(opts.pluginId, opts.serverName)
      return {
        serverId: r.serverId ?? id,
        ready: r.ready ?? true,
        ...(r.error !== undefined ? { error: r.error } : {}),
        shutdown: r.shutdown ?? (async () => undefined),
      }
    },
  }
  return { port, calls }
}

describe("ADR-0338 launcher §A — no mcpServers", () => {
  test("manifest without mcpServers ⇒ []", async () => {
    const m = makeManifest("plugin-a")
    const reg = createInMemoryPluginMcpRegistry()
    const { port, calls } = collectingPort()
    const out = await launchPluginMcpServers(m, reg, port)
    expect(out).toEqual([])
    expect(calls).toEqual([])
  })
})

describe("ADR-0338 launcher §B — empty mcpServers", () => {
  test("manifest with mcpServers: {} ⇒ []", async () => {
    const m = makeManifest("plugin-a", {})
    const reg = createInMemoryPluginMcpRegistry()
    const { port, calls } = collectingPort()
    const out = await launchPluginMcpServers(m, reg, port)
    expect(out).toEqual([])
    expect(calls).toEqual([])
  })
})

describe("ADR-0338 launcher §C — single server", () => {
  test("1 server ⇒ 1 launch + registry tracks it", async () => {
    const m = makeManifest("plugin-a", { docs: makeSpec("docs-mcp", ["--stdio"]) })
    const reg = createInMemoryPluginMcpRegistry()
    const { port, calls } = collectingPort()
    const out = await launchPluginMcpServers(m, reg, port)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.pluginId).toBe("plugin-a")
    expect(calls[0]?.serverName).toBe("docs")
    expect(out).toHaveLength(1)
    expect(out[0]?.serverId).toBe("plugin-a::docs")
    expect(out[0]?.ready).toBe(true)
    expect(reg.handlesFor("plugin-a")).toHaveLength(1)
  })
})

describe("ADR-0338 launcher §D — multiple servers, deterministic order", () => {
  test("N servers ⇒ lex-ordered launch", async () => {
    const m = makeManifest("plugin-a", {
      zeta: makeSpec(),
      alpha: makeSpec(),
      mu: makeSpec(),
    })
    const reg = createInMemoryPluginMcpRegistry()
    const { port, calls } = collectingPort()
    const out = await launchPluginMcpServers(m, reg, port)
    expect(calls.map((c) => c.serverName)).toEqual(["alpha", "mu", "zeta"])
    expect(out.map((h) => h.serverId)).toEqual([
      "plugin-a::alpha",
      "plugin-a::mu",
      "plugin-a::zeta",
    ])
  })
})

describe("ADR-0338 launcher §E — port throws (NO-THROW)", () => {
  test("port.launch throws ⇒ ready:false handle, error message captured", async () => {
    const m = makeManifest("plugin-a", { broken: makeSpec() })
    const reg = createInMemoryPluginMcpRegistry()
    const { port } = collectingPort(() => new Error("spawn failed"))
    const out = await launchPluginMcpServers(m, reg, port)
    expect(out).toHaveLength(1)
    expect(out[0]?.ready).toBe(false)
    expect(out[0]?.error).toBe("spawn failed")
    expect(out[0]?.serverId).toBe("plugin-a::broken")
    // Failed handle is still tracked (so the host can call shutdownAll uniformly).
    expect(reg.handlesFor("plugin-a")).toHaveLength(1)
  })
})

describe("ADR-0338 launcher §F — isolation", () => {
  test("one server fails, others succeed ⇒ all returned in order", async () => {
    const m = makeManifest("plugin-a", {
      a: makeSpec(),
      bad: makeSpec(),
      c: makeSpec(),
    })
    const reg = createInMemoryPluginMcpRegistry()
    const { port } = collectingPort((opts) =>
      opts.serverName === "bad" ? new Error("nope") : { ready: true },
    )
    const out = await launchPluginMcpServers(m, reg, port)
    expect(out).toHaveLength(3)
    expect(out[0]?.ready).toBe(true)
    expect(out[1]?.ready).toBe(false)
    expect(out[1]?.error).toBe("nope")
    expect(out[2]?.ready).toBe(true)
  })
})

describe("ADR-0338 launcher §G — idempotency", () => {
  test("re-launch with already-tracked serverId ⇒ no second spawn", async () => {
    const m = makeManifest("plugin-a", { docs: makeSpec() })
    const reg = createInMemoryPluginMcpRegistry()
    const { port, calls } = collectingPort()
    const first = await launchPluginMcpServers(m, reg, port)
    expect(calls).toHaveLength(1)
    expect(first).toHaveLength(1)

    const second = await launchPluginMcpServers(m, reg, port)
    expect(calls).toHaveLength(1) // still 1 — no respawn
    expect(second).toHaveLength(1)
    expect(second[0]).toBe(first[0] as McpServerHandle) // reused
  })
})

describe("ADR-0338 launcher §H — wrong serverId from port", () => {
  test("port returns inconsistent serverId ⇒ launcher rewraps with canonical", async () => {
    const m = makeManifest("plugin-a", { docs: makeSpec() })
    const reg = createInMemoryPluginMcpRegistry()
    const { port } = collectingPort(() => ({
      serverId: "WRONG_ID_FROM_PORT",
      ready: true,
    }))
    const out = await launchPluginMcpServers(m, reg, port)
    expect(out).toHaveLength(1)
    expect(out[0]?.serverId).toBe("plugin-a::docs") // canonical, not "WRONG_ID_FROM_PORT"
  })
})

describe("ADR-0338 launcher §I — registry.track throws (NO-THROW)", () => {
  test("registry throwing on track ⇒ handle still returned", async () => {
    const m = makeManifest("plugin-a", { docs: makeSpec() })
    const explodingReg: PluginMcpRegistry = {
      track: () => {
        throw new Error("registry boom")
      },
      handlesFor: () => [],
      hasServerId: () => false,
      shutdownAll: async () => undefined,
    }
    const { port } = collectingPort()
    const out = await launchPluginMcpServers(m, explodingReg, port)
    expect(out).toHaveLength(1)
    expect(out[0]?.ready).toBe(true)
  })
})

describe("ADR-0338 launcher §J — shutdownAll then re-launch", () => {
  test("shutdownAll clears registry ⇒ next launch spawns fresh", async () => {
    const m = makeManifest("plugin-a", { docs: makeSpec() })
    const reg = createInMemoryPluginMcpRegistry()
    const { port, calls } = collectingPort()

    await launchPluginMcpServers(m, reg, port)
    expect(calls).toHaveLength(1)
    expect(reg.hasServerId("plugin-a::docs")).toBe(true)

    await reg.shutdownAll()
    expect(reg.hasServerId("plugin-a::docs")).toBe(false)

    await launchPluginMcpServers(m, reg, port)
    expect(calls).toHaveLength(2) // fresh spawn
  })
})

describe("ADR-0338 launcher §K — composeServerId", () => {
  test("composeServerId joins with `::`", () => {
    expect(composeServerId("plugin-a", "docs")).toBe("plugin-a::docs")
    expect(composeServerId("a.b-c", "x_y.z")).toBe("a.b-c::x_y.z")
  })
})
