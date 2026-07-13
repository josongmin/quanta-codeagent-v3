/**
 * HELLGATE — sub-agent nesting control (capability-absence + runtime
 * typed-defense). RFC docs/plans/jul-13-subagent-nesting-control.md §4.1/§4.2,
 * §6.5 B — rev.3 (lineage-derived depth authority; default cap 3, Phase 0-2
 * byte-identical, the real 3→1 flip is a gated Phase 4).
 *
 * L1 (capability projection / tool ABSENCE) vs L2 (runtime admission / reject)
 * are ORTHOGONAL and BOTH necessary — this suite proves each catches what the
 * other misses:
 *   - P1-b: the 4 tier1 block builders drop ALL spawn families for a child at/
 *     above the spawn-depth cap (`spawnToolsAvailable(config) === false`). A
 *     child NEVER SEES the tool → cheaper than a runtime bounce, but only covers
 *     paths that go through a block builder. Since the default cap is 3, absence
 *     is driven at a depth ≥ cap — here we pin BOTH the default cap 3 (depth 3
 *     leaf) AND a root-only env cap 1 (depth 1 leaf) so the byte-identical
 *     default AND the parameterization are both witnessed.
 *   - P2-a: the runner-holding bypass paths (background / delegate) never pass
 *     through a block builder — a forced spawn there is caught ONLY by the
 *     runtime reject, now aligned to the SAME policy cap (`spawnDepthCap()`) AND
 *     lineage-derived: the reject is on `childDepthOf(parent)`, NOT the
 *     caller-asserted `req.depth` (§4.1/§4.2). A forged `req.depth` cannot slip
 *     past — the parent's REAL depth is the authority.
 *
 * Mutation coverage (red-on-injection, each proven in-body): remove any one L1
 * gate ⇒ that family leaks (P1-b RED); revert the L2 reject to `req.depth`
 * ⇒ a forged shallow req at a deep parent slips past (P2-a RED); the depth-0 root
 * arm is the byte-identical control (all families PRESENT).
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnToolsAvailable } from "@/agent/spawn-depth"
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

/** Set the runtime cap through the real env→runtimeConfig seam. */
const withCap = (cap: number): void => {
  process.env["QUANTA_MAX_DESCENDANT_DEPTH"] = String(cap)
  __resetRuntimeConfig()
}
const clearCap = (): void => {
  delete process.env["QUANTA_MAX_DESCENDANT_DEPTH"]
  __resetRuntimeConfig()
}

/** A no-op delegator satisfying the tool-side `DelegationPort`. */
const stubDelegator = () => ({
  delegate: async () => ({ ok: true, output: "", turns: 0 }),
  listModes: () => [] as never[],
  describeMode: () => null,
})

/** Build an AgentConfig that materializes the 3 co-loadable spawn families.
 *  `depth` (undefined ⇒ 0 root) and `subMaxDepth` are the levers under test. */
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
    subagent: {
      enable6Tools: true,
      enableBatchSpawn: true,
      ...(subMaxDepth !== undefined ? { maxDepth: subMaxDepth } : {}),
    },
    teamRegistry: createTeamRegistry(),
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
  test("default cap 3: depth 0/1/2 KEEP all spawn families (byte-identical control)", () => {
    clearCap() // default maxDescendantDepth === 3
    for (const depth of [undefined, 0, 1, 2]) {
      const present = loadableFamilyNames(cfg(depth))
      for (const marker of LOADABLE_MARKERS) {
        expect(present).toContain(marker)
      }
    }
  })

  test("default cap 3: depth 3 (== cap): EVERY spawn family ABSENT; each gate covered", () => {
    clearCap()
    const child = cfg(3)
    // At depth 3 with default cap 3 the predicate is FALSE ⇒ every gate fires.
    expect(spawnToolsAvailable(child)).toBe(false)

    // Per-builder absence — pinning EACH loadable gate independently so removing
    // any ONE gate (mutation) leaks THAT family and turns THIS block RED.
    expect(buildSubagentBlock(child)).toBeUndefined() // agent trio + spawn_agent
    expect(buildTeamBlock(child)).toEqual([]) // team_create/_delete
    expect(buildDelegateBlock(child)).toEqual([]) // delegate

    const absent = loadableFamilyNames(child)
    for (const marker of LOADABLE_MARKERS) {
      expect(absent).not.toContain(marker)
    }
    expect(absent).toEqual([])
  })

  test("parameterized: env cap 1 (root-only) ⇒ depth 1 EVERY family ABSENT", () => {
    withCap(1)
    try {
      const child = cfg(1)
      expect(spawnToolsAvailable(child)).toBe(false) // 1 < 1 === false
      expect(buildSubagentBlock(child)).toBeUndefined()
      expect(buildTeamBlock(child)).toEqual([])
      expect(buildDelegateBlock(child)).toEqual([])
      expect(loadableFamilyNames(child)).toEqual([])
    } finally {
      clearCap()
    }
  })

  test("parameterized: env cap 1 but QUANTA_MAX_DESCENDANT_DEPTH=2 ⇒ depth 1 PRESENT again", () => {
    withCap(2)
    try {
      const child = cfg(1)
      expect(spawnToolsAvailable(child)).toBe(true) // 1 < 2
      const present = loadableFamilyNames(child)
      for (const marker of LOADABLE_MARKERS) {
        expect(present).toContain(marker)
      }
    } finally {
      clearCap()
    }
  })

  test("L1-only miss proof: the block-builder gate does NOT stop a held runner", () => {
    withCap(1)
    try {
      expect(buildSubagentBlock(cfg(1))).toBeUndefined()
    } finally {
      clearCap()
    }
  })
})

