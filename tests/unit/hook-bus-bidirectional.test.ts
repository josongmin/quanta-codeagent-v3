import { describe, expect, test } from "bun:test"
import { HookBus, PROMPT_HOOK_MAX_CHARS } from "@/agent"
import { StructuredLogger } from "@/observability"

/**
 * ADR-0133 — bidirectional Request/Response RPC. Three new lifecycle events
 * (`post_tool_use_failure`, `pre_compact`, `subagent_start`, `subagent_stop`)
 * + two new response channels (`promptHook` accumulator with 10K cap,
 * `abort` first-wins short-circuit). Backward compat: every legacy
 * `{deny, updatedInput?}` test still passes (covered by hooks.test.ts /
 * hooks-matcher.test.ts / hooks-updated-input.test.ts).
 */

describe("ADR-0133 — new event variants", () => {
  test("post_tool_use_failure fires its handlers and exposes the error", async () => {
    const bus = new HookBus()
    const seen: { name: string; error: string }[] = []
    bus.on("post_tool_use_failure", (e) => {
      seen.push({ name: e.name, error: e.error })
    })
    await bus.emit({
      type: "post_tool_use_failure",
      name: "bash",
      input: { command: "false" },
      error: "exit 1",
    })
    expect(seen).toEqual([{ name: "bash", error: "exit 1" }])
  })

  test("pre_compact handlers see messagesToCompact + isFirstCompaction", async () => {
    const bus = new HookBus()
    const seen: { count: number; first: boolean }[] = []
    bus.on("pre_compact", (e) => {
      seen.push({ count: e.messagesToCompact, first: e.isFirstCompaction })
    })
    await bus.emit({
      type: "pre_compact",
      messagesToCompact: 42,
      isFirstCompaction: true,
    })
    await bus.emit({
      type: "pre_compact",
      messagesToCompact: 30,
      isFirstCompaction: false,
    })
    expect(seen).toEqual([
      { count: 42, first: true },
      { count: 30, first: false },
    ])
  })

  test("subagent_start handlers see id/parentId/taskPrompt", async () => {
    const bus = new HookBus()
    const seen: { id: string; parent: string | undefined; prompt: string }[] = []
    bus.on("subagent_start", (e) => {
      seen.push({ id: e.subagentId, parent: e.parentId, prompt: e.taskPrompt })
    })
    await bus.emit({
      type: "subagent_start",
      subagentId: "sub-1",
      parentId: "root",
      taskPrompt: "find X",
    })
    expect(seen).toEqual([{ id: "sub-1", parent: "root", prompt: "find X" }])
  })

  test("subagent_stop handlers see the result envelope", async () => {
    const bus = new HookBus()
    const seen: { id: string; ok: boolean; finalText: string; turns: number }[] = []
    bus.on("subagent_stop", (e) => {
      seen.push({
        id: e.subagentId,
        ok: e.result.ok,
        finalText: e.result.finalText,
        turns: e.result.turns,
      })
    })
    await bus.emit({
      type: "subagent_stop",
      subagentId: "sub-1",
      result: { ok: true, finalText: "done", turns: 4 },
    })
    expect(seen).toEqual([{ id: "sub-1", ok: true, finalText: "done", turns: 4 }])
  })
})

