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
 * RFC §7 "선존 features.ts init-cycle fail은 무관"). Importing the LEAF module
 * `@/agent/tier1/subagent-batch` DIRECTLY still crashes (verified: it re-enters
 * `features.ts:188` `buildSubagentBatchBlock` before initialization — the cycle
 * is NOT merely through the `@/agent/tier1` barrel), so there is NO import path
 * that reaches the builder without exploding the whole test file.
 *
 * N3 HONESTY: the OLD "coverage" here was CIRCULAR — it asserted
 * `spawnToolsAvailable(child) === false`, the SAME predicate the gate calls, so
 * it would still pass even if the `if (!spawnToolsAvailable(config)) return []`
 * line were deleted from `buildSubagentBatchBlock`. Since the builder is
 * genuinely un-importable, we replace that tautology with a NON-CIRCULAR
 * STRUCTURAL guard: read the builder source and assert the gate line is present
 * (mirroring the plane-a-secret-boundary structural tests). This DOES turn RED
 * if the gate is removed from the source — the tautology did not. The other 3
 * builders load clean and are exercised NON-vacuously (real block build +
 * absence-by-name).
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
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
const cfg = (depth?: number, subMaxDepth?: number): AgentConfig =>
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
    // `maxDepth` (the PRE-EXISTING `QUANTA_SUBAGENT_MAX_DEPTH` per-run knob) is
    // the R1 lever: the capability gate must consult it, not just spawnDepthCap().
    subagent: {
      enable6Tools: true,
      enableBatchSpawn: true,
      ...(subMaxDepth !== undefined ? { maxDepth: subMaxDepth } : {}),
    },
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

// ── R1 : capability gate honors the per-run QUANTA_SUBAGENT_MAX_DEPTH knob ────

