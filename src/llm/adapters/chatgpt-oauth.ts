/** ChatGPT-OAuth adapter (ADR-0094 Phase 2).
 *
 *  Calls `${apiBase}/responses` with the disk-stored OAuth bearer instead of
 *  an API key. `apiBase` defaults to `https://chatgpt.com/backend-api/codex`
 *  — the Responses-API endpoint the OSS Codex CLI uses for ChatGPT
 *  subscription traffic. The wire protocol is Server-Sent Events; we parse
 *  the canonical `response.*` event names and map them to {@link StreamEvent}.
 *
 *  Token freshness is enforced at the top of each `stream()` call:
 *    1. Read token from disk (`~/.quanta/auth/chatgpt.json`).
 *    2. If `expires_at` is within the next 60 s, run a refresh first and
 *       persist the new bundle. Refresh shares an in-flight guard with the
 *       auth module so concurrent streams collapse to one issuer hit.
 *    3. POST with `Authorization: Bearer ${access_token}` +
 *       `ChatGPT-Account-Id` + `OAI-Product-Sku` + `originator`.
 *
 *  401 mid-stream ⇒ typed `auth` LLMError. The retry/fallback layer
 *  (LLMErrorKind doc) refuses to retry or fall back on `auth` — the user is
 *  told to relogin instead.
 */

import {
  type FetchLike,
  chatgptTokenPath,
  isExpired,
  readToken,
  refreshToken,
  resolveOAuthConfig,
  resolveQuantaHome,
  type TokenRecord,
  writeToken,
} from "@/auth/chatgpt-oauth"
import { LLMError } from "@/shared"
import type { LLMErrorKind } from "@/shared/errors"
import type { LLMPort } from "../ports"
import { parseToolInputOrThrow } from "./shared"
import type { Message, StreamEvent, StreamInput, SystemPromptInput, ToolSchema } from "../types"

const RESPONSES_PATH = "/responses"
const MODELS_PATH = "/models"
/** Minimum client_version any ChatGPT-account model accepts (the
 *  `minimal_client_version` field is `"0.0.1"` for every model in the catalog
 *  as of 2026-05). Sent as a required query param on `/codex/models`; without
 *  it backend returns 400 `Field required`. Probe-verified, not guessed. */
const MODELS_CLIENT_VERSION = "0.0.1"

/** Cached `/models` catalog (memo). Keyed by `account_id` so multiple
 *  surfaces / accounts in one process keep separate caches. The catalog
 *  changes server-side rarely (model rollouts), so a 5-minute soft TTL
 *  amortises the round-trip without going stale across product launches. */
interface ModelCatalog {
  readonly models: readonly { readonly model: string; readonly is_default?: boolean }[]
  readonly fetchedAtMs: number
}
const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000
const modelCatalogCache = new Map<string, ModelCatalog>()

/** Test seam — clear catalog cache between tests. */
export const __resetCatalogCacheForTest = (): void => {
  modelCatalogCache.clear()
}

export interface ChatGPTOAuthConfig {
  readonly model: string
  /** Env source for resolveOAuthConfig + token path. The composition root
   *  passes its already-loaded env (mirrors the factory's `EnvLike`
   *  pattern). */
  readonly env: Record<string, string | undefined>
  /** Test seam: override fetch (mock SSE bodies). */
  readonly fetchImpl?: FetchLike
  /** Test seam: pin time so refresh / expiry checks are deterministic. */
  readonly nowMs?: () => number
}

const statusToKind = (status: number): LLMErrorKind => {
  if (status === 401 || status === 403) return "auth"
  if (status === 429) return "rate_limit"
  if (status === 404) return "not_found"
  if (status === 400 || status === 422) return "bad_request"
  if (status >= 500 && status < 600) return "server_error"
  return "unknown"
}

/** Refresh the access token if it expires within this many ms — a 1-minute
 *  cushion absorbs clock skew between the client and the OAuth issuer and
 *  the latency budget of an in-flight streaming request, so a token that
 *  passes the check here is guaranteed valid through the wire call. */
const TOKEN_REFRESH_SKEW_MS = 60_000

