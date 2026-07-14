/**
 * HELLGATE — OS-process side-agent DEPTH CONTAINMENT (defense-in-depth).
 *
 * The process-backed side-agent (`QUANTA_SIDE_AGENT_PROCESS`) forks an OS
 * process running `worker-charter-runner.ts`, whose `assembleChildConfig` builds
 * the daemon PARENT `AgentConfig` handed to `createSubagentRunner`.
 * `subagentRunnerToSidePass` invokes that runner ONCE to spawn the actual
 * investigating pass, which runs at `childDepthOf(parent) = parent.depth + 1`.
 *
 * PRIOR HOLE: the config was DEPTH-BLIND (`depth: undefined` ⇒ treated as a
 * genuine ROOT). Under the DEFAULT operator cap the single investigating pass is
 * a depth-1 leaf, so spawn tools are already projected away — BUT a background
 * daemon treated as root inherits the FULL root spawning budget: if the operator
 * policy `QUANTA_MAX_DESCENDANT_DEPTH` were WIDENED, the daemon's pass could
 * recurse descendants, contained ONLY by the `subagentRunnerToSidePass`
 * read-only tool filter (single-layer).
 *
 * FIX under test: `assembleChildConfig` pins a TIGHTENING-ONLY per-config
 * `subagent.maxDepth = childDepthOf(daemon)`, so the effective ceiling
 * (`min(operator policy, this)`) admits EXACTLY the one investigating pass and NO
 * deeper — the investigating pass's own children are denied fail-closed even
 * under a widened operator policy. Defense-in-depth ON TOP of the read filter.
 *
 * RED (pre-fix): `assembleChildConfig(...)` carries no `subagent.maxDepth`, so
 * under a WIDENED policy the investigating pass is spawn-tool-ENTITLED.
 * red-on-injection: revert the fix (drop the pin) ⇒ RED again.
 */

import { describe, expect, test } from "bun:test"
import { childDepthOf, effectiveCap, spawnToolsAvailable } from "@/agent/spawn-depth"
import { projectSpawnTools, SPAWN_TOOL_NAMES } from "@/agent/spawn-projection"
import type { AgentConfig } from "@/agent/types"
import type { EnvLike, LLMPort } from "@/llm"
import { __resetRuntimeConfig } from "@/shared"
import {
  assembleChildConfig,
  MIN_DAEMON_DEPTH,
  resolveDaemonDepth,
  WORKER_PARENT_DEPTH_ENV,
} from "@/side-agent/worker-charter-runner"
import type { Tool } from "@/tool"

const withCap = (cap: number | undefined): void => {
  if (cap === undefined) delete process.env["QUANTA_MAX_DESCENDANT_DEPTH"]
  else process.env["QUANTA_MAX_DESCENDANT_DEPTH"] = String(cap)
  __resetRuntimeConfig()
}

/** A never-called LLM stub — assembly does not invoke it. */
const stubLlm = (): LLMPort =>
  ({
    stream: () => {
      throw new Error("unused")
    },
  }) as unknown as LLMPort

/** A fake spawn-creation tool tagged with a real SPAWN_TOOL_NAMES name, plus a
 *  benign read tool, so projection has something to strip AND keep. */
const spawnToolNamed = (name: string): Tool =>
  ({
    name,
    description: name,
    parameters: {},
    execute: () => (async function* () {})(),
  }) as unknown as Tool

/** Assemble the DAEMON PARENT config via the REAL production depth resolver
 *  (empty env ⇒ fail-closed floor), so the depth/cap under test are the shipped
 *  resolution, not test-baked literals. */
const assemble = (env: EnvLike = {}): AgentConfig =>
  assembleChildConfig(stubLlm(), "/repo", resolveDaemonDepth(env))

/** The config the INVESTIGATING PASS runs under: depth = childDepthOf(daemon),
 *  inheriting the daemon's tightening `subagent` block (the runner propagates
 *  `parent.subagent` onto the child — see subagent-runner.ts). This is the
 *  surface `projectSpawnTools`/`spawnToolsAvailable` gate for the pass. */
const passConfigOf = (daemon: AgentConfig): AgentConfig =>
  ({
    depth: childDepthOf(daemon),
    ...(daemon.subagent ? { subagent: daemon.subagent } : {}),
  }) as unknown as AgentConfig