describe("ADR-0133 — promptHook accumulator", () => {
  test("promptHook from one handler surfaces on emit result", async () => {
    const bus = new HookBus()
    bus.on("post_tool_use", () => ({
      promptHook: { injectAfterSystem: "remember: be terse" },
    }))
    const result = await bus.emit({
      type: "post_tool_use",
      name: "read",
      input: {},
      ok: true,
      output: "x",
    })
    expect(result.promptHook).toEqual({ injectAfterSystem: "remember: be terse" })
  })

  test("promptHook from multiple handlers accumulates with newline join", async () => {
    const bus = new HookBus()
    bus.on("post_tool_use", () => ({ promptHook: { injectAfterSystem: "rule A" } }))
    bus.on("post_tool_use", () => ({ promptHook: { injectAfterSystem: "rule B" } }))
    bus.on("post_tool_use", () => ({ promptHook: { injectBeforeUser: "ctx C" } }))
    const result = await bus.emit({
      type: "post_tool_use",
      name: "read",
      input: {},
      ok: true,
      output: "x",
    })
    expect(result.promptHook).toEqual({
      injectAfterSystem: "rule A\nrule B",
      injectBeforeUser: "ctx C",
    })
  })

  test("promptHook OMITTED when no handler returned one (byte-identical legacy result)", async () => {
    const bus = new HookBus()
    bus.on("post_tool_use", () => undefined)
    const result = await bus.emit({
      type: "post_tool_use",
      name: "read",
      input: {},
      ok: true,
      output: "x",
    })
    expect("promptHook" in result).toBe(false)
  })

  test("promptHook 10K cap trims FIFO and logs warning", async () => {
    const lines: string[] = []
    const logger = new StructuredLogger({ level: "warn", sink: (l) => lines.push(l) })
    const bus = new HookBus(logger)
    const huge = "X".repeat(PROMPT_HOOK_MAX_CHARS)
    bus.on("post_tool_use", () => ({ promptHook: { injectAfterSystem: huge } }))
    bus.on("post_tool_use", () => ({ promptHook: { injectAfterSystem: "tail" } }))
    const result = await bus.emit({
      type: "post_tool_use",
      name: "read",
      input: {},
      ok: true,
      output: "x",
    })
    const text = result.promptHook?.injectAfterSystem ?? ""
    // Capped at exactly PROMPT_HOOK_MAX_CHARS, tail preserved.
    expect(text.length).toBe(PROMPT_HOOK_MAX_CHARS)
    expect(text.endsWith("tail")).toBe(true)
    // Warning emitted (event name + side identifying the trimmed side).
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const warns = lines.map(
      (l) => JSON.parse(l) as { event: string; fields: { side?: string; cap?: number } },
    )
    expect(warns.some((w) => w.event === "hook.prompt_hook.trimmed")).toBe(true)
    expect(warns.some((w) => w.fields.side === "injectAfterSystem")).toBe(true)
  })

  test("promptHook works on EVERY event (turn_start / pre_compact / subagent_start / subagent_stop / post_tool_use_failure)", async () => {
    const bus = new HookBus()
    bus.on("turn_start", () => ({ promptHook: { injectBeforeUser: "ts" } }))
    bus.on("pre_compact", () => ({ promptHook: { injectAfterSystem: "pc" } }))
    bus.on("subagent_start", () => ({ promptHook: { injectAfterSystem: "ss" } }))
    bus.on("subagent_stop", () => ({ promptHook: { injectBeforeUser: "sx" } }))
    bus.on("post_tool_use_failure", () => ({
      promptHook: { injectBeforeUser: "ptf" },
    }))
    const r1 = await bus.emit({ type: "turn_start", turn: 1 })
    expect(r1.promptHook?.injectBeforeUser).toBe("ts")
    const r2 = await bus.emit({
      type: "pre_compact",
      messagesToCompact: 1,
      isFirstCompaction: true,
    })
    expect(r2.promptHook?.injectAfterSystem).toBe("pc")
    const r3 = await bus.emit({
      type: "subagent_start",
      subagentId: "s",
      parentId: undefined,
      taskPrompt: "t",
    })
    expect(r3.promptHook?.injectAfterSystem).toBe("ss")
    const r4 = await bus.emit({
      type: "subagent_stop",
      subagentId: "s",
      result: { ok: true, finalText: "", turns: 0 },
    })
    expect(r4.promptHook?.injectBeforeUser).toBe("sx")
    const r5 = await bus.emit({
      type: "post_tool_use_failure",
      name: "x",
      input: {},
      error: "e",
    })
    expect(r5.promptHook?.injectBeforeUser).toBe("ptf")
  })
})

describe("ADR-0133 — abort short-circuit", () => {
  test("first abort wins, later handlers do NOT run", async () => {
    const bus = new HookBus()
    let secondRan = false
    bus.on("pre_compact", () => ({ abort: { reason: "first" } }))
    bus.on("pre_compact", () => {
      secondRan = true
      return { abort: { reason: "second" } }
    })
    const result = await bus.emit({
      type: "pre_compact",
      messagesToCompact: 1,
      isFirstCompaction: false,
    })
    expect(result.abort).toEqual({ reason: "first" })
    expect(secondRan).toBe(false)
  })

  test("abort OMITTED when no handler asked", async () => {
    const bus = new HookBus()
    bus.on("pre_compact", () => undefined)
    const result = await bus.emit({
      type: "pre_compact",
      messagesToCompact: 1,
      isFirstCompaction: false,
    })
    expect("abort" in result).toBe(false)
  })

  test("abort on pre_tool_use is surfaced even if a prior handler rewrote", async () => {
    const bus = new HookBus()
    bus.on("pre_tool_use", () => ({ updatedInput: { x: 1 } }))
    bus.on("pre_tool_use", () => ({ abort: { reason: "stop" } }))
    const result = await bus.emit({ type: "pre_tool_use", name: "x", input: {} })
    expect(result.abort).toEqual({ reason: "stop" })
    // earlier rewrite still surfaces (it was admitted before the abort)
    expect(result.updatedInput).toEqual({ x: 1 })
  })

  test("a malformed abort (no reason string) is IGNORED", async () => {
    const bus = new HookBus()
    bus.on("pre_compact", () => ({ abort: { reason: 42 } }) as unknown as undefined)
    bus.on("pre_compact", () => ({ abort: { reason: "good" } }))
    const result = await bus.emit({
      type: "pre_compact",
      messagesToCompact: 1,
      isFirstCompaction: false,
    })
    // First (malformed) is ignored, second is honored.
    expect(result.abort).toEqual({ reason: "good" })
  })
})

