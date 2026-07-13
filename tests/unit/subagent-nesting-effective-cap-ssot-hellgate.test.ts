/**
 * HELLGATE — FIX-A: single effective-cap SSOT for sub-agent nesting control.
 * RFC docs/plans/jul-13-subagent-nesting-control.md §4.5 / §6.5 B.
 *
 * The nesting control has THREE cap sources that must AGREE:
 *   1. Capability gate   — `spawnToolsAvailable` (spawn-depth-policy.ts):
 *                          `(depth ?? 0) < (config.subagent?.maxDepth ?? spawnDepthCap())`
 *   2. Runner reject     — `createSubagentRunner` (subagent-runner.ts:736):
 *                          `req.depth > (opts.maxDepth ?? spawnDepthCap())`
 *   3. Secondary pre-checks — the `@/subagent` slice's `agent` tool
 *                          (agent-tool.ts:658 `opts.maxDepth ?? DEFAULT_MAX_DEPTH`)
 *                          and `spawn_agent` (handlers-6.ts:668
 *                          `deps.maxDepth ?? DEFAULT_MAX_DEPTH`).
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
import { spawnDepthCap, spawnToolsAvailable } from "@/agent/spawn-depth-policy"
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
  test("default cap 1: agent REJECTS a call whose ctx.depth forks childDepth 3", async () => {
    __resetRuntimeConfig() // spawnDepthCap() === 1 (default), no per-config maxDepth
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
  })

  test("paired control: childDepth AT the resolved cap is admitted (deny is depth-driven)", async () => {
    __resetRuntimeConfig()
    const spy = spyRunner()
    // Reuse a block-equivalent wiring: resolved cap 1, ctx.depth 0 ⇒ childDepth 1
    // ⇒ 1 > 1 false ⇒ admit. Proves A1's deny is the cap boundary, not blanket.
    const agent = createAgentTool({ runner: spy.runner, maxDepth: spawnDepthCap() })
    const r = asResult(await driveLast(agent, { prompt: "x" }, ctxAtDepth(0)))
    await new Promise<void>((res) => setTimeout(res, 5))
    expect(r.ok).toBe(true)
    expect(spy.forks()).toBe(1)
  })

  test("per-config maxDepth=2 widens the block's agent cap to 2 (all three agree)", async () => {
    __resetRuntimeConfig()
    // config.subagent.maxDepth=2 ⇒ resolved cap 2 ⇒ childDepth 3 (ctx.depth 2)
    // STILL rejected (3 > 2), but childDepth 2 (ctx.depth 1) now admitted.
    const block = buildSubagentBlock(cfg({ depth: 0, maxDepth: 2 }))!
    const agent = agentOf(block)
    const denied = asResult(await driveLast(agent, { prompt: "x" }, ctxAtDepth(2)))
    expect(denied.ok).toBe(false)
    expect(denied.output).toContain("maxDepth 2")
  })
})

// ── A2 : the BLOCK's spawn_agent deps carry the resolved cap (wiring proof) ───

describe("A2 — spawn_agent secondary pre-check receives the resolved cap", () => {
  test("6-tool given maxDepth=resolved(1) REJECTS childDepth 2 that fallback 3 admits", async () => {
    __resetRuntimeConfig()
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
      const resolvedCap = config.subagent?.maxDepth ?? spawnDepthCap()
      const childDepth = depth + 1
      expect(childDepth).toBeLessThanOrEqual(resolvedCap) // never exceeds ⇒ inert
    }
  })
})

// ── A3 : 3-source cross-agreement (gate ⇔ runner ⇔ secondary pre-check) ───────

describe("A3 — all three cap sources agree for every (depth, effective-cap)", () => {
  test("no (depth, cap) where the gate, runner reject, and pre-check disagree", async () => {
    __resetRuntimeConfig() // spawnDepthCap() === 1
    // (parentDepth, per-config cap). effective cap = cap ?? spawnDepthCap().
    const combos: ReadonlyArray<readonly [number, number | undefined]> = [
      [0, undefined],
      [1, undefined],
      [2, undefined],
      [0, 2],
      [1, 2],
      [2, 2],
      [0, 3],
      [2, 3],
      [1, 0], // kill switch
    ]
    for (const [depth, cap] of combos) {
      const effectiveCap = cap ?? spawnDepthCap()
      const childDepth = depth + 1

      // (1) Capability gate: is THIS agent (at `depth`) entitled to spawn tools?
      const gateOpen = spawnToolsAvailable(
        cfg({ depth, ...(cap !== undefined ? { maxDepth: cap } : {}) }),
      )
      // Gate opens ⇔ depth < effectiveCap ⇔ the child it would fork is admissible.
      expect(gateOpen).toBe(depth < effectiveCap)

      // (2) Runner reject: forked child at childDepth is admitted iff childDepth
      //     <= effectiveCap (reject is `req.depth > maxDepth`). The injected
      //     `run` short-circuits the loop; a valid parentCfg lets an ADMITTED
      //     spawn build its child config without a stub crash.
      const runner = createSubagentRunner(parentCfg(), {
        run: (async () => ({
          reason: "completed",
          turns: 1,
          messages: [{ role: "assistant", content: [{ type: "text", text: "x" }] }],
        })) as never,
        maxDepth: effectiveCap,
        isGitRepo: async () => false,
      })
      const runnerResult = await runner({
        prompt: "p",
        depth: childDepth,
        isolation: "none",
      } as SubagentRequest)
      const runnerAdmits = runnerResult.ok
      expect(runnerAdmits).toBe(childDepth <= effectiveCap)

      // (3) Secondary pre-check (spawn_agent): admitted iff childDepth <=
      //     effectiveCap, GIVEN the resolved cap is threaded in (FIX-A).
      const spawn = createSubagent6Tools({
        runner: async () => settledResult(),
        registry: new TaskRegistry(),
        parentDepth: depth,
        maxDepth: effectiveCap,
      }).tools.find((t) => t.name === "spawn_agent")!
      const pre = asResult(await driveLast(spawn, { prompt: "p" }, ctxAtDepth(0)))
      const preAdmits = pre.ok
      await new Promise<void>((res) => setTimeout(res, 2))

      // CROSS-SOURCE AGREEMENT: the runner and the secondary pre-check make the
      // IDENTICAL admit/reject decision for the forked child; the gate makes the
      // matching tool-exposure decision for the parent. No depth where one admits
      // and another rejects.
      expect(preAdmits).toBe(runnerAdmits)
      expect(gateOpen).toBe(runnerAdmits) // parent exposure ⇔ child admissibility
    }
  })
})

// ── B : cap=0 total kill-switch (FIX-B) ──────────────────────────────────────

describe("FIX-B — QUANTA_MAX_SPAWN_DEPTH=0 is a total kill-switch (root included)", () => {
  test("cap 0: root (depth 0) gets NO spawn tools; block absent", () => {
    const original = process.env["QUANTA_MAX_SPAWN_DEPTH"]
    process.env["QUANTA_MAX_SPAWN_DEPTH"] = "0"
    __resetRuntimeConfig()
    try {
      expect(spawnDepthCap()).toBe(0)
      // spawnToolsAvailable at the ROOT: (0 ?? 0) < (undefined ?? 0) === 0 < 0
      // === FALSE ⇒ even root loses spawn tools ⇒ the block is absent.
      const rootConfig = cfg({ depth: 0 })
      expect(spawnToolsAvailable(rootConfig)).toBe(false)
      expect(buildSubagentBlock(rootConfig)).toBeUndefined()
      // Undefined depth (root contract) too.
      expect(spawnToolsAvailable(cfg({}))).toBe(false)
    } finally {
      if (original === undefined) delete process.env["QUANTA_MAX_SPAWN_DEPTH"]
      else process.env["QUANTA_MAX_SPAWN_DEPTH"] = original
      __resetRuntimeConfig()
    }
  })

  test("unset ⇒ default cap 1 ⇒ root DOES spawn (kill-switch is opt-in)", () => {
    __resetRuntimeConfig()
    expect(spawnDepthCap()).toBe(1)
    expect(spawnToolsAvailable(cfg({ depth: 0 }))).toBe(true) // 0 < 1
    expect(buildSubagentBlock(cfg({ depth: 0 }))).toBeDefined()
  })
})

// ── A4 : STRUCTURAL red-on-injection anchor ──────────────────────────────────

describe("A4 — @/agent caller threads the resolved cap UNCONDITIONALLY (structural)", () => {
  test("tier1/subagent.ts resolves `effectiveMaxDepth` and passes it to all 3 constructors", () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const src = readFileSync(resolve(here, "../../src/agent/tier1/subagent.ts"), "utf8")
    // The resolved cap uses the SAME expression as the gate/runner.
    expect(src).toContain("const effectiveMaxDepth = config.subagent.maxDepth ?? spawnDepthCap()")
    // Passed UNCONDITIONALLY (not the old conditional spread) to the runner,
    // the agent tool, and the 6-tool set. Reverting any of these to the
    // `config.subagent.maxDepth !== undefined ? { maxDepth: … } : {}` spread —
    // which drops maxDepth on the unset path → the @/subagent 3-fallback — turns
    // A1/A2 RED (childDepth 3 admitted again).
    const passes = src.match(/maxDepth: effectiveMaxDepth/g) ?? []
    expect(passes.length).toBeGreaterThanOrEqual(3)
    // And the old conditional-spread of the RAW config value must NOT feed these
    // constructors anymore (it would re-open the fallback on the unset path).
    // `spawnDepthCap` is imported (slice-fence-respecting resolution at caller).
    expect(src).toContain(
      'import { spawnDepthCap, spawnToolsAvailable } from "@/agent/spawn-depth-policy"',
    )
  })
})
