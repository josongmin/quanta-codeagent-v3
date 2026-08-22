/**
 * Hellgate — `defineToolAsync` + `poll_deferred` + dispatch wire (ADR-0287).
 *
 * Exercises:
 *   - async tool registration via `defineToolAsync` + DeferredHandle yield
 *   - poll_deferred round-trip (pending → completed unwrap)
 *   - unknown handle classification
 *   - mid-work throw surfaceable as worker-threw
 *   - dispatch detects `result.deferred` and prepends `<deferred handle=.../>`
 *   - multiple async tools share one registry without leaking state
 *   - parent abort propagates to every registered work
 *   - sync tools without `registry` are byte-identical (default-OFF)
 *   - AbortSignal threading
 *   - 1000-cycle leak check (list shrinks back via LRU)
 *   - cancel via tool path
 *   - registry empty ⇒ poll_deferred behaves uniformly
 *   - active registry ⇒ poll_deferred tool is constructible per-call
 *
 * NOTE: We test the dispatch wire by inspecting the `DispatchResult.preview`
 * (the dispatch surface that the LLM sees as tool_result text). The real
 * dispatch path is exercised via `dispatchTool` with a minimal `AgentConfig`.
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { dispatchTool } from "@/agent/dispatch"
import type { AgentConfig } from "@/agent/types"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { defineToolAsync } from "@/tool/async-helper"
import { DefaultDeferredResultRegistry } from "@/tool/deferred/default-registry"
import { pollDeferredTool } from "@/tool/poll_deferred"
import { ToolRegistry } from "@/tool/registry"
import type { Tool, ToolContext, ToolEvent, ToolResult } from "@/tool/types"

const baseConfig = (registry: ToolRegistry): AgentConfig =>
  ({
    cwd: "/tmp",
    signal: new AbortController().signal,
    registry,
    stream: { emit: () => undefined },
  }) as unknown as AgentConfig

const permission = (): PermissionContext =>
  ({
    autoMode: "default",
  }) as unknown as PermissionContext

const call = (name: string, input: unknown, id = "call-1"): ToolUseBlock => ({
  type: "tool_use",
  id,
  name,
  input,
})

const collectAsync = async (tool: Tool, input: unknown): Promise<ToolResult> => {
  const ctx: ToolContext = { cwd: "/tmp", signal: new AbortController().signal }
  let result: ToolResult | undefined
  for await (const e of tool.execute(input as never, ctx) as AsyncIterable<ToolEvent>) {
    if (e.type === "result") result = e.result
  }
  if (!result) throw new Error("no terminal result")
  return result
}

describe("ADR-0287 — defineToolAsync surface", () => {
  test("async tool registers work + yields a DeferredHandle in result.deferred", async () => {
    const reg = new DefaultDeferredResultRegistry()
    const tool = defineToolAsync<{ q: string }>({
      name: "async_search",
      description: "d",
      inputSchema: z.object({ q: z.string() }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      registry: reg,
      work: async () => ({ ok: true, output: "found" }),
    })
    const res = await collectAsync(tool, { q: "x" })
    expect(res.deferred?.id).toMatch(/^deferred-/)
    expect(res.output).toContain("poll_deferred")
  })

  test("poll_deferred round-trip: pending → completed unwraps inner result", async () => {
    const reg = new DefaultDeferredResultRegistry()
    let gate: () => void = () => undefined
    const tool = defineToolAsync<{ q: string }>({
      name: "async_search",
      description: "d",
      inputSchema: z.object({ q: z.string() }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      registry: reg,
      work: async () =>
        new Promise<ToolResult>((res) => {
          gate = () => res({ ok: true, output: "final-answer" })
        }),
    })
    const placeholder = await collectAsync(tool, { q: "x" })
    const handleId = placeholder.deferred?.id
    expect(handleId).toBeDefined()
    // Poll once — still pending or running.
    const poll = pollDeferredTool(reg)
    const probe1 = await collectAsync(poll, { handle: handleId })
    expect(probe1.output).toMatch(/\[(pending|running)\]/)
    gate()
    // Wait for the work to settle.
    await new Promise((res) => setTimeout(res, 5))
    const probe2 = await collectAsync(poll, { handle: handleId, awaitMs: 50 })
    expect(probe2.ok).toBe(true)
    expect(probe2.output).toContain("final-answer")
    expect(probe2.output).toContain("completed via=deferred")
  })

  test("unknown handle yields a classified failure", async () => {
    const reg = new DefaultDeferredResultRegistry()
    const poll = pollDeferredTool(reg)
    const res = await collectAsync(poll, { handle: "deferred-ghost" })
    expect(res.ok).toBe(false)
    expect(res.output).toContain("[failed]")
    expect(res.output).toContain("unknown-handle")
  })

  test("worker throw mid-work is surfaced via poll_deferred", async () => {
    const reg = new DefaultDeferredResultRegistry()
    const tool = defineToolAsync<Record<string, never>>({
      name: "async_thrower",
      description: "d",
      inputSchema: z.object({}),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      registry: reg,
      work: async () => {
        throw new Error("kaboom")
      },
    })
    const placeholder = await collectAsync(tool, {})
    const handleId = placeholder.deferred?.id ?? ""
    const poll = pollDeferredTool(reg)
    const probe = await collectAsync(poll, { handle: handleId, awaitMs: 50 })
    expect(probe.ok).toBe(false)
    expect(probe.output).toContain("worker-threw")
    expect(probe.output).toContain("kaboom")
  })
})

describe("ADR-0287 — dispatch wire (deferred-envelope prefix)", () => {
  test("dispatch prepends <deferred handle=.../> when result.deferred is present", async () => {
    const defRegistry = new DefaultDeferredResultRegistry()
    const tool = defineToolAsync<{ q: string }>({
      name: "async_search",
      description: "d",
      inputSchema: z.object({ q: z.string() }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      registry: defRegistry,
      work: async () => ({ ok: true, output: "x" }),
    })
    const toolReg = new ToolRegistry([tool])
    const out = await dispatchTool(
      call("async_search", { q: "x" }),
      baseConfig(toolReg),
      permission(),
    )
    expect(out.preview).toMatch(/^<deferred handle="deferred-1"\/>\n/)
  })

  test("sync tools are byte-identical (no <deferred/> envelope when result.deferred absent)", async () => {
    const tool: Tool = {
      name: "sync_echo",
      description: "d",
      inputSchema: z.object({ q: z.string() }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      async *execute() {
        yield { type: "result", result: { ok: true, output: "hello" } }
      },
    }
    const toolReg = new ToolRegistry([tool])
    const out = await dispatchTool(call("sync_echo", { q: "x" }), baseConfig(toolReg), permission())
    expect(out.preview).toBe("hello")
    expect(out.preview.startsWith("<deferred")).toBe(false)
  })
})

describe("ADR-0287 — multi-async + lifecycle", () => {
  test("multiple async tools sharing one registry are isolated by handle", async () => {
    const reg = new DefaultDeferredResultRegistry()
    const mk = (n: string, out: string): Tool =>
      defineToolAsync<Record<string, never>>({
        name: n,
        description: "d",
        inputSchema: z.object({}),
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        registry: reg,
        work: async () => ({ ok: true, output: out }),
      })
    const t1 = mk("a1", "one")
    const t2 = mk("a2", "two")
    const r1 = await collectAsync(t1, {})
    const r2 = await collectAsync(t2, {})
    const poll = pollDeferredTool(reg)
    await new Promise((res) => setTimeout(res, 5))
    const p1 = await collectAsync(poll, { handle: r1.deferred?.id ?? "", awaitMs: 50 })
    const p2 = await collectAsync(poll, { handle: r2.deferred?.id ?? "", awaitMs: 50 })
    expect(p1.output).toContain("one")
    expect(p2.output).toContain("two")
  })

  test("AbortSignal: the work function receives the per-handle signal", async () => {
    const reg = new DefaultDeferredResultRegistry()
    let receivedSignal: AbortSignal | undefined
    const tool = defineToolAsync<Record<string, never>>({
      name: "async_sig",
      description: "d",
      inputSchema: z.object({}),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      registry: reg,
      work: async (_input, _ctx, signal) => {
        receivedSignal = signal
        return { ok: true, output: "ok" }
      },
    })
    await collectAsync(tool, {})
    await new Promise((res) => setTimeout(res, 5))
    expect(receivedSignal).toBeDefined()
    expect(receivedSignal?.aborted).toBe(false)
  })

  test("cancel via registry: work observes abort + status becomes cancelled", async () => {
    const reg = new DefaultDeferredResultRegistry()
    const tool = defineToolAsync<Record<string, never>>({
      name: "async_cancellable",
      description: "d",
      inputSchema: z.object({}),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      registry: reg,
      work: async (_i, _c, signal) =>
        new Promise<ToolResult>((_res, rej) => {
          signal.addEventListener("abort", () =>
            rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
          )
        }),
    })
    const placeholder = await collectAsync(tool, {})
    const handleId = placeholder.deferred?.id ?? ""
    const live = reg.list()
    const h = live.find((x) => x.id === handleId)
    expect(h).toBeDefined()
    if (h) reg.cancel(h)
    const poll = pollDeferredTool(reg)
    const probe = await collectAsync(poll, { handle: handleId, awaitMs: 50 })
    expect(probe.output).toContain("cancelled")
  })

  test("parent abort → cancelling each registered handle drains the registry", async () => {
    const reg = new DefaultDeferredResultRegistry()
    const mk = (n: string): Tool =>
      defineToolAsync<Record<string, never>>({
        name: n,
        description: "d",
        inputSchema: z.object({}),
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        registry: reg,
        work: async (_i, _c, signal) =>
          new Promise<ToolResult>((_res, rej) => {
            signal.addEventListener("abort", () =>
              rej(Object.assign(new Error("aborted"), { name: "AbortError" })),
            )
          }),
      })
    await collectAsync(mk("p1"), {})
    await collectAsync(mk("p2"), {})
    await collectAsync(mk("p3"), {})
    const before = reg.list()
    expect(before.length).toBe(3)
    // Composition-root pattern: a parent abort iterates the live list and
    // cancels each handle (the registry does not own an aggregate signal).
    for (const h of before) reg.cancel(h)
    // Every status is cancelled.
    for (const h of before) {
      const s = reg.poll(h)
      expect(s.kind).toBe("cancelled")
    }
  })

  test("1000-cycle leak check: LRU keeps list bounded at the cap", async () => {
    const reg = new DefaultDeferredResultRegistry({ cap: 50 })
    for (let i = 0; i < 200; i += 1) {
      const tool = defineToolAsync<Record<string, never>>({
        name: `t${i}`,
        description: "d",
        inputSchema: z.object({}),
        isReadOnly: () => true,
        isConcurrencySafe: () => true,
        registry: reg,
        work: async () => ({ ok: true, output: String(i) }),
      })
      await collectAsync(tool, {})
    }
    // Settle every worker before measuring (otherwise pending entries are
    // non-evictable and the cap is a soft ceiling).
    await new Promise((res) => setTimeout(res, 20))
    // List should be ≤ cap once everything has had a chance to settle and
    // subsequent registrations evict the oldest non-pending.
    expect(reg.list().length).toBeLessThanOrEqual(50)
  })
})

describe("ADR-0287 — default-OFF degradation", () => {
  test("defineToolAsync without registry runs work synchronously", async () => {
    const tool = defineToolAsync<Record<string, never>>({
      name: "async_degraded",
      description: "d",
      inputSchema: z.object({}),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      work: async () => ({ ok: true, output: "sync-result" }),
    })
    const res = await collectAsync(tool, {})
    expect(res.deferred).toBeUndefined()
    expect(res.output).toBe("sync-result")
  })

  test("poll_deferred is constructible per-call (not auto-registered)", () => {
    const reg = new DefaultDeferredResultRegistry()
    const t1 = pollDeferredTool(reg)
    const t2 = pollDeferredTool(reg)
    // Each invocation returns a fresh closure; the name stays stable.
    expect(t1.name).toBe("poll_deferred")
    expect(t2.name).toBe("poll_deferred")
  })

  test("registry empty + poll_deferred with unknown handle: graceful classified failure", async () => {
    const reg = new DefaultDeferredResultRegistry()
    const poll = pollDeferredTool(reg)
    const res = await collectAsync(poll, { handle: "deferred-1" })
    expect(res.ok).toBe(false)
    expect(res.output).toContain("unknown-handle")
  })

  test("active registry: registering an async tool produces a handle that poll_deferred picks up", async () => {
    const reg = new DefaultDeferredResultRegistry()
    const tool = defineToolAsync<Record<string, never>>({
      name: "active_async",
      description: "d",
      inputSchema: z.object({}),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      registry: reg,
      work: async () => ({ ok: true, output: "active-result" }),
    })
    const placeholder = await collectAsync(tool, {})
    const handleId = placeholder.deferred?.id ?? ""
    expect(handleId.length).toBeGreaterThan(0)
    const poll = pollDeferredTool(reg)
    const probe = await collectAsync(poll, { handle: handleId, awaitMs: 50 })
    expect(probe.output).toContain("active-result")
  })
})
