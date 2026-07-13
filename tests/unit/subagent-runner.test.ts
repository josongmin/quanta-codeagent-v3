import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { runAgent } from "../../src/agent/loop"
import { buildEffectiveConfig } from "../../src/agent/session-resources"
import { createSubagentRunner } from "../../src/agent/subagent-runner"
import type { AgentConfig, AgentOutcome } from "../../src/agent/types"
import type { Message } from "../../src/llm"
import type { isGitRepo, withWorktree } from "../../src/runtime/worktree"
import type { SubagentRequest } from "../../src/subagent/types"
import type { Tool, ToolEvent } from "../../src/tool"
import { ToolRegistry } from "../../src/tool"

/** Index into a captured array, throwing if the slot is absent. Same
 *  fail-on-missing contract the previous `arr[i]!` non-null assertions had,
 *  but with an explicit runtime guard instead of a compile-only assertion. */
const at = <T>(arr: readonly T[], i: number): T => {
  const v = arr[i]
  if (v === undefined) throw new Error(`expected element at index ${i}`)
  return v
}

/** A trivial named tool so registry filtering can be asserted by name. */
const fakeTool = (name: string): Tool => ({
  name,
  description: name,
  inputSchema: z.object({}),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: "" } }
  },
})

const baseRegistry = (): ToolRegistry =>
  new ToolRegistry([fakeTool("read"), fakeTool("write"), fakeTool("bash")])

/** A structurally valid parent AgentConfig. The real loop is never invoked
 *  (every test injects a fake `run`), so ports can be inert stubs. */
const parentConfig = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    // biome-ignore lint/suspicious/noExplicitAny: inert port stub
    llm: { stream: async function* () {} } as any,
    registry: baseRegistry(),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "PARENT" }] }],
    system: "PARENT SYSTEM",
    cwd: "/repo",
    maxTurns: 17,
    signal: new AbortController().signal,
    ...over,
  }) as AgentConfig

const outcome = (over: Partial<AgentOutcome> = {}): AgentOutcome => ({
  reason: "completed",
  turns: 2,
  messages: [
    { role: "user", content: [{ type: "text", text: "hi" }] },
    { role: "assistant", content: [{ type: "text", text: "the answer" }] },
  ],
  ...over,
})

const req = (over: Partial<SubagentRequest> = {}): SubagentRequest => ({
  prompt: "do the thing",
  depth: 1,
  ...over,
})

/** Capture the child config the runner hands to `runAgent`. */
const capturing = (
  result: AgentOutcome = outcome(),
): { run: typeof runAgent; seen: AgentConfig[] } => {
  const seen: AgentConfig[] = []
  const run = (async (c: AgentConfig) => {
    seen.push(c)
    return result
  }) as typeof runAgent
  return { run, seen }
}

describe("createSubagentRunner — depth guard", () => {
  test("denies (never throws) when req.depth exceeds maxDepth", async () => {
    const { run, seen } = capturing()
    const runner = createSubagentRunner(parentConfig(), { run, maxDepth: 3 })
    const r = await runner(req({ depth: 4 }))
    // RFC jul-13 §6.5 B Phase 2 — Codex-style directive message, cap interpolated.
    expect(r).toEqual({
      ok: false,
      finalText: "max subagent depth (3) exceeded — complete this task yourself, do not spawn.",
      turns: 0,
    })
    expect(seen.length).toBe(0) // loop never forked
  })

  test("default maxDepth follows the spawn-depth policy cap (spawnDepthCap ⇒ 1)", async () => {
    // RFC jul-13 §6.5 B Phase 2 — the runner default cap is now `spawnDepthCap()`
    // (= runtimeConfig().maxSpawnDepth, default 1), NOT the old local 3. This
    // aligns the runner-holding bypass paths (background/delegate) with the same
    // policy the tier1 block builders gate on. `opts.maxDepth` override still wins.
    const { run } = capturing()
    const runner = createSubagentRunner(parentConfig(), { run })
    expect((await runner(req({ depth: 2 }))).ok).toBe(false) // > cap 1 ⇒ denied
    expect((await runner(req({ depth: 1 }))).ok).toBe(true) // == cap 1 ⇒ allowed
  })

  test("depth exactly at the limit is allowed", async () => {
    const { run, seen } = capturing()
    const runner = createSubagentRunner(parentConfig(), { run, maxDepth: 3 })
    expect((await runner(req({ depth: 3 }))).ok).toBe(true)
    expect(seen.length).toBe(1)
  })
})