describe("R1 — capability gate consults config.subagent.maxDepth (runner-agreement)", () => {
  // The HIGH regression: before Wave 2, a depth-1 child spawned. The Phase-1
  // gate read ONLY spawnDepthCap() (=maxSpawnDepth, env QUANTA_MAX_SPAWN_DEPTH,
  // default 1) and IGNORED the PRE-EXISTING per-run knob QUANTA_SUBAGENT_MAX_DEPTH
  // (→ config.subagent.maxDepth), which the runner reject DOES honor. So a user
  // who set QUANTA_SUBAGENT_MAX_DEPTH=2 (allow 2-level nesting) WITHOUT
  // QUANTA_MAX_SPAWN_DEPTH got a depth-1 child that silently lost ALL spawn tools
  // — inconsistent with the runner, which would have LET that child spawn.
  //
  // NB these cases leave QUANTA_MAX_SPAWN_DEPTH UNSET (spawnDepthCap()===1) so the
  // ONLY thing opening the gate is config.subagent.maxDepth. That is precisely the
  // mutation target: revert the gate to `< spawnDepthCap()` (drop the
  // config.subagent.maxDepth term) and the maxDepth=2 depth-1 cases go RED.

  test("depth-1 child with config.subagent.maxDepth=2 KEEPS every spawn family (by name)", () => {
    __resetRuntimeConfig() // QUANTA_MAX_SPAWN_DEPTH unset ⇒ spawnDepthCap()===1
    const child = cfg(1, 2) // depth 1, per-run cap 2 (simulates QUANTA_SUBAGENT_MAX_DEPTH=2)
    // Gate open: 1 < (subagent.maxDepth=2 ?? 1) === 1 < 2 === true. With the OLD
    // gate this was 1 < spawnDepthCap()===1 === false ⇒ tools stripped (the bug).
    expect(spawnToolsAvailable(child)).toBe(true)

    // Non-vacuous: the block builders actually RETURN their tools, and the tool
    // set contains agent/spawn_agent/team_create/delegate BY NAME.
    const subBlock = buildSubagentBlock(child)
    expect(subBlock).toBeDefined()
    const present = loadableFamilyNames(child)
    for (const marker of LOADABLE_MARKERS) {
      expect(present).toContain(marker)
    }
    // agent trio (`agent`) + 6-tool (`spawn_agent`) both present on the child.
    expect(present).toContain("agent")
    expect(present).toContain("spawn_agent")
  })

  test("depth-2 child with config.subagent.maxDepth=2 is a LEAF (tools absent)", () => {
    __resetRuntimeConfig()
    const grandchild = cfg(2, 2) // 2 < 2 === false ⇒ leaf, CONSISTENT with runner reject
    expect(spawnToolsAvailable(grandchild)).toBe(false)
    expect(buildSubagentBlock(grandchild)).toBeUndefined()
    expect(buildTeamBlock(grandchild)).toEqual([])
    expect(buildDelegateBlock(grandchild)).toEqual([])
    expect(loadableFamilyNames(grandchild)).toEqual([])
  })

  test("default (NO per-config maxDepth, NO env) ⇒ depth-1 child is root-only leaf", () => {
    __resetRuntimeConfig()
    const child = cfg(1) // no subagent.maxDepth, no env ⇒ falls back to spawnDepthCap()===1
    expect(spawnToolsAvailable(child)).toBe(false) // 1 < 1 === false
    expect(buildSubagentBlock(child)).toBeUndefined()
    expect(loadableFamilyNames(child)).toEqual([])
  })

  test("gate ↔ runner AGREE on the effective cap (no config where they disagree)", () => {
    // The runner's effective cap is `opts.maxDepth ?? spawnDepthCap()` where
    // `opts.maxDepth = config.subagent.maxDepth` (verified in subagent.ts and the
    // other 4 call sites). The gate now reads the IDENTICAL expression
    // `config.subagent?.maxDepth ?? spawnDepthCap()`. Cross-check the two truth
    // tables agree across every (depth, per-run cap) combo the runner sees:
    // gate opens ⇔ child (depth+1) is admitted ⇔ depth < cap.
    __resetRuntimeConfig() // spawnDepthCap()===1
    const combos: ReadonlyArray<readonly [number, number | undefined]> = [
      [0, undefined], // root, no per-run cap
      [1, undefined], // depth-1 child, no per-run cap
      [0, 2],
      [1, 2],
      [2, 2],
      [1, 0], // kill switch: cap 0 ⇒ nobody spawns
      [0, 0],
    ]
    for (const [depth, cap] of combos) {
      const effectiveCap = cap ?? 1 // spawnDepthCap() default
      const gateOpen = spawnToolsAvailable(cfg(depth, cap))
      // Runner allows a spawn from THIS agent iff the child (depth+1) is admitted:
      // runner reject is `req.depth > maxDepth`, child req.depth === depth+1, so
      // allowed ⇔ depth+1 <= effectiveCap ⇔ depth < effectiveCap.
      const runnerAllowsSpawn = depth < effectiveCap
      expect(gateOpen).toBe(runnerAllowsSpawn)
    }
  })
})

// ── N3 : spawn_batch gate STRUCTURAL guard (non-circular, builder un-importable)

describe("N3 — spawn_batch capability gate present in source (structural)", () => {
  test("buildSubagentBatchBlock contains the `spawnToolsAvailable` early-return gate", () => {
    // The batch builder cannot be imported (features.ts TDZ init-cycle — see
    // header). A predicate re-assertion here would be CIRCULAR (passes even if the
    // gate line were deleted). Instead read the builder SOURCE and assert the gate
    // line is present — a real structural guard that RE-goes RED if the gate is
    // removed. Mirrors the plane-a-secret-boundary structural tests.
    const here = dirname(fileURLToPath(import.meta.url))
    const batchSrcPath = resolve(here, "../../src/agent/tier1/subagent-batch.ts")
    const src = readFileSync(batchSrcPath, "utf8")
    // The exact gate: an early-return when the child is not entitled to spawn.
    expect(src).toContain("if (!spawnToolsAvailable(config)) return []")
    // And it must be inside buildSubagentBatchBlock (the fn under guard), before
    // the runner/tool construction — assert ordering so a stray occurrence in a
    // comment/other fn does not vacuously satisfy the check.
    const fnStart = src.indexOf("export const buildSubagentBatchBlock")
    const gateIdx = src.indexOf("if (!spawnToolsAvailable(config)) return []", fnStart)
    const runnerIdx = src.indexOf("createSubagentRunner(config", fnStart)
    expect(fnStart).toBeGreaterThanOrEqual(0)
    expect(gateIdx).toBeGreaterThan(fnStart)
    expect(runnerIdx).toBeGreaterThan(gateIdx) // gate precedes runner construction
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
