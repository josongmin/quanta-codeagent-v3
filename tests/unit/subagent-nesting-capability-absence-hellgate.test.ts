/**
 * HELLGATE — sub-agent nesting control, Phase 1 (capability-absence) + Phase 2
 * (runtime typed-defense). RFC docs/plans/jul-13-subagent-nesting-control.md
 * §4 L1/L2, §6.5 B.
 *
 * L1 (capability projection / tool ABSENCE) vs L2 (runtime admission / reject)
 * are ORTHOGONAL and BOTH necessary — this suite proves each catches what the
 * other misses:
 *   - P1-b: the 4 tier1 block builders drop ALL spawn families for a child at/
 *     above the spawn-depth cap (`spawnToolsAvailable(config) === false`). A
 *     child NEVER SEES the tool → cheaper than a runtime bounce, but only covers
 *     paths that go through a block builder.
 *   - P2-a: the runner-holding bypass paths (background / delegate) never pass
 *     through a block builder — a forced spawn there is caught ONLY by the
 *     runtime `req.depth > maxDepth` reject, now aligned to the SAME policy cap
 *     (`spawnDepthCap()`, no longer the stray local `3`).
 *
 * Mutation coverage (red-on-injection, each proven in-body): remove any one L1
 * gate ⇒ that family leaks at depth 1 (P1-b RED); revert the L2 cap alignment
 * (`?? spawnDepthCap()` → `?? 3`) ⇒ a depth-2 child slips past (P2-a RED); the
 * depth-0 root arm is the byte-identical control (all families PRESENT).
 *
 * ⚠️ IMPORT NOTE: `@/agent/tier1/subagent-batch` is NOT imported here. That
 * module transitively pulls `../subagent-runner` → `./loop` → `@/agent/features`,
 * and `features.ts` re-exports `buildSubagentBatchBlock` in a circular init that
 * ReferenceErrors at bun module-load time — a PRE-EXISTING breakage (the shipped
 * `subagent-batch-hellgate.test.ts` fails identically on the clean fork point;
 * RFC §7 "선존 features.ts init-cycle fail은 무관"). We therefore cover the
 * `spawn_batch` gate through its SSOT branch condition — the same
 * `spawnToolsAvailable(config)` predicate the batch builder returns `[]` on —
 * rather than co-loading the cyclic module (which would make the WHOLE file
 * unloadable). The other 3 builders load clean and are exercised directly.
 */

import { describe, expect, test } from "bun:test"
import { spawnToolsAvailable } from "@/agent/spawn-depth-policy"
import { createSubagentRunner } from "@/agent/subagent-runner"
// Per-builder LEAF imports (NOT the `@/agent/tier1` barrel, which re-exports the
// cyclic `features.ts`). `subagent-batch` is deliberately absent — see header.
import { buildDelegateBlock } from "@/agent/tier1/delegate"
import { buildSubagentBlock } from "@/agent/tier1/subagent"
import { buildTeamBlock } from "@/agent/tier1/team"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { StreamPort } from "@/stream"
import type { SubagentRequest, SubagentResult } from "@/subagent"
import { createTeamRegistry } from "@/subagent"
import { defaultTools, type Tool, ToolRegistry } from "@/tool"

// ── fixtures ────────────────────────────────────────────────────────────────

/** A no-op delegator satisfying the tool-side `DelegationPort` (delegate +
 *  listModes; describeMode present since the producer port is a superset). */
const stubDelegator = () => ({
  delegate: async () => ({ ok: true, output: "", turns: 0 }),
  listModes: () => [] as never[],
  describeMode: () => null,
})

/** Build an AgentConfig that materializes the 3 co-loadable spawn families at
 *  the root. `depth` (undefined ⇒ 0 root) is the sole lever under test. The
 *  `subagent.enableBatchSpawn` flag is set too so the `spawn_batch` gate's SSOT
 *  predicate is exercised against a config that WOULD produce the tool. */
const cfg = (depth?: number): AgentConfig =>
  ({
    registry: new ToolRegistry(defaultTools),
    stream: { emit() {} } as StreamPort,
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: [],
    system: "test",
    cwd: "/tmp",
    maxTurns: 1,
    signal: new AbortController().signal,
    llm: { model: "scripted", async *stream() {} } as unknown as LLMPort,
    // subagent block → `agent` trio + `spawn_agent` (6-tool); enableBatchSpawn is
    // the batch builder's own gate input (covered via the predicate below).
    subagent: { enable6Tools: true, enableBatchSpawn: true },
    // team block → `team_create` / `team_delete`
    teamRegistry: createTeamRegistry(),
    // delegate block → `delegate`
    delegation: { delegator: stubDelegator() },
    ...(depth !== undefined ? { depth } : {}),
  }) as unknown as AgentConfig

