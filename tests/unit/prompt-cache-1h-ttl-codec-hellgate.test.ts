import { describe, expect, test } from "bun:test"
import {
  buildAnthropicMessagesRequest,
  cacheConversationPrefix,
  toAnthropicSystem,
  ttlControl,
} from "@/llm/anthropic-messages-codec"
import type { CacheTtl, Message, StreamInput, SystemBlock } from "@/llm/types"

/**
 * Hellgate for the 1-hour prompt-cache TTL knob (RFC jun-6-prompt-cache-1h-ttl).
 *
 * The sacred guarantee under adversarial pressure: with the knob OFF (default
 * `"5m"`), every `cache_control` the codec stamps is byte-identical to the
 * pre-feature `{ type: "ephemeral" }` — NO `ttl` key, period. With the knob ON
 * (`"1h"`) the codec adds ONLY `ttl: "1h"` to the breakpoints it ALREADY
 * places — it must not add a breakpoint, move one, or touch the 4-cap / prefix
 * layout. These tests are pure codec (no wire, no network).
 */

const sys = (blocks: SystemBlock[]): SystemBlock[] => blocks

const textMsg = (role: "user" | "assistant", text: string): Message => ({
  role,
  content: [{ type: "text", text }],
})

const baseInput = (overrides: Partial<StreamInput> = {}): StreamInput => ({
  messages: [textMsg("user", "hello")],
  tools: [],
  ...overrides,
})

describe("ttlControl — the single literal-construction site", () => {
  test("default ⇒ bare ephemeral, NO ttl key (golden)", () => {
    const out = ttlControl()
    expect(out).toEqual({ type: "ephemeral" })
    expect("ttl" in out).toBe(false)
    // Deep structural golden: exactly one key.
    expect(Object.keys(out)).toEqual(["type"])
  })

  test('"5m" ⇒ byte-identical to the pre-feature inline literal', () => {
    const out = ttlControl("5m")
    expect(out).toEqual({ type: "ephemeral" })
    expect("ttl" in out).toBe(false)
    expect(Object.keys(out)).toEqual(["type"])
  })

  test('"1h" ⇒ adds ttl:"1h" and nothing else', () => {
    const out = ttlControl("1h")
    expect(out).toEqual({ type: "ephemeral", ttl: "1h" })
    expect(out.ttl).toBe("1h")
    expect(new Set(Object.keys(out))).toEqual(new Set(["type", "ttl"]))
  })
})

