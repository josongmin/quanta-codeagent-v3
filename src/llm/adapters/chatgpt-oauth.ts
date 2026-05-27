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
import { buildResponsesBody } from "../openai-responses-wire"
import type { LLMPort } from "../ports"
import { prepareResponsesContinuationRequest, responsesStatusToKind, streamResponsesSurface } from "../responses-stream"
import type { StreamEvent, StreamInput } from "../types"
import { resolveAdapterStreamTimeouts, type AdapterStreamTimeoutConfig } from "./shared"

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

export interface ChatGPTOAuthConfig extends AdapterStreamTimeoutConfig {
  readonly model: string
  /** Env source for resolveOAuthConfig + token path. The composition root
   *  passes its already-loaded env (mirrors the factory's `EnvLike`
   *  pattern). */
  readonly env: Record<string, string | undefined>
  /** Test seam: override fetch (mock SSE bodies). */
  readonly fetchImpl?: FetchLike
  /** Test seam: pin time so refresh / expiry checks are deterministic. */
  readonly nowMs?: () => number
  readonly maxTokens?: number
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
  readonly surfaceId = "openai-responses"
  readonly transportId = "chatgpt-oauth"
  /** Human-readable auth-mode label — distinguishes the subscription path
   *  from a BYOK API-key call in the CLI runtime banner + `/status`. */
  readonly authMode = "ChatGPT subscription"
  private readonly env: Record<string, string | undefined>
  private readonly fetchImpl: FetchLike
  private readonly nowMs: () => number
  private readonly maxTokens: number | undefined
  private readonly streamTimeoutMs: { firstChunkMs: number; idleMs: number }

  constructor(config: ChatGPTOAuthConfig) {
    this.model = config.model
    this.env = config.env
    this.fetchImpl = config.fetchImpl ?? ((url, init) => fetch(url, init))
    this.nowMs = config.nowMs ?? (() => Date.now())
    this.maxTokens = config.maxTokens
    this.streamTimeoutMs = resolveAdapterStreamTimeouts(config)
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
        {
          kind: responsesStatusToKind(res.status),
          statusCode: res.status,
          provider: "chatgpt-oauth",
        },
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
    const continuationStore = input.responsesContinuation?.store

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

    const prepared = prepareResponsesContinuationRequest({
      input,
      model: effectiveModel,
      transportId: "chatgpt-oauth",
      ...(this.maxTokens !== undefined ? { maxOutputTokens: this.maxTokens } : {}),
      ...(continuationStore !== undefined ? { continuationStore } : {}),
    })

    // DEBUG: dump request body shape (truncate image data URLs) so we can
    // see whether `input_image` parts are reaching the wire. Remove once
    // vision is verified end-to-end.
    if (process.env.QUANTA_DEBUG_OAUTH === "1") {
      const debugJson = JSON.stringify(prepared.body, (_k, v) => {
        if (typeof v === "string" && v.startsWith("data:") && v.length > 80) {
          return `${v.slice(0, 60)}…[${v.length} chars]`
        }
        return v
      })
      process.stderr.write(`[oauth body] ${debugJson}\n`)
    }

    yield* streamResponsesSurface({
      provider: "chatgpt-oauth",
      transportId: "chatgpt-oauth",
      model: effectiveModel,
      input,
      request: prepared,
      fetchImpl: this.fetchImpl,
      url,
      headers,
      timeoutMs: this.streamTimeoutMs,
      ...(continuationStore !== undefined ? { continuationStore } : {}),
      disableResumeOnStatuses: new Set([400, 422]),
    })
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

export { buildResponsesBody }
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object"
