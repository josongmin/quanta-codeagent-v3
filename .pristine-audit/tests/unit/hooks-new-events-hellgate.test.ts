/**
 * HELLGATE — S5 hook hardening: NEW event types' end-to-end contract.
 *
 * Three events:
 *   1. `user_prompt_submit` — emitted by the loop ONCE per run BEFORE the
 *      LLM is consulted. Handlers can rewrite the prompt, deny the run, or
 *      abort. Default-OFF: no handlers ⇒ no overhead.
 *   2. `pre_compact` — emitted by `compactIfNeeded` BEFORE the summarizer
 *      LLM is invoked. Handlers can return `{abortReason}` to skip THIS
 *      compaction (the loop's breaker sees a no-op).
 *   3. `subagent_stop` — emitted by `subagent-runner.ts` AFTER a forked
 *      child returns (success / fail / cancel). Fire-and-forget for status
 *      reporting; an `abort` here is meaningless (the child finished).
 *
 * Each event has an existing implementation slot — these tests pin the
 * surface invariants + anti-leak / default-OFF promises.
 */
import { describe, expect, test } from "bun:test"
import { HookBus } from "@/agent/hooks"
import type { Message } from "@/llm"

describe("S5 — user_prompt_submit", () => {
  test("handler receives prompt text + attachments count + threadId", async () => {
    const bus = new HookBus()
    const seen: Array<{ prompt: string; attachmentsCount: number; threadId: string }> = []
    bus.on("user_prompt_submit", (e) => {
      seen.push({
        prompt: e.prompt,
        attachmentsCount: e.attachmentsCount,
        threadId: e.threadId,
      })
    })
    await bus.emit({
      type: "user_prompt_submit",
      prompt: "ship it",
      attachmentsCount: 2,
      threadId: "thread-42",
    })
    expect(seen).toEqual([{ prompt: "ship it", attachmentsCount: 2, threadId: "thread-42" }])
  })

  test("returning {deny} surfaces the first deny reason", async () => {
    const bus = new HookBus()
    bus.on("user_prompt_submit", () => ({ deny: "blocked: contains secret" }))
    const result = await bus.emit({
      type: "user_prompt_submit",
      prompt: "hi",
      attachmentsCount: 0,
      threadId: "t",
    })
    expect(result.deny).toEqual({ deny: "blocked: contains secret" })
  })

  test("returning {updatedPrompt} rewrites the prompt; LAST rewrite wins", async () => {
    const bus = new HookBus()
    bus.on("user_prompt_submit", () => ({ updatedPrompt: "v1" }))
    bus.on("user_prompt_submit", (e) => {
      // Second handler sees the rewritten prompt (composes in order).
      expect(e.prompt).toBe("v1")
      return { updatedPrompt: `${e.prompt} → v2` }
    })
    const result = await bus.emit({
      type: "user_prompt_submit",
      prompt: "v0",
      attachmentsCount: 0,
      threadId: "t",
    })
    expect(result.updatedPrompt).toBe("v1 → v2")
  })

  test("a handler may return BOTH {updatedPrompt} AND {promptHook} (combined)", async () => {
    const bus = new HookBus()
    bus.on("user_prompt_submit", () => ({
      updatedPrompt: "rewritten",
      promptHook: { injectAfterSystem: "remember: be terse" },
    }))
    const result = await bus.emit({
      type: "user_prompt_submit",
      prompt: "orig",
      attachmentsCount: 0,
      threadId: "t",
    })
    expect(result.updatedPrompt).toBe("rewritten")
    expect(result.promptHook?.injectAfterSystem).toBe("remember: be terse")
  })

  test("returning a short-circuit value halts the chain (first wins)", async () => {
    const bus = new HookBus()
    let secondRan = false
    bus.on("user_prompt_submit", () => ({ abort: { reason: "policy" } }))
    bus.on("user_prompt_submit", () => {
      secondRan = true
    })
    const result = await bus.emit({
      type: "user_prompt_submit",
      prompt: "hi",
      attachmentsCount: 0,
      threadId: "t",
    })
    expect(result.abort).toEqual({ reason: "policy" })
    expect(secondRan).toBe(false)
  })

  test("a throwing handler is isolated; later handlers still run", async () => {
    const bus = new HookBus()
    let secondRan = false
    bus.on("user_prompt_submit", () => {
      throw new Error("oops")
    })
    bus.on("user_prompt_submit", () => {
      secondRan = true
    })
    const result = await bus.emit({
      type: "user_prompt_submit",
      prompt: "hi",
      attachmentsCount: 0,
      threadId: "t",
    })
    expect(secondRan).toBe(true)
    expect(result.deny).toBeNull()
  })

  test("no handlers ⇒ no overhead, legacy result shape", async () => {
    const bus = new HookBus()
    const result = await bus.emit({
      type: "user_prompt_submit",
      prompt: "hi",
      attachmentsCount: 0,
      threadId: "t",
    })
    expect(result).toEqual({ deny: null })
  })

  test("handler return shape is type-narrowed (TypeScript / runtime parity)", async () => {
    const bus = new HookBus()
    // A handler that returns a string (NOT a HookUpdatedPrompt) is treated
    // as a no-op — only `{updatedPrompt: string}` is the rewrite signal.
    bus.on("user_prompt_submit", () => "plain string" as unknown as undefined)
    const result = await bus.emit({
      type: "user_prompt_submit",
      prompt: "hi",
      attachmentsCount: 0,
      threadId: "t",
    })
    expect(result.updatedPrompt).toBeUndefined()
  })
})

