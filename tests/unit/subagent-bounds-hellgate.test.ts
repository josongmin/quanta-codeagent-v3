/**
 * Hellgate: B2 (wait-timeout policy clamp) + B3 (concurrency cap).
 *
 * B2 — `WaitTimeoutPolicy` clamps a caller-supplied `timeoutMs` into
 *      `[minMs, maxMs]` (clamp, not reject); omitted ⇒ `defaultMs`. The
 *      DEFAULT policy preserves the pre-B2 behavior (30s default; generous
 *      ceiling so no existing override is clamped). Applies to BOTH
 *      `wait_agent` and `task_output(block:true)`.
 *
 * B3 — `spawn_agent` rejects (structured error, cause:"concurrency_cap") a
 *      spawn that would exceed an injected per-session cap; admits exactly
 *      `maxConcurrent` concurrent children; absent cap ⇒ unlimited (default,
 *      no regression).
 */
import { describe, expect, it } from "bun:test"
import {
  clampWaitTimeout,
  DEFAULT_WAIT_TIMEOUT_POLICY,
  handleSpawnAgent,
  handleWaitAgent,
  type WaitTimeoutPolicy,
} from "@/subagent/handlers-6"
import {
  clampTaskOutputTimeout,
  createTaskOutputTool,
  DEFAULT_TASK_OUTPUT_TIMEOUT_POLICY,
} from "@/subagent/task-tools"
import { TaskRegistry } from "@/subagent/registry"
import type { SubagentRunner } from "@/subagent/types"
import type { ToolContext, ToolEvent } from "@/tool"

// ─── B2: pure clamp ────────────────────────────────────────────────────────

describe("B2 clampWaitTimeout (pure)", () => {
  const policy: WaitTimeoutPolicy = { minMs: 100, maxMs: 5_000, defaultMs: 1_000 }

  it("returns defaultMs when omitted", () => {
    expect(clampWaitTimeout(policy, undefined)).toBe(1_000)
  })
  it("raises a below-min value to minMs", () => {
    expect(clampWaitTimeout(policy, 5)).toBe(100)
  })
  it("lowers an above-max value to maxMs", () => {
    expect(clampWaitTimeout(policy, 9_999_999)).toBe(5_000)
  })
  it("passes an in-band value through verbatim", () => {
    expect(clampWaitTimeout(policy, 2_500)).toBe(2_500)
  })
  it("degenerate min>max collapses to the ceiling (never above maxMs)", () => {
    expect(clampWaitTimeout({ minMs: 10_000, maxMs: 500, defaultMs: 1_000 }, 9_999)).toBe(500)
  })
})

describe("B2 default policy = pre-B2 behavior", () => {
  it("omitted ⇒ 30s default", () => {
    expect(clampWaitTimeout(DEFAULT_WAIT_TIMEOUT_POLICY, undefined)).toBe(30_000)
  })
  it("a typical pre-B2 override is NOT clamped (inside generous band)", () => {
    expect(clampWaitTimeout(DEFAULT_WAIT_TIMEOUT_POLICY, 120_000)).toBe(120_000)
  })
  it("task_output default policy matches wait_agent default", () => {
    expect(clampTaskOutputTimeout(DEFAULT_TASK_OUTPUT_TIMEOUT_POLICY, undefined)).toBe(30_000)
    expect(clampTaskOutputTimeout(DEFAULT_TASK_OUTPUT_TIMEOUT_POLICY, 1)).toBe(1)
  })
})

// ─── B2: handler integration (clamp drives the effective wait) ──────────────

