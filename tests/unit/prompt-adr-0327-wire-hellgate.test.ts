/**
 * ADR-0327 — `buildTurnContext` wire seam hellgate.
 *
 * Three optional channels added in ADR-0327 (system-prompt cache from
 * ADR-0326, context-change events from ADR-0321, mention injections from
 * ADR-0325). The byte-identical invariant: when ALL THREE are absent the
 * rendered `system` array and `messages` array are EXACTLY the legacy
 * shape — no extra block, no extra message, no reordered slot.
 *
 * The active invariant: when present, the three channels splice in a
 * stable order — context-change AFTER hook-context, mention-injection
 * AFTER context-change, both BEFORE the trailing `<system-reminder>`.
 */
import { describe, expect, test } from "bun:test"
import type { ContextEvent } from "@/agent/context-change"
import type { TurnContextInput } from "@/agent/prompt"
import { buildTurnContext } from "@/agent/prompt"
import type { Message } from "@/llm"
import { asCacheKey, createInMemorySystemPromptCache } from "@/llm/system-prompt-cache"

const seed: Message[] = [{ role: "user", content: [{ type: "text", text: "do it" }] }]

const base = (over: Partial<TurnContextInput> = {}): TurnContextInput => ({
  baseMessages: seed,
  cwd: "/repo",
  planMode: false,
  ...over,
})

const reminderTailText = (msgs: readonly Message[]): string | undefined => {
  const last = msgs[msgs.length - 1]
  if (last === undefined || last.role !== "user") return undefined
  const block = last.content[0]
  return block?.type === "text" ? block.text : undefined
}

describe("ADR-0327 — byte-identical when all wires absent", () => {
  test("no cache / no events / no mentions ⇒ output equals legacy buildTurnContext", () => {
    const a = buildTurnContext(base())
    const b = buildTurnContext(base())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
    // Sanity: legacy shape has exactly 2 messages — the seed user msg + the
    // trailing `<system-reminder>` block. No wire active means no extra.
    expect(a.messages.length).toBe(2)
  })
})

describe("ADR-0327 — system-prompt cache wire (ADR-0326)", () => {
  test("cache + key engaged ⇒ factory called once across two builds, text identical to legacy", () => {
    const cache = createInMemorySystemPromptCache()
    const key = asCacheKey("session-test-1")
    const wired = buildTurnContext(base({ systemPromptCache: cache, systemPromptCacheKey: key }))
    const wired2 = buildTurnContext(base({ systemPromptCache: cache, systemPromptCacheKey: key }))
    const legacy = buildTurnContext(base())
    expect(JSON.stringify(wired)).toBe(JSON.stringify(legacy))
    expect(JSON.stringify(wired2)).toBe(JSON.stringify(legacy))
    const stats = cache.stats()
    expect(stats.misses).toBe(1) // first build
    expect(stats.hits).toBe(1) // second build reuses
    expect(stats.size).toBe(1)
  })

  test("cache absent but key present ⇒ cache disengaged (legacy build)", () => {
    const key = asCacheKey("session-test-2")
    const wired = buildTurnContext(base({ systemPromptCacheKey: key }))
    const legacy = buildTurnContext(base())
    expect(JSON.stringify(wired)).toBe(JSON.stringify(legacy))
  })

  test("caller-provided `system` ⇒ cache bypassed (caller owns its own memoization)", () => {
    const cache = createInMemorySystemPromptCache()
    const key = asCacheKey("session-test-3")
    const customSystem = "CUSTOM CALLER PROVIDED"
    buildTurnContext(
      base({ system: customSystem, systemPromptCache: cache, systemPromptCacheKey: key }),
    )
    // Cache must NOT have been engaged — caller provided the prefix directly.
    expect(cache.stats().misses).toBe(0)
    expect(cache.stats().hits).toBe(0)
  })
})