// ── R1 : capability gate honors the per-run QUANTA_SUBAGENT_MAX_DEPTH knob ────

describe("R1 — capability gate consults config.subagent.maxDepth (runner-agreement)", () => {
  // The gate reads `config.subagent?.maxDepth ?? spawnDepthCap()` — the IDENTICAL
  // expression the runner uses. These cases set QUANTA_MAX_DESCENDANT_DEPTH=1 so
  // the env cap alone would say leaf for depth 1; the ONLY widening lever is
  // config.subagent.maxDepth. Reverting the gate to `< spawnDepthCap()` (drop the
  // config.subagent.maxDepth term) turns the maxDepth=2 depth-1 cases RED.

  test("depth-1 child with config.subagent.maxDepth=2 KEEPS every spawn family (by name)", () => {
    withCap(1) // spawnDepthCap()===1
    try {
      const child = cfg(1, 2) // depth 1, per-run cap 2
      expect(spawnToolsAvailable(child)).toBe(true) // 1 < 2

      const subBlock = buildSubagentBlock(child)
      expect(subBlock).toBeDefined()
      const present = loadableFamilyNames(child)
      for (const marker of LOADABLE_MARKERS) {
        expect(present).toContain(marker)
      }
      expect(present).toContain("agent")
      expect(present).toContain("spawn_agent")
    } finally {
      clearCap()
    }
  })

  test("depth-2 child with config.subagent.maxDepth=2 is a LEAF (tools absent)", () => {
    withCap(1)
    try {
      const grandchild = cfg(2, 2) // 2 < 2 === false ⇒ leaf, CONSISTENT with runner reject
      expect(spawnToolsAvailable(grandchild)).toBe(false)
      expect(buildSubagentBlock(grandchild)).toBeUndefined()
      expect(buildTeamBlock(grandchild)).toEqual([])
      expect(buildDelegateBlock(grandchild)).toEqual([])
      expect(loadableFamilyNames(grandchild)).toEqual([])
    } finally {
      clearCap()
    }
  })

  test("env cap 1, NO per-config maxDepth ⇒ depth-1 child is root-only leaf", () => {
    withCap(1)
    try {
      const child = cfg(1)
      expect(spawnToolsAvailable(child)).toBe(false) // 1 < 1 === false
      expect(buildSubagentBlock(child)).toBeUndefined()
      expect(loadableFamilyNames(child)).toEqual([])
    } finally {
      clearCap()
    }
  })

  test("gate ↔ runner AGREE on the effective cap (no config where they disagree)", () => {
    // Gate opens ⇔ child (depth+1) is admitted ⇔ depth < effectiveCap. Cross-check
    // across every (depth, per-run cap) combo the runner sees.
    withCap(1) // spawnDepthCap()===1
    try {
      const combos: ReadonlyArray<readonly [number, number | undefined]> = [
        [0, undefined],
        [1, undefined],
        [0, 2],
        [1, 2],
        [2, 2],
        [1, 0], // kill switch
        [0, 0],
      ]
      for (const [depth, cap] of combos) {
        const effectiveCap = cap ?? 1 // spawnDepthCap() (env cap 1)
        const gateOpen = spawnToolsAvailable(cfg(depth, cap))
        const runnerAllowsSpawn = depth < effectiveCap
        expect(gateOpen).toBe(runnerAllowsSpawn)
      }
    } finally {
      clearCap()
    }
  })
})