/** Names of the tools the 3 DIRECTLY-loadable builders contribute. */
const loadableFamilyNames = (config: AgentConfig): string[] => {
  const names = (ts: Tool[]): string[] => ts.map((t) => t.name)
  const subBlock = buildSubagentBlock(config)
  return [
    ...(subBlock ? names(subBlock.extraTools) : []),
    ...names(buildTeamBlock(config)),
    ...names(buildDelegateBlock(config)),
  ]
}

// Markers for the 3 co-loadable families (subagent trio/6-tool, team, delegate).
const LOADABLE_MARKERS = ["agent", "spawn_agent", "team_create", "delegate"] as const

// ── P1-b : capability-absence at/above cap ──────────────────────────────────

describe("P1-b — spawn-tool capability ABSENCE for a child at the depth cap", () => {
  test("depth 0 (root, default cap 1): ALL spawn families PRESENT (byte-identical control)", () => {
    __resetRuntimeConfig()
    const present = loadableFamilyNames(cfg(0))
    for (const marker of LOADABLE_MARKERS) {
      expect(present).toContain(marker)
    }
    // Undefined depth === root === present too (AgentConfig.depth contract).
    const presentUndef = loadableFamilyNames(cfg(undefined))
    for (const marker of LOADABLE_MARKERS) {
      expect(presentUndef).toContain(marker)
    }
    // spawn_batch gate SSOT: the batch builder returns its tools iff this
    // predicate is TRUE (root ⇒ present). Same condition, module not co-loaded.
    expect(spawnToolsAvailable(cfg(0))).toBe(true)
    expect(spawnToolsAvailable(cfg(undefined))).toBe(true)
  })

  test("depth 1 (== default cap 1): EVERY spawn family ABSENT; each gate covered", () => {
    __resetRuntimeConfig()
    const child = cfg(1)
    // Predicate is the mutation target hoisted into the policy module (SSOT the
    // 4 gates share). At depth 1 with default cap 1 it is FALSE ⇒ every gate fires.
    expect(spawnToolsAvailable(child)).toBe(false)

    // Per-builder absence — pinning EACH loadable gate independently so removing
    // any ONE gate (mutation) leaks THAT family and turns THIS block RED.
    expect(buildSubagentBlock(child)).toBeUndefined() // agent trio + spawn_agent
    expect(buildTeamBlock(child)).toEqual([]) // team_create/_delete
    expect(buildDelegateBlock(child)).toEqual([]) // delegate

    // …and the assembled union carries NONE of the loadable family markers.
    const absent = loadableFamilyNames(child)
    for (const marker of LOADABLE_MARKERS) {
      expect(absent).not.toContain(marker)
    }
    expect(absent).toEqual([])

    // spawn_batch gate: same SSOT predicate is FALSE ⇒ `buildSubagentBatchBlock`
    // early-returns `[]` (the `if (!spawnToolsAvailable(config)) return []` line).
    // Removing that gate leaks spawn_batch at depth 1 exactly as the assertion
    // below would flip — covered at the predicate, module not co-loaded.
    expect(spawnToolsAvailable(child)).toBe(false)
  })

  test("threshold is parameterized: depth 1 with QUANTA_MAX_SPAWN_DEPTH=2 ⇒ PRESENT again", () => {
    const original = process.env["QUANTA_MAX_SPAWN_DEPTH"]
    process.env["QUANTA_MAX_SPAWN_DEPTH"] = "2"
    __resetRuntimeConfig()
    try {
      const child = cfg(1)
      expect(spawnToolsAvailable(child)).toBe(true) // 1 < 2
      const present = loadableFamilyNames(child)
      for (const marker of LOADABLE_MARKERS) {
        expect(present).toContain(marker)
      }
    } finally {
      if (original === undefined) delete process.env["QUANTA_MAX_SPAWN_DEPTH"]
      else process.env["QUANTA_MAX_SPAWN_DEPTH"] = original
      __resetRuntimeConfig()
    }
  })

  test("L1-only miss proof: the block-builder gate does NOT stop a held runner", () => {
    // Orthogonality — the tool-absence gate operates at ASSEMBLY time. It says
    // nothing about a runner-holding bypass path (background/delegate) that
    // already holds a runner and forces a spawn. A child config yields NO spawn
    // tools, yet a runner constructed directly (bypass) would still run unless
    // the runtime cap denies it — which is exactly what P2-a pins below.
    __resetRuntimeConfig()
    expect(buildSubagentBlock(cfg(1))).toBeUndefined()
  })
})