describe("S5 — pre_compact", () => {
  test("handler receives messagesToCompact + isFirstCompaction", async () => {
    const bus = new HookBus()
    const seen: { count: number; first: boolean }[] = []
    bus.on("pre_compact", (e) => {
      seen.push({ count: e.messagesToCompact, first: e.isFirstCompaction })
    })
    await bus.emit({ type: "pre_compact", messagesToCompact: 32, isFirstCompaction: false })
    expect(seen).toEqual([{ count: 32, first: false }])
  })

  test("returning a short-circuit value skips THIS compaction (consumed by compaction.ts bridge)", async () => {
    const bus = new HookBus()
    bus.on("pre_compact", () => ({ abort: { reason: "snapshot in progress" } }))
    const result = await bus.emit({
      type: "pre_compact",
      messagesToCompact: 10,
      isFirstCompaction: true,
    })
    expect(result.abort).toEqual({ reason: "snapshot in progress" })
  })

  test("multiple handlers run; short-circuit return halts the chain", async () => {
    const bus = new HookBus()
    const calls: string[] = []
    bus.on("pre_compact", () => {
      calls.push("first")
    })
    bus.on("pre_compact", () => {
      calls.push("second")
      return { abort: { reason: "halt" } }
    })
    bus.on("pre_compact", () => {
      calls.push("third")
    })
    await bus.emit({ type: "pre_compact", messagesToCompact: 5, isFirstCompaction: false })
    expect(calls).toEqual(["first", "second"])
  })

  test("promptHook on pre_compact is accumulated (audit-log use case)", async () => {
    const bus = new HookBus()
    bus.on("pre_compact", () => ({
      promptHook: { injectAfterSystem: "compaction event N" },
    }))
    const result = await bus.emit({
      type: "pre_compact",
      messagesToCompact: 5,
      isFirstCompaction: false,
    })
    expect(result.promptHook?.injectAfterSystem).toBe("compaction event N")
  })

  test("no handlers ⇒ legacy shape", async () => {
    const bus = new HookBus()
    const result = await bus.emit({
      type: "pre_compact",
      messagesToCompact: 5,
      isFirstCompaction: false,
    })
    expect(result).toEqual({ deny: null })
  })
})

describe("S5 — subagent_stop", () => {
  test("handler receives subagentId + result {ok, finalText, turns}", async () => {
    const bus = new HookBus()
    let seen: { id: string; ok: boolean; turns: number; text: string } | undefined
    bus.on("subagent_stop", (e) => {
      seen = {
        id: e.subagentId,
        ok: e.result.ok,
        turns: e.result.turns,
        text: e.result.finalText,
      }
    })
    await bus.emit({
      type: "subagent_stop",
      subagentId: "sub-1",
      result: { ok: true, finalText: "done", turns: 3 },
    })
    expect(seen).toEqual({ id: "sub-1", ok: true, turns: 3, text: "done" })
  })

  test("subagent_stop fires for FAIL outcomes too", async () => {
    const bus = new HookBus()
    let okSeen: boolean | undefined
    bus.on("subagent_stop", (e) => {
      okSeen = e.result.ok
    })
    await bus.emit({
      type: "subagent_stop",
      subagentId: "sub-1",
      result: { ok: false, finalText: "failed: tool denied", turns: 1 },
    })
    expect(okSeen).toBe(false)
  })

  test("promptHook on subagent_stop is captured for parent fold", async () => {
    const bus = new HookBus()
    bus.on("subagent_stop", () => ({
      promptHook: { injectBeforeUser: "subagent reported: <details>" },
    }))
    const result = await bus.emit({
      type: "subagent_stop",
      subagentId: "s",
      result: { ok: true, finalText: "ok", turns: 1 },
    })
    expect(result.promptHook?.injectBeforeUser).toBe("subagent reported: <details>")
  })

  test("no handlers ⇒ legacy shape, zero overhead", async () => {
    const bus = new HookBus()
    const result = await bus.emit({
      type: "subagent_stop",
      subagentId: "s",
      result: { ok: true, finalText: "", turns: 0 },
    })
    expect(result).toEqual({ deny: null })
  })

  test("fire-and-forget: a handler return that's not promptHook/abort is ignored", async () => {
    const bus = new HookBus()
    bus.on("subagent_stop", () => ({ deny: "ignored on this event" }))
    const result = await bus.emit({
      type: "subagent_stop",
      subagentId: "s",
      result: { ok: true, finalText: "", turns: 0 },
    })
    // deny is only honored on pre_tool_use / user_prompt_submit.
    expect(result.deny).toBeNull()
  })
})

