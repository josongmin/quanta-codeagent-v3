/**
 * HELLGATE — FIX-A: single effective-cap SSOT for sub-agent nesting control.
 * RFC docs/plans/jul-13-subagent-nesting-control.md §4.5 / §6.5 B.
 *
 * The nesting control has THREE cap sources that must AGREE, all resolving the
 * rev.4 MIN-CAP `effectiveCap(requested) = min(operator policy, requested ?? +∞)`
 * (config can only TIGHTEN, never RAISE):
 *   1. Capability gate   — `spawnToolsAvailable` (spawn-depth.ts):
 *                          `(depth ?? 0) < effectiveCap(config.subagent?.maxDepth)`
 *   2. Runner reject     — `createSubagentRunner` (subagent-runner.ts):
 *                          `childDepthOf(parent) > effectiveCap(opts.maxDepth)`
 *   3. Secondary pre-checks — the `@/subagent` slice's `agent` tool
 *                          (agent-tool.ts `opts.maxDepth ?? DEFAULT_MAX_DEPTH`)
 *                          and `spawn_agent` (handlers-6.ts
 *                          `deps.maxDepth ?? DEFAULT_MAX_DEPTH`), which receive the
 *                          RESOLVED effectiveCap threaded in from the @/agent caller.
 *
 * BEFORE FIX-A the secondary pre-checks fell back to a LOCAL LITERAL
 * `DEFAULT_MAX_DEPTH = 3` when the `@/agent` block builder omitted `maxDepth`
 * (it spread it only when `config.subagent.maxDepth !== undefined`). With no
 * per-config cap this made source (3) = 3 while sources (1) and (2) resolved
 * to `spawnDepthCap()` (default 1) — a LOOSER, inconsistent cap. The slice
 * fence forbids `@/subagent` importing `spawnDepthCap`, so FIX-A resolves the
 * effective cap at the `@/agent` CALLER boundary (`tier1/subagent.ts`) and
 * threads it in EXPLICITLY as `opts.maxDepth` / `deps.maxDepth`, so the
 * `?? DEFAULT_MAX_DEPTH` fallback is never hit in practice.
 *
 * This suite proves:
 *   A0 — the DIVERGENCE is real: a raw `createAgentTool({runner})` / a raw
 *        `createSubagent6Tools({runner,registry})` with NO maxDepth admits a
 *        child at childDepth 3 (fallback === 3). This is the mutation baseline.
 *   A1 — the `agent` tool the BLOCK builds honors the RESOLVED cap: a
 *        block built at the root with default cap 1 REJECTS a call whose
 *        ctx.depth would fork childDepth 3 (would be admitted under fallback 3).
 *        `agent`'s depth is read from `ctx.depth` (runtime lineage), so this
 *        divergence is REACHABLE (unlike spawn_agent whose parentDepth is
 *        config-bounded by the capability gate — proven inert below).
 *   A2 — the `spawn_agent` deps the BLOCK builds carry the resolved cap: a
 *        raw 6-tool set given `maxDepth: <resolved>` rejects a childDepth the
 *        3-fallback would admit (belt-and-suspenders wiring proof).
 *   A3 — 3-SOURCE AGREEMENT: for every (depth, effective-cap) the gate's
 *        tool-absence decision, the runner reject, AND the secondary pre-check
 *        all agree — no depth where one admits and another rejects.
 *   A4 — STRUCTURAL: the `@/agent` caller threads `maxDepth: effectiveMaxDepth`
 *        UNCONDITIONALLY into all three constructors (red-on-injection anchor —
 *        reverting to the conditional-spread turns A1/A2/A4 RED).
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { effectiveCap, spawnDepthCap, spawnToolsAvailable } from "@/agent/spawn-depth"
import { projectSpawnTools } from "@/agent/spawn-projection"
import { createSubagentRunner } from "@/agent/subagent-runner"
import { buildSubagentBlock } from "@/agent/tier1/subagent"
import type { AgentConfig } from "@/agent/types"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { StreamPort } from "@/stream"
import {
  createAgentTool,
  createSubagent6Tools,
  type SubagentRequest,
  type SubagentResult,
  type SubagentRunner,
  TaskRegistry,
} from "@/subagent"
import type { Tool, ToolContext, ToolEvent } from "@/tool"
import { defaultTools, ToolRegistry } from "@/tool"

// ── fixtures ────────────────────────────────────────────────────────────────

/** A minimal but VALID parent config so an ADMITTED runner spawn can build its
 *  child config (needs `parent.llm.model`, cwd, etc.) without a stub crash. The
 *  injected `run` short-circuits the actual loop, so we never call the LLM. */
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

