/**
 * HELLGATE — sub-agent nesting control (capability-absence + runtime
 * typed-defense). RFC docs/plans/jul-13-subagent-nesting-control.md §4.1/§4.2,
 * §6.5 B — rev.4 (lineage-derived depth authority; default cap 1 = root-only,
 * the user's leaf intent; per-config maxDepth can only TIGHTEN via min-cap).
 *
 * L1 (capability projection / tool ABSENCE) vs L2 (runtime admission / reject)
 * are ORTHOGONAL and BOTH necessary — this suite proves each catches what the
 * other misses:
 *   - P1-b: rev.4 §4.4 — a SINGLE `projectSpawnTools` filter (features.ts seam,
 *     over the finalized `extraTools`) drops the CREATION spawn tools
 *     (`SPAWN_TOOL_NAMES`) for a child at/above the spawn-depth cap
 *     (`canExposeSpawnTools(depth, effectiveCap) === false`). The block builders
 *     no longer self-gate — they mint unconditionally — so this suite exercises
 *     the filter over the built tools. A child NEVER SEES the creation tool →
 *     cheaper than a runtime bounce, but only covers paths whose tools flow
 *     through that seam. Since the rev.4 default cap is 1 (root-only), absence is
 *     driven at depth ≥ cap — here we pin BOTH the default cap 1 (depth 1 leaf)
 *     AND env caps so the root-only default AND parameterization are witnessed.
 *     §5.1 N2 fix: `team_delete` (management) SURVIVES for a leaf; only
 *     `team_create` (the spawn vector) is removed.
 *   - P2-a: the runner-holding bypass paths (background / delegate) never pass
 *     through the projection seam — a forced spawn there is caught ONLY by the
 *     runtime reject, aligned to the SAME policy cap AND lineage-derived: the
 *     reject is on `childDepthOf(parent)`, NOT the caller-asserted `req.depth`
 *     (§4.1/§4.2). A forged `req.depth` cannot slip past.
 *
 * Mutation coverage (red-on-injection, each proven in-body): remove the
 * `projectSpawnTools` call ⇒ a leaf leaks the creation tools (P1-b RED); remove a
 * name from `SPAWN_TOOL_NAMES` ⇒ that tool leaks (P1-b RED); revert the L2 reject
 * to `req.depth` ⇒ a forged shallow req at a deep parent slips past (P2-a RED);
 * the depth-0 root arm is the byte-identical control (all families PRESENT).
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnToolsAvailable } from "@/agent/spawn-depth"
import { projectSpawnTools, SPAWN_TOOL_NAMES } from "@/agent/spawn-projection"
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

/** The RAW tools the 3 DIRECTLY-loadable builders mint (pre-projection). Under
 *  rev.4 the builders always mint; capability projection is a separate step. */
const loadableTools = (config: AgentConfig): Tool[] => {
  const subBlock = buildSubagentBlock(config)
  return [
    ...(subBlock ? subBlock.extraTools : []),
    ...buildTeamBlock(config),
    ...buildDelegateBlock(config),
  ]
}

/** Names AFTER the single `projectSpawnTools` filter — the LLM-visible menu the
 *  features.ts seam produces (creation tools removed for a leaf). */
const projectedFamilyNames = (config: AgentConfig): string[] =>
  projectSpawnTools(loadableTools(config), config).map((t) => t.name)

// Markers for the 3 co-loadable CREATION families (trio/6-tool, team, delegate).
const LOADABLE_MARKERS = ["agent", "spawn_agent", "team_create", "delegate"] as const

// ── P1-b : capability-absence at/above cap ──────────────────────────────────

