import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { createSubagentRunner } from "../../src/agent/subagent-runner"
import type { AgentConfig, AgentOutcome } from "../../src/agent/types"
import type { Message } from "../../src/llm"
import type { isGitRepo, withWorktree } from "../../src/runtime/worktree"
import type { runAgent } from "../../src/agent/loop"
import { ToolRegistry } from "../../src/tool"
import type { Tool, ToolContext, ToolEvent } from "../../src/tool"
import type { SubagentRequest } from "../../src/subagent/types"

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
    expect(r).toEqual({ ok: false, finalText: "max subagent depth exceeded", turns: 0 })
    expect(seen.length).toBe(0) // loop never forked
  })

  test("default maxDepth is 3", async () => {
    const { run } = capturing()
    const runner = createSubagentRunner(parentConfig(), { run })
    expect((await runner(req({ depth: 4 }))).ok).toBe(false)
    expect((await runner(req({ depth: 3 }))).ok).toBe(true)
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
    const msgs = seen[0]!.messages as Message[]
    expect(msgs).toEqual([{ role: "user", content: [{ type: "text", text: "investigate X" }] }])
  })

  test("toolFilter produces a filtered registry; absent ⇒ inherits parent", async () => {
    const { run, seen } = capturing()
    const parent = parentConfig()
    const runner = createSubagentRunner(parent, { run })

    await runner(req({ toolFilter: ["read", "missing"] }))
    expect(seen[0]!.registry.specs().map((s) => s.name).sort()).toEqual(["read"])

    await runner(req())
    // No filter ⇒ the parent's own registry instance is inherited as-is.
    expect(seen[1]!.registry).toBe(parent.registry)
    expect(seen[1]!.registry.specs().map((s) => s.name).sort()).toEqual([
      "bash",
      "read",
      "write",
    ])
  })

  test("empty toolFilter ⇒ empty child registry (no throw)", async () => {
    const { run, seen } = capturing()
    const runner = createSubagentRunner(parentConfig(), { run })
    await runner(req({ toolFilter: [] }))
    expect(seen[0]!.registry.specs()).toEqual([])
  })

  test("maxTurns = budget.maxTurns ?? parent.maxTurns", async () => {
    const { run, seen } = capturing()
    const runner = createSubagentRunner(parentConfig({ maxTurns: 17 }), { run })
    await runner(req({ budget: { maxTurns: 5 } }))
    expect(seen[0]!.maxTurns).toBe(5)
    await runner(req())
    expect(seen[1]!.maxTurns).toBe(17)
  })

  test("store / hooks / metrics / run / sessionId / memory are dropped", async () => {
    const { run, seen } = capturing()
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
    })
    const runner = createSubagentRunner(parent, { run })
    await runner(req())
    const child = seen[0]!
    expect(child.store).toBeUndefined()
    expect(child.hooks).toBeUndefined()
    expect(child.metrics).toBeUndefined()
    expect(child.run).toBeUndefined()
    expect(child.sessionId).toBeUndefined()
    expect(child.memory).toBeUndefined()
    // Kept ports survive.
    expect(child.llm).toBe(parent.llm)
    expect(child.stream).toBe(parent.stream)
    expect(child.permission).toBe(parent.permission)
    expect(child.system).toBe(parent.system)
  })

  test("surfaces req.depth on the child config (the dispatch depth seam)", async () => {
    const { run, seen } = capturing()
    const runner = createSubagentRunner(parentConfig(), { run })
    await runner(req({ depth: 2 }))
    expect((seen[0] as unknown as { depth?: number }).depth).toBe(2)
  })
})

describe("createSubagentRunner — abort propagation", () => {
  test("aborting the parent aborts the child signal", async () => {
    const ac = new AbortController()
    const { run, seen } = capturing()
    const runner = createSubagentRunner(parentConfig({ signal: ac.signal }), { run })
    await runner(req())
    const childSignal = seen[0]!.signal
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
    expect(seen[0]!.signal.aborted).toBe(true)
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
    const withWorktreeFake: typeof withWorktree = async (id, repoRoot, fn) => {
      expect(repoRoot).toBe("/repo")
      const value = await fn("/repo/.claude/worktrees/agent-x")
      return { value, info: { worktreePath: "/repo/.claude/worktrees/agent-x", branch: "b", removed: true } }
    }
    const runner = createSubagentRunner(parentConfig(), {
      run,
      isGitRepo: isGitRepoFake,
      withWorktree: withWorktreeFake,
    })
    const r = await runner(req({ isolation: "worktree" }))
    expect(r.ok).toBe(true)
    expect(seen[0]!.cwd).toBe("/repo/.claude/worktrees/agent-x")
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
    expect(seen[0]!.cwd).toBe("/plain")
  })

  test("isolation:none ⇒ uses req.cwd when provided, else parent cwd", async () => {
    const { run, seen } = capturing()
    const runner = createSubagentRunner(parentConfig({ cwd: "/repo" }), { run })
    await runner(req({ isolation: "none", cwd: "/custom" }))
    expect(seen[0]!.cwd).toBe("/custom")
    await runner(req({ isolation: "none" }))
    expect(seen[1]!.cwd).toBe("/repo")
  })
})