describe("ADR-0327 — context-change wire (ADR-0321)", () => {
  test("1 event ⇒ 1 message spliced AFTER baseMessages and BEFORE reminder", () => {
    const ev: ContextEvent = {
      kind: "context_update",
      field: "cwd",
      prev: "/old",
      next: "/new",
      at: 1700000000000,
    }
    const out = buildTurnContext(base({ contextChangeEvents: [ev] }))
    // Layout: [seed user, context-update user, reminder user]
    expect(out.messages.length).toBe(3)
    expect(out.messages[0]).toBe(seed[0]) // same reference (spread copy preserves)
    const ctxMsg = out.messages[1]
    if (ctxMsg === undefined) throw new Error("ctxMsg missing")
    expect(ctxMsg.role).toBe("user")
    const ctxBlock = ctxMsg.content[0]
    const text = ctxBlock !== undefined && ctxBlock.type === "text" ? ctxBlock.text : ""
    expect(text).toContain("context-update")
    expect(text).toContain("/old")
    expect(text).toContain("/new")
    // Reminder still rides the tail.
    expect(reminderTailText(out.messages)).toContain("system-reminder")
  })

  test("empty array ⇒ no splice (byte-identical to absent)", () => {
    const a = buildTurnContext(base({ contextChangeEvents: [] }))
    const b = buildTurnContext(base())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe("ADR-0327 — mention-injection wire (ADR-0325)", () => {
  test("pre-built messages spliced verbatim into the same slot", () => {
    const mention: Message = {
      role: "user",
      content: [{ type: "text", text: '<mention kind="skill" target="code-review"></mention>' }],
    }
    const out = buildTurnContext(base({ mentionInjectionMessages: [mention] }))
    expect(out.messages.length).toBe(3)
    expect(out.messages[1]).toEqual(mention)
  })

  test("empty array ⇒ no splice (byte-identical to absent)", () => {
    const a = buildTurnContext(base({ mentionInjectionMessages: [] }))
    const b = buildTurnContext(base())
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe("ADR-0327 — combined order: context-change → mention → reminder", () => {
  test("both wires active ⇒ stable chronological order", () => {
    const ev: ContextEvent = {
      kind: "mode_change",
      prev: "default",
      next: "plan",
      at: 1700000000000,
    }
    const mention: Message = {
      role: "user",
      content: [{ type: "text", text: '<mention kind="skill" target="x"></mention>' }],
    }
    const out = buildTurnContext(
      base({
        contextChangeEvents: [ev],
        mentionInjectionMessages: [mention],
      }),
    )
    // [seed, mode_change envelope, mention, reminder]
    expect(out.messages.length).toBe(4)
    const m1 = out.messages[1]?.content[0]
    expect(m1?.type === "text" && m1.text.includes("mode-change")).toBe(true)
    const m2 = out.messages[2]?.content[0]
    expect(m2?.type === "text" && m2.text.includes("mention")).toBe(true)
    expect(reminderTailText(out.messages)).toContain("system-reminder")
  })

  test("all four channels (hook + context-change + mention + reminder) coexist in order", () => {
    const ev: ContextEvent = {
      kind: "skill_activation",
      skillId: "code-review",
      trigger: "user",
      at: 1700000000000,
    }
    const mention: Message = {
      role: "user",
      content: [{ type: "text", text: '<mention kind="skill" target="y"></mention>' }],
    }
    const out = buildTurnContext(
      base({
        contextChangeEvents: [ev],
        mentionInjectionMessages: [mention],
        hookPromptInjects: [{ injectBeforeUser: "HOOK PRE" }],
      }),
    )
    // [seed, hook-context, context-change, mention, reminder]
    expect(out.messages.length).toBe(5)
    const h = out.messages[1]?.content[0]
    expect(h?.type === "text" && h.text.includes("HOOK PRE")).toBe(true)
  })
})

describe("ADR-0327 — system array unchanged by wire", () => {
  test("wires active ⇒ `system` array byte-identical to legacy", () => {
    const cache = createInMemorySystemPromptCache()
    const key = asCacheKey("session-test-system-stable")
    const ev: ContextEvent = {
      kind: "mode_change",
      prev: "a",
      next: "b",
      at: 1700000000000,
    }
    const wired = buildTurnContext(
      base({
        systemPromptCache: cache,
        systemPromptCacheKey: key,
        contextChangeEvents: [ev],
        mentionInjectionMessages: [{ role: "user", content: [{ type: "text", text: "x" }] }],
      }),
    )
    const legacy = buildTurnContext(base())
    expect(JSON.stringify(wired.system)).toBe(JSON.stringify(legacy.system))
  })
})