describe("createSubagentRunner — child config overrides", () => {
  test("seeds the child with exactly the request prompt", async () => {
    const { run, seen } = capturing()
    const runner = createSubagentRunner(parentConfig(), { run })
    await runner(req({ prompt: "investigate X" }))
    const msgs = at(seen, 0).messages as Message[]
    expect(msgs).toEqual([{ role: "user", content: [{ type: "text", text: "investigate X" }] }])
  })

  test("toolFilter produces a filtered registry; absent ⇒ inherits parent", async () => {
    const { run, seen } = capturing()
    const parent = parentConfig()
    const runner = createSubagentRunner(parent, { run })

    await runner(req({ toolFilter: ["read", "missing"] }))
    expect(
      at(seen, 0)
        .registry.specs()
        .map((s) => s.name)
        .sort(),
    ).toEqual(["read"])

    await runner(req())
    // No filter ⇒ the parent's own registry instance is inherited as-is.
    expect(at(seen, 1).registry).toBe(parent.registry)
    expect(
      at(seen, 1)
        .registry.specs()
        .map((s) => s.name)
        .sort(),
    ).toEqual(["bash", "read", "write"])
  })

  test("empty toolFilter ⇒ empty child registry (no throw)", async () => {
    const { run, seen } = capturing()
    const runner = createSubagentRunner(parentConfig(), { run })
    await runner(req({ toolFilter: [] }))
    expect(at(seen, 0).registry.specs()).toEqual([])
  })

  test("maxTurns = budget.maxTurns ?? parent.maxTurns", async () => {
    const { run, seen } = capturing()
    const runner = createSubagentRunner(parentConfig({ maxTurns: 17 }), { run })
    await runner(req({ budget: { maxTurns: 5 } }))
    expect(at(seen, 0).maxTurns).toBe(5)
    await runner(req())
    expect(at(seen, 1).maxTurns).toBe(17)
  })

  test("store / hooks / metrics / run / sessionId / memory are dropped; subagent is PROPAGATED", async () => {
    const { run, seen } = capturing()
    // biome-ignore lint/suspicious/noExplicitAny: opaque runner stub, identity is what matters
    const subagentBlock = { runner: (async () => ({})) as any, maxDepth: 2 }
    const parent = parentConfig({
      // biome-ignore lint/suspicious/noExplicitAny: opaque stubs, presence is what matters
      store: { v: 1 } as any,
      // biome-ignore lint/suspicious/noExplicitAny: opaque stub
      hooks: { emit: async () => undefined } as any,
      // biome-ignore lint/suspicious/noExplicitAny: opaque stub
      metrics: {} as any,
      // biome-ignore lint/suspicious/noExplicitAny: opaque stub
      run: { traceId: "t" } as any,
      sessionId: "parent-session",
      memory: { recallLimit: 9 },
      // biome-ignore lint/suspicious/noExplicitAny: structural subagent block
      subagent: subagentBlock as any,
      // biome-ignore lint/suspicious/noExplicitAny: skills must NOT propagate
      skills: { dir: "/skills" } as any,
    })
    const runner = createSubagentRunner(parent, { run })
    await runner(req())
    const child = at(seen, 0)
    expect(child.store).toBeUndefined()
    expect(child.hooks).toBeUndefined()
    expect(child.metrics).toBeUndefined()
    expect(child.run).toBeUndefined()
    expect(child.sessionId).toBeUndefined()
    expect(child.memory).toBeUndefined()
    // ADR-0011: `subagent` is now PROPAGATED into the child (same
    // object/value as the parent) so a forked child can itself spawn
    // sub-subagents; recursion stays bounded by the depth marker + maxDepth
    // deny guard. `skills` is still NOT propagated (clean tool surface).
    expect(child.subagent).toBe(parent.subagent)
    expect(child.subagent).toEqual(subagentBlock)
    expect(child.skills).toBeUndefined()
    // Kept ports survive.
    expect(child.llm).toBe(parent.llm)
    expect(child.stream).toBe(parent.stream)
    expect(child.permission).toBe(parent.permission)
    expect(child.system).toBe(parent.system)
  })

  test("subagent is omitted (not undefined) when the parent has none", async () => {
    const { run, seen } = capturing()
    const parent = parentConfig()
    expect(parent.subagent).toBeUndefined()
    const runner = createSubagentRunner(parent, { run })
    await runner(req())
    const child = at(seen, 0)
    expect(child.subagent).toBeUndefined()
    expect("subagent" in child).toBe(false) // omitted, never assigned undefined
  })

  test("surfaces req.depth on the child config (the dispatch depth seam)", async () => {
    const { run, seen } = capturing()
    // This seam is about depth PROPAGATION onto the child, orthogonal to the cap.
    // Give explicit `maxDepth` headroom so the fork proceeds at req.depth 2 (the
    // default cap is now `spawnDepthCap()` === 1 after the RFC jul-13 §6.5 B
    // Phase 2 alignment, which would otherwise DENY depth 2 before forking).
    const runner = createSubagentRunner(parentConfig(), { run, maxDepth: 3 })
    await runner(req({ depth: 2 }))
    expect((seen[0] as unknown as { depth?: number }).depth).toBe(2)
  })

  // Round 2 fix: Codex-absorption safety contracts MUST propagate to forked
  // children. A review/audit-mode parent that spawns a child WITHOUT mode
  // inheritance would silently allow the child to invoke mutating tools at
  // dispatch, breaking the read-only posture. Same for verify-/closeout-guard
  // and HITL 4-tier.
  test("propagates mode/verifyGuard/closeoutGuard/hitl to the child (Codex-absorption inheritance)", async () => {
    const { run, seen } = capturing()
    const parent = parentConfig({
      mode: "review",
      verifyGuard: { maxTrips: 2 },
      closeoutGuard: { enabled: true, fourRule: true },
      hitl: { enabled: true },
    })
    const runner = createSubagentRunner(parent, { run })
    await runner(req())
    const child = at(seen, 0)
    expect(child.mode).toBe("review")
    expect(child.verifyGuard).toEqual({ maxTrips: 2 })
    expect(child.closeoutGuard).toEqual({ enabled: true, fourRule: true })
    expect(child.hitl).toEqual({ enabled: true })
  })

  test("does NOT propagate repoRules or workingState (cwd-bound / session-scoped)", async () => {
    const { run, seen } = capturing()
    const parent = parentConfig({
      repoRules: {
        sourcePath: "/r/AGENTS.md",
        entrypoint: "AGENTS.md",
        body: "parent rules",
        loadedAt: 1,
      },
      workingState: { enabled: true },
    })
    const runner = createSubagentRunner(parent, { run })
    await runner(req())
    const child = at(seen, 0)
    // repoRules: the child may run in a different cwd (worktree fork) where
    // the parent's repo-local authority is stale — intentional drop.
    expect(child.repoRules).toBeUndefined()
    // workingState: Codex L3 session-scoped — each agent gets a fresh
    // scratchpad. Intentional drop.
    expect(child.workingState).toBeUndefined()
  })

  test("omits absorption fields entirely when the parent has none (no `undefined` assigns)", async () => {
    const { run, seen } = capturing()
    const parent = parentConfig()
    expect(parent.mode).toBeUndefined()
    expect(parent.hitl).toBeUndefined()
    const runner = createSubagentRunner(parent, { run })
    await runner(req())
    const child = at(seen, 0)
    expect("mode" in child).toBe(false)
    expect("verifyGuard" in child).toBe(false)
    expect("closeoutGuard" in child).toBe(false)
    expect("hitl" in child).toBe(false)
  })
})

