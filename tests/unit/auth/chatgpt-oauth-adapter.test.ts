import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { chatgptTokenPath, writeToken } from "@/auth/chatgpt-oauth"
import {
  __resetCatalogCacheForTest,
  buildResponsesBody,
  ChatGPTOAuthAdapter,
} from "@/llm/adapters/chatgpt-oauth"
import type { StreamEvent, StreamInput } from "@/llm/types"
import type { TurnTimingCapture } from "@/observability"
import { LLMError } from "@/shared"

/**
 * Phase 2 wiring tests (ADR-0094). Verifies:
 *   1. Token absence → typed `auth` LLMError (never silent).
 *   2. Wire shape: POST to {apiBase}/codex/responses, headers include
 *      Bearer + ChatGPT-Account-Id + OAI-Product-Sku + originator.
 *   3. SSE → StreamEvent mapping: text_delta / tool_use_* / usage / stop.
 *   4. Non-2xx → typed LLMError with appropriate kind.
 *
 * The pre-Phase-2 stub behaviour (`not_implemented` kind, fallback-eligible)
 * was retired together with the stub itself. The retry/fallback policy on
 * `not_implemented` lives in the shared errors layer and is exercised by
 * dedicated tests there — not against this adapter, which no longer emits
 * that kind.
 */

const FIXED_NOW = Date.parse("2026-05-23T12:00:00.000Z")
const futureExpiry = new Date(FIXED_NOW + 24 * 3600_000).toISOString()

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cgo-adapter-"))
  __resetCatalogCacheForTest()
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Multi-call fetch mock — dispatches by URL substring so a `/models` GET
 *  and a `/responses` POST in the same test can return different shapes.
 *  Returns the FIRST handler that the URL contains. */
const _dispatchFetch =
  (handlers: { match: string; respond: () => Response }[]) =>
  async (url: string, _init?: RequestInit): Promise<Response> => {
    for (const h of handlers) {
      if (url.includes(h.match)) return h.respond()
    }
    throw new Error(`unexpected fetch URL: ${url}`)
  }

const catalogResponse = (models: readonly { model: string; is_default?: boolean }[]): Response =>
  new Response(JSON.stringify({ models }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })

const seedToken = async (
  overrides: Partial<Parameters<typeof writeToken>[1]> = {},
): Promise<void> => {
  await writeToken(chatgptTokenPath(dir), {
    access_token: "at-test",
    refresh_token: "rt-test",
    expires_at: futureExpiry,
    account_id: "acct-1",
    plan_type: "pro",
    ...overrides,
  })
}

const emptyStreamInput = (): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
})

const collect = async (gen: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of gen) out.push(ev)
  return out
}

// Build a Response whose body emits the given SSE chunks one at a time.
const sseResponse = (chunks: readonly string[]): Response => {
  const enc = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(enc.encode(c))
      controller.close()
    },
  })
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