export class ChatGPTOAuthAdapter implements LLMPort {
  readonly model: string
  /** Pinned provider id for the pre-stream `llm_request` marker. */
  readonly provider = "chatgpt-oauth"
  /** Human-readable auth-mode label — distinguishes the subscription path
   *  from a BYOK API-key call in the CLI runtime banner + `/status`. */
  readonly authMode = "ChatGPT subscription"
  private readonly env: Record<string, string | undefined>
  private readonly fetchImpl: FetchLike
  private readonly nowMs: () => number

  constructor(config: ChatGPTOAuthConfig) {
    this.model = config.model
    this.env = config.env
    this.fetchImpl = config.fetchImpl ?? ((url, init) => fetch(url, init))
    this.nowMs = config.nowMs ?? (() => Date.now())
  }

  private async ensureFreshToken(): Promise<TokenRecord> {
    const home = resolveQuantaHome(this.env)
    const path = chatgptTokenPath(home)
    const rec = await readToken(path)
    if (rec === null) {
      throw new LLMError("ChatGPT-OAuth: not signed in — run `quanta /login --chatgpt` first.", {
        kind: "auth",
        provider: "chatgpt-oauth",
      })
    }
    if (!isExpired(rec, this.nowMs(), TOKEN_REFRESH_SKEW_MS)) return rec
    const cfg = resolveOAuthConfig(this.env)
    try {
      const next = await refreshToken({
        cfg,
        current: rec,
        fetchImpl: this.fetchImpl,
        nowMs: this.nowMs,
      })
      await writeToken(path, next)
      return next
    } catch (e) {
      throw new LLMError(
        `ChatGPT-OAuth token refresh failed: ${(e as Error).message}. ` +
          "Run `quanta /login --chatgpt` to sign in again.",
        { kind: "auth", provider: "chatgpt-oauth", cause: e },
      )
    }
  }