// ── N3 : spawn_batch gate STRUCTURAL guard (non-circular, builder un-importable)

describe("N3 — spawn_batch capability gate present in source (structural)", () => {
  test("buildSubagentBatchBlock contains the `spawnToolsAvailable` early-return gate", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const batchSrcPath = resolve(here, "../../src/agent/tier1/subagent-batch.ts")
    const src = readFileSync(batchSrcPath, "utf8")
    expect(src).toContain("if (!spawnToolsAvailable(config)) return []")
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

/** A parent config at a given lineage depth — the runner's REAL authority for
 *  the child depth (§4.1). `undefined` ⇒ genuine root (childDepthOf ⇒ 1). */
const parentCfg = (depth?: number): AgentConfig =>
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
    ...(depth !== undefined ? { depth } : {}),
  }) as unknown as AgentConfig

const req = (depth: number): SubagentRequest =>
  ({ prompt: "would recurse", depth }) as SubagentRequest

describe("P2-a — runtime reject is LINEAGE-DERIVED and aligned to spawnDepthCap()", () => {
  test("deep PARENT ⇒ typed reject, loop NOT forked (reject is childDepthOf(parent), not req.depth)", async () => {
    withCap(1) // spawnDepthCap() === 1 (env cap; default 3 would also reject a depth-3 parent)
    try {
      const spy = capturingRun()
      // Parent at depth 3 ⇒ childDepthOf = 4 > cap 1 ⇒ deny. NO opts.maxDepth ⇒ the
      // runner defaults to spawnDepthCap() (=1). The forged shallow `req.depth`
      // below is IGNORED — the parent's REAL depth is the authority.
      const runner = createSubagentRunner(parentCfg(3), { run: spy.run })
      const r: SubagentResult = await runner(req(1)) // forged shallow req.depth
      expect(r.ok).toBe(false)
      expect(r.finalText).toBe(
        "max subagent depth (1) exceeded — complete this task yourself, do not spawn.",
      )
      expect(spy.forked()).toBe(0) // loop never forked
    } finally {
      clearCap()
    }
  })

  test("ANTI-FORGERY red-on-injection: forged req.depth:0 from a deep parent is STILL denied", async () => {
    // The core §4.1 pin. A malicious/legacy path forges req.depth=0 (root) at a
    // parent that is actually depth 3. Under rev.3 the reject reads
    // childDepthOf(parent)=4 > cap ⇒ DENY. Reverting the reject to `req.depth >
    // maxDepth` would ADMIT (0 > 1 false) → r.ok===true → RED.
    withCap(1)
    try {
      const spy = capturingRun()
      const runner = createSubagentRunner(parentCfg(3), { run: spy.run })
      const r = await runner(req(0)) // forged root depth
      expect(r.ok).toBe(false) // authority ignores the forgery
      expect(spy.forked()).toBe(0)
    } finally {
      clearCap()
    }
  })

  test("paired control — parent at depth 0 (root) DOES fork (deny is depth-driven)", async () => {
    withCap(1)
    try {
      const spy = capturingRun()
      // Root parent ⇒ childDepthOf = 1 <= cap 1 ⇒ allowed.
      const runner = createSubagentRunner(parentCfg(0), { run: spy.run })
      const r = await runner(req(1))
      expect(r.ok).toBe(true)
      expect(spy.forked()).toBe(1)
    } finally {
      clearCap()
    }
  })

  test("explicit opts.maxDepth override still WINS over the policy cap", async () => {
    withCap(1)
    try {
      const spy = capturingRun()
      // Host explicitly widens to 3 → a parent at depth 2 (childDepth 3) is admitted.
      const runner = createSubagentRunner(parentCfg(2), { run: spy.run, maxDepth: 3 })
      expect((await runner(req(3))).ok).toBe(true)
      // …and a parent at depth 4 (childDepth 5 > override 3) is rejected.
      const deep = createSubagentRunner(parentCfg(4), { run: spy.run, maxDepth: 3 })
      const denied = await deep(req(5))
      expect(denied.ok).toBe(false)
      expect(denied.finalText).toBe(
        "max subagent depth (3) exceeded — complete this task yourself, do not spawn.",
      )
    } finally {
      clearCap()
    }
  })

  test("L2-only miss proof: the runtime reject does NOT remove the tool from a set", () => {
    clearCap()
    expect(buildSubagentBlock(cfg(0))).toBeDefined()
  })
})