describe("createSubagentRunner — abort propagation", () => {
  test("aborting the parent aborts the child signal", async () => {
    const ac = new AbortController()
    const { run, seen } = capturing()
    const runner = createSubagentRunner(parentConfig({ signal: ac.signal }), { run })
    await runner(req())
    const childSignal = at(seen, 0).signal
    expect(childSignal.aborted).toBe(false)
    ac.abort()
    expect(childSignal.aborted).toBe(true)
  })

  test("already-aborted parent ⇒ child starts aborted", async () => {
    const ac = new AbortController()
    ac.abort()
    const { run, seen } = capturing()
    const runner = createSubagentRunner(parentConfig({ signal: ac.signal }), { run })
    await runner(req())
    expect(at(seen, 0).signal.aborted).toBe(true)
  })

  test("child finishing does NOT abort the parent", async () => {
    const ac = new AbortController()
    const { run } = capturing()
    const runner = createSubagentRunner(parentConfig({ signal: ac.signal }), { run })
    await runner(req())
    expect(ac.signal.aborted).toBe(false)
  })
})

describe("createSubagentRunner — outcome mapping", () => {
  test("completed ⇒ ok:true, last assistant text joined, turns + messages", async () => {
    const { run } = capturing(
      outcome({
        reason: "completed",
        turns: 4,
        messages: [
          { role: "assistant", content: [{ type: "text", text: "stale" }] },
          { role: "user", content: [{ type: "text", text: "q" }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "part 1 " },
              { type: "text", text: "part 2" },
            ],
          },
        ],
      }),
    )
    const r = await createSubagentRunner(parentConfig(), { run })(req())
    expect(r.ok).toBe(true)
    expect(r.finalText).toBe("part 1 part 2")
    expect(r.turns).toBe(4)
    expect(r.messages).toBeDefined()
  })

  test("non-completed reasons ⇒ ok:false", async () => {
    for (const reason of ["max_turns", "aborted", "error"] as const) {
      const { run } = capturing(outcome({ reason }))
      const r = await createSubagentRunner(parentConfig(), { run })(req())
      expect(r.ok).toBe(false)
    }
  })

  test("empty-turn STALL (loop sealed `error`) ⇒ ok:false, not a silent ok:true", async () => {
    // jul-3 C1 — a subagent whose loop stalled on repeated empty turns now ends
    // its AgentOutcome with `reason:"error"` (recovery.ts EMPTY_TURN_EXHAUSTED_
    // REASON routes through the error terminal), NOT `completed`. The runner's
    // `ok: reason==="completed"` map must therefore flip it to ok:false — the
    // parent surfaces a failed child, never a spurious success. finalText still
    // reflects whatever the last assistant turn held (here: none ⇒ "").
    const { run } = capturing(
      outcome({
        reason: "error",
        messages: [{ role: "user", content: [{ type: "text", text: "do it" }] }],
      }),
    )
    const r = await createSubagentRunner(parentConfig(), { run })(req())
    expect(r.ok).toBe(false)
    expect(r.finalText).toBe("")
  })

  test("no assistant text ⇒ empty finalText (no throw)", async () => {
    const { run } = capturing(
      outcome({ messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] }),
    )
    const r = await createSubagentRunner(parentConfig(), { run })(req())
    expect(r.finalText).toBe("")
  })
})