describe("ADR-0133 — backward compat with legacy result shape", () => {
  test("non-pre_tool_use event with no extras returns exactly { deny: null }", async () => {
    const bus = new HookBus()
    bus.on("post_tool_use", () => undefined)
    const result = await bus.emit({
      type: "post_tool_use",
      name: "read",
      input: {},
      ok: true,
      output: "x",
    })
    expect(Object.keys(result).sort()).toEqual(["deny"])
    expect(result.deny).toBeNull()
  })

  test("emit with no handlers returns exactly { deny: null } (zero-overhead path)", async () => {
    const bus = new HookBus()
    const result = await bus.emit({
      type: "subagent_start",
      subagentId: "s",
      parentId: undefined,
      taskPrompt: "t",
    })
    expect(Object.keys(result).sort()).toEqual(["deny"])
  })

  test("pre_tool_use rewrite + new promptHook coexist (every field surfaced)", async () => {
    const bus = new HookBus()
    bus.on("pre_tool_use", () => ({
      updatedInput: { path: "rewritten" },
      promptHook: { injectAfterSystem: "noted" },
    }))
    const result = await bus.emit({
      type: "pre_tool_use",
      name: "read",
      input: { path: "orig" },
    })
    expect(result.deny).toBeNull()
    expect(result.updatedInput).toEqual({ path: "rewritten" })
    expect(result.promptHook).toEqual({ injectAfterSystem: "noted" })
  })
})

describe("ADR-0133 — matcher gating extends to post_tool_use_failure", () => {
  test("matcher fires only for matching tool name on failure event", async () => {
    const bus = new HookBus()
    const seen: string[] = []
    bus.on(
      "post_tool_use_failure",
      (e) => {
        seen.push(e.name)
      },
      { matcher: ["bash"] },
    )
    await bus.emit({
      type: "post_tool_use_failure",
      name: "bash",
      input: {},
      error: "e",
    })
    await bus.emit({
      type: "post_tool_use_failure",
      name: "read",
      input: {},
      error: "e",
    })
    expect(seen).toEqual(["bash"])
  })
})

describe("ADR-0133 — deterministic ordering preserved across new events", () => {
  test("registration order is the firing order for every event variant", async () => {
    const bus = new HookBus()
    const order: string[] = []
    for (let i = 1; i <= 5; i++) {
      bus.on("pre_compact", () => {
        order.push(`h${i}`)
      })
    }
    await bus.emit({
      type: "pre_compact",
      messagesToCompact: 1,
      isFirstCompaction: false,
    })
    expect(order).toEqual(["h1", "h2", "h3", "h4", "h5"])
  })
})

describe("ADR-0133 — throw-isolation extends to new events", () => {
  test("throwing handler does NOT break sibling on subagent_stop", async () => {
    const lines: string[] = []
    const logger = new StructuredLogger({ level: "error", sink: (l) => lines.push(l) })
    const bus = new HookBus(logger)
    let siblingRan = false
    bus.on("subagent_stop", () => {
      throw new Error("boom")
    })
    bus.on("subagent_stop", () => {
      siblingRan = true
    })
    await bus.emit({
      type: "subagent_stop",
      subagentId: "s",
      result: { ok: true, finalText: "", turns: 0 },
    })
    expect(siblingRan).toBe(true)
    expect(lines.length).toBeGreaterThanOrEqual(1)
    const rec = JSON.parse(lines[0] ?? "{}") as { event: string }
    expect(rec.event).toBe("hook.handler.error")
  })
})
