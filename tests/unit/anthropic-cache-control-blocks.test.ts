/**
 * R-Phase5 P0-B regression — `cache_control` on the conversation prefix is
 * attached ONLY to text blocks, never to `tool_use` / `tool_result` /
 * `thinking` blocks (the Anthropic API only honors `cache_control` on text;
 * stamping it on a non-text block silently drops the breakpoint).
 *
 * `cacheConversationPrefix` is module-private. We exercise it via the same
 * client-stubbing pattern as `tests/unit/anthropic-cache.test.ts`: hijack
 * `client.messages.create`, drain the stream, inspect the captured
 * `messages` payload and assert cache_control placement.
 */
import { describe, expect, test } from "bun:test"
import type { Message, StreamInput } from "@/llm"
import { AnthropicAdapter } from "@/llm"

type Block = { type: string; cache_control?: unknown }
type Msg = { role: string; content: Block[] | string }
type CreateParams = { messages: Msg[] }

const driveOnce = async (messages: Message[]): Promise<CreateParams> => {
  const adapter = new AnthropicAdapter({ apiKey: "test-key", model: "claude-x" })
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
  const input: StreamInput = { messages, tools: [] }
  for await (const _ of adapter.stream(input)) void _
  if (params === undefined) throw new Error("create() was not called")
  return params
}

const lastBlocks = (params: CreateParams): Block[] => {
  const last = params.messages.at(-1)
  if (!last) throw new Error("no last message")
  if (typeof last.content === "string") throw new Error("string content unexpected")
  return last.content
}

describe("R-Phase5 P0-B — cacheConversationPrefix attaches only to text blocks", () => {
  test("last block is text → cache_control on that text block (happy path)", async () => {
    const params = await driveOnce([{ role: "user", content: [{ type: "text", text: "hello" }] }])
    const blocks = lastBlocks(params)
    expect(blocks[0]?.type).toBe("text")
    expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral" })
  })

  test("last block is tool_use → cache_control SKIPS tool_use, lands on prior text", async () => {
    const params = await driveOnce([
      {
        role: "assistant",
        content: [
          { type: "text", text: "I'll call read." },
          { type: "tool_use", id: "t1", name: "read", input: { path: "a.ts" } },
        ],
      },
    ])
    const blocks = lastBlocks(params)
    expect(blocks[0]?.type).toBe("text")
    expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral" })
    expect(blocks[1]?.type).toBe("tool_use")
    expect(blocks[1]?.cache_control).toBeUndefined()
  })

  test("last block is tool_result → cache_control walks back to prior text", async () => {
    const params = await driveOnce([
      {
        role: "user",
        content: [
          { type: "text", text: "context" },
          { type: "tool_result", tool_use_id: "t1", content: "ok" },
        ],
      },
    ])
    const blocks = lastBlocks(params)
    expect(blocks[0]?.type).toBe("text")
    expect(blocks[0]?.cache_control).toEqual({ type: "ephemeral" })
    expect(blocks[1]?.type).toBe("tool_result")
    expect(blocks[1]?.cache_control).toBeUndefined()
  })

  test("message has NO text block at all → no cache_control attached anywhere", async () => {
    const params = await driveOnce([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "read", input: {} }],
      },
    ])
    const blocks = lastBlocks(params)
    expect(blocks.length).toBe(1)
    expect(blocks[0]?.type).toBe("tool_use")
    // No text block existed — gracefully no-op, no API-violating stamp.
    expect(blocks[0]?.cache_control).toBeUndefined()
  })

  test("multiple text + tool_use mix → LAST text (not earlier) carries cache_control", async () => {
    const params = await driveOnce([
      {
        role: "assistant",
        content: [
          { type: "text", text: "first thought" },
          { type: "tool_use", id: "t1", name: "read", input: {} },
          { type: "text", text: "second thought (last text)" },
          { type: "tool_use", id: "t2", name: "edit", input: {} },
        ],
      },
    ])
    const blocks = lastBlocks(params)
    expect(blocks[0]?.cache_control).toBeUndefined() // first text — older
    expect(blocks[2]?.cache_control).toEqual({ type: "ephemeral" }) // last text wins
    expect(blocks[1]?.cache_control).toBeUndefined() // tool_use clean
    expect(blocks[3]?.cache_control).toBeUndefined() // tool_use clean
  })
})