describe("P1-b — spawn-tool capability ABSENCE for a child at the depth cap", () => {
  test("rev.4 default cap 1: ONLY the root (depth 0/undefined) KEEPS all spawn families", () => {
    clearCap() // default maxDescendantDepth === 1 (root-only)
    for (const depth of [undefined, 0]) {
      const present = projectedFamilyNames(cfg(depth))
      for (const marker of LOADABLE_MARKERS) {
        expect(present).toContain(marker)
      }
    }
  })

  test("env cap 3: depth 0/1/2 KEEP all spawn families (parameterization control)", () => {
    withCap(3) // widen the operator policy to 3
    for (const depth of [undefined, 0, 1, 2]) {
      const present = projectedFamilyNames(cfg(depth))
      for (const marker of LOADABLE_MARKERS) {
        expect(present).toContain(marker)
      }
    }
    clearCap()
  })

  test("rev.4 default cap 1: depth 1 (== cap): every CREATION tool ABSENT after projection", () => {
    clearCap()
    const child = cfg(1)
    // At depth 1 with default cap 1 the predicate is FALSE ⇒ the filter fires.
    expect(spawnToolsAvailable(child)).toBe(false)

    // The builders STILL mint their tools (SSOT moved to the single filter) —
    // pin that so the projection is what removes them, not a per-builder gate.
    expect(buildSubagentBlock(child)).toBeDefined()
    expect(buildTeamBlock(child).length).toBeGreaterThan(0)
    expect(buildDelegateBlock(child).length).toBeGreaterThan(0)

    // After the single filter: ALL 7 SPAWN_TOOL_NAMES gone; removing the
    // projectSpawnTools call OR a name from the set leaks that tool ⇒ RED.
    const projected = projectedFamilyNames(child)
    for (const name of SPAWN_TOOL_NAMES) {
      expect(projected).not.toContain(name)
    }
    for (const marker of LOADABLE_MARKERS) {
      expect(projected).not.toContain(marker)
    }

    // §5.1 N2 FIX — management/observe tools SURVIVE for a leaf. team_delete
    // (management) stays even though team_create (spawn) is stripped; so do the
    // subagent management tools. The raw menu HAD them; projection keeps them.
    expect(loadableTools(child).map((t) => t.name)).toContain("team_create") // pre-filter
    expect(projected).toContain("team_delete")
    expect(projected).toContain("task_output")
    expect(projected).toContain("task_stop")
    expect(projected).toContain("wait_agent")
    expect(projected).toContain("close_agent")
    expect(projected).toContain("send_input")
  })

  test("parameterized: env cap 1 (root-only) ⇒ depth 1 every CREATION tool ABSENT", () => {
    withCap(1)
    try {
      const child = cfg(1)
      expect(spawnToolsAvailable(child)).toBe(false) // 1 < 1 === false
      const projected = projectedFamilyNames(child)
      for (const marker of LOADABLE_MARKERS) {
        expect(projected).not.toContain(marker)
      }
      // management survives (§5.1)
      expect(projected).toContain("team_delete")
    } finally {
      clearCap()
    }
  })

  test("parameterized: env cap 1 but QUANTA_MAX_DESCENDANT_DEPTH=2 ⇒ depth 1 PRESENT again", () => {
    withCap(2)
    try {
      const child = cfg(1)
      expect(spawnToolsAvailable(child)).toBe(true) // 1 < 2
      const present = projectedFamilyNames(child)
      for (const marker of LOADABLE_MARKERS) {
        expect(present).toContain(marker)
      }
    } finally {
      clearCap()
    }
  })

  test("L1-only miss proof: the projection does NOT stop a held runner", () => {
    withCap(1)
    try {
      // The builder still mints the tool set; only the LLM-visible menu loses the
      // creation tools. A runner already held by a bypass path is unaffected —
      // that is what the L2 runtime reject (P2-a) exists to bound.
      expect(buildSubagentBlock(cfg(1))).toBeDefined()
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

  /** Assert every CREATION family is stripped by the projection for a leaf. */
  const expectLeafAfterProjection = (child: AgentConfig): void => {
    expect(spawnToolsAvailable(child)).toBe(false)
    const projected = projectedFamilyNames(child)
    for (const marker of LOADABLE_MARKERS) expect(projected).not.toContain(marker)
    expect(projected).toContain("team_delete") // §5.1 — management survives
  }

  test("min-cap: depth-1 child with config.subagent.maxDepth=5 is STILL a LEAF at policy 1", () => {
    withCap(1) // operator policy 1 (root-only)
    try {
      // depth 1, requested 5 — rev.3 override would ADMIT; rev.4 min(1,5)=1 ⇒ LEAF.
      expectLeafAfterProjection(cfg(1, 5))
    } finally {
      clearCap()
    }
  })

  test("min-cap: config.subagent.maxDepth=1 TIGHTENS policy 3 ⇒ depth-1 child is a LEAF", () => {
    withCap(3) // operator policy 3 — without the request, depth 1 would spawn
    try {
      const child = cfg(1, 1) // requested 1 ⇒ min(3,1)=1 ⇒ 1 < 1 false ⇒ leaf
      expectLeafAfterProjection(child)
      // paired control: at policy 3 WITHOUT the tightening request, depth 1 spawns.
      const sibling = cfg(1)
      expect(spawnToolsAvailable(sibling)).toBe(true) // 1 < 3
      expect(projectedFamilyNames(sibling)).toContain("agent")
    } finally {
      clearCap()
    }
  })

  test("depth-2 grandchild with config.subagent.maxDepth=2 at policy 3 is a LEAF", () => {
    withCap(3)
    try {
      expectLeafAfterProjection(cfg(2, 2)) // min(3,2)=2 ⇒ 2 < 2 false ⇒ leaf
    } finally {
      clearCap()
    }
  })

  test("default policy 1, NO per-config maxDepth ⇒ depth-1 child is root-only leaf", () => {
    clearCap() // policy 1 (default)
    expectLeafAfterProjection(cfg(1))
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

// ── N3 : the 4 per-builder gates are REMOVED (rev.4 single-filter SSOT) ────────

describe("N3 — rev.4 §4.4: the per-builder spawnToolsAvailable gates are REMOVED", () => {
  // The old design had `if (!spawnToolsAvailable(config)) return …` in each of the
  // 4 spawn builders. rev.4 replaces them with the single `projectSpawnTools`
  // filter at the features.ts seam. This structural pin fails RED if any builder
  // re-introduces a self-gate (a split-brain vs the single filter). Positive
  // coverage (the SET covers every creation tool) lives in the meta-pin suite
  // `subagent-nesting-single-filter-projection-hellgate.test.ts`.
  const here = dirname(fileURLToPath(import.meta.url))
  for (const builder of ["subagent.ts", "subagent-batch.ts", "team.ts", "delegate.ts"]) {
    test(`tier1/${builder} no longer self-gates on spawnToolsAvailable`, () => {
      const src = readFileSync(resolve(here, "../../src/agent/tier1", builder), "utf8")
      expect(src).not.toContain("spawnToolsAvailable")
    })
  }
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
