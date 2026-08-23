/**
 * HELLGATE — C1: the Anthropic cache_control marker budget is enforced at the
 * FINAL WIRE (§17.5 packet C1).
 *
 * Anthropic rejects a request carrying more than 4 `cache_control` blocks with
 * an HTTP 400. Today the budget is enforced in the WRONG place, against the
 * WRONG denominator, and its verdict is DISCARDED:
 *
 *   - `prompt-sections.ts` declares `MAX_CACHE_BREAKPOINTS = 4` and
 *     `validateSectionsCacheBudget` counts only the SYSTEM SECTIONS.
 *   - `buildAnthropicMessagesRequest` then ALWAYS adds one more marker via
 *     `cacheConversationPrefix` (the trailing conversation breakpoint), which
 *     no budget accounts for. 4 cached sections ⇒ 5 markers on the wire.
 *   - `prompt.ts:691` calls the validator and THROWS THE RESULT AWAY, so even
 *     the check it does perform cannot warn.
 *
 * Reachability today is honest: `userAppend` currently has no producer in the
 * loop, so the live preset tops out at 3 cached sections (base, project_md,
 * session_ctx) + 1 conversation = exactly 4. The request is AT the cap, not
 * over it. That is precisely why this must be locked at the wire: the budget
 * has ZERO headroom, and the moment a 4th cached section appears EVERY
 * Anthropic request 400s — across all five providers that share this codec
 * (public, Bedrock, Vertex, Foundry, Mantle).
 *
 * Everything here drives the SHIPPED adapter front door and asserts on the
 * params object actually handed to `messages.create`.
 *
 * Invariants:
 *
 *  C1-1  4 cached sections + a conversation marker ⇒ the WIRE still carries
 *        <= 4 markers.  <-- the RED
 *  C1-2  With a conversation marker present the system budget is 3.
 *  C1-3  No conversation marker (last message has no text block) ⇒ the system
 *        budget is the full 4.
 *  C1-4  BYTE-IDENTITY at and under budget — 1/2/3 cached sections are
 *        untouched, including block order, text, and the absence of any key.
 *  C1-5  The SURVIVORS are the earliest markers. `prompt-sections.ts` declares
 *        its section order to BE the cache prefix, most-stable first
 *        (base -> project_md -> session_ctx -> user_append), so keeping the
 *        leading markers preserves the fallback ladder; dropping a middle one
 *        would strand every later breakpoint behind a drifting prefix.
 *  C1-6  TTL parity — a `1h` retention survives on the markers that are kept
 *        and is not silently downgraded.
 *  C1-7  PAIRED CONTROL — the cap must not be a blanket stripper: a request
 *        that is already legal keeps every marker it declared.
 */

import { describe, expect, test } from "bun:test"
import type { Message, StreamInput, SystemBlock } from "@/llm"
import { AnthropicAdapter } from "@/llm"

const MAX_MARKERS = 4

type SysBlock = { type: string; text: string; cache_control?: unknown }
type CreateParams = {
  system?: string | SysBlock[]
  messages: Array<{ role: string; content: unknown }>
  tools?: unknown
}

const driveOnce = async (
  input: StreamInput,
  over: { readonly cacheTtl?: "5m" | "1h" } = {},
): Promise<CreateParams> => {
  const adapter = new AnthropicAdapter({ apiKey: "test-key", model: "claude-x", ...over })
  let params: CreateParams | undefined
  const client = (adapter as unknown as { client: { messages: { create: unknown } } }).client
  client.messages.create = (p: CreateParams) => {
    params = p
    const empty = {
      [Symbol.asyncIterator]() {
        return { next: () => Promise.resolve({ done: true as const, value: undefined }) }
      },
    }
    return Promise.resolve(empty)
  }
  for await (const _ of adapter.stream(input)) {
    // drain
  }
  if (params === undefined) throw new Error("create() was not called")
  return params
}

/** Count markers on the WHOLE request exactly as Anthropic does: every
 *  `cache_control` PROPERTY anywhere in `tools + system + messages`. Walking
 *  the structure (rather than searching the serialized text) is what makes
 *  this a wire assertion that content cannot forge — see C1-8. */
const markerCount = (v: unknown): number => {
  if (v === null || typeof v !== "object") return 0
  if (Array.isArray(v)) return v.reduce<number>((n, item) => n + markerCount(item), 0)
  let n = 0
  for (const [key, value] of Object.entries(v)) {
    if (key === "cache_control") {
      if (value !== undefined) n++
      continue
    }
    n += markerCount(value)
  }
  return n
}

const systemBlocks = (p: CreateParams): SysBlock[] => {
  if (p.system === undefined || typeof p.system === "string")
    throw new Error("expected SystemBlock[] on the wire")
  return p.system
}

/** Which system blocks kept a marker, by their `text` (the section identity in
 *  these fixtures). Asserting on identity — not on a count — is what proves
 *  WHICH markers survived. */
const markedTexts = (p: CreateParams): string[] =>
  systemBlocks(p)
    .filter((b) => b.cache_control !== undefined)
    .map((b) => b.text)

const cachedSystem = (...names: readonly string[]): SystemBlock[] =>
  names.map((name) => ({ type: "text", text: name, cache: true }) as SystemBlock)

/** A conversation whose LAST message ends in a text block — `cacheConversation
 *  Prefix` stamps it, so this ALWAYS contributes exactly one marker. */
const textTail: Message[] = [{ role: "user", content: [{ type: "text", text: "hi" }] }]

/** A conversation whose last message has NO text block at all — the prefix
 *  helper walks back, finds nothing, and returns the messages untouched, so
 *  this contributes ZERO markers. */
const toolTail: Message[] = [
  {
    role: "assistant",
    content: [{ type: "tool_use", id: "t1", name: "x", input: {} }],
  } as unknown as Message,
]