describe("ChatGPTOAuthAdapter (Phase 2)", () => {
  test("missing token → typed auth LLMError", async () => {
    const a = new ChatGPTOAuthAdapter({
      model: "gpt-5-codex",
      env: { QUANTA_PREFS_HOME: dir },
      nowMs: () => FIXED_NOW,
    })
    let caught: unknown
    try {
      for await (const _ of a.stream(emptyStreamInput())) void _
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LLMError)
    expect((caught as LLMError).kind).toBe("auth")
    expect((caught as LLMError).provider).toBe("chatgpt-oauth")
    expect((caught as LLMError).message).toContain("/login")
  })

  test("happy path: probes /models then POSTs to /responses with bearer + account headers", async () => {
    await seedToken()
    const captured: { url: string; init: RequestInit }[] = []
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      captured.push({ url, init: init ?? {} })
      if (url.includes("/codex/models")) {
        return catalogResponse([{ model: "gpt-5-codex", is_default: true }])
      }
      return sseResponse([
        'data: {"type":"response.output_text.delta","delta":"hello"}\n\n',
        'data: {"type":"response.completed","response":{"model":"gpt-5-codex","usage":{"input_tokens":3,"output_tokens":1}}}\n\n',
        "data: [DONE]\n\n",
      ])
    }
    const a = new ChatGPTOAuthAdapter({
      model: "gpt-5-codex",
      env: { QUANTA_PREFS_HOME: dir },
      fetchImpl,
      nowMs: () => FIXED_NOW,
    })
    const events = await collect(a.stream(emptyStreamInput()))

    // Two fetches: catalog GET first, then responses POST.
    expect(captured.length).toBe(2)
    // `client_version` query param is REQUIRED by the backend (probe-verified
    // 400 otherwise) — assert it's present on the URL.
    expect(captured[0]?.url).toBe(
      "https://chatgpt.com/backend-api/codex/models?client_version=0.0.1",
    )
    expect(captured[0]?.init.method).toBe("GET")
    expect(captured[1]?.url).toBe("https://chatgpt.com/backend-api/codex/responses")
    expect(captured[1]?.init.method).toBe("POST")
    const h = captured[1]?.init.headers as Record<string, string>
    expect(h.authorization).toBe("Bearer at-test")
    expect(h["chatgpt-account-id"]).toBe("acct-1")
    expect(h["oai-product-sku"]).toBe("CODEX")
    expect(h.originator).toBe("codex_cli")
    expect(h.accept).toBe("text/event-stream")

    expect(events[0]).toEqual({ type: "text_delta", delta: "hello" })
    expect(events.find((e) => e.type === "usage")).toMatchObject({
      type: "usage",
      inputTokens: 3,
      outputTokens: 1,
      model: "gpt-5-codex",
    })
    expect(events[events.length - 1]).toMatchObject({
      type: "message_stop",
      stop_reason: "end_turn",
    })
  })

  test("marks requestSentAt on the actual /responses POST, not during /models preflight", async () => {
    await seedToken()
    const marks: string[] = []
    const timingCapture: TurnTimingCapture = {
      markRequestSent: () => {
        marks.push("request")
      },
      markFirstToken: () => {
        marks.push("first")
      },
      markStreamEnd: () => {
        marks.push("end")
      },
      snapshot: () => ({
        requestSentAt: 0,
        firstTokenAt: null,
        firstTokenLatencyMs: null,
        streamEndAt: 0,
        totalDurationMs: 0,
        ttftMs: null,
        totalTtftMs: null,
      }),
    }
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("/codex/models")) {
        expect(marks).toEqual([])
        return catalogResponse([{ model: "gpt-5", is_default: true }])
      }
      expect(marks).toEqual(["request"])
      expect(init?.method).toBe("POST")
      return sseResponse([
        'data: {"type":"response.completed","response":{"model":"gpt-5","usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
      ])
    }
    const a = new ChatGPTOAuthAdapter({
      model: "gpt-5",
      env: { QUANTA_PREFS_HOME: dir },
      fetchImpl,
      nowMs: () => FIXED_NOW,
    })
    await collect(
      a.stream({
        ...emptyStreamInput(),
        turnTimingCapture: timingCapture,
      }),
    )
    expect(marks).toContain("request")
  })

  test("catalog swap: configured model absent → backend-default used + body shows swapped slug", async () => {
    await seedToken()
    let postedBody: { model?: string } | null = null
    const fetchImpl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (url.includes("/codex/models")) {
        // ChatGPT-account catalog excludes the legacy `gpt-5-codex` slug —
        // exactly the production state that produced the original RCA 400.
        return catalogResponse([
          { model: "gpt-5.1-codex-max", is_default: true },
          { model: "gpt-5.1-codex-mini" },
        ])
      }
      postedBody = JSON.parse((init?.body as string) ?? "{}") as { model?: string }
      return sseResponse([
        'data: {"type":"response.completed","response":{"model":"gpt-5.1-codex-max","usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      ])
    }
    const a = new ChatGPTOAuthAdapter({
      model: "gpt-5-codex", // not in catalog → must swap
      env: { QUANTA_PREFS_HOME: dir },
      fetchImpl,
      nowMs: () => FIXED_NOW,
    })
    await collect(a.stream(emptyStreamInput()))
    expect((postedBody as { model?: string } | null)?.model).toBe("gpt-5.1-codex-max")
  })

  test("catalog cache: second stream within TTL skips the /models round-trip", async () => {
    await seedToken()
    let modelsCalls = 0
    let responsesCalls = 0
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("/codex/models")) {
        modelsCalls += 1
        return catalogResponse([{ model: "gpt-5", is_default: true }])
      }
      responsesCalls += 1
      return sseResponse([
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
      ])
    }
    const a = new ChatGPTOAuthAdapter({
      model: "gpt-5",
      env: { QUANTA_PREFS_HOME: dir },
      fetchImpl,
      nowMs: () => FIXED_NOW,
    })
    await collect(a.stream(emptyStreamInput()))
    await collect(a.stream(emptyStreamInput()))
    expect(modelsCalls).toBe(1)
    expect(responsesCalls).toBe(2)
  })

  test("empty catalog → typed auth LLMError with explanation", async () => {
    await seedToken()
    const fetchImpl = async (): Promise<Response> => catalogResponse([])
    const a = new ChatGPTOAuthAdapter({
      model: "gpt-5",
      env: { QUANTA_PREFS_HOME: dir },
      fetchImpl,
      nowMs: () => FIXED_NOW,
    })
    let caught: unknown
    try {
      for await (const _ of a.stream(emptyStreamInput())) void _
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LLMError)
    expect((caught as LLMError).kind).toBe("auth")
    expect((caught as LLMError).message).toContain("empty catalog")
  })

  test("function-call SSE → tool_use_{start,delta,end}", async () => {
    await seedToken()
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("/codex/models")) {
        return catalogResponse([{ model: "gpt-5-codex", is_default: true }])
      }
      return sseResponse([
        'data: {"type":"response.output_item.added","item":{"type":"function_call","call_id":"call_1","name":"bash"}}\n\n',
        'data: {"type":"response.function_call_arguments.delta","item_id":"call_1","delta":"{\\"cmd\\":\\"l"}\n\n',
        'data: {"type":"response.function_call_arguments.delta","item_id":"call_1","delta":"s\\"}"}\n\n',
        'data: {"type":"response.output_item.done","item":{"type":"function_call","call_id":"call_1","arguments":"{\\"cmd\\":\\"ls\\"}"}}\n\n',
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}\n\n',
      ])
    }
    const a = new ChatGPTOAuthAdapter({
      model: "gpt-5-codex",
      env: { QUANTA_PREFS_HOME: dir },
      fetchImpl,
      nowMs: () => FIXED_NOW,
    })
    const events = await collect(a.stream(emptyStreamInput()))
    const starts = events.filter((e) => e.type === "tool_use_start")
    const ends = events.filter((e) => e.type === "tool_use_end")
    expect(starts).toHaveLength(1)
    expect((starts[0] as { id: string; name: string }).name).toBe("bash")
    expect(ends).toHaveLength(1)
    expect((ends[0] as { input: unknown }).input).toEqual({ cmd: "ls" })
  })

  test("HTTP 401 on /responses → typed auth LLMError (never retried, never fell back)", async () => {
    await seedToken()
    const seenUrls: string[] = []
    const fetchImpl = async (url: string): Promise<Response> => {
      seenUrls.push(url)
      if (url.includes("/codex/models")) {
        return catalogResponse([{ model: "gpt-5", is_default: true }])
      }
      return new Response("unauthorized", { status: 401, statusText: "Unauthorized" })
    }
    const a = new ChatGPTOAuthAdapter({
      model: "gpt-5",
      env: { QUANTA_PREFS_HOME: dir },
      fetchImpl,
      nowMs: () => FIXED_NOW,
    })
    let caught: unknown
    try {
      for await (const _ of a.stream(emptyStreamInput())) void _
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LLMError)
    expect((caught as LLMError).kind).toBe("auth")
    expect((caught as LLMError).statusCode).toBe(401)
    expect(seenUrls).toHaveLength(2)
    expect(seenUrls.filter((u) => u.includes("/codex/models"))).toHaveLength(1)
    expect(seenUrls.filter((u) => u.includes("/codex/responses"))).toHaveLength(1)
  })

  test("HTTP 429 → typed rate_limit LLMError", async () => {
    await seedToken()
    const fetchImpl = async (url: string): Promise<Response> => {
      if (url.includes("/codex/models")) {
        return catalogResponse([{ model: "gpt-5", is_default: true }])
      }
      return new Response("slow down", { status: 429, statusText: "Too Many Requests" })
    }
    const a = new ChatGPTOAuthAdapter({
      model: "gpt-5",
      env: { QUANTA_PREFS_HOME: dir },
      fetchImpl,
      nowMs: () => FIXED_NOW,
    })
    let caught: unknown
    try {
      for await (const _ of a.stream(emptyStreamInput())) void _
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(LLMError)
    expect((caught as LLMError).kind).toBe("rate_limit")
    expect((caught as LLMError).statusCode).toBe(429)
  })
})