describe("createSubagentRunner — worktree isolation", () => {
  test("git repo + isolation:worktree ⇒ child cwd is the worktree path", async () => {
    const { run, seen } = capturing()
    const isGitRepoFake: typeof isGitRepo = async () => true
    const withWorktreeFake: typeof withWorktree = async (_id, repoRoot, fn) => {
      expect(repoRoot).toBe("/repo")
      const value = await fn("/repo/.claude/worktrees/agent-x")
      return {
        value,
        info: { worktreePath: "/repo/.claude/worktrees/agent-x", branch: "b", removed: true },
      }
    }
    const runner = createSubagentRunner(parentConfig(), {
      run,
      isGitRepo: isGitRepoFake,
      withWorktree: withWorktreeFake,
    })
    const r = await runner(req({ isolation: "worktree" }))
    expect(r.ok).toBe(true)
    expect(at(seen, 0).cwd).toBe("/repo/.claude/worktrees/agent-x")
  })

  test("not a git repo ⇒ falls back to no isolation (no throw, parent cwd)", async () => {
    const { run, seen } = capturing()
    let wtCalled = false
    const runner = createSubagentRunner(parentConfig({ cwd: "/plain" }), {
      run,
      isGitRepo: (async () => false) as typeof isGitRepo,
      withWorktree: (async () => {
        wtCalled = true
        throw new Error("should not be called")
      }) as unknown as typeof withWorktree,
    })
    const r = await runner(req({ isolation: "worktree" }))
    expect(r.ok).toBe(true)
    expect(wtCalled).toBe(false)
    expect(at(seen, 0).cwd).toBe("/plain")
    // UX honesty (jul-7 audit F5): the degradation is SURFACED, not silent — a caller
    // relying on isolation must see that it did not happen (ran shared in the parent cwd).
    expect(r.finalText).toContain('isolation:"worktree" requested but NOT achieved')
    expect(r.finalText.toLowerCase()).toContain("no write isolation")
  })

  test("git repo + isolation ⇒ NO degradation notice (isolation achieved)", async () => {
    const { run } = capturing()
    const runner = createSubagentRunner(parentConfig({ cwd: "/repo" }), {
      run,
      isGitRepo: (async () => true) as typeof isGitRepo,
      withWorktree: (async (_id, _root, fn) => ({
        value: await fn("/repo/.claude/worktrees/agent-x"),
        info: { worktreePath: "/repo/.claude/worktrees/agent-x", branch: "b", removed: true },
      })) as typeof withWorktree,
    })
    const r = await runner(req({ isolation: "worktree" }))
    // non-vacuous control: when isolation IS achieved, the notice must be ABSENT.
    expect(r.finalText).not.toContain("NOT achieved")
  })

  test("isolation:none ⇒ child cwd is the parent cwd (req.cwd field removed)", async () => {
    // Round 2: `SubagentRequest.cwd` was removed; the child ALWAYS inherits
    // `parent.cwd` on the no-isolation path. This regression keeps the
    // parent-cwd flow pinned so a future re-introduction of a per-request cwd
    // override has to retire this assertion explicitly.
    const { run, seen } = capturing()
    const runner = createSubagentRunner(parentConfig({ cwd: "/repo" }), { run })
    await runner(req({ isolation: "none" }))
    expect(at(seen, 0).cwd).toBe("/repo")
    // Missing isolation ⇒ same path (no isolation), parent.cwd inherited.
    await runner(req())
    expect(at(seen, 1).cwd).toBe("/repo")
  })
})