  /** Fetch (or reuse cached) `/codex/models` catalog. This is how Codex CLI
   *  itself discovers which models the user's auth/plan actually permits
   *  (see `codex-rs/model-provider/src/models_endpoint.rs:MODELS_ENDPOINT`).
   *  Without this probe, we'd hardcode a slug the backend rejects for the
   *  ChatGPT-account auth path — the exact RCA of the
   *  "'gpt-5-codex' model is not supported when using Codex with a ChatGPT
   *  account" 400. */
  private async fetchModelCatalog(
    baseURL: string,
    token: TokenRecord,
    cfg: ReturnType<typeof resolveOAuthConfig>,
  ): Promise<ModelCatalog> {
    const key = token.account_id ?? "default"
    const cached = modelCatalogCache.get(key)
    if (cached !== undefined && this.nowMs() - cached.fetchedAtMs < MODEL_CATALOG_TTL_MS) {
      return cached
    }
    const headers: Record<string, string> = {
      accept: "application/json",
      authorization: `Bearer ${token.access_token}`,
      "oai-product-sku": cfg.sku,
      originator: cfg.originator,
    }
    if (token.account_id !== undefined) headers["chatgpt-account-id"] = token.account_id

    const res = await this.fetchImpl(
      `${baseURL}${MODELS_PATH}?client_version=${encodeURIComponent(MODELS_CLIENT_VERSION)}`,
      { method: "GET", headers },
    )
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new LLMError(
        `chatgpt-oauth /models lookup failed: ${res.status} ${res.statusText}` +
          (text ? ` — ${text.slice(0, 200)}` : ""),
        { kind: statusToKind(res.status), statusCode: res.status, provider: "chatgpt-oauth" },
      )
    }
    const parsed = (await res.json().catch(() => null)) as unknown
    const models = extractCatalogModels(parsed)
    if (models.length === 0) {
      throw new LLMError(
        "chatgpt-oauth /models returned an empty catalog — your account may not have model access yet.",
        { kind: "auth", provider: "chatgpt-oauth" },
      )
    }
    const catalog: ModelCatalog = { models, fetchedAtMs: this.nowMs() }
    modelCatalogCache.set(key, catalog)
    return catalog
  }

  /** Pick the model to actually send. Order:
   *   1. If the configured model is in the catalog → use it (caller intent).
   *   2. Else if catalog has an `is_default: true` entry → use that.
   *   3. Else → use the first catalog entry.
   *  Returns `[resolvedModel, swappedFromCallerModel]` so the wire layer
   *  can stamp the actual model on the usage event. */
  private resolveModelFromCatalog(catalog: ModelCatalog): { model: string; swappedFrom?: string } {
    const wanted = this.model
    const slugs = catalog.models.map((m) => m.model)
    if (slugs.includes(wanted)) return { model: wanted }
    const isDefault = catalog.models.find((m) => m.is_default === true)
    const fallback = isDefault?.model ?? catalog.models[0]?.model
    if (fallback === undefined) {
      throw new LLMError(
        `chatgpt-oauth: configured model "${wanted}" not in catalog and no default available.`,
        { kind: "bad_request", provider: "chatgpt-oauth" },
      )
    }
    return { model: fallback, swappedFrom: wanted }
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const token = await this.ensureFreshToken()
    const cfg = resolveOAuthConfig(this.env)
    const baseURL = cfg.apiBase.endsWith("/codex") ? cfg.apiBase : `${cfg.apiBase}/codex`

    const catalog = await this.fetchModelCatalog(baseURL, token, cfg)
    const resolved = this.resolveModelFromCatalog(catalog)
    const effectiveModel = resolved.model

    const url = `${baseURL}${RESPONSES_PATH}`
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "text/event-stream",
      authorization: `Bearer ${token.access_token}`,
      "oai-product-sku": cfg.sku,
      originator: cfg.originator,
    }
    if (token.account_id !== undefined) {
      headers["chatgpt-account-id"] = token.account_id
    }

    const body = buildResponsesBody(input, effectiveModel)

    // DEBUG: dump request body shape (truncate image data URLs) so we can
    // see whether `input_image` parts are reaching the wire. Remove once
    // vision is verified end-to-end.
    if (process.env.QUANTA_DEBUG_OAUTH === "1") {
      const debugJson = JSON.stringify(body, (_k, v) => {
        if (typeof v === "string" && v.startsWith("data:") && v.length > 80) {
          return `${v.slice(0, 60)}…[${v.length} chars]`
        }
        return v
      })
      process.stderr.write(`[oauth body] ${debugJson}\n`)
    }

    // Stamp the actual provider wire boundary after token/catalog preflight.
    input.turnTimingCapture?.markRequestSent()
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    })

    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new LLMError(
        `chatgpt-oauth request failed: ${res.status} ${res.statusText}` +
          (text ? ` — ${text.slice(0, 200)}` : ""),
        {
          kind: statusToKind(res.status),
          statusCode: res.status,
          provider: "chatgpt-oauth",
        },
      )
    }

    if (res.body === null) {
      throw new LLMError("chatgpt-oauth response has no body", {
        kind: "stream_corrupt",
        provider: "chatgpt-oauth",
      })
    }

    // ADR-0234: thread the per-call spinner-stall tick hook into the SSE
    // parser. This adapter does NOT wrap with `withStreamTimeout` (it parses
    // raw fetch SSE itself), so the parser carries the same swallow-policy
    // locally — a faulty surface detector MUST NOT poison the live producer.
    // Absent ⇒ parser sees `undefined` and skips the call (byte-identical
    // to pre-feature).
    yield* parseSSE(res.body, effectiveModel, input.onChunk)
  }
}

/** Pull the model list out of the catalog response.
 *
 *  Probe-verified response shape (chatgpt.com/backend-api/codex/models on a
 *  Pro account, 2026-05-23):
 *    {
 *      "models": [
 *        {
 *          "slug": "gpt-5.2",
 *          "display_name": "gpt-5.2",
 *          "visibility": "list" | "hide" | "none",
 *          "priority": 29,
 *          ...
 *        }
 *      ]
 *    }
 *
 *  The field that carries the wire model name is **`slug`** — NOT `model`
 *  (Codex's older `ModelPreset` typing uses `model`, but the live HTTP
 *  response uses `slug`). Accept both for forward-compat. Skip entries with
 *  `visibility: "hide" | "none"` so we never propose a model the picker
 *  hides. Sort by `priority` ascending so the first entry is the
 *  backend's preferred default (mirrors Codex's
 *  `remote_models.sort_by(|a, b| a.priority.cmp(&b.priority))`). */