describe("buildResponsesBody", () => {
  test("system prompt rides on `instructions`, NOT as a role:system input item", () => {
    // Probe-verified contract: ChatGPT-account `/responses` rejects requests
    // with no `instructions` field. The system prompt must live there, and
    // the input array carries only user/assistant turns.
    const body = buildResponsesBody(
      {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [],
        system: "be helpful",
      },
      "gpt-5.2",
    )
    expect(body.model).toBe("gpt-5.2")
    expect(body.stream).toBe(true)
    expect(body.store).toBe(false)
    expect(body.instructions).toBe("be helpful")
    const items = body.input as Array<{ type: string; role?: string }>
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ type: "message", role: "user" })
  })

  test("empty system falls back to a non-empty default instructions string", () => {
    const body = buildResponsesBody(
      {
        messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        tools: [],
      },
      "gpt-5.2",
    )
    expect(typeof body.instructions).toBe("string")
    expect((body.instructions as string).length).toBeGreaterThan(0)
  })

  test("converts tool_use assistant turn to function_call item", () => {
    const body = buildResponsesBody(
      {
        messages: [
          {
            role: "assistant",
            content: [{ type: "tool_use", id: "call_x", name: "bash", input: { cmd: "ls" } }],
          },
        ],
        tools: [],
      },
      "gpt-5-codex",
    )
    const items = body.input as Array<{ type: string; call_id?: string; name?: string }>
    expect(items[0]).toMatchObject({
      type: "function_call",
      call_id: "call_x",
      name: "bash",
    })
  })

  test("converts tool_result user turn to function_call_output item", () => {
    const body = buildResponsesBody(
      {
        messages: [
          {
            role: "user",
            content: [{ type: "tool_result", tool_use_id: "call_x", content: "ok" }],
          },
        ],
        tools: [],
      },
      "gpt-5-codex",
    )
    const items = body.input as Array<{ type: string; call_id?: string; output?: string }>
    expect(items[0]).toMatchObject({
      type: "function_call_output",
      call_id: "call_x",
      output: "ok",
    })
  })

  test("emits tools in Responses function shape", () => {
    const body = buildResponsesBody(
      {
        messages: [],
        tools: [
          {
            name: "bash",
            description: "run a command",
            input_schema: { type: "object", properties: { cmd: { type: "string" } } },
          },
        ],
      },
      "gpt-5-codex",
    )
    const tools = body.tools as Array<{ type: string; name: string; parameters: unknown }>
    expect(tools[0]).toMatchObject({
      type: "function",
      name: "bash",
      description: "run a command",
    })
  })
})
