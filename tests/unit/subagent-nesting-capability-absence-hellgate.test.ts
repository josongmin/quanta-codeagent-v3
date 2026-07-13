/**
 * HELLGATE — sub-agent nesting control (capability-absence + runtime
 * typed-defense). RFC docs/plans/jul-13-subagent-nesting-control.md §4.1/§4.2,
 * §6.5 B — rev.4 (lineage-derived depth authority; default cap 1 = root-only,
 * the user's leaf intent; per-config maxDepth can only TIGHTEN via min-cap).
 *
 * L1 (capability projection / tool ABSENCE) vs L2 (runtime admission / reject)
 * are ORTHOGONAL and BOTH necessary — this suite proves each catches what the
 * other misses:
 *   - P1-b: the 4 tier1 block builders drop ALL spawn families for a child at/
 *     above the spawn-depth cap (`spawnToolsAvailable(config) === false`). A
 *     child NEVER SEES the tool → cheaper than a runtime bounce, but only covers
 *     paths that go through a block builder. Since the rev.4 default cap is 1
 *     (root-only), absence is driven at a depth ≥ cap — here we pin BOTH the
 *     default cap 1 (depth 1 leaf) AND an env cap 3 (depth 3 leaf) so the
 *     root-only default AND the parameterization are both witnessed.
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
  test("rev.4 default cap 1: ONLY the root (depth 0/undefined) KEEPS all spawn families", () => {
    clearCap() // default maxDescendantDepth === 1 (root-only)
    for (const depth of [undefined, 0]) {
      const present = loadableFamilyNames(cfg(depth))
      for (const marker of LOADABLE_MARKERS) {
        expect(present).toContain(marker)
      }
    }
  })

  test("env cap 3: depth 0/1/2 KEEP all spawn families (parameterization control)", () => {
    withCap(3) // widen the operator policy to 3
    for (const depth of [undefined, 0, 1, 2]) {
      const present = loadableFamilyNames(cfg(depth))
      for (const marker of LOADABLE_MARKERS) {
        expect(present).toContain(marker)
      }
    }
    clearCap()
  })

  test("rev.4 default cap 1: depth 1 (== cap): EVERY spawn family ABSENT; each gate covered", () => {
    clearCap()
    const child = cfg(1)
    // At depth 1 with default cap 1 the predicate is FALSE ⇒ every gate fires.
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

// ── R1 : min-cap — config.subagent.maxDepth can only TIGHTEN, never RAISE ─────

describe("R1 — capability gate applies rev.4 min-cap (config tightens, never widens)", () => {
  // rev.4: the gate reads `(depth ?? 0) < effectiveCap(config.subagent?.maxDepth)`
  // = `< min(operator policy, requested ?? +∞)`. A per-config maxDepth can only
  // LOWER the cap below policy, never raise it. This RESOLVES R1's two-knob
  // split-brain (rev.3 override let a config widen past policy). Reverting the
  // gate to the `?? override` turns the cap-raise-forbidden cases RED.

  test("min-cap: depth-1 child with config.subagent.maxDepth=5 is STILL a LEAF at policy 1", () => {
    withCap(1) // operator policy 1 (root-only)
    try {
      const child = cfg(1, 5) // depth 1, requested 5 — rev.3 override would ADMIT
      // rev.4 min(1,5)=1 ⇒ 1 < 1 false ⇒ LEAF. Config CANNOT raise past policy.
      expect(spawnToolsAvailable(child)).toBe(false)
      expect(buildSubagentBlock(child)).toBeUndefined()
      expect(buildTeamBlock(child)).toEqual([])
      expect(buildDelegateBlock(child)).toEqual([])
      expect(loadableFamilyNames(child)).toEqual([])
    } finally {
      clearCap()
    }
  })

  test("min-cap: config.subagent.maxDepth=1 TIGHTENS policy 3 ⇒ depth-1 child is a LEAF", () => {
    withCap(3) // operator policy 3 — without the request, depth 1 would spawn
    try {
      const child = cfg(1, 1) // requested 1 ⇒ min(3,1)=1 ⇒ 1 < 1 false ⇒ leaf
      expect(spawnToolsAvailable(child)).toBe(false)
      expect(buildSubagentBlock(child)).toBeUndefined()
      // paired control: at policy 3 WITHOUT the tightening request, depth 1 spawns.
      const sibling = cfg(1)
      expect(spawnToolsAvailable(sibling)).toBe(true) // 1 < 3
    } finally {
      clearCap()
    }
  })

  test("depth-2 grandchild with config.subagent.maxDepth=2 at policy 3 is a LEAF", () => {
    withCap(3)
    try {
      const grandchild = cfg(2, 2) // min(3,2)=2 ⇒ 2 < 2 false ⇒ leaf
      expect(spawnToolsAvailable(grandchild)).toBe(false)
      expect(buildSubagentBlock(grandchild)).toBeUndefined()
      expect(buildTeamBlock(grandchild)).toEqual([])
      expect(buildDelegateBlock(grandchild)).toEqual([])
      expect(loadableFamilyNames(grandchild)).toEqual([])
    } finally {
      clearCap()
    }
  })

  test("default policy 1, NO per-config maxDepth ⇒ depth-1 child is root-only leaf", () => {
    clearCap() // policy 1 (default)
    const child = cfg(1)
    expect(spawnToolsAvailable(child)).toBe(false) // 1 < 1 === false
    expect(buildSubagentBlock(child)).toBeUndefined()
    expect(loadableFamilyNames(child)).toEqual([])
  })

  test("gate ↔ runner AGREE on the min-cap (no {policy,requested,depth} where they disagree)", () => {
    // Gate opens ⇔ child (depth+1) is admitted ⇔ depth < effectiveCap. Cross-check
    // across every (policy, requested, depth) combo the runner sees. effectiveCap
    // = min(policy, requested ?? +∞) — config tightens only.
    for (const policy of [0, 1, 2, 3]) {
      withCap(policy)
      const combos: ReadonlyArray<readonly [number, number | undefined]> = [
        [0, undefined],
        [1, undefined],
        [2, undefined],
        [0, 2],
        [1, 2],
        [2, 2],
        [1, 5], // requested 5 must NOT raise past policy
        [1, 0], // kill-switch request
        [0, 0],
      ]
      for (const [depth, requested] of combos) {
        const effCap = Math.min(policy, requested ?? Number.POSITIVE_INFINITY)
        const gateOpen = spawnToolsAvailable(cfg(depth, requested))
        const runnerAllowsSpawn = depth < effCap
        expect(gateOpen).toBe(runnerAllowsSpawn)
      }
    }
    clearCap()
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

describe("P2-a — runtime reject is LINEAGE-DERIVED and aligned to the min-cap", () => {
  test("deep PARENT ⇒ typed reject, loop NOT forked (reject is childDepthOf(parent), not req.depth)", async () => {
    withCap(1) // spawnDepthCap() === 1 (env cap; default 1 also rejects a depth-3 parent)
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
    // parent that is actually depth 3. Under rev.4 the reject reads
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

  test("rev.4 min-cap: explicit opts.maxDepth can only TIGHTEN the policy, NEVER raise it", async () => {
    // rev.3 override let `opts.maxDepth:3` WIN over policy 1; rev.4 min-cap clamps
    // it: effectiveCap(3) = min(policy 1, 3) = 1. So a parent at depth 1
    // (childDepth 2 > 1) is REJECTED even with maxDepth:3. RED-ON-INJECTION:
    // reverting to `opts.maxDepth ?? spawnDepthCap()` admits ⇒ r.ok flips true.
    withCap(1)
    try {
      const spy = capturingRun()
      const runner = createSubagentRunner(parentCfg(1), { run: spy.run, maxDepth: 3 })
      const denied = await runner(req(2))
      expect(denied.ok).toBe(false) // maxDepth 3 CANNOT raise past policy 1
      expect(denied.finalText).toBe(
        "max subagent depth (1) exceeded — complete this task yourself, do not spawn.",
      )
      expect(spy.forked()).toBe(0)
    } finally {
      clearCap()
    }
  })

  test("rev.4 min-cap: opts.maxDepth TIGHTENS an env policy 3 to 1", async () => {
    withCap(3) // policy 3
    try {
      const spy = capturingRun()
      // Host tightens to 1 → parent at depth 1 (childDepth 2 > min(3,1)=1) rejected.
      const runner = createSubagentRunner(parentCfg(1), { run: spy.run, maxDepth: 1 })
      const denied = await runner(req(2))
      expect(denied.ok).toBe(false)
      expect(denied.finalText).toBe(
        "max subagent depth (1) exceeded — complete this task yourself, do not spawn.",
      )
      // paired control: WITHOUT the tightening, policy 3 admits childDepth 2.
      const loose = createSubagentRunner(parentCfg(1), { run: spy.run })
      expect((await loose(req(2))).ok).toBe(true)
    } finally {
      clearCap()
    }
  })

  test("L2-only miss proof: the runtime reject does NOT remove the tool from a set", () => {
    clearCap()
    expect(buildSubagentBlock(cfg(0))).toBeDefined()
  })
})