const extractCatalogModels = (
  raw: unknown,
): readonly { readonly model: string; readonly is_default?: boolean }[] => {
  const list = Array.isArray(raw)
    ? raw
    : isObject(raw) && Array.isArray(raw.models)
      ? raw.models
      : isObject(raw) && Array.isArray(raw.data)
        ? raw.data
        : []
  const rows: { model: string; priority: number; is_default?: boolean }[] = []
  for (const item of list) {
    if (!isObject(item)) continue
    if (typeof item.visibility === "string" && item.visibility !== "list") continue
    const slug =
      typeof item.slug === "string"
        ? item.slug
        : typeof item.model === "string"
          ? item.model
          : typeof item.id === "string"
            ? item.id
            : null
    if (slug === null) continue
    const priority = typeof item.priority === "number" ? item.priority : Number.MAX_SAFE_INTEGER
    rows.push({
      model: slug,
      priority,
      ...(item.is_default === true ? { is_default: true } : {}),
    })
  }
  rows.sort((a, b) => a.priority - b.priority)
  return rows.map(({ model, is_default }) =>
    is_default === true ? { model, is_default: true } : { model },
  )
}

// ────────────────────────────────────────────────────────────────────────
// StreamInput → Responses API request body
// ────────────────────────────────────────────────────────────────────────

interface ResponsesInputItem {
  readonly type: string
  readonly [k: string]: unknown
}

const flattenSystem = (s: SystemPromptInput | undefined): string => {
  if (s === undefined) return ""
  if (typeof s === "string") return s
  return s.map((b) => b.text).join("\n\n")
}

const messageToItems = (m: Message): ResponsesInputItem[] => {
  const items: ResponsesInputItem[] = []
  const textParts: ResponsesInputItem[] = []
  for (const b of m.content) {
    if (b.type === "text") {
      textParts.push({
        type: m.role === "assistant" ? "output_text" : "input_text",
        text: b.text,
      })
    } else if (b.type === "tool_use") {
      items.push({
        type: "function_call",
        call_id: b.id,
        name: b.name,
        arguments: JSON.stringify(b.input ?? {}),
      })
    } else if (b.type === "tool_result") {
      // ADR-0126: `b.contentBlocks` (when present) carries image attachments.
      // The Responses API `function_call_output.output` field is string-only
      // — use the legacy `b.content` view; structured form ignored at this
      // surface (vision input would ride elsewhere). Byte-identical.
      items.push({
        type: "function_call_output",
        call_id: b.tool_use_id,
        output: b.content,
      })
    } else if (b.type === "image" && m.role === "user") {
      // Vision input — Responses API `input_image` part. `detail: "high"`
      // forces the model to actually attend to the image (some configs
      // treat absent `detail` as "skip" on large attachments).
      textParts.push({
        type: "input_image",
        image_url: `data:${b.mediaType};base64,${b.data}`,
      } as unknown as ResponsesInputItem)
    }
    // thinking blocks: not surfaced on the Responses input shape — Phase-2.1
    // follow-up.
  }
  if (textParts.length > 0) {
    items.push({ type: "message", role: m.role, content: textParts })
  }
  return items
}

const toolsToResponsesShape = (tools: readonly ToolSchema[]): readonly ResponsesInputItem[] =>
  tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }))

/** Fallback instruction string used when the caller provides no `system`.
 *  The Responses API rejects the request with HTTP 400 "Instructions are
 *  required" when this field is absent or empty (probe-verified
 *  2026-05-23), so a non-empty default is mandatory. */
const DEFAULT_INSTRUCTIONS = "You are a helpful assistant."

