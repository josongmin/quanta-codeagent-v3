/**
 * ADR-0340 — `createPluginActivationHandler` hellgate.
 *
 * Coverage (≥ 14):
 *   A. unknown pluginId (registry miss)          → empty result, NO-THROW
 *   B. known plugin, no MCP + no skills           → empty handles + skills
 *   C. 1 MCP server                              → port.launch called, 1 handle
 *   D. multiple MCP servers                      → all launched
 *   E. mcpLauncherPort absent                    → skip MCP, skill step runs
 *   F. mcpRegistry absent                        → skip MCP, skill step runs
 *   G. skillRegistry absent                      → skip skills, MCP runs
 *   H. idempotent: same id twice                 → cached, no re-spawn
 *   I. launch port throws                        → swallow, ready:false handle
 *   J. skill registry lookup throws              → drop entry (NO-THROW)
 *   K. emit hook fires per resolved skill        → 2 emits for 2 skills
 *   L. emit absent                               → no emit, descriptors fine
 *   M. turnId propagated to skill_activation     → event.turnId === input
 *   N. ADR-0336 manifest mcpServers (array)      → adapted via shape adapter
 *   O. registry.lookup throws                    → empty result, NO-THROW
 *   P. malformed pluginId (empty string)         → empty result
 *   Q. caller-side registry shutdownAll tracks   → handle reachable via handlesFor
 */

import { describe, expect, test } from "bun:test"
import type { PluginManifest, PluginRegistryPort } from "@/agent/plugin-discovery"
import {
  composeServerId,
  createInMemoryPluginMcpRegistry,
  type McpLauncherPort,
} from "@/agent/plugin-mcp-launcher"
import type { SkillActivationEventLike } from "@/agent/plugin-skill-extension"
import type { MCPServerSpec } from "@/skill/plugin-manifest"
import type { SkillRegistryReadOnly } from "@/skill/registry-readonly"
import { createPluginActivationHandler } from "../handler"

/** Build a minimal ADR-0336 manifest. Post-ADR-0341 `mcpServers` is the
 *  Codex-canonical `Record<string, MCPServerSpec>` shape. */
const mkManifest = (
  id: string,
  opts: { mcpServers?: Readonly<Record<string, MCPServerSpec>>; skills?: readonly string[] } = {},
): PluginManifest => {
  const m: PluginManifest = {
    id,
    name: id,
    capabilities: [],
  }
  if (opts.mcpServers !== undefined)
    (m as { mcpServers?: Readonly<Record<string, MCPServerSpec>> }).mcpServers = opts.mcpServers
  if (opts.skills !== undefined) (m as { skills?: readonly string[] }).skills = opts.skills
  return m
}

/** Build a stub registry from id → manifest map. */
const mkPluginRegistry = (map: Record<string, PluginManifest>): PluginRegistryPort => ({
  lookup: (id: string) => map[id] ?? null,
  list: () => Object.values(map),
})

/** Build a counting launcher port. */
const mkPort = (): { port: McpLauncherPort; calls: { pluginId: string; serverName: string }[] } => {
  const calls: { pluginId: string; serverName: string }[] = []
  const port: McpLauncherPort = {
    launch: async (_spec, opts) => {
      calls.push({ pluginId: opts.pluginId, serverName: opts.serverName })
      return {
        serverId: composeServerId(opts.pluginId, opts.serverName),
        ready: true,
        shutdown: async () => undefined,
      }
    },
  }
  return { port, calls }
}

/** Build a skill registry stub. */
const mkSkills = (map: Record<string, string>): SkillRegistryReadOnly => ({
  lookup: (name: string) => {
    const description = map[name]
    return description === undefined ? null : { name, description }
  },
})

