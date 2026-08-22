/**
 * Phase 0-a hellgate (jul-13 sub-agent nesting-control RFC §6.5 / §7):
 * BACKGROUND child depth propagation + revived `req.depth > maxDepth` reject.
 *
 * PRE-EXISTING CORRECTNESS BUG (measure-first exception — red-on-injection is
 * sufficient): `specToRequest` previously hardcoded `depth: 0`, claiming a
 * "host bridge does depth+1 upstream". That bridge does NOT exist — the bg
 * engine passes the `req` straight to the runner — so every background child
 * ran at real depth 0 and the runner's `req.depth > maxDepth` reject was
 * NEVER reachable (unbounded background recursion the instant the scheduler
 * is wired).
 *
 * FIX: `specToRequest(spec, signal, parentDepth)` → `depth: parentDepth + 1`,
 * mirroring the foreground `buildChildConfig` convention (child depth =
 * parentDepth + 1). The host threads `parentDepth = config.depth ?? 0` at
 * scheduler construction (the scheduler is built FROM the parent's config).
 *
 * A. depth propagation (specToRequest unit + scheduler integration):
 *    a child forked from a parent at depth D observes `req.depth === D + 1`.
 *    Mutation (revert to `depth: 0`) → RED.
 * B. revived reject (P0-c integration): with depth now propagated, a child
 *    forked at `parentDepth` s.t. `parentDepth + 1 > maxDepth` REACHES the
 *    real `createSubagentRunner` `req.depth > maxDepth` deny — the loop is
 *    never forked. This proves the previously-dead guard is revived.
 */

import { describe, expect, test } from "bun:test"
import type { runAgent } from "@/agent/loop"
import { defaultBackgroundSubagentScheduler, specToRequest } from "@/agent/subagent-background"
import { createSubagentRunner } from "@/agent/subagent-runner"
import type { AgentConfig, AgentOutcome } from "@/agent/types"
import type { SubagentResult as SliceResult, SubagentRequest, SubagentRunner } from "@/subagent"

/** A runner that records the request it observed and completes on demand. */
const capturingRunner = (): {
  runner: SubagentRunner
  resolve: (out: SliceResult) => void
  captured: { req: SubagentRequest | null }
} => {
  let resolveFn: ((out: SliceResult) => void) | null = null
  const captured: { req: SubagentRequest | null } = { req: null }
  const runner: SubagentRunner = (req) => {
    captured.req = req
    return new Promise<SliceResult>((res) => {
      resolveFn = res
    })
  }
  return {
    runner,
    resolve: (out) => resolveFn?.(out),
    captured,
  }
}

/** Drain microtasks so the synchronously-started run captures its request. */
const yieldMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

// ─────────────────────────────────────────────────────────────
// A. specToRequest — pure depth propagation
// ─────────────────────────────────────────────────────────────

describe("Phase 0-a — specToRequest depth propagation", () => {
  const sig = new AbortController().signal

  test("HELL-A1: root parent (depth 0) → child req.depth === 1", () => {
    const r = specToRequest({ task: "t" }, sig, 0)
    expect(r.depth).toBe(1)
  })

  test("HELL-A2: parent depth D → child req.depth === D + 1 (truth table)", () => {
    for (const d of [0, 1, 2, 3, 7]) {
      expect(specToRequest({ task: "t" }, sig, d).depth).toBe(d + 1)
    }
  })

  test("HELL-A3: child depth is NEVER a hardcoded 0 (mutation sentinel)", () => {
    // Reverting `depth: parentDepth + 1` back to `depth: 0` makes every one of
    // these fail — the mutation is caught for any non-negative parent depth.
    expect(specToRequest({ task: "t" }, sig, 0).depth).not.toBe(0)
    expect(specToRequest({ task: "t" }, sig, 2).depth).toBe(3)
  })
})

// ─────────────────────────────────────────────────────────────
// B. scheduler integration — the forked child observes parentDepth + 1
// ─────────────────────────────────────────────────────────────