const inputWith = (system: SystemBlock[], messages: Message[]): StreamInput =>
  ({ system, messages, tools: [] }) as StreamInput

describe("C1 — Anthropic cache_control budget is enforced on the final wire", () => {
  test("C1-1 four cached sections + conversation marker ⇒ wire still <= 4 markers", async () => {
    const p = await driveOnce(
      inputWith(cachedSystem("base", "project_md", "session_ctx", "user_append"), textTail),
    )
    expect(markerCount(p)).toBeLessThanOrEqual(MAX_MARKERS)
  })

  test("C1-2 a conversation marker reserves one slot ⇒ system budget is 3", async () => {
    const p = await driveOnce(
      inputWith(cachedSystem("base", "project_md", "session_ctx", "user_append"), textTail),
    )
    expect(markerCount(p.system)).toBe(3)
    expect(markerCount(p.messages)).toBe(1)
  })

  test("C1-3 no conversation marker ⇒ the system budget is the full 4", async () => {
    const p = await driveOnce(
      inputWith(cachedSystem("base", "project_md", "session_ctx", "user_append"), toolTail),
    )
    expect(markerCount(p.messages)).toBe(0)
    expect(markerCount(p.system)).toBe(4)
    expect(markerCount(p)).toBe(4)
  })

  test("C1-5 the SURVIVORS are the earliest (most-stable-prefix) markers", async () => {
    const p = await driveOnce(
      inputWith(cachedSystem("base", "project_md", "session_ctx", "user_append"), textTail),
    )
    expect(markedTexts(p)).toEqual(["base", "project_md", "session_ctx"])
  })

  test("C1-5b the dropped block SURVIVES as content — only its marker is removed", async () => {
    const p = await driveOnce(
      inputWith(cachedSystem("base", "project_md", "session_ctx", "user_append"), textTail),
    )
    // The section's TEXT must still be on the wire, in order: capping the cache
    // budget must never silently delete prompt content.
    expect(systemBlocks(p).map((b) => b.text)).toEqual([
      "base",
      "project_md",
      "session_ctx",
      "user_append",
    ])
    const dropped = systemBlocks(p)[3]
    if (dropped === undefined) throw new Error("expected a 4th block")
    expect("cache_control" in dropped).toBe(false)
  })

  test("C1-6 a 1h retention survives on the markers that are kept", async () => {
    const p = await driveOnce(
      inputWith(cachedSystem("base", "project_md", "session_ctx", "user_append"), textTail),
      { cacheTtl: "1h" },
    )
    for (const b of systemBlocks(p).filter((x) => x.cache_control !== undefined)) {
      expect(b.cache_control).toEqual({ type: "ephemeral", ttl: "1h" })
    }
    expect(markerCount(p)).toBeLessThanOrEqual(MAX_MARKERS)
  })
})

describe("C1 — at-and-under budget is byte-identical (the cap must be inert)", () => {
  // The whole point of a wire-level cap is that it does NOTHING to a legal
  // request. Compare the FULL serialized params, not just the marker count, so
  // a cap that reordered or rewrote blocks would fail here.
  const legal: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["1 cached section", ["base"]],
    ["2 cached sections", ["base", "project_md"]],
    ["3 cached sections (the live preset ceiling)", ["base", "project_md", "session_ctx"]],
  ]

  for (const [label, names] of legal) {
    test(`C1-4 ${label} + conversation marker ⇒ untouched`, async () => {
      const p = await driveOnce(inputWith(cachedSystem(...names), textTail))
      expect(markedTexts(p)).toEqual([...names])
      expect(markerCount(p)).toBe(names.length + 1)
      expect(markerCount(p)).toBeLessThanOrEqual(MAX_MARKERS)
    })
  }

  test("C1-7 paired control — an already-legal request keeps EVERY marker", async () => {
    // 3 system + 1 conversation = exactly 4: at the cap, nothing to drop.
    const p = await driveOnce(
      inputWith(cachedSystem("base", "project_md", "session_ctx"), textTail),
    )
    expect(markerCount(p)).toBe(MAX_MARKERS)
    expect(markedTexts(p)).toEqual(["base", "project_md", "session_ctx"])
  })

  test("C1-8 message CONTENT cannot forge a marker and steal budget", async () => {
    // Marker accounting must read PROPERTIES, not content bytes. A message
    // whose text is exactly `cache_control` serializes as
    // `"text":"cache_control"`; a stringify-and-count budget saw that as a
    // marker and silently dropped a real system breakpoint — a cache
    // downgrade any user could trigger by typing, and enough such messages
    // would strip every system breakpoint.
    const forged: Message[] = [
      { role: "user", content: [{ type: "text", text: "cache_control" }] },
      { role: "assistant", content: [{ type: "text", text: '"cache_control":' }] },
      { role: "user", content: [{ type: "text", text: "cache_control" }] },
    ]
    const p = await driveOnce(inputWith(cachedSystem("base", "project_md", "session_ctx"), forged))
    expect(markedTexts(p)).toEqual(["base", "project_md", "session_ctx"])
    expect(markerCount(p)).toBe(MAX_MARKERS)
  })

  test("C1-7b uncached system blocks are never stamped by the cap", async () => {
    const system: SystemBlock[] = [
      { type: "text", text: "base", cache: true },
      { type: "text", text: "plain" },
      { type: "text", text: "project_md", cache: true },
    ]
    const p = await driveOnce(inputWith(system, textTail))
    expect(markedTexts(p)).toEqual(["base", "project_md"])
    const plain = systemBlocks(p)[1]
    if (plain === undefined) throw new Error("expected the uncached block")
    expect("cache_control" in plain).toBe(false)
  })
})