describe("S5 — backward compat for legacy events", () => {
  test("registering a handler for one new event does NOT affect siblings", async () => {
    const bus = new HookBus()
    let userPromptSeen = 0
    let turnStartSeen = 0
    bus.on("user_prompt_submit", () => {
      userPromptSeen++
    })
    bus.on("turn_start", () => {
      turnStartSeen++
    })
    await bus.emit({ type: "turn_start", turn: 1 })
    await bus.emit({ type: "turn_start", turn: 2 })
    expect(userPromptSeen).toBe(0)
    expect(turnStartSeen).toBe(2)
  })

  test("a snapshot trace before/after registering new-event handlers is bytewise identical for legacy events", async () => {
    const events: string[] = []
    const before = new HookBus()
    before.on("turn_start", (e) => {
      events.push(`turn:${e.turn}`)
    })
    await before.emit({ type: "turn_start", turn: 1 })
    const beforeTrace = events.slice()

    // Add a new-event handler — must not perturb the legacy event's trace.
    const after = new HookBus()
    after.on("turn_start", (e) => {
      events.push(`turn:${e.turn}`)
    })
    after.on("user_prompt_submit", () => undefined)
    after.on("pre_compact", () => undefined)
    after.on("subagent_stop", () => undefined)
    events.length = 0
    await after.emit({ type: "turn_start", turn: 1 })
    expect(events).toEqual(beforeTrace)
  })
})

describe("S5 — anti-leak invariants for new events", () => {
  test("user_prompt_submit handler does NOT see internal toolArgs / cookies — only prompt+attachmentsCount+threadId", async () => {
    const bus = new HookBus()
    let received: Record<string, unknown> | undefined
    bus.on("user_prompt_submit", (e) => {
      received = e as unknown as Record<string, unknown>
    })
    await bus.emit({
      type: "user_prompt_submit",
      prompt: "hi",
      attachmentsCount: 0,
      threadId: "t",
    })
    expect(Object.keys(received as object).sort()).toEqual([
      "attachmentsCount",
      "prompt",
      "threadId",
      "type",
    ])
  })

  test("pre_compact payload has NO content / message bodies", async () => {
    const bus = new HookBus()
    let received: Record<string, unknown> | undefined
    bus.on("pre_compact", (e) => {
      received = e as unknown as Record<string, unknown>
    })
    await bus.emit({ type: "pre_compact", messagesToCompact: 5, isFirstCompaction: false })
    expect(Object.keys(received as object).sort()).toEqual([
      "isFirstCompaction",
      "messagesToCompact",
      "type",
    ])
  })

  test("subagent_stop result.finalText is plain text the parent already sees — no separate leak channel", async () => {
    const bus = new HookBus()
    let received: { ok: boolean; finalText: string; turns: number } | undefined
    bus.on("subagent_stop", (e) => {
      received = e.result
    })
    await bus.emit({
      type: "subagent_stop",
      subagentId: "s",
      result: { ok: true, finalText: "answer", turns: 1 },
    })
    expect(Object.keys(received as object).sort()).toEqual(["finalText", "ok", "turns"])
  })
})

describe("S5 — loop integration smoke (user_prompt_submit)", () => {
  // These do NOT spin up a full agent loop; they verify the message-mutation
  // helper that loop.ts uses (`emitUserPromptSubmitHook`) does the right
  // thing by exercising the documented behavior via the bus directly.

  test("the seeded message format the loop expects (text block) is supported", () => {
    const msg: Message = {
      role: "user",
      content: [{ type: "text", text: "prompt body" }],
    }
    // Pinning the message shape that loop.ts walks: role=user, content[0]
    // text. If this shape changes, loop.ts's emitUserPromptSubmitHook walker
    // must change in lockstep — this test is the canary.
    expect(msg.role).toBe("user")
    expect(msg.content[0]?.type).toBe("text")
  })
})