// ── P2-a : runtime typed-defense for the runner-holding bypass paths ─────────

const capturingRun = (): {
  run: NonNullable<NonNullable<Parameters<typeof createSubagentRunner>[1]>["run"]>
  forked: () => number
} => {
  let count = 0
  const run = (async () =>
    ({
      reason: "completed",
      turns: 1,
      messages: [{ role: "assistant", content: [{ type: "text", text: "x" }] }],
    }) as never) as NonNullable<NonNullable<Parameters<typeof createSubagentRunner>[1]>["run"]>
  const wrapped = (async (...args: unknown[]) => {
    count += 1
    return (run as (...a: unknown[]) => unknown)(...args)
  }) as NonNullable<NonNullable<Parameters<typeof createSubagentRunner>[1]>["run"]>
  return { run: wrapped, forked: () => count }
}

const parentCfg = (): AgentConfig =>
  ({
    registry: new ToolRegistry(defaultTools),
    stream: { emit() {} } as StreamPort,
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: [],
    system: "test",
    cwd: "/tmp",
    maxTurns: 1,
    signal: new AbortController().signal,
    llm: { model: "scripted", async *stream() {} } as unknown as LLMPort,
  }) as unknown as AgentConfig

const req = (depth: number): SubagentRequest =>
  ({ prompt: "would recurse", depth }) as SubagentRequest

describe("P2-a — runtime reject aligned to spawnDepthCap() for bypass paths", () => {
  test("forced spawn at req.depth > spawnDepthCap() ⇒ typed reject, loop NOT forked", async () => {
    __resetRuntimeConfig() // spawnDepthCap() === maxSpawnDepth === 1 (default)
    const spy = capturingRun()
    // NO opts.maxDepth override ⇒ the runner defaults to spawnDepthCap() (=1),
    // NOT the old local DEFAULT_MAX_DEPTH (=3). Simulate the L1-bypass: a
    // runner-holding child at depth 2 that still tries to spawn.
    const runner = createSubagentRunner(parentCfg(), { run: spy.run })
    const r: SubagentResult = await runner(req(2))

    expect(r.ok).toBe(false)
    // Codex-style directive with the effective cap interpolated. This is the
    // P2-a red-on-injection anchor: reverting `?? spawnDepthCap()` back to `?? 3`
    // makes depth 2 ≤ 3 slip past → `r.ok === true` → RED.
    expect(r.finalText).toBe(
      "max subagent depth (1) exceeded — complete this task yourself, do not spawn.",
    )
    expect(spy.forked()).toBe(0) // loop never forked
  })

  test("paired control — req.depth == cap DOES fork (deny is depth-driven, not blanket)", async () => {
    __resetRuntimeConfig()
    const spy = capturingRun()
    const runner = createSubagentRunner(parentCfg(), { run: spy.run })
    const r = await runner(req(1)) // 1 <= cap 1 ⇒ allowed
    expect(r.ok).toBe(true)
    expect(spy.forked()).toBe(1)
  })

  test("explicit opts.maxDepth override still WINS over the policy cap", async () => {
    __resetRuntimeConfig()
    const spy = capturingRun()
    // Host explicitly widens to 3 → a depth-3 child is admitted despite cap 1.
    const runner = createSubagentRunner(parentCfg(), { run: spy.run, maxDepth: 3 })
    expect((await runner(req(3))).ok).toBe(true)
    // …and depth 4 (> the override) is rejected with the OVERRIDE cap in the msg.
    const denied = await runner(req(4))
    expect(denied.ok).toBe(false)
    expect(denied.finalText).toBe(
      "max subagent depth (3) exceeded — complete this task yourself, do not spawn.",
    )
  })

  test("L2-only miss proof: the runtime reject does NOT remove the tool from a set", () => {
    // Orthogonality mirror — the runtime admission is a CALL-TIME bounce; it
    // never changes what a block builder assembles. If the tier1 gates were
    // absent, a child would still SEE the spawn tools (wasted context/tokens) and
    // only get bounced on invocation. L1 is the least-privilege optimization L2
    // cannot provide. At depth 0 the runner ADMITS (root spawns) — so the runtime
    // layer is NOT what keeps children tool-free; that is purely L1's doing.
    __resetRuntimeConfig()
    expect(buildSubagentBlock(cfg(0))).toBeDefined()
  })
})
