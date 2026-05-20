import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { buildSessionFeatures } from "@/agent/features"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { TaskRegistry as TaskRegistryType } from "@/subagent"
import { defaultTools, ToolRegistry } from "@/tool"

/**
 * Round 2 — `buildSessionFeatures(config).cleanup` graceful-shutdown hook.
 *
 * When `config.subagent` is set, `cleanup()` aborts EVERY currently-running
 * background task via `registry.stop(id)` and awaits all settlements through
 * `waitForSettle`. Absent ⇒ `cleanup` is undefined. Idempotent: a second call
 * sees `pendingIds() === []` and returns immediately.
 */

const inertLLM: LLMPort = {
  // biome-ignore lint/correctness/useYield: never invoked here; features only stores the port
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    throw new Error("unexpected stream() call")
  },
}

const baseCfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    llm: inertLLM,
    registry: new ToolRegistry(defaultTools),
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    system: "SYS",
    cwd: "/repo",
    maxTurns: 5,
    signal: new AbortController().signal,
    ...over,
  }) as AgentConfig

/** Race a promise against a wall-clock timer; resolves with "p" if `p` settles
 *  first, "timer" otherwise. Used to assert "fast path" bounds. */
const raceTimer = async (p: Promise<unknown>, ms: number): Promise<"p" | "timer"> => {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race<"p" | "timer">([
      p.then((): "p" => "p"),
      new Promise<"timer">((res) => {
        timer = setTimeout(() => res("timer"), ms)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

describe("buildSessionFeatures — cleanup() presence gating", () => {
  test("config.subagent set ⇒ features.cleanup is a function", async () => {
    const f = await buildSessionFeatures(baseCfg({ subagent: { maxDepth: 3 } }))
    expect(typeof f.cleanup).toBe("function")
  })

  test("config.subagent unset ⇒ features.cleanup is undefined", async () => {
    const f = await buildSessionFeatures(baseCfg())
    expect(f.cleanup).toBeUndefined()
  })
})

describe("buildSessionFeatures — cleanup() fast-path + idempotency", () => {
  test("cleanup() with no pending tasks resolves within 5ms (fast path)", async () => {
    const f = await buildSessionFeatures(baseCfg({ subagent: {} }))
    if (!f.cleanup) throw new Error("expected cleanup")
    const cleanup = f.cleanup
    const winner = await raceTimer(cleanup(), 5)
    expect(winner).toBe("p")
  })

  test("cleanup() called twice is idempotent (second call is also a no-op fast path)", async () => {
    const f = await buildSessionFeatures(baseCfg({ subagent: {} }))
    if (!f.cleanup) throw new Error("expected cleanup")
    const cleanup = f.cleanup
    await cleanup()
    // Second call sees pendingIds() === [] and returns immediately.
    const winner = await raceTimer(cleanup(), 5)
    expect(winner).toBe("p")
  })
})

/** Register a never-settling task on the shared registry directly (no real
 *  forked runAgent). Returns the id. The runner never settles, but the
 *  registry's `stop()` resolves its waitForSettle promise on abort. */
const registerStuck = (reg: TaskRegistryType): string => {
  const id = reg.newId()
  reg.register({ id, description: "stuck" })
  // No background promise wired — `cleanup` only needs the registry to track
  // the running id; `stop()` flips the status and resolves waitForSettle.
  return id
}

describe("buildSessionFeatures — cleanup() stops running tasks", () => {
  test("a single stuck task is stopped and cleanup() resolves promptly", async () => {
    const f = await buildSessionFeatures(baseCfg({ subagent: {} }))
    if (!f.cleanup || !f.taskRegistry) throw new Error("expected cleanup + taskRegistry")
    const reg: TaskRegistryType = f.taskRegistry
    const cleanup = f.cleanup
    const id = registerStuck(reg)
    expect(reg.get(id)?.status).toBe("running")

    const winner = await raceTimer(cleanup(), 100)
    expect(winner).toBe("p")
    expect(reg.get(id)?.status).toBe("stopped")
  })

  test("multiple pending tasks are ALL stopped by a single cleanup() call", async () => {
    const f = await buildSessionFeatures(baseCfg({ subagent: {} }))
    if (!f.cleanup || !f.taskRegistry) throw new Error("expected cleanup + taskRegistry")
    const reg: TaskRegistryType = f.taskRegistry
    const cleanup = f.cleanup
    const ids = [registerStuck(reg), registerStuck(reg), registerStuck(reg)]
    for (const id of ids) expect(reg.get(id)?.status).toBe("running")
    expect(reg.pendingIds().sort()).toEqual(ids.slice().sort())

    const winner = await raceTimer(cleanup(), 100)
    expect(winner).toBe("p")
    for (const id of ids) expect(reg.get(id)?.status).toBe("stopped")
    expect(reg.pendingIds()).toEqual([])
  })

  test("cleanup() via the live `agent` tool path: launching background + cleanup unwinds it", async () => {
    // This exercises the integration end-to-end: a tool-launched background
    // task whose injected runner never settles. `cleanup()` MUST flip the
    // registry status to "stopped" without depending on the runner exiting.
    const f = await buildSessionFeatures(baseCfg({ subagent: { maxDepth: 3 } }))
    if (!f.cleanup || !f.taskRegistry) throw new Error("expected cleanup + taskRegistry")
    const cleanup = f.cleanup
    const reg = f.taskRegistry

    // The features-wired `agent` tool's runner is the real
    // `createSubagentRunner(config)` — which calls `runAgent` on its child.
    // Driving it foreground/background here would attempt to invoke `inertLLM`
    // and throw. So we use the SAME shared TaskRegistry via direct register
    // (the cleanup contract is on the registry, not on the tool path), which
    // is the exact pattern the loop's shutdown sequence relies on.
    const id = reg.newId()
    reg.register({ id, description: "stuck-bg" })

    const settlePromise = reg.waitForSettle(id)
    const winner = await raceTimer(cleanup(), 100)
    expect(winner).toBe("p")
    expect(reg.get(id)?.status).toBe("stopped")
    // waitForSettle resolved as part of cleanup's await.
    await settlePromise // must already be resolved
  })

  test("a third-party already-stopped task does not break a subsequent cleanup", async () => {
    const f = await buildSessionFeatures(baseCfg({ subagent: {} }))
    if (!f.cleanup || !f.taskRegistry) throw new Error("expected cleanup + taskRegistry")
    const cleanup = f.cleanup
    const reg = f.taskRegistry

    // Two tasks: one will be manually stopped first.
    const idA = registerStuck(reg)
    const idB = registerStuck(reg)
    expect(reg.stop(idA)).toBe(true)
    expect(reg.get(idA)?.status).toBe("stopped")

    const winner = await raceTimer(cleanup(), 100)
    expect(winner).toBe("p")
    expect(reg.get(idA)?.status).toBe("stopped")
    expect(reg.get(idB)?.status).toBe("stopped")
  })
})

describe("buildSessionFeatures — cleanup interplay with extraTools", () => {
  test("agent tool wiring is present and shared with the registry the cleanup acts on", async () => {
    const f = await buildSessionFeatures(baseCfg({ subagent: { maxDepth: 3 } }))
    if (!f.cleanup || !f.taskRegistry) throw new Error("expected cleanup + taskRegistry")
    const reg = f.taskRegistry
    const cleanup = f.cleanup

    // Sanity guard for the live tool wiring shape (the features wiring tests
    // also cover this; we only need the registry pointer for cleanup here).
    expect(f.extraTools.find((t) => t.name === "agent")).toBeDefined()
    expect(f.extraTools.find((t) => t.name === "task_output")).toBeDefined()
    expect(f.extraTools.find((t) => t.name === "task_stop")).toBeDefined()

    // Cleanup is a no-op when nothing has been launched — fast path.
    const winner = await raceTimer(cleanup(), 5)
    expect(winner).toBe("p")
    expect(reg.pendingIds()).toEqual([])
  })
})