const settledResult = (r: Partial<SubagentResult> = {}): SubagentResult => ({
  ok: true,
  finalText: "done",
  turns: 1,
  ...r,
})

/** A runner spy that counts forks and never actually recurses. */
const spyRunner = (): { runner: SubagentRunner; forks: () => number } => {
  let n = 0
  return {
    runner: async () => {
      n += 1
      return settledResult()
    },
    forks: () => n,
  }
}

/** Drive a tool's execute() to completion, return the terminal event. */
const driveLast = async (tool: Tool, input: unknown, c: ToolContext): Promise<ToolEvent> => {
  let last: ToolEvent | undefined
  for await (const ev of tool.execute(input as never, c)) last = ev
  if (!last) throw new Error("tool yielded no events")
  return last
}

/** Pin the runtime cap to 1 (root-only) through the real env→runtimeConfig seam.
 *  rev.3 default is 3; these SSOT-agreement tests were written against a
 *  root-only cap, so they set it explicitly (the default-3 value is owned by
 *  max-descendant-depth-config-pin.test.ts). */
const withCap1 = (): void => {
  process.env.QUANTA_MAX_DESCENDANT_DEPTH = "1"
  __resetRuntimeConfig()
}
/** Pin the runtime operator policy to an arbitrary cap through the real env seam. */
const withCap = (cap: number): void => {
  process.env.QUANTA_MAX_DESCENDANT_DEPTH = String(cap)
  __resetRuntimeConfig()
}
const clearCap = (): void => {
  delete process.env.QUANTA_MAX_DESCENDANT_DEPTH
  __resetRuntimeConfig()
}

const ctxAtDepth = (depth: number): ToolContext =>
  ({ cwd: "/tmp", signal: new AbortController().signal, depth }) as ToolContext

/** A minimal AgentConfig materializing the subagent block. `depth`/`maxDepth`
 *  are the levers; `enable6Tools` builds the spawn_agent path too. */
const cfg = (opts: { depth?: number; maxDepth?: number } = {}): AgentConfig =>
  ({
    subagent: {
      enable6Tools: true,
      ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
    },
    ...(opts.depth !== undefined ? { depth: opts.depth } : {}),
  }) as unknown as AgentConfig

const agentOf = (block: NonNullable<ReturnType<typeof buildSubagentBlock>>): Tool =>
  block.extraTools.find((t) => t.name === "agent")!

const asResult = (ev: ToolEvent): { ok: boolean; output: string } => {
  // Denials are surfaced as `result` events with `ok:false` (agent-tool.ts
  // `deny()` / handlers-6 `errSpawn`), so the terminal event is always `result`.
  if (ev.type === "result") return { ok: ev.result.ok, output: ev.result.output }
  throw new Error(`expected result event, got ${ev.type}`)
}

// ── A0 : the divergence is REAL (fallback === 3, the mutation baseline) ───────

describe("A0 — raw @/subagent constructors fall back to DEFAULT_MAX_DEPTH=3", () => {
  test("raw createAgentTool (no maxDepth) ADMITS childDepth 3 (ctx.depth 2)", async () => {
    const spy = spyRunner()
    const tool = createAgentTool({ runner: spy.runner })
    // childDepth = ctx.depth(2) + 1 = 3; fallback cap 3 ⇒ 3 > 3 is FALSE ⇒ admit.
    const r = asResult(await driveLast(tool, { prompt: "x" }, ctxAtDepth(2)))
    await new Promise<void>((res) => setTimeout(res, 5))
    expect(r.ok).toBe(true)
    expect(spy.forks()).toBe(1)
  })

  test("raw createSubagent6Tools (no maxDepth) ADMITS childDepth 3 (parentDepth 2)", async () => {
    const spy = spyRunner()
    const spawn = createSubagent6Tools({
      runner: spy.runner,
      registry: new TaskRegistry(),
      parentDepth: 2,
    }).tools.find((t) => t.name === "spawn_agent")!
    // childDepth = parentDepth(2) + 1 = 3; fallback cap 3 ⇒ admit.
    const r = asResult(await driveLast(spawn, { prompt: "x" }, ctxAtDepth(0)))
    await new Promise<void>((res) => setTimeout(res, 5))
    expect(r.ok).toBe(true)
    expect(spy.forks()).toBe(1)
  })
})

// ── A1 : the BLOCK's `agent` tool honors the RESOLVED cap (reachable) ─────────