describe("worker-charter-runner assembleChildConfig — daemon depth containment", () => {
  test("daemon config pins a tightening subagent.maxDepth = childDepthOf(daemon)", () => {
    const daemon = assemble()
    // RED pre-fix: no subagent block ⇒ no tightening cap ⇒ widened policy leaks.
    expect(daemon.subagent).toBeDefined()
    expect(daemon.subagent?.maxDepth).toBe(childDepthOf(daemon))
    // The pinned cap is a real, non-root descendant level (the pass runs >= 1).
    expect(childDepthOf(daemon)).toBeGreaterThanOrEqual(1)
  })

  test("under a WIDENED operator policy the investigating pass is STILL a LEAF", () => {
    withCap(9) // operator policy widened far past the default 1
    try {
      const pass = passConfigOf(assemble())
      const pinned = pass.subagent?.maxDepth
      expect(typeof pinned).toBe("number")
      // effectiveCap = min(policy 9, pinned tightening cap) === the pinned cap,
      // so the pass at its own depth is NOT entitled to spawn tools.
      expect(effectiveCap(pinned)).toBe(pinned as number)
      expect(spawnToolsAvailable(pass)).toBe(false)

      // Behavioral: projectSpawnTools strips every creation tool for the pass.
      const menu: Tool[] = [
        spawnToolNamed("agent"),
        spawnToolNamed("side_agent_spawn"),
        spawnToolNamed("subagent_fork"),
        spawnToolNamed("read_file"), // survivor control
      ]
      const projectedNames = projectSpawnTools(menu, pass).map((t) => t.name)
      for (const spawnName of SPAWN_TOOL_NAMES) {
        expect(projectedNames).not.toContain(spawnName)
      }
      expect(projectedNames).toContain("read_file")
    } finally {
      withCap(undefined)
    }
  })

  test("PAIRED CONTROL: WITHOUT the pin, a widened policy WOULD expose spawn tools to the pass", () => {
    withCap(9)
    try {
      const daemon = assemble()
      // Same pass depth but strip the tightening subagent block (simulates the
      // pre-fix depth-blind root-budget path). Now effectiveCap = policy 9, and a
      // depth-1 pass IS entitled ⇒ proves the pin is what closes the hole.
      const unpinnedPass = { depth: childDepthOf(daemon) } as unknown as AgentConfig
      expect(spawnToolsAvailable(unpinnedPass)).toBe(true)
      expect(
        projectSpawnTools([spawnToolNamed("agent")], unpinnedPass).map((t) => t.name),
      ).toContain("agent")
    } finally {
      withCap(undefined)
    }
  })

  test("the single investigating pass is STILL ADMITTED under the default cap (no regression)", () => {
    withCap(undefined) // default operator policy cap = 1
    try {
      const daemon = assemble()
      // childDepthOf(daemon) must be <= effectiveCap so the runner admits the ONE
      // legitimate investigating pass (a stricter daemon depth would DENY it and
      // break the whole feature). This is the guard against over-tightening.
      const passDepth = childDepthOf(daemon)
      expect(passDepth).toBeLessThanOrEqual(effectiveCap(daemon.subagent?.maxDepth))
    } finally {
      withCap(undefined)
    }
  })
})

describe("resolveDaemonDepth — fail-closed lineage resolution", () => {
  test("no threaded parent depth (absent / empty env) ⇒ fail-closed floor", () => {
    expect(resolveDaemonDepth({})).toBe(MIN_DAEMON_DEPTH)
    expect(resolveDaemonDepth({ [WORKER_PARENT_DEPTH_ENV]: "" })).toBe(MIN_DAEMON_DEPTH)
    expect(resolveDaemonDepth({})).toBeGreaterThanOrEqual(0)
  })

  test("a threaded spawning-agent depth DEEPENS the daemon lineage (never shallower)", () => {
    // A deeper spawner ⇒ a proportionally deeper daemon (so its pass sits deeper).
    expect(resolveDaemonDepth({ [WORKER_PARENT_DEPTH_ENV]: "2" })).toBe(2)
    expect(resolveDaemonDepth({ [WORKER_PARENT_DEPTH_ENV]: "5" })).toBe(5)
  })

  test("a forged / malformed threaded value cannot grant a shallower budget (floored)", () => {
    expect(resolveDaemonDepth({ [WORKER_PARENT_DEPTH_ENV]: "not-a-number" })).toBe(MIN_DAEMON_DEPTH)
    expect(resolveDaemonDepth({ [WORKER_PARENT_DEPTH_ENV]: "-4" })).toBe(MIN_DAEMON_DEPTH)
    for (const v of ["-4", "not-a-number", ""]) {
      expect(resolveDaemonDepth({ [WORKER_PARENT_DEPTH_ENV]: v })).toBeGreaterThanOrEqual(0)
    }
  })

  test("a deeper daemon's pinned cap tracks its deeper pass (containment scales)", () => {
    // Threaded parent depth 3 ⇒ daemon depth 3 ⇒ pass depth 4 ⇒ pinned cap 4.
    const daemon = assemble({ [WORKER_PARENT_DEPTH_ENV]: "3" })
    expect(daemon.depth).toBe(3)
    expect(daemon.subagent?.maxDepth).toBe(4)
    expect(childDepthOf(daemon)).toBe(4)
  })
})