// jul-7 audit (F1): feature tools (spawn_agent / team_*) are added by buildSessionFeatures
// AFTER the inherited registry was filtered by the child's tool_filter — so without a second
// gate a restricted child re-acquires them. buildEffectiveConfig now intersects feature tools
// with `config.toolAllowlist` (the child's filter). Absent allowlist ⇒ byte-identical.
describe("buildEffectiveConfig — feature-tool allowlist gate (jul-7 audit F1)", () => {
  const cfg = (over: Partial<AgentConfig>): AgentConfig =>
    ({ ...parentConfig(), registry: new ToolRegistry([fakeTool("read")]), ...over }) as AgentConfig

  test("restricted child: feature tools NOT in toolAllowlist are DROPPED (spawn/team leak blocked)", () => {
    const out = buildEffectiveConfig(cfg({ toolAllowlist: ["read", "grep"] }), [
      fakeTool("spawn_agent"),
      fakeTool("team_create"),
      fakeTool("grep"),
    ])
    expect(out.registry.has("read")).toBe(true) // inherited
    expect(out.registry.has("grep")).toBe(true) // feature, allowlisted ⇒ kept
    expect(out.registry.has("spawn_agent")).toBe(false) // feature, NOT allowlisted ⇒ blocked
    expect(out.registry.has("team_create")).toBe(false)
  })

  test("unrestricted (no toolAllowlist): ALL feature tools kept (non-vacuous byte-identical control)", () => {
    const out = buildEffectiveConfig(cfg({}), [fakeTool("spawn_agent"), fakeTool("grep")])
    expect(out.registry.has("spawn_agent")).toBe(true) // no allowlist ⇒ feature kept
    expect(out.registry.has("grep")).toBe(true)
  })

  test("allowlisted feature tool survives (a child that explicitly permits `agent` can spawn)", () => {
    const out = buildEffectiveConfig(cfg({ toolAllowlist: ["read", "spawn_agent"] }), [
      fakeTool("spawn_agent"),
      fakeTool("team_create"),
    ])
    expect(out.registry.has("spawn_agent")).toBe(true) // explicitly allowed ⇒ kept
    expect(out.registry.has("team_create")).toBe(false) // not allowed ⇒ blocked
  })
})