describe("A1 — block-built `agent` tool uses the resolved cap, NOT DEFAULT_MAX_DEPTH", () => {
  test("env cap 1: agent REJECTS a call whose ctx.depth forks childDepth 3", async () => {
    withCap1() // spawnDepthCap() === 1 (env cap), no per-config maxDepth
    expect(spawnDepthCap()).toBe(1)
    // Root builds the block (depth 0 < cap 1). The `agent` tool reads depth from
    // ctx.depth at CALL time (runtime lineage), independent of config.depth — so
    // a host that plumbs ctx.depth=2 reaches the pre-check with childDepth 3.
    const block = buildSubagentBlock(cfg({ depth: 0 }))!
    const agent = agentOf(block)
    const r = asResult(await driveLast(agent, { prompt: "x" }, ctxAtDepth(2)))
    // FIX-A: wired cap === spawnDepthCap() === 1 ⇒ childDepth 3 > 1 ⇒ DENY.
    // PRE-FIX (fallback 3): 3 > 3 false ⇒ WOULD ADMIT (the hole). Assert deny +
    // the resolved cap (1) appears in the message (NOT 3).
    expect(r.ok).toBe(false)
    expect(r.output).toContain("maxDepth 1")
    expect(r.output).not.toContain("maxDepth 3")
    clearCap()
  })

  test("paired control: childDepth AT the resolved cap is admitted (deny is depth-driven)", async () => {
    withCap1()
    const spy = spyRunner()
    // Reuse a block-equivalent wiring: resolved cap 1, ctx.depth 0 ⇒ childDepth 1
    // ⇒ 1 > 1 false ⇒ admit. Proves A1's deny is the cap boundary, not blanket.
    const agent = createAgentTool({ runner: spy.runner, maxDepth: spawnDepthCap() })
    const r = asResult(await driveLast(agent, { prompt: "x" }, ctxAtDepth(0)))
    await new Promise<void>((res) => setTimeout(res, 5))
    expect(r.ok).toBe(true)
    expect(spy.forks()).toBe(1)
  })

  test("rev.4 min-cap: per-config maxDepth=5 CANNOT widen above policy 1 (block agent cap stays 1)", async () => {
    __resetRuntimeConfig() // default policy 1 (root-only)
    // rev.3 override would make config.subagent.maxDepth=5 ⇒ cap 5; rev.4 min-cap
    // ⇒ min(1,5)=1. So childDepth 2 (ctx.depth 1) is REJECTED at cap 1 — config
    // did NOT raise the cap. RED-ON-INJECTION: reverting to `?? override` makes
    // the cap 5 ⇒ this call ADMITS ⇒ the assertion below flips.
    const block = buildSubagentBlock(cfg({ depth: 0, maxDepth: 5 }))!
    const agent = agentOf(block)
    const denied = asResult(await driveLast(agent, { prompt: "x" }, ctxAtDepth(1)))
    expect(denied.ok).toBe(false)
    expect(denied.output).toContain("maxDepth 1") // resolved to policy, NOT 5
    expect(denied.output).not.toContain("maxDepth 5")
  })

  test("rev.4 min-cap: per-config maxDepth=1 TIGHTENS an env policy 3 to 1", async () => {
    process.env.QUANTA_MAX_DESCENDANT_DEPTH = "3"
    __resetRuntimeConfig()
    // policy 3, requested 1 ⇒ min(3,1)=1. childDepth 2 (ctx.depth 1) now REJECTED
    // (would be admitted at policy 3). Proves the config tightens.
    const block = buildSubagentBlock(cfg({ depth: 0, maxDepth: 1 }))!
    const agent = agentOf(block)
    const denied = asResult(await driveLast(agent, { prompt: "x" }, ctxAtDepth(1)))
    expect(denied.ok).toBe(false)
    expect(denied.output).toContain("maxDepth 1")
    clearCap()
  })
})

// ── A2 : the BLOCK's spawn_agent deps carry the resolved cap (wiring proof) ───

