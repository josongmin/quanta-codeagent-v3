/**
 * Minimal OpenAI-compatible /v1/chat/completions proxy backed by quanta's
 * logged-in ChatGPT OAuth credential. Lets external OpenAI-API clients (mini-
 * swe-agent via litellm) drive gpt-5.4 through the existing `createLLM`
 * ("chatgpt-oauth") path — no raw API key, no token extraction.
 *
 *   bun run docs/analysis/swe-bench-verified-analysis/_data/oauth-proxy.ts   # :8765
 *   point litellm at  http://localhost:8765/v1  with any dummy OPENAI_API_KEY
 *
 * Non-streaming only (mini uses litellm.completion). Maps tools <-> tool_use.
 */
import { createLLM } from "@/llm"
import type { Message, StreamInput, ToolResultBlock, ToolSchema, ContentBlock } from "@/llm/types"

const PORT = Number(process.env.OAUTH_PROXY_PORT ?? 8765)

/** OpenAI chat messages -> quanta {system, messages}. */
function mapMessages(oai: any[]): { system: string; messages: Message[] } {
  const sys: string[] = []
  const messages: Message[] = []
  const flatten = (c: any): string =>
    typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => (p?.text ?? "")).join("") : ""
  for (const m of oai) {
    if (m.role === "system") { sys.push(flatten(m.content)); continue }
    if (m.role === "tool") {
      const block: ToolResultBlock = { type: "tool_result", tool_use_id: m.tool_call_id, content: flatten(m.content) }
      const last = messages[messages.length - 1]
      if (last && last.role === "user") last.content.push(block)
      else messages.push({ role: "user", content: [block] })
      continue
    }
    if (m.role === "assistant") {
      const content: ContentBlock[] = []
      const txt = flatten(m.content)
      if (txt) content.push({ type: "text", text: txt })
      for (const tc of m.tool_calls ?? []) {
        let input: unknown = {}
        try { input = JSON.parse(tc.function?.arguments || "{}") } catch { input = {} }
        content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input })
      }
      messages.push({ role: "assistant", content: content.length ? content : [{ type: "text", text: "" }] })
      continue
    }
    // user (or anything else)
    messages.push({ role: "user", content: [{ type: "text", text: flatten(m.content) }] })
  }
  return { system: sys.join("\n\n"), messages }
}

function mapTools(oai: any[] | undefined): ToolSchema[] {
  if (!oai) return []
  return oai.map((t) => ({
    name: t.function?.name ?? t.name,
    description: t.function?.description ?? "",
    input_schema: t.function?.parameters ?? { type: "object", properties: {} },
  }))
}