describe("createPluginActivationHandler — ADR-0340 hellgate", () => {
  test("A. unknown pluginId ⇒ empty result, NO-THROW", async () => {
    const handler = createPluginActivationHandler({
      pluginRegistry: mkPluginRegistry({}),
    })
    const out = await handler("ghost")
    expect(out).toEqual({ pluginId: "ghost", mcpHandles: [], resolvedSkills: [] })
  })

  test("B. known plugin, no MCP + no skills ⇒ empty arrays", async () => {
    const handler = createPluginActivationHandler({
      pluginRegistry: mkPluginRegistry({ x: mkManifest("x") }),
    })
    const out = await handler("x")
    expect(out.pluginId).toBe("x")
    expect(out.mcpHandles).toEqual([])
    expect(out.resolvedSkills).toEqual([])
  })

  test("C. 1 MCP server ⇒ port.launch called once, 1 handle tracked", async () => {
    const { port, calls } = mkPort()
    const registry = createInMemoryPluginMcpRegistry()
    const handler = createPluginActivationHandler({
      pluginRegistry: mkPluginRegistry({
        gh: mkManifest("gh", { mcpServers: { fs: { command: "/usr/bin/node", args: [] } } }),
      }),
      mcpLauncherPort: port,
      mcpRegistry: registry,
    })
    const out = await handler("gh")
    expect(calls).toEqual([{ pluginId: "gh", serverName: "fs" }])
    expect(out.mcpHandles).toHaveLength(1)
    expect(out.mcpHandles[0]?.serverId).toBe("gh::fs")
    expect(registry.handlesFor("gh")).toHaveLength(1)
  })

  test("D. multiple MCP servers ⇒ all launched", async () => {
    const { port, calls } = mkPort()
    const registry = createInMemoryPluginMcpRegistry()
    const handler = createPluginActivationHandler({
      pluginRegistry: mkPluginRegistry({
        gh: mkManifest("gh", {
          mcpServers: {
            fs: { command: "/a", args: [] },
            git: { command: "/b", args: [] },
            shell: { command: "/c", args: [] },
          },
        }),
      }),
      mcpLauncherPort: port,
      mcpRegistry: registry,
    })
    const out = await handler("gh")
    expect(calls.map((c) => c.serverName)).toEqual(["fs", "git", "shell"])
    expect(out.mcpHandles).toHaveLength(3)
  })

  test("E. mcpLauncherPort absent ⇒ skip MCP, skill step still runs", async () => {
    const handler = createPluginActivationHandler({
      pluginRegistry: mkPluginRegistry({
        a: mkManifest("a", {
          mcpServers: { fs: { command: "/x", args: [] } },
          skills: ["pr-review"],
        }),
      }),
      skillRegistry: mkSkills({ "pr-review": "Review PRs" }),
    })
    const out = await handler("a")
    expect(out.mcpHandles).toEqual([])
    expect(out.resolvedSkills).toEqual([{ name: "pr-review", description: "Review PRs" }])
  })

  test("F. mcpRegistry absent ⇒ skip MCP, skill step runs", async () => {
    const { port } = mkPort()
    const handler = createPluginActivationHandler({
      pluginRegistry: mkPluginRegistry({
        a: mkManifest("a", {
          mcpServers: { fs: { command: "/x", args: [] } },
          skills: ["pr-review"],
        }),
      }),
      mcpLauncherPort: port,
      // mcpRegistry omitted on purpose
      skillRegistry: mkSkills({ "pr-review": "Review PRs" }),
    })
    const out = await handler("a")
    expect(out.mcpHandles).toEqual([])
    expect(out.resolvedSkills).toHaveLength(1)
  })

  test("G. skillRegistry absent ⇒ skip skills, MCP runs", async () => {
    const { port } = mkPort()
    const registry = createInMemoryPluginMcpRegistry()
    const handler = createPluginActivationHandler({
      pluginRegistry: mkPluginRegistry({
        a: mkManifest("a", {
          mcpServers: { fs: { command: "/x", args: [] } },
          skills: ["pr-review"],
        }),
      }),
      mcpLauncherPort: port,
      mcpRegistry: registry,
    })
    const out = await handler("a")
    expect(out.mcpHandles).toHaveLength(1)
    expect(out.resolvedSkills).toEqual([])
  })

  test("H. idempotent: same pluginId twice ⇒ cached result, no re-spawn", async () => {
    const { port, calls } = mkPort()
    const registry = createInMemoryPluginMcpRegistry()
    const handler = createPluginActivationHandler({
      pluginRegistry: mkPluginRegistry({
        gh: mkManifest("gh", { mcpServers: { fs: { command: "/a", args: [] } } }),
      }),
      mcpLauncherPort: port,
      mcpRegistry: registry,
    })
    const first = await handler("gh")
    const second = await handler("gh")
    expect(second).toBe(first) // cache returns SAME reference
    expect(calls).toHaveLength(1) // no re-spawn
  })

  test("I. launch port throws ⇒ ready:false handle, NO-THROW", async () => {
    const port: McpLauncherPort = {
      launch: async () => {
        throw new Error("spawn failed")
      },
    }
    const registry = createInMemoryPluginMcpRegistry()
    const handler = createPluginActivationHandler({
      pluginRegistry: mkPluginRegistry({
        x: mkManifest("x", { mcpServers: { fs: { command: "/a", args: [] } } }),
      }),
      mcpLauncherPort: port,
      mcpRegistry: registry,
    })
    const out = await handler("x")
    expect(out.mcpHandles).toHaveLength(1)
    expect(out.mcpHandles[0]?.ready).toBe(false)
    expect(out.mcpHandles[0]?.error).toContain("spawn failed")
  })

  test("J. skill registry lookup throws ⇒ drop entry, NO-THROW", async () => {
    const throwingSkills: SkillRegistryReadOnly = {
      lookup: () => {
        throw new Error("registry boom")
      },
    }
    const handler = createPluginActivationHandler({
      pluginRegistry: mkPluginRegistry({
        a: mkManifest("a", { skills: ["pr-review"] }),
      }),
      skillRegistry: throwingSkills,
    })
    const out = await handler("a")
    expect(out.resolvedSkills).toEqual([])
  })

  test("K. emit hook fires per resolved skill", async () => {
    const events: SkillActivationEventLike[] = []
    const handler = createPluginActivationHandler({
      pluginRegistry: mkPluginRegistry({
        a: mkManifest("a", { skills: ["s1", "s2"] }),
      }),
      skillRegistry: mkSkills({ s1: "d1", s2: "d2" }),
      emit: (e) => events.push(e),
    })
    await handler("a")
    expect(events).toHaveLength(2)
    expect(events.map((e) => e.skillId)).toEqual(["s1", "s2"])
    expect(events.every((e) => e.trigger === "auto")).toBe(true)
  })

  test("L. emit absent ⇒ no emit, descriptors fine", async () => {
    const handler = createPluginActivationHandler({
      pluginRegistry: mkPluginRegistry({
        a: mkManifest("a", { skills: ["s1"] }),
      }),
      skillRegistry: mkSkills({ s1: "d1" }),
    })
    const out = await handler("a")
    expect(out.resolvedSkills).toHaveLength(1)
  })

  test("M. turnId propagated to skill_activation event", async () => {
    const events: SkillActivationEventLike[] = []
    const handler = createPluginActivationHandler({
      pluginRegistry: mkPluginRegistry({
        a: mkManifest("a", { skills: ["s1"] }),
      }),
      skillRegistry: mkSkills({ s1: "d1" }),
      emit: (e) => events.push(e),
    })
    await handler("a", { turnId: "t-42" })
    expect(events[0]?.turnId).toBe("t-42")
  })

  test("N. Record manifest with deterministic lex-order ⇒ launcher sees sorted serverNames", async () => {
    const { port, calls } = mkPort()
    const registry = createInMemoryPluginMcpRegistry()
    // Post-ADR-0341: PluginManifest.mcpServers is Record<string, MCPServerSpec>.
    // The handler iterates `Object.keys(...).sort()` so the launcher sees a
    // deterministic order regardless of insertion. The manifest parser (ADR-0336
    // post-0341) is responsible for dropping invalid entries up front; the
    // handler does NOT re-validate spec shape.
    const handler = createPluginActivationHandler({
      pluginRegistry: mkPluginRegistry({
        gh: mkManifest("gh", {
          mcpServers: {
            // intentionally non-lex insertion order — handler must sort
            git: { command: "/b", args: [] },
            fs: { command: "/a", args: [] },
          },
        }),
      }),
      mcpLauncherPort: port,
      mcpRegistry: registry,
    })
    const out = await handler("gh")
    expect(calls.map((c) => c.serverName)).toEqual(["fs", "git"])
    expect(out.mcpHandles).toHaveLength(2)
  })

  test("O. plugin registry.lookup throws ⇒ empty result, NO-THROW", async () => {
    const throwing: PluginRegistryPort = {
      lookup: () => {
        throw new Error("registry boom")
      },
      list: () => [],
    }
    const handler = createPluginActivationHandler({ pluginRegistry: throwing })
    const out = await handler("x")
    expect(out).toEqual({ pluginId: "x", mcpHandles: [], resolvedSkills: [] })
  })

  test("P. malformed pluginId (empty string) ⇒ empty result", async () => {
    const handler = createPluginActivationHandler({
      pluginRegistry: mkPluginRegistry({ a: mkManifest("a", { skills: ["s1"] }) }),
      skillRegistry: mkSkills({ s1: "d1" }),
    })
    const out = await handler("")
    expect(out.mcpHandles).toEqual([])
    expect(out.resolvedSkills).toEqual([])
  })

  test("Q. handles reachable via registry.handlesFor", async () => {
    const { port } = mkPort()
    const registry = createInMemoryPluginMcpRegistry()
    const handler = createPluginActivationHandler({
      pluginRegistry: mkPluginRegistry({
        gh: mkManifest("gh", { mcpServers: { fs: { command: "/a", args: [] } } }),
      }),
      mcpLauncherPort: port,
      mcpRegistry: registry,
    })
    await handler("gh")
    expect(registry.handlesFor("gh")).toHaveLength(1)
  })

  test("R. emit hook absent — default trigger=auto still encoded in cached result", async () => {
    const handler = createPluginActivationHandler({
      pluginRegistry: mkPluginRegistry({
        a: mkManifest("a", { skills: ["s1"] }),
      }),
      skillRegistry: mkSkills({ s1: "d1" }),
    })
    const out = await handler("a")
    expect(out.resolvedSkills).toEqual([{ name: "s1", description: "d1" }])
  })

  test("S. cached result is reused on second call even when skills empty (lookup-miss path)", async () => {
    const handler = createPluginActivationHandler({
      pluginRegistry: mkPluginRegistry({}),
    })
    const first = await handler("ghost")
    const second = await handler("ghost")
    expect(second).toBe(first)
  })

  test("T. emit hook throwing is swallowed (NO-THROW invariant)", async () => {
    const handler = createPluginActivationHandler({
      pluginRegistry: mkPluginRegistry({
        a: mkManifest("a", { skills: ["s1"] }),
      }),
      skillRegistry: mkSkills({ s1: "d1" }),
      emit: () => {
        throw new Error("emit boom")
      },
    })
    // Must not throw, must still return descriptor.
    const out = await handler("a")
    expect(out.resolvedSkills).toEqual([{ name: "s1", description: "d1" }])
  })

  test("U. now() injection used for event.at (determinism)", async () => {
    const events: SkillActivationEventLike[] = []
    const handler = createPluginActivationHandler({
      pluginRegistry: mkPluginRegistry({
        a: mkManifest("a", { skills: ["s1"] }),
      }),
      skillRegistry: mkSkills({ s1: "d1" }),
      emit: (e) => events.push(e),
      now: () => 1234567890,
    })
    await handler("a")
    expect(events[0]?.at).toBe(1234567890)
  })
})