describe("Phase 0-a — background scheduler threads parentDepth", () => {
  test("HELL-B1: scheduler built with parentDepth=0 forks child at req.depth 1", async () => {
    const { runner, captured, resolve } = capturingRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner, parentDepth: 0 })
    sched.fork({ task: "investigate" })
    await yieldMicrotasks()
    expect(captured.req).not.toBeNull()
    expect(captured.req?.depth).toBe(1)
    resolve({ ok: true, finalText: "done", turns: 1 })
  })

  test("HELL-B2: scheduler built with parentDepth=2 forks child at req.depth 3", async () => {
    const { runner, captured, resolve } = capturingRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner, parentDepth: 2 })
    sched.fork({ task: "investigate" })
    await yieldMicrotasks()
    expect(captured.req?.depth).toBe(3)
    resolve({ ok: true, finalText: "done", turns: 1 })
  })

  test("HELL-B3: absent parentDepth defaults to root (child req.depth 1)", async () => {
    // OFF byte-identical: a root/single-level spawn with no parentDepth given
    // still yields a child at depth 1 (was depth 0 before the fix — the bug).
    const { runner, captured, resolve } = capturingRunner()
    const sched = defaultBackgroundSubagentScheduler({ runner })
    sched.fork({ task: "x" })
    await yieldMicrotasks()
    expect(captured.req?.depth).toBe(1)
    resolve({ ok: true, finalText: "done", turns: 1 })
  })
})

// ─────────────────────────────────────────────────────────────
// C. P0-c — the previously-DEAD `req.depth > maxDepth` reject is REACHED
// ─────────────────────────────────────────────────────────────

/** Minimal structurally-valid parent AgentConfig — the real loop is never
 *  invoked (the depth guard denies first, or a fake `run` is injected). */
const parentConfig = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    // biome-ignore lint/suspicious/noExplicitAny: inert port stub
    llm: { stream: async function* () {} } as any,
    stream: { emit: () => {} },
    permission: { mode: "default" },
    messages: [{ role: "user", content: [{ type: "text", text: "PARENT" }] }],
    system: "PARENT SYSTEM",
    cwd: "/repo",
    maxTurns: 5,
    signal: new AbortController().signal,
    ...over,
  }) as AgentConfig

/** Capture whether the real loop (`runAgent`) was ever forked. */
const loopSpy = (result: AgentOutcome): { run: typeof runAgent; forked: () => number } => {
  let count = 0
  const run = (async () => {
    count += 1
    return result
  }) as typeof runAgent
  return { run, forked: () => count }
}

const okOutcome = (): AgentOutcome => ({
  reason: "completed",
  turns: 1,
  messages: [{ role: "assistant", content: [{ type: "text", text: "a" }] }],
})

describe("Phase 0-c — revived req.depth > maxDepth reject via background path", () => {
  test("HELL-C1: bg child at depth > maxDepth REACHES the runner deny (loop NOT forked)", async () => {
    // maxDepth=1: a parent at depth 1 forks a child at req.depth 2 > 1 ⇒ the
    // runner's `req.depth > maxDepth` guard MUST deny. Before the fix the child
    // req.depth was a hardcoded 0 ≤ 1, so this guard was UNREACHABLE and the
    // loop would have been forked (unbounded recursion).
    const spy = loopSpy(okOutcome())
    const runner = createSubagentRunner(parentConfig({ depth: 1 }), {
      run: spy.run,
      maxDepth: 1,
    })
    const sched = defaultBackgroundSubagentScheduler({ runner, parentDepth: 1 })
    const id = sched.fork({ task: "would-recurse" })
    const snap = await sched.await(id)
    // The revived deny surfaced as a failed background result…
    expect(snap?.status).toBe("failed")
    // RFC jul-13 §6.5 B Phase 2 — reject message is now the Codex-style directive
    // with the cap interpolated (`max subagent depth (1) exceeded — …`).
    expect(snap?.errorMessage ?? snap?.outputDetail ?? "").toContain(
      "max subagent depth (1) exceeded",
    )
    // …and the real agent loop was NEVER forked (recursion actually bounded).
    expect(spy.forked()).toBe(0)
  })

  test("HELL-C2: control — bg child at depth ≤ maxDepth DOES fork the loop", async () => {
    // Paired control proving C1's deny is depth-driven, not blanket. Parent at
    // depth 0 forks a child at req.depth 1 ≤ maxDepth 1 ⇒ loop IS forked.
    const spy = loopSpy(okOutcome())
    const runner = createSubagentRunner(parentConfig({ depth: 0 }), {
      run: spy.run,
      maxDepth: 1,
    })
    const sched = defaultBackgroundSubagentScheduler({ runner, parentDepth: 0 })
    const id = sched.fork({ task: "leaf-work" })
    const snap = await sched.await(id)
    expect(snap?.status).toBe("completed")
    expect(spy.forked()).toBe(1)
  })
})
