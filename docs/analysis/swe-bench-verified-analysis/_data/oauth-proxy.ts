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
    if (url.pathname.endsWith("/models")) return Response.json({ object: "list", data: [{ id: "gpt-5.4", object: "model" }] })
    return new Response("ok")
  },
})
console.error(`oauth-proxy listening on http://localhost:${PORT}/v1 (chatgpt-oauth -> gpt-5.4)`)