describe("toAnthropicSystem — system-block breakpoint", () => {
  const system = sys([
    { type: "text", text: "static prefix", cache: true },
    { type: "text", text: "dynamic tail" },
  ])

  test("default (no ttl arg) ⇒ cache block carries bare ephemeral (golden)", () => {
    const out = toAnthropicSystem(system) as Array<{
      type: string
      text: string
      cache_control?: unknown
    }>
    expect(out[0].cache_control).toEqual({ type: "ephemeral" })
    expect("ttl" in (out[0].cache_control as object)).toBe(false)
    // The non-cache block must carry NO cache_control at all.
    expect("cache_control" in out[1]).toBe(false)
  })

  test('"5m" ⇒ byte-identical to default', () => {
    expect(toAnthropicSystem(system, "5m")).toEqual(toAnthropicSystem(system))
  })

  test('"1h" ⇒ ONLY the cache:true block gains ttl:"1h"', () => {
    const out = toAnthropicSystem(system, "1h") as Array<{
      text: string
      cache_control?: { type: string; ttl?: string }
    }>
    expect(out[0].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    expect("cache_control" in out[1]).toBe(false)
  })

  test("string system prompt is returned verbatim regardless of ttl", () => {
    expect(toAnthropicSystem("plain", "1h")).toBe("plain")
    expect(toAnthropicSystem("plain", "5m")).toBe("plain")
  })

  test('no cache:true block ⇒ "1h" stamps NOTHING (no breakpoint invented)', () => {
    const noCache = sys([
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ])
    const out = toAnthropicSystem(noCache, "1h") as Array<Record<string, unknown>>
    for (const b of out) expect("cache_control" in b).toBe(false)
  })
})

describe("cacheConversationPrefix — last-message breakpoint", () => {
  const buildMsgs = () => [
    { role: "user" as const, content: [{ type: "text" as const, text: "q1" }] },
    {
      role: "assistant" as const,
      content: [
        { type: "text" as const, text: "thinking" },
        { type: "text" as const, text: "answer" },
      ],
    },
  ]

  test("default ⇒ last text block carries bare ephemeral (golden)", () => {
    const out = cacheConversationPrefix(buildMsgs())
    const last = out[1].content as Array<{ text: string; cache_control?: unknown }>
    // Stamped on the LAST text block (`answer`), not the first.
    expect(last[1].cache_control).toEqual({ type: "ephemeral" })
    expect("ttl" in (last[1].cache_control as object)).toBe(false)
    expect("cache_control" in last[0]).toBe(false)
  })

  test('"5m" ⇒ deep-equal to default', () => {
    expect(cacheConversationPrefix(buildMsgs(), "5m")).toEqual(cacheConversationPrefix(buildMsgs()))
  })

  test('"1h" ⇒ last text block carries ttl:"1h"; exactly ONE breakpoint', () => {
    const out = cacheConversationPrefix(buildMsgs(), "1h")
    const last = out[1].content as Array<{ text: string; cache_control?: unknown }>
    expect(last[1].cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    expect("cache_control" in last[0]).toBe(false)
    // Breakpoint count unchanged vs the 5m path.
    const count5m = JSON.stringify(cacheConversationPrefix(buildMsgs(), "5m")).split(
      '"cache_control"',
    ).length
    const count1h = JSON.stringify(out).split('"cache_control"').length
    expect(count1h).toBe(count5m)
  })

  test("empty messages ⇒ unchanged with EITHER ttl", () => {
    expect(cacheConversationPrefix([], "1h")).toEqual([])
    expect(cacheConversationPrefix([], "5m")).toEqual([])
  })

  test("string-content last message ⇒ unchanged with EITHER ttl", () => {
    const m = [{ role: "user" as const, content: "just a string" }]
    expect(cacheConversationPrefix(m as never, "1h")).toEqual(m as never)
    expect(cacheConversationPrefix(m as never, "5m")).toEqual(m as never)
  })

  test("empty-content last message ⇒ unchanged with EITHER ttl", () => {
    const m = [{ role: "user" as const, content: [] }]
    expect(cacheConversationPrefix(m as never, "1h")).toEqual(m as never)
  })

  test('no text block in last message ⇒ "1h" invents NO breakpoint', () => {
    const m = [
      {
        role: "assistant" as const,
        content: [{ type: "tool_use" as const, id: "t1", name: "x", input: {} }],
      },
    ]
    const out = cacheConversationPrefix(m as never, "1h")
    expect(out).toEqual(m as never)
    expect(JSON.stringify(out)).not.toContain("cache_control")
  })

  test("idempotent: pre-stamped cache_control is NOT double-/re-stamped", () => {
    const pre = [
      {
        role: "assistant" as const,
        content: [
          {
            type: "text" as const,
            text: "answer",
            cache_control: { type: "ephemeral" as const },
          },
        ],
      },
    ]
    // Even with "1h", a block that ALREADY carries cache_control is untouched
    // (the codec never silently flips a caller-set ttl).
    const out = cacheConversationPrefix(pre as never, "1h")
    const last = out[0].content as Array<{ cache_control?: { ttl?: string } }>
    expect(last[0].cache_control).toEqual({ type: "ephemeral" })
    expect(last[0].cache_control?.ttl).toBeUndefined()
  })
})

describe("buildAnthropicMessagesRequest — end-to-end wire shape", () => {
  const input = baseInput({
    system: sys([{ type: "text", text: "sys", cache: true }]),
    messages: [textMsg("user", "hi")],
  })

  test("default (no 4th arg) ⇒ byte-identical golden (every cache_control bare)", () => {
    const req = buildAnthropicMessagesRequest("claude-opus-4-8", 1024, input)
    const serialized = JSON.stringify(req)
    expect(serialized).toContain('"cache_control":{"type":"ephemeral"}')
    expect(serialized).not.toContain('"ttl"')
  })

  test('"5m" ⇒ deep-equal to default', () => {
    expect(buildAnthropicMessagesRequest("claude-opus-4-8", 1024, input, "5m")).toEqual(
      buildAnthropicMessagesRequest("claude-opus-4-8", 1024, input),
    )
  })

  test('"1h" ⇒ both breakpoints (system + conversation prefix) carry ttl:"1h"', () => {
    const req = buildAnthropicMessagesRequest("claude-opus-4-8", 1024, input, "1h")
    const serialized = JSON.stringify(req)
    // Exactly two cache_control breakpoints, both with ttl:"1h".
    const breakpoints = serialized.split('"cache_control"').length - 1
    expect(breakpoints).toBe(2)
    const withTtl = serialized.split('"ttl":"1h"').length - 1
    expect(withTtl).toBe(2)
  })

  test('"1h" does NOT change breakpoint COUNT vs "5m" (4-cap untouched)', () => {
    const req5m = buildAnthropicMessagesRequest("claude-opus-4-8", 1024, input, "5m")
    const req1h = buildAnthropicMessagesRequest("claude-opus-4-8", 1024, input, "1h")
    const count = (r: unknown) => JSON.stringify(r).split('"cache_control"').length
    expect(count(req1h)).toBe(count(req5m))
  })

  test('"1h" leaves model / max_tokens / stream / tools / no-beta-header untouched', () => {
    const req5m = buildAnthropicMessagesRequest("claude-opus-4-8", 1024, input, "5m") as Record<
      string,
      unknown
    >
    const req1h = buildAnthropicMessagesRequest("claude-opus-4-8", 1024, input, "1h") as Record<
      string,
      unknown
    >
    expect(req1h.model).toBe(req5m.model)
    expect(req1h.max_tokens).toBe(req5m.max_tokens)
    expect(req1h.stream).toBe(req5m.stream)
    expect(req1h.tools).toEqual(req5m.tools)
    // The codec emits no header field — beta headers live on the adapter client.
    expect("anthropic-beta" in req1h).toBe(false)
    expect("headers" in req1h).toBe(false)
  })

  test("the only structural diff between 5m and 1h is the added ttl keys", () => {
    const strip = (r: unknown) => JSON.stringify(r).replaceAll(',"ttl":"1h"', "")
    const a = strip(buildAnthropicMessagesRequest("claude-opus-4-8", 1024, input, "5m"))
    const b = strip(buildAnthropicMessagesRequest("claude-opus-4-8", 1024, input, "1h"))
    expect(b).toBe(a)
  })
})

// Exhaustiveness: the closed union has exactly the two members the codec
// branches on. A new member would be a compile error here AND below.
describe("CacheTtl — closed union discipline", () => {
  test("every member round-trips through ttlControl", () => {
    const members: CacheTtl[] = ["5m", "1h"]
    for (const m of members) {
      const out = ttlControl(m)
      expect(out.type).toBe("ephemeral")
      if (m === "1h") expect(out.ttl).toBe("1h")
      else expect(out.ttl).toBeUndefined()
    }
  })
})