describe("A2 — spawn_agent secondary pre-check receives the resolved cap", () => {
  test("6-tool given maxDepth=resolved(1) REJECTS childDepth 2 that fallback 3 admits", async () => {
    withCap1()
    const spy = spyRunner()
    // Simulate the deps the FIXED block wires when spawnDepthCap()===1: an
    // explicit maxDepth=1 (resolved) instead of an omitted one (→ fallback 3).
    const spawn = createSubagent6Tools({
      runner: spy.runner,
      registry: new TaskRegistry(),
      parentDepth: 1, // childDepth 2
      maxDepth: spawnDepthCap(), // 1 — the resolved cap the block now threads
    }).tools.find((t) => t.name === "spawn_agent")!
    const r = asResult(await driveLast(spawn, { prompt: "x" }, ctxAtDepth(0)))
    expect(r.ok).toBe(false)
    expect(r.output).toContain("depth 2")
    expect(spy.forks()).toBe(0)
    clearCap()
  })

  test("spawn_agent divergence is INERT through the block (gate bounds parentDepth)", () => {
    // The block sets `parentDepth: config.depth` and only builds when the
    // capability gate is open (`config.depth < cap`). So childDepth = depth+1
    // <= cap <= resolved cap — always admitted regardless of the 3-fallback.
    // This documents WHY spawn_agent's pre-check is belt-and-suspenders (A2 above
    // drives it directly), while `agent` (ctx.depth-driven, A1) is the reachable
    // divergence. Assert the gate invariant holds for the block's parentDepth.
    __resetRuntimeConfig()
    for (const depth of [0]) {
      const config = cfg({ depth })
      expect(spawnToolsAvailable(config)).toBe(true) // block builds
      const resolvedCap = effectiveCap(config.subagent?.maxDepth)
      const childDepth = depth + 1
      expect(childDepth).toBeLessThanOrEqual(resolvedCap) // never exceeds ⇒ inert
    }
  })
})

// ── A3 : 3-source cross-agreement (gate ⇔ runner ⇔ secondary pre-check) ───────

/** One (policy already env-set) × requested × depth combo: assert the gate, the
 *  runner reject, and the spawn_agent pre-check make the IDENTICAL admit/reject
 *  decision. Extracted so the A3 matrix loop stays under the cognitive-complexity
 *  cap. `requested` is driven RAW into the runner so its own `effectiveCap(...)`
 *  re-mins against the policy (idempotent); the @/subagent pre-check (which does
 *  NOT re-min — slice fence) gets the already-resolved `cap`. */
const assertThreeSourceAgreement = async (
  requested: number | undefined,
  depth: number,
): Promise<void> => {
  const cap = effectiveCap(requested) // min(policy, requested ?? +∞)
  const childDepth = depth + 1

  // (1) Capability gate: is THIS agent (at `depth`) entitled to spawn tools?
  const gateOpen = spawnToolsAvailable(
    cfg({ depth, ...(requested !== undefined ? { maxDepth: requested } : {}) }),
  )
  expect(gateOpen).toBe(depth < cap) // gate opens ⇔ its forked child is admissible

  // (2) Runner reject — LINEAGE-DERIVED (`childDepthOf(parent) > effectiveCap`),
  //     the parent carries the real depth; runner re-mins the RAW requested.
  const runner = createSubagentRunner({ ...parentCfg(), depth } as AgentConfig, {
    run: (async () => ({
      reason: "completed",
      turns: 1,
      messages: [{ role: "assistant", content: [{ type: "text", text: "x" }] }],
    })) as never,
    ...(requested !== undefined ? { maxDepth: requested } : {}),
    isGitRepo: async () => false,
  })
  const runnerAdmits = (
    await runner({ prompt: "p", depth: childDepth, isolation: "none" } as SubagentRequest)
  ).ok
  expect(runnerAdmits).toBe(childDepth <= cap)

  // (3) Secondary pre-check (spawn_agent) — the @/agent caller threads the
  //     already-RESOLVED `cap` in (FIX-A); the @/subagent slice does not re-min.
  const spawn = createSubagent6Tools({
    runner: async () => settledResult(),
    registry: new TaskRegistry(),
    parentDepth: depth,
    maxDepth: cap,
  }).tools.find((t) => t.name === "spawn_agent")!
  const preAdmits = asResult(await driveLast(spawn, { prompt: "p" }, ctxAtDepth(0))).ok
  await new Promise<void>((res) => setTimeout(res, 2))

  // CROSS-SOURCE AGREEMENT: no (policy, requested, depth) where one admits and
  // another rejects — no split-brain.
  expect(preAdmits).toBe(runnerAdmits)
  expect(gateOpen).toBe(runnerAdmits) // parent exposure ⇔ child admissibility
}

describe("A3 — all three cap sources agree for every (depth, effective-cap)", () => {
  test("no (depth, policy×requested) where the gate, runner reject, and pre-check disagree", async () => {
    // rev.4 min-cap matrix: {policy 0/1/2/3} × {requested none/1/2/5} × {depth 0..3}.
    for (const policy of [0, 1, 2, 3]) {
      withCap(policy) // spawnDepthCap() === policy (env)
      for (const requested of [undefined, 1, 2, 5]) {
        for (const depth of [0, 1, 2, 3]) {
          await assertThreeSourceAgreement(requested, depth)
        }
      }
    }
    clearCap()
  })
})