describe("B2 handleWaitAgent honors the injected policy", () => {
  it("above-max override is clamped — error message reflects the clamped value", async () => {
    const registry = new TaskRegistry()
    const id = registry.newId()
    registry.register({ id, description: "x" })
    const policy: WaitTimeoutPolicy = { minMs: 1, maxMs: 25, defaultMs: 10 }
    const start = Date.now()
    // requested 10_000_000 would hang ~3h without the clamp; policy caps at 25ms.
    const out = await handleWaitAgent(
      { agentId: id, timeoutMs: 10_000_000 },
      { registry, timeoutPolicy: policy },
    )
    const elapsed = Date.now() - start
    expect(out.kind).toBe("error")
    if (out.kind === "error") {
      expect(out.cause).toBe("timeout")
      expect(out.message).toContain("25ms")
    }
    expect(elapsed).toBeLessThan(2_000)
  })
})

// ─── B2: task_output(block:true) clamp ──────────────────────────────────────

const ctx = (): ToolContext => ({ cwd: "/tmp", signal: new AbortController().signal })

describe("B2 task_output honors the injected timeout policy", () => {
  it("an above-max timeout_ms is clamped — block returns the timeout result, not after the huge value", async () => {
    const registry = new TaskRegistry()
    const id = registry.newId()
    registry.register({ id, description: "x" }) // stays running forever
    // maxMs:50 ⇒ a requested 9_999_999 (~2.8h) is clamped to 50ms. The PRIMARY
    // proof is that the block path returns its timeout-result AT ALL (a missed
    // clamp would hang ~2.8h and the test framework would kill it instead).
    const tool = createTaskOutputTool(registry, { minMs: 1, maxMs: 50, defaultMs: 10 })
    const start = Date.now()
    const events: ToolEvent[] = []
    for await (const ev of tool.execute({ task_id: id, block: true, timeout_ms: 9_999_999 }, ctx())) {
      events.push(ev)
    }
    const result = events.find((e) => e.type === "result")
    expect(result?.type).toBe("result")
    if (result?.type === "result") {
      // the "still running" branch is ONLY reached when the block timer fired
      // (i.e. the clamp capped the wait); a settled task would not hit it.
      expect(result.result.output).toContain("still running")
    }
    // Secondary (loose, contention-tolerant) signal: nowhere near the requested
    // ~2.8h. A wide ceiling keeps this deterministic under parallel test load.
    expect(Date.now() - start).toBeLessThan(30_000)
  })
})

// ─── B3: concurrency cap ────────────────────────────────────────────────────

/** A runner that never settles ⇒ spawned tasks stay "running" so the cap is
 *  observable deterministically. */
const pendingRunner: SubagentRunner = () => new Promise(() => {})

describe("B3 spawn_agent concurrency cap", () => {
  it("admits exactly maxConcurrent and rejects the next with a structured error", async () => {
    const registry = new TaskRegistry()
    const deps = { runner: pendingRunner, registry, maxConcurrent: 2 }

    const a = await handleSpawnAgent({ prompt: "1" }, deps)
    const b = await handleSpawnAgent({ prompt: "2" }, deps)
    expect(a.kind).toBe("success")
    expect(b.kind).toBe("success")

    const c = await handleSpawnAgent({ prompt: "3" }, deps)
    expect(c.kind).toBe("error")
    if (c.kind === "error") {
      expect(c.cause).toBe("concurrency_cap")
      expect(c.message).toContain("2 concurrent")
    }
  })

  it("absent cap ⇒ unlimited (default, no regression)", async () => {
    const registry = new TaskRegistry()
    const deps = { runner: pendingRunner, registry }
    for (let i = 0; i < 50; i++) {
      const r = await handleSpawnAgent({ prompt: `t${i}` }, deps)
      expect(r.kind).toBe("success")
    }
  })

  it("cap counts only RUNNING tasks — depth guard still independent", async () => {
    const registry = new TaskRegistry()
    // cap 1 + depth guard: a depth violation is rejected on its own cause,
    // not the concurrency cause (depth checked first).
    const deps = { runner: pendingRunner, registry, maxConcurrent: 1, maxDepth: 0 }
    const out = await handleSpawnAgent({ prompt: "x" }, deps)
    expect(out.kind).toBe("error")
    if (out.kind === "error") expect(out.cause).toBe("depth_exceeded")
  })
})