export const buildResponsesBody = (input: StreamInput, model: string): Record<string, unknown> => {
  const items: ResponsesInputItem[] = []
  for (const m of input.messages) {
    for (const it of messageToItems(m)) items.push(it)
  }
  const sys = flattenSystem(input.system)
  // ChatGPT-account `/responses` REQUIRES a non-empty `instructions` field —
  // the system prompt goes here, NOT into the input array as a
  // `role:"system"` message (probe-verified 400 otherwise). Empty caller
  // system ⇒ minimal default so the request still composes.
  const instructions = sys !== "" ? sys : DEFAULT_INSTRUCTIONS
  // Service-tier knob — matches ChatGPT's "Standard / Fast" toggle. Codex
  // sends this same field on `/codex/responses`. Values:
  //   auto      — let backend pick (default)
  //   default   — standard tier
  //   flex      — slower, cheaper queue
  //   priority  — ChatGPT's "Fast" mode (1.5× speed, more usage)
  //   scale     — high-throughput tier
  // Set via `QUANTA_SERVICE_TIER`; absent ⇒ omitted (backend default).
  // `QUANTA_FAST=1` is shorthand for `priority`.
  const tierRaw = process.env.QUANTA_SERVICE_TIER
  const tierFromFast = process.env.QUANTA_FAST === "1" ? "priority" : undefined
  const serviceTier = tierFromFast ?? tierRaw

  // Reasoning effort knob — matches ChatGPT UI's "Low / Medium / High /
  // Extra High" picker. Responses API spec: `reasoning: { effort }`.
  // Values: "minimal" | "low" | "medium" | "high"  (Extra High maps to
  // "high" on the OpenAI API — there is no distinct "extra" value on
  // the wire). Set via `QUANTA_REASONING_EFFORT`; absent ⇒ omitted
  // (backend / model default).
  const effortRaw = process.env.QUANTA_REASONING_EFFORT?.toLowerCase()
  const reasoningEffort =
    effortRaw === "minimal" ||
    effortRaw === "low" ||
    effortRaw === "medium" ||
    effortRaw === "high"
      ? effortRaw
      : undefined

  return {
    model,
    instructions,
    input: items,
    stream: true,
    tools: toolsToResponsesShape(input.tools),
    parallel_tool_calls: false,
    store: false,
    ...(serviceTier !== undefined && serviceTier.length > 0
      ? { service_tier: serviceTier }
      : {}),
    ...(reasoningEffort !== undefined
      ? { reasoning: { effort: reasoningEffort } }
      : {}),
  }
}

// ────────────────────────────────────────────────────────────────────────
// SSE parser
// ────────────────────────────────────────────────────────────────────────

interface SSEEvent {
  readonly event?: string
  readonly data: string
}

const parseSSEEvent = (raw: string): SSEEvent | null => {
  let event: string | undefined
  const dataParts: string[] = []
  for (const line of raw.split("\n")) {
    if (line.startsWith(":")) continue
    if (line.startsWith("event:")) event = line.slice(6).trim()
    else if (line.startsWith("data:")) dataParts.push(line.slice(5).replace(/^ /, ""))
  }
  if (dataParts.length === 0) return null
  return event !== undefined
    ? { event, data: dataParts.join("\n") }
    : { data: dataParts.join("\n") }
}

async function* parseSSEStream(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buf = ""
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let i: number
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const raw = buf.slice(0, i)
        buf = buf.slice(i + 2)
        const ev = parseSSEEvent(raw)
        if (ev !== null) yield ev
      }
    }
    if (buf.trim() !== "") {
      const ev = parseSSEEvent(buf)
      if (ev !== null) yield ev
    }
  } finally {
    reader.releaseLock()
  }
}

interface ResponsesEvent {
  readonly type?: string
  readonly delta?: string
  readonly item?: {
    type?: string
    id?: string
    call_id?: string
    name?: string
    arguments?: string
  }
  readonly response?: {
    model?: string
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cached_input_tokens?: number
    }
  }
  readonly item_id?: string
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object"

/** ADR-0234: invoke the optional onChunk hook, swallowing any error so a
 *  faulty spinner-stall detector never poisons the SSE producer. Mirrors
 *  `notifyChunkArrival` in `src/llm/stream-timeout.ts` — same contract,
 *  local to this adapter because it parses SSE itself rather than wrapping
 *  with `withStreamTimeout`. */
