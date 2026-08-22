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
  if (cap === undefined) delete process.env.QUANTA_MAX_DESCENDANT_DEPTH
  else process.env.QUANTA_MAX_DESCENDANT_DEPTH = String(cap)
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

const cfg = (depth: number | undefined, registry: ReturnType<typeof stubRegistry>): AgentConfig =>
  ({ depth, sideAgentDaemons: registry }) as unknown as AgentConfig

const ctx = (): ToolContext => ({ cwd: "/repo", signal: new AbortController().signal })

const spawnInput = {
  task: "monitor",
  trigger: { kind: "interval", every_ms: 5000 },
  max_wakes: 3,
  max_turns_per_wake: 3,
}

const runSpawn = async (
  depth: number | undefined,
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

  // ── BOUNDARY sweep : childDepth = depth+1 <= cap admits, else denies ──────────
  // The wiring authority is `canAdmitChildDepth(childDepthOf(config), effectiveCap(cap))`
  // = `(depth+1) <= cap`. Assert the decision at EVERY at-cap / over-cap / under-cap
  // boundary for cap ∈ {0,1,2,3} × depth ∈ {0,1,2,3}, and that registry.spawn fires
  // IFF admitted (real effect, not just result.ok). A single flipped `<`/`<=` or an
  // off-by-one in childDepthOf goes RED on one of these rows.
  test("boundary truth table: admit ⇔ (depth+1) <= cap, registry.spawn fires iff admitted", async () => {
    for (const cap of [0, 1, 2, 3]) {
      for (const depth of [0, 1, 2, 3]) {
        withCap(cap)
        try {
          const reg = stubRegistry()
          const res = await runSpawn(depth, reg)
          const expectedAdmit = depth + 1 <= cap
          expect({ cap, depth, ok: res.ok, spawned: reg.spawned.length }).toEqual({
            cap,
            depth,
            ok: expectedAdmit,
            spawned: expectedAdmit ? 1 : 0,
          })
        } finally {
          withCap(undefined)
        }
      }
    }
  })

  // ── MALFORMED own-depth : fail-CLOSED, NEVER fail-open to root ────────────────
  // A parent AgentConfig carrying a non-nonneg-integer depth (NaN / negative /
  // fractional) makes `childDepthOf` throw SpawnLineageError, which `admitsDaemonChild`
  // catches → DENY. This is the authoritative backstop the projection optimization
  // cannot see: a forced/held-runner path with a corrupt depth must NOT mint a daemon.
  // Cap is WIDE (3) so a fail-OPEN-to-root regression (silently coercing to depth 0 ⇒
  // childDepth 1 <= 3 ⇒ admit) would flip these RED.
  test("malformed own depth (NaN / -1 / 2.5) ⇒ DENIED + registry.spawn NOT called (fail-closed at cap 3)", async () => {
    for (const bad of [Number.NaN, -1, 2.5]) {
      withCap(3)
      try {
        const reg = stubRegistry()
        const res = await runSpawn(bad, reg)
        expect(res.ok).toBe(false)
        expect(res.output.toLowerCase()).toContain("depth")
        expect(reg.spawned).toEqual([]) // NEVER fail-open to root
      } finally {
        withCap(undefined)
      }
    }
  })

  // Paired control for the malformed sweep: `undefined` depth is a GENUINE root
  // (spec: 0=root, absent=root), NOT a malformed value — it must ADMIT at cap 3.
  // This proves the deny above is the malformed-guard, not a blanket "non-0 denies".
  test("undefined depth is a genuine root (paired control) ⇒ ADMITTED at cap 3", async () => {
    withCap(3)
    try {
      const reg = stubRegistry()
      const res = await runSpawn(undefined, reg)
      expect(res.ok).toBe(true)
      expect(reg.spawned.length).toBe(1)
    } finally {
      withCap(undefined)
    }
  })
})