// ── B : cap=0 total kill-switch ──────────────────────────────────────────────

describe("QUANTA_MAX_DESCENDANT_DEPTH=0 is a total kill-switch (root included)", () => {
  // rev.4 §4.4: the block builder NO LONGER self-gates — it always mints its
  // tools; the SINGLE `projectSpawnTools` filter (features.ts seam) removes them.
  // So capability-absence is asserted through the filter over the built tools.
  const spawnNamesAfterProjection = (opts: { depth?: number; maxDepth?: number }): string[] => {
    const config = cfg(opts)
    const block = buildSubagentBlock(config)
    expect(block).toBeDefined() // builder unconditionally mints (SSOT moved out)
    return projectSpawnTools(block!.extraTools, config)
      .map((t) => t.name)
      .filter((n) => n === "agent" || n === "spawn_agent")
  }

  test("cap 0: root (depth 0) gets NO spawn tools after projection", () => {
    const original = process.env.QUANTA_MAX_DESCENDANT_DEPTH
    process.env.QUANTA_MAX_DESCENDANT_DEPTH = "0"
    __resetRuntimeConfig()
    try {
      expect(spawnDepthCap()).toBe(0)
      // canExposeSpawnTools at the ROOT: (0 ?? 0) < (undefined ?? 0) === 0 < 0
      // === FALSE ⇒ even root loses spawn tools ⇒ the filter strips agent/spawn_agent.
      expect(spawnToolsAvailable(cfg({ depth: 0 }))).toBe(false)
      expect(spawnNamesAfterProjection({ depth: 0 })).toEqual([])
      // Undefined depth (root contract) too.
      expect(spawnToolsAvailable(cfg({}))).toBe(false)
      expect(spawnNamesAfterProjection({})).toEqual([])
    } finally {
      if (original === undefined) delete process.env.QUANTA_MAX_DESCENDANT_DEPTH
      else process.env.QUANTA_MAX_DESCENDANT_DEPTH = original
      __resetRuntimeConfig()
    }
  })

  test("unset ⇒ rev.4 default cap 1 ⇒ root DOES spawn, depth-1 child does NOT (root-only)", () => {
    clearCap()
    expect(spawnDepthCap()).toBe(1)
    expect(spawnToolsAvailable(cfg({ depth: 0 }))).toBe(true) // 0 < 1 ⇒ root spawns
    expect(spawnNamesAfterProjection({ depth: 0 })).toEqual(["agent", "spawn_agent"])
    // depth-1 child is a LEAF at the default policy (root-only intent): the filter
    // strips the creation tools even though the builder minted them.
    expect(spawnToolsAvailable(cfg({ depth: 1 }))).toBe(false) // 1 < 1 false
    expect(spawnNamesAfterProjection({ depth: 1 })).toEqual([])
  })
})

// ── A4 : STRUCTURAL red-on-injection anchor ──────────────────────────────────

describe("A4 — @/agent caller threads the resolved cap UNCONDITIONALLY (structural)", () => {
  test("tier1/subagent.ts resolves `effectiveMaxDepth` and passes it to all 3 constructors", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(resolve(here, "../../src/agent/tier1/subagent.ts"), "utf8")
    // rev.4: the resolved cap is the MIN-CAP `effectiveCap(config.subagent.maxDepth)`
    // — the SAME min-cap the gate/runner use. Reverting to the rev.3 `?? override`
    // (`config.subagent.maxDepth ?? spawnDepthCap()`) lets a config widen past
    // policy again ⇒ the min-cap red-on-injection tests turn RED.
    expect(src).toContain("const effectiveMaxDepth = effectiveCap(config.subagent.maxDepth)")
    // Passed UNCONDITIONALLY (not the old conditional spread) to the runner,
    // the agent tool, and the 6-tool set. Reverting any of these to the
    // `config.subagent.maxDepth !== undefined ? { maxDepth: … } : {}` spread —
    // which drops maxDepth on the unset path → the @/subagent 3-fallback — turns
    // A1/A2 RED.
    const passes = src.match(/maxDepth: effectiveMaxDepth/g) ?? []
    expect(passes.length).toBeGreaterThanOrEqual(3)
    // And `effectiveCap` is imported (slice-fence-respecting min-cap resolution at
    // the @/agent caller boundary). rev.4 §4.4: this builder NO LONGER imports
    // `spawnToolsAvailable` — capability projection moved to the single
    // `projectSpawnTools` filter at the features.ts seam.
    expect(src).toContain('import { effectiveCap } from "@/agent/spawn-depth"')
    expect(src).not.toContain("spawnToolsAvailable")
  })
})