const notifyChunkArrival = (onChunk: (() => void) | undefined): void => {
  if (onChunk === undefined) return
  try {
    onChunk()
  } catch {
    // Intentionally silent — detector book-keeping must never break the
    // producer.
  }
}

async function* parseSSE(
  body: ReadableStream<Uint8Array>,
  fallbackModel: string,
  onChunk?: () => void,
): AsyncGenerator<StreamEvent> {
  const toolCalls = new Map<string, { name: string; args: string }>()
  let usage: {
    input: number
    output: number
    cached?: number
    model?: string
  } | null = null

  for await (const sseEv of parseSSEStream(body)) {
    if (sseEv.data === "[DONE]") break
    // ADR-0234: a frame arrived from the wire — bump the per-correlation
    // `lastEventMs` even when we end up `continue`-ing past it (e.g.
    // heartbeat / unknown event types). Anchored BEFORE the JSON parse so
    // a malformed frame that throws still counts as "the stream is alive".
    notifyChunkArrival(onChunk)
    let json: unknown
    try {
      json = JSON.parse(sseEv.data)
    } catch (e) {
      // Wire-level corruption: a `data:` frame whose body is not valid JSON
      // is unrecoverable for this stream. Other adapters route comparable
      // SDK-thrown wire errors through `LLMError.fromSdkError` so the typed
      // `.kind`/`.statusCode` flow is uniform across providers. Do the same
      // here instead of silently swallowing the frame (and risking dropped
      // tool calls / silent truncation of the response).
      throw LLMError.fromSdkError("chatgpt-oauth", e, "chatgpt-oauth SSE parse error")
    }
    if (!isObject(json)) continue
    const ev = json as ResponsesEvent
    const t = ev.type

    if (t === "response.output_text.delta") {
      if (typeof ev.delta === "string" && ev.delta !== "") {
        yield { type: "text_delta", delta: ev.delta }
      }
      continue
    }

    if (t === "response.reasoning_summary_text.delta" || t === "response.reasoning.delta") {
      if (typeof ev.delta === "string" && ev.delta !== "") {
        yield { type: "thinking_delta", text: ev.delta }
      }
      continue
    }

    if (t === "response.output_item.added" && ev.item?.type === "function_call") {
      const id = ev.item.call_id ?? ev.item.id ?? ""
      const name = ev.item.name ?? ""
      if (id !== "" && name !== "") {
        toolCalls.set(id, { name, args: "" })
        yield { type: "tool_use_start", id, name }
      }
      continue
    }

    if (t === "response.function_call_arguments.delta") {
      const id = ev.item_id ?? ""
      const delta = ev.delta ?? ""
      if (id !== "" && delta !== "") {
        const slot = toolCalls.get(id)
        if (slot) slot.args += delta
        yield { type: "tool_use_delta", id, delta }
      }
      continue
    }

    if (t === "response.output_item.done" && ev.item?.type === "function_call") {
      const id = ev.item.call_id ?? ev.item.id ?? ""
      const slot = toolCalls.get(id)
      const raw = ev.item.arguments ?? slot?.args ?? "{}"
      const input = parseToolInputOrThrow(raw, id, "chatgpt-oauth", "with-cause")
      yield { type: "tool_use_end", id, input }
      toolCalls.delete(id)
      continue
    }

    if (t === "response.completed") {
      const u = ev.response?.usage
      if (u !== undefined) {
        usage = {
          input: u.input_tokens ?? 0,
          output: u.output_tokens ?? 0,
          ...(typeof u.cached_input_tokens === "number" ? { cached: u.cached_input_tokens } : {}),
          ...(typeof ev.response?.model === "string" ? { model: ev.response.model } : {}),
        }
      }
      continue
    }

    if (t === "response.failed" || t === "response.incomplete") {
      yield {
        type: "message_stop",
        stop_reason: t === "response.failed" ? "error" : "incomplete",
      }
      return
    }
  }

  if (usage !== null) {
    yield {
      type: "usage",
      inputTokens: usage.input,
      outputTokens: usage.output,
      ...(usage.cached !== undefined ? { cacheReadTokens: usage.cached } : {}),
      model: usage.model ?? fallbackModel,
    }
  }
  yield { type: "message_stop", stop_reason: "end_turn" }
}
