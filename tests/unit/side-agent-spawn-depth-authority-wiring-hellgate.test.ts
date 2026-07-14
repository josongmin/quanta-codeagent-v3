/**
 * HELLGATE — rev.4 §4: `buildSideAgentBlock` WIRES the real spawn-depth authority
 * into `side_agent_spawn`, so daemon CREATION obeys the min-cap like every other
 * spawn vector. The tool-level pin (`side-agent-tools-hellgate`) proves the tool
 * honors an INJECTED `admitChild`; THIS pin proves the production builder actually
 * derives that predicate from `config.depth` vs `effectiveCap` — the wiring a
 * default `() => true` would silently skip (red-on-injection: revert the builder
 * to `sideAgentTools(registry)` and the leaf/cap-0 cases below go RED).
 */

import { describe, expect, test } from "bun:test"
import { buildSideAgentBlock } from "@/agent/tier1/side-agent"
import type { AgentConfig } from "@/agent/types"
import { __resetRuntimeConfig } from "@/shared"
import type { Tool, ToolContext, ToolEvent } from "@/tool"

const withCap = (cap: number | undefined): void => {
  if (cap === undefined) delete process.env["QUANTA_MAX_DESCENDANT_DEPTH"]
  else process.env["QUANTA_MAX_DESCENDANT_DEPTH"] = String(cap)
  __resetRuntimeConfig()
}

/** Minimal SideAgentDaemonPort-shaped stub that records spawn calls. */
const stubRegistry = () => {
  const spawned: string[] = []
  return {
    spawned,
    spawn: (spec: unknown): string => {
      spawned.push(JSON.stringify(spec))
      return `sa-${spawned.length}`
    },
    list: () => [],
    stop: () => false,
    findingsSince: () => [],
  }
}

const cfg = (depth: number, registry: ReturnType<typeof stubRegistry>): AgentConfig =>
  ({ depth, sideAgentDaemons: registry }) as unknown as AgentConfig

const ctx = (): ToolContext => ({ cwd: "/repo", signal: new AbortController().signal })

const spawnInput = {
  task: "monitor",
  trigger: { kind: "interval", every_ms: 5000 },
  max_wakes: 3,
  max_turns_per_wake: 3,
}

const runSpawn = async (
  depth: number,
  registry: ReturnType<typeof stubRegistry>,
): Promise<{ ok: boolean; output: string }> => {
  const tool = buildSideAgentBlock(cfg(depth, registry)).find(
    (t: Tool) => t.name === "side_agent_spawn",
  )
  if (tool === undefined) throw new Error("side_agent_spawn not built")
  let last = { ok: false, output: "no result" }
  for await (const ev of tool.execute(spawnInput as never, ctx()) as AsyncIterable<ToolEvent>) {
    if (ev.type === "result") last = { ok: ev.result.ok, output: ev.result.output }
  }
  return last
}

describe("buildSideAgentBlock — wires the REAL spawn-depth authority", () => {
  test("leaf (depth 1, default cap 1) → daemon creation DENIED + registry.spawn NOT called", async () => {
    withCap(1) // childDepthOf({depth:1}) = 2 > cap 1 ⇒ deny
    try {
      const reg = stubRegistry()
      const res = await runSpawn(1, reg)
      expect(res.ok).toBe(false)
      expect(res.output.toLowerCase()).toContain("depth")
      expect(reg.spawned).toEqual([]) // authority, not just a message
    } finally {
      withCap(undefined)
    }
  })

  test("root (depth 0, cap 1) → daemon creation ALLOWED (paired control)", async () => {
    withCap(1) // childDepthOf({depth:0}) = 1 <= cap 1 ⇒ admit
    try {
      const reg = stubRegistry()
      const res = await runSpawn(0, reg)
      expect(res.ok).toBe(true)
      expect(reg.spawned.length).toBe(1)
    } finally {
      withCap(undefined)
    }
  })

  test("cap=0 kill switch → even the root is DENIED", async () => {
    withCap(0) // childDepthOf({depth:0}) = 1 > cap 0 ⇒ deny
    try {
      const reg = stubRegistry()
      const res = await runSpawn(0, reg)
      expect(res.ok).toBe(false)
      expect(reg.spawned).toEqual([])
    } finally {
      withCap(undefined)
    }
  })
})