async function handleChat(body: any) {
  const model = String(body.model || "gpt-5.4").replace(/^openai\//, "")
  const { system, messages } = mapMessages(body.messages || [])
  const tools = mapTools(body.tools)
  const llm = createLLM("chatgpt-oauth", { model }, process.env)
  const input: StreamInput = { system, messages, tools }

  let text = ""
  const toolCalls: { id: string; name: string; args: string }[] = []
  const partial = new Map<string, { name: string; input: unknown }>()
  for await (const ev of llm.stream(input)) {
    if (ev.type === "text_delta") text += ev.delta
    else if (ev.type === "tool_use_start") partial.set(ev.id, { name: ev.name, input: {} })
    else if (ev.type === "tool_use_end") {
      const p = partial.get(ev.id) ?? { name: "bash", input: {} }
      toolCalls.push({ id: ev.id, name: p.name, args: JSON.stringify(ev.input ?? {}) })
    }
  }

  const message: any = { role: "assistant", content: text || null }
  if (toolCalls.length) {
    message.tool_calls = toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.args } }))
  }
  return {
    id: `chatcmpl-proxy-${messages.length}`,
    object: "chat.completion",
    created: 0,
    model: `openai/${model}`,
    choices: [{ index: 0, message, finish_reason: toolCalls.length ? "tool_calls" : "stop" }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

/**
 * OpenAI **Responses API** (`/v1/responses`) bridge. Newer agent SDKs
 * (OpenHands SDK v1.x) detect gpt-5* as Responses-capable and call this path
 * instead of chat/completions. litellm sends `{instructions, input[], tools[]}`
 * and parses our reply into a `ResponsesAPIResponse` (it reads `.output[]`:
 * `message` items with `output_text` parts + `function_call` items). We map
 * that shape to/from the same quanta `createLLM("chatgpt-oauth")` stream, so
 * OpenHands runs in its NATIVE Responses mode (faithful to how it scores on the
 * leaderboard) — not a degraded chat-completions fallback.
 */
function mapResponsesInput(body: any): { system: string; messages: Message[] } {
  const sys: string[] = []
  if (typeof body.instructions === "string" && body.instructions) sys.push(body.instructions)
  const messages: Message[] = []
  const flatten = (c: any): string =>
    typeof c === "string"
      ? c
      : Array.isArray(c)
        ? c.map((p) => (typeof p === "string" ? p : (p?.text ?? ""))).join("")
        : ""
  const input = body.input
  if (typeof input === "string") {
    messages.push({ role: "user", content: [{ type: "text", text: input }] })
    return { system: sys.join("\n\n"), messages }
  }
  for (const item of Array.isArray(input) ? input : []) {
    const t = item?.type
    if (t === "function_call_output") {
      const block: ToolResultBlock = {
        type: "tool_result",
        tool_use_id: item.call_id,
        content: flatten(item.output),
      }
      const last = messages[messages.length - 1]
      if (last && last.role === "user") last.content.push(block)
      else messages.push({ role: "user", content: [block] })
      continue
    }
    if (t === "function_call") {
      let input2: unknown = {}
      try { input2 = JSON.parse(item.arguments || "{}") } catch { input2 = {} }
      messages.push({
        role: "assistant",
        content: [{ type: "tool_use", id: item.call_id, name: item.name, input: input2 }],
      })
      continue
    }
    // message-shaped item with a role
    const role = item?.role
    if (role === "system" || role === "developer") { sys.push(flatten(item.content)); continue }
    if (role === "assistant") {
      messages.push({ role: "assistant", content: [{ type: "text", text: flatten(item.content) }] })
      continue
    }
    messages.push({ role: "user", content: [{ type: "text", text: flatten(item?.content) }] })
  }
  return { system: sys.join("\n\n"), messages }
}

function mapResponsesTools(oai: any[] | undefined): ToolSchema[] {
  if (!oai) return []
  // Responses tools are flat: {type:"function", name, description, parameters}
  return oai.map((t) => ({
    name: t.name ?? t.function?.name,
    description: t.description ?? t.function?.description ?? "",
    input_schema: t.parameters ?? t.function?.parameters ?? { type: "object", properties: {} },
  }))
}

async function handleResponses(body: any) {
  const model = String(body.model || "gpt-5.4").replace(/^openai\//, "")
  const { system, messages } = mapResponsesInput(body)
  const tools = mapResponsesTools(body.tools)
  const llm = createLLM("chatgpt-oauth", { model }, process.env)
  const streamInput: StreamInput = { system, messages, tools }

  let text = ""
  const toolCalls: { id: string; name: string; args: string }[] = []
  const partial = new Map<string, { name: string; input: unknown }>()
  for await (const ev of llm.stream(streamInput)) {
    if (ev.type === "text_delta") text += ev.delta
    else if (ev.type === "tool_use_start") partial.set(ev.id, { name: ev.name, input: {} })
    else if (ev.type === "tool_use_end") {
      const p = partial.get(ev.id) ?? { name: "bash", input: {} }
      toolCalls.push({ id: ev.id, name: p.name, args: JSON.stringify(ev.input ?? {}) })
    }
  }

  const output: any[] = []
  if (text) {
    output.push({
      type: "message",
      id: `msg_${messages.length}`,
      status: "completed",
      role: "assistant",
      content: [{ type: "output_text", text, annotations: [] }],
    })
  }
  for (const tc of toolCalls) {
    output.push({
      type: "function_call",
      id: `fc_${tc.id}`,
      call_id: tc.id,
      name: tc.name,
      arguments: tc.args,
      status: "completed",
    })
  }
  return {
    id: `resp-proxy-${messages.length}`,
    object: "response",
    created_at: 0,
    status: "completed",
    model: `openai/${model}`,
    output,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
  }
}

Bun.serve({
  port: PORT,
  idleTimeout: 240,
  async fetch(req) {
    const url = new URL(req.url)
    if (url.pathname.endsWith("/chat/completions") && req.method === "POST") {
      try {
        const body = await req.json()
        const res = await handleChat(body)
        return Response.json(res)
      } catch (e: any) {
        console.error("proxy error:", String(e).slice(0, 300))
        return Response.json({ error: { message: String(e).slice(0, 300), type: "proxy_error" } }, { status: 500 })
      }
    }
    if (url.pathname.endsWith("/responses") && req.method === "POST") {
      try {
        const body = await req.json()
        const res = await handleResponses(body)
        return Response.json(res)
      } catch (e: any) {
        console.error("proxy /responses error:", String(e).slice(0, 300))
        return Response.json({ error: { message: String(e).slice(0, 300), type: "proxy_error" } }, { status: 500 })
      }
    }
    if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "gpt-5.4", object: "model" }] })
    return new Response("ok")
  },
})
console.error(`oauth-proxy listening on http://localhost:${PORT}/v1 (chatgpt-oauth -> gpt-5.4)`)
