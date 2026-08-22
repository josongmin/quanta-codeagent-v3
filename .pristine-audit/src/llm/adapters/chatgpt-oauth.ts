/** ChatGPT-OAuth adapter (ADR-0094 Phase 2).
 *
 *  Calls `${apiBase}/responses` with the disk-stored OAuth bearer instead of
 *  an API key. `apiBase` defaults to `https://chatgpt.com/backend-api/codex`
 *  — the Responses-API endpoint the OSS Codex CLI uses for ChatGPT
 *  subscription traffic. The wire protocol is Server-Sent Events; we parse
 *  the canonical `response.*` event names and map them to {@link StreamEvent}.
 *
 *  Token freshness is enforced at the top of each `stream()` call:
 *    1. Read token from disk (`~/.quanta/auth/chatgpt.json`), falling back
 *       to Codex's `~/.codex/auth.json` ChatGPT bundle when quanta has not
 *       persisted its own copy yet.
 *    2. If `expires_at` is within the next 60 s, run a refresh first and
 *       persist the new bundle to quanta's canonical token path. Refresh
 *       shares an in-flight guard with the auth module so concurrent streams
 *       collapse to one issuer hit.
 *    3. POST with `Authorization: Bearer ${access_token}` +
 *       `ChatGPT-Account-Id` + `OAI-Product-Sku` + `originator`.
 *
 *  401 mid-stream ⇒ typed `auth` LLMError. The retry/fallback layer
 *  (LLMErrorKind doc) refuses to retry or fall back on `auth` — the user is
 *  told to relogin instead.
 */

import {
  chatgptTokenPath,
  deleteToken,
  type FetchLike,
  isExpired,
  readResolvedToken,
  refreshToken,
  resolveOAuthConfig,
  resolveQuantaHome,
  TokenExchangeError,
  type TokenRecord,
  writeToken,
} from "@/auth/chatgpt-oauth"
import { errMessage, LLMError, type LLMErrorKind, logger } from "@/shared"
import { buildResponsesBody } from "../openai-responses-wire"
import type { LLMPort } from "../ports"
import { resolveDeliverableReasoningEffort } from "../reasoning-effort"
import {
  defaultResponsesReasoningCarryoverStore,
  prepareResponsesContinuationRequest,
  type ResponsesReasoningCarryoverStore,
  responsesStatusToKind,
  streamResponsesSurface,
} from "../responses-stream"
import type { StreamEvent, StreamInput } from "../types"
import { type AdapterStreamTimeoutConfig, resolveAdapterStreamTimeouts } from "./shared"

const RESPONSES_PATH = "/responses"
const MODELS_PATH = "/models"
/** Client version advertised to `/codex/models` (required query param —
 *  without it the backend returns 400 `Field required`).
 *
 *  The backend gates each model on its `minimal_client_version` and returns
 *  ONLY models whose minimum is `<=` the value we send. The earlier "0.0.1"
 *  assumption (every model's minimum was 0.0.1 as of 2026-05) went stale: by
 *  2026-06 live models require 0.98.0–0.124.0 (gpt-5.5 needs 0.124.0), so a
 *  0.0.1 probe filtered the entire catalog out and surfaced as the misleading
 *  "empty catalog — account may not have model access" error. We pin a current
 *  Codex CLI release so newly-rolled models stay visible; bump it when the
 *  backend gates a model behind a higher minimum. aug-19: bumped 0.131.0 →
 *  0.146.0 (current Codex CLI release) so models gated behind a higher minimum
 *  (e.g. a gpt-5.6-family slug) surface instead of being filtered out.
 *  Probe-verified 2026-06-02 at 0.131.0. */
const MODELS_CLIENT_VERSION = "0.146.0"

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
  /** OpenAI `service_tier` — env-derived at the composition root and passed
   *  in as plain config (this adapter never reads process.env). */
  readonly serviceTier?: string
  /** Reasoning effort — env-derived at the composition root and passed in. */
  readonly reasoningEffort?: string
  /** Reasoning summary request (`QUANTA_REASONING_SUMMARY`) — env-derived at the
   *  composition root. True ⇒ `reasoning.summary:"auto"` on the body. */
  readonly reasoningSummary?: boolean
  /** Reasoning summary detail level (`QUANTA_REASONING_SUMMARY_DETAIL`) —
   *  env-derived at the composition root. `"detailed"` ⇒ max CoT visibility.
   *  Omitted ⇒ `"auto"` (wire default). */
  readonly reasoningSummaryDetail?: "auto" | "concise" | "detailed"
  /** Reasoning output verbosity (`QUANTA_REASONING_VERBOSITY`) — env-derived at
   *  the composition root. Threaded onto the body as `text.verbosity`. */
  readonly reasoningVerbosity?: string
  /** H15 — o-series reasoning carry-over (`QUANTA_REASONING_CARRYOVER`). Absent/
   *  false ⇒ byte-identical (thinking dropped, no re-emit). */
  readonly reasoningCarryover?: boolean
  /** When true, the prepared request body is logged (truncating long data:
   *  URLs) via the shared logger at debug level. Env-derived
   *  (`QUANTA_DEBUG_OAUTH`) at the composition root — the slice itself takes a
   *  plain boolean and routes through the logger port, never raw stderr. */
  readonly debugOAuth?: boolean
}

/** Refresh the access token if it expires within this many ms — a 1-minute
 *  cushion absorbs clock skew between the client and the OAuth issuer and
 *  the latency budget of an in-flight streaming request, so a token that
 *  passes the check here is guaranteed valid through the wire call. */
const TOKEN_REFRESH_SKEW_MS = 60_000

/** Jun-10 silent-failure audit #15 — classify a token-REFRESH failure into a
 *  typed LLMError shape by branching on the TYPED statusCode, never the
 *  message. `invalid_grant`/401 is the ONLY re-auth ("run /login") trigger
 *  (RFC 6749 §5.2: `invalid_grant` = the refresh token is revoked/expired);
 *  everything else keeps its transient kind so the retry/fallback policy can
 *  route it instead of fatally killing the turn with a false "run /login". */
const classifyRefreshFailure = (
  e: unknown,
): { kind: LLMErrorKind; statusCode?: number; retryAfterMs?: number; errorCode?: string } => {
  if (e instanceof TokenExchangeError) {
    const status = e.statusCode
    if (status === 401 || e.errorCode === "invalid_grant") {
      // Thread the OAuth `error` code so the token-purge predicate can fire on
      // an explicit `invalid_grant` even when the issuer returned it at 400
      // (RFC 6749 §5.2 allows 400) — D6: a revoked bundle must be deleted, not
      // re-refreshed forever, regardless of the status code it arrived on.
      return {
        kind: "auth",
        statusCode: status,
        ...(e.errorCode !== undefined ? { errorCode: e.errorCode } : {}),
      }
    }
    if (status === 429) {
      return {
        kind: "rate_limit",
        statusCode: status,
        ...(e.retryAfterMs !== undefined ? { retryAfterMs: e.retryAfterMs } : {}),
      }
    }
    if (status >= 500 && status < 600) return { kind: "server_error", statusCode: status }
    if (status === 400 || status === 422) return { kind: "bad_request", statusCode: status }
    // D8 — a 403 at the token endpoint (account suspended, scope/grant revoked,
    // non-`invalid_grant`) is an auth problem: route it to the "run /login"
    // advice + purge path rather than the catch-all `unknown` (which gave no
    // remediation hint and left the dead bundle on disk).
    if (status === 403) return { kind: "auth", statusCode: status }
    // statusCode 0 = response-shape failure (malformed 2xx body) and any other
    // unmapped status: NOT a revocation — never re-classify as fatal auth.
    return { kind: "unknown", statusCode: status }
  }
  // Non-HTTP failure: the fetch itself threw (DNS/socket) or the post-refresh
  // disk persist failed — transient, retry-eligible, never a re-auth trigger.
  return { kind: "network" }
}

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
  private readonly serviceTier: string | undefined
  private readonly reasoningEffort: string | undefined
  private readonly reasoningSummary: boolean
  private readonly reasoningSummaryDetail: "auto" | "concise" | "detailed" | undefined
  private readonly reasoningVerbosity: string | undefined
  /** H15 — per-session reasoning carry-over: flag + ONE store for the adapter's
   *  lifetime (off ⇒ undefined ⇒ byte-identical). */
  private readonly reasoningCarryover: boolean
  private readonly reasoningCarryoverStore: ResponsesReasoningCarryoverStore | undefined
  private readonly debugOAuth: boolean
  /** D7 (rounds-2/3 audit) — in-memory fallback for a refreshed token whose
   *  disk PERSIST failed. Set ONLY on a write failure: the on-disk copy is then
   *  stale, so without this every subsequent call would re-read the expired disk
   *  token and re-refresh (issuer-budget churn). Cleared on a successful persist
   *  so the normal path keeps re-reading disk (picks up other-process rotations). */
  private memTokenFallback: TokenRecord | undefined

  constructor(config: ChatGPTOAuthConfig) {
    this.model = config.model
    this.env = config.env
    this.fetchImpl = config.fetchImpl ?? ((url, init) => fetch(url, init))
    this.nowMs = config.nowMs ?? (() => Date.now())
    this.maxTokens = config.maxTokens
    this.streamTimeoutMs = resolveAdapterStreamTimeouts(config)
    this.serviceTier = config.serviceTier
    // Fail BEFORE the first model invocation (see the OpenAI-Responses adapter):
    // a misconfigured effort stops the run from starting instead of shipping the
    // provider default under a receipt claiming the requested value.
    this.reasoningEffort = resolveDeliverableReasoningEffort(
      config.reasoningEffort,
      "chatgpt-oauth",
    )
    this.reasoningSummary = config.reasoningSummary === true
    this.reasoningSummaryDetail = config.reasoningSummaryDetail
    this.reasoningVerbosity = config.reasoningVerbosity
    this.reasoningCarryover = config.reasoningCarryover === true
    this.reasoningCarryoverStore = this.reasoningCarryover
      ? defaultResponsesReasoningCarryoverStore()
      : undefined
    this.debugOAuth = config.debugOAuth ?? false
  }

  private async ensureFreshToken(): Promise<TokenRecord> {
    const home = resolveQuantaHome(this.env)
    const path = chatgptTokenPath(home)
    // D7 fallback: a previously-refreshed token whose disk persist failed is the
    // freshest known good — reuse it until it expires rather than re-refreshing
    // off the stale disk copy on every call. (Normal path leaves this undefined.)
    if (this.memTokenFallback !== undefined) {
      if (!isExpired(this.memTokenFallback, this.nowMs(), TOKEN_REFRESH_SKEW_MS)) {
        return this.memTokenFallback
      }
      this.memTokenFallback = undefined
    }
    const resolved = await readResolvedToken(this.env)
    if (resolved === null) {
      throw new LLMError(
        "ChatGPT-OAuth: not signed in — run `quanta /login --chatgpt`, or sign in to Codex first.",
        {
          kind: "auth",
          provider: "chatgpt-oauth",
        },
      )
    }
    const rec = resolved.record
    if (!isExpired(rec, this.nowMs(), TOKEN_REFRESH_SKEW_MS)) return rec
    const cfg = resolveOAuthConfig(this.env)
    let next: TokenRecord
    try {
      next = await refreshToken({
        cfg,
        current: rec,
        fetchImpl: this.fetchImpl,
        nowMs: this.nowMs,
      })
    } catch (e) {
      // Audit #15 — branch on the TYPED statusCode: only invalid_grant/401/403
      // means "the refresh token is dead, re-login"; a 429/5xx/network blip
      // keeps its transient kind so retry/fallback can route it.
      const classified = classifyRefreshFailure(e)
      const advice =
        classified.kind === "auth"
          ? " Run `quanta /login --chatgpt` or sign in to Codex again."
          : ""
      throw new LLMError(`ChatGPT-OAuth token refresh failed: ${errMessage(e)}.${advice}`, {
        kind: classified.kind,
        provider: "chatgpt-oauth",
        cause: e,
        ...(classified.statusCode !== undefined ? { statusCode: classified.statusCode } : {}),
        ...(classified.retryAfterMs !== undefined ? { retryAfterMs: classified.retryAfterMs } : {}),
        ...(classified.errorCode !== undefined ? { providerCode: classified.errorCode } : {}),
      })
    }
    // D7 — the refresh itself SUCCEEDED; the new bundle is valid in memory. The
    // on-disk copy is a cache (it lets the NEXT process reuse the token), NOT
    // load-bearing for THIS call. A persist failure (EACCES, full disk, etc.)
    // must NOT discard the fresh token and re-classify the success as a
    // retryable "network" error — that burned the issuer budget on a full
    // re-refresh ×maxRetries and threw away a perfectly good access token.
    // Log + proceed on the in-memory token.
    try {
      await writeToken(path, next)
      this.memTokenFallback = undefined // disk is fresh — keep re-reading it.
    } catch (e) {
      // Disk copy is now stale; hold the fresh token in memory so subsequent
      // calls in THIS process reuse it instead of re-refreshing off stale disk.
      this.memTokenFallback = next
      logger.warn(
        `chatgpt-oauth: refreshed token persist failed (${errMessage(e)}) — ` +
          "proceeding with the in-memory token; will reuse it until it expires.",
      )
    }
    return next
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

  /** Best-effort purge of an invalidated quanta-managed token. Returns
   *  `true` when our copy was deleted, `false` when there was nothing to
   *  delete OR the token is owned by another tool (Codex) — in that case
   *  we MUST NOT delete it, the user has to re-sign-in through that tool. */
  private async purgeQuantaTokenBestEffort(): Promise<boolean> {
    try {
      const resolved = await readResolvedToken(this.env)
      if (resolved === null) return false
      if (resolved.source !== "quanta") return false
      await deleteToken(resolved.path)
      return true
    } catch {
      // Filesystem hiccup — surface the original 401 to the user instead
      // of masking it with a delete error. The next call will try again.
      return false
    }
  }

  /** True for a server-side token-INVALIDATION — the on-disk bundle is dead
   *  weight and must be purged so the router falls through instead of looping a
   *  refresh on a revoked grant (D6). Fires on:
   *    - statusCode 401 (mid-stream invalidation, or a 401 refresh failure), OR
   *    - statusCode 400/403 carrying `providerCode === "invalid_grant"` — the
   *      classifier (`classifyRefreshFailure`) already calls these `kind:"auth"`,
   *      so the purge predicate MUST agree or the revoked bundle survives and
   *      re-refreshes a dead token until the user manually `/login`s.
   *  Deliberately NOT fired for other `kind:"auth"` errors with no invalidation
   *  signal ("not signed in" / "empty catalog") — there's nothing wrong with the
   *  bundle there, so we keep it. */
  private static isInvalidatedAuthError(error: unknown): boolean {
    if (!(error instanceof LLMError)) return false
    if (error.kind !== "auth") return false
    return error.statusCode === 401 || error.providerCode === "invalid_grant"
  }

  /** H15 — the carry-over flag+store fragment, present ONLY when the gate is on
   *  (off ⇒ `{}` ⇒ byte-identical). Extracted so `stream` stays under the
   *  cognitive-complexity gate. */
  private carryoverOpts():
    | { reasoningCarryover: true; reasoningCarryoverStore: ResponsesReasoningCarryoverStore }
    | Record<string, never> {
    return this.reasoningCarryover && this.reasoningCarryoverStore !== undefined
      ? { reasoningCarryover: true, reasoningCarryoverStore: this.reasoningCarryoverStore }
      : {}
  }

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    try {
      const token = await this.ensureFreshToken()
      const cfg = resolveOAuthConfig(this.env)
      const baseURL = cfg.apiBase.endsWith("/codex") ? cfg.apiBase : `${cfg.apiBase}/codex`

      const catalog = await this.fetchModelCatalog(baseURL, token, cfg)
      const resolved = this.resolveModelFromCatalog(catalog)
      const effectiveModel = resolved.model
      // Honor the documented contract: a silent model substitution is NOT
      // silent — surface which model actually ran so the user/operator can see
      // their configured model was unavailable in the catalog and a fallback
      // was chosen on their behalf.
      if (resolved.swappedFrom !== undefined) {
        logger.warn(
          `chatgpt-oauth: configured model "${resolved.swappedFrom}" not in catalog — ` +
            `running "${effectiveModel}" instead`,
        )
      }
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

      // H15 — carry-over flag+store only when the gate is on (off ⇒ byte-identical).
      const carryover = this.carryoverOpts()
      const prepared = prepareResponsesContinuationRequest({
        input,
        model: effectiveModel,
        transportId: "chatgpt-oauth",
        ...(this.maxTokens !== undefined ? { maxOutputTokens: this.maxTokens } : {}),
        ...(this.serviceTier !== undefined ? { serviceTier: this.serviceTier } : {}),
        ...(this.reasoningEffort !== undefined ? { reasoningEffort: this.reasoningEffort } : {}),
        ...(this.reasoningSummary ? { reasoningSummary: true } : {}),
        ...(this.reasoningSummaryDetail !== undefined
          ? { reasoningSummaryDetail: this.reasoningSummaryDetail }
          : {}),
        ...(this.reasoningVerbosity !== undefined
          ? { reasoningVerbosity: this.reasoningVerbosity }
          : {}),
        ...(continuationStore !== undefined ? { continuationStore } : {}),
        ...carryover,
      })

      if (this.debugOAuth) {
        const debugJson = JSON.stringify(prepared.body, (_k, v) => {
          if (typeof v === "string" && v.startsWith("data:") && v.length > 80) {
            return `${v.slice(0, 60)}…[${v.length} chars]`
          }
          return v
        })
        logger.debug(`[oauth body] ${debugJson}`)
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
        ...carryover,
        disableResumeOnStatuses: new Set([400, 422]),
      })
    } catch (error) {
      // Server-side token invalidation — happens when the user signs out from
      // chatgpt.com on another device, OpenAI force-rotates, or the refresh
      // grant is revoked (401, or 400/403 `invalid_grant`). The on-disk bundle
      // is dead weight at that point: every subsequent call would fail again
      // until `/login` overwrites it. Purge our copy proactively so the provider
      // router falls through to whatever else is configured (BYOK key,
      // anthropic, etc.) instead of looping on a dead token (D6).
      if (ChatGPTOAuthAdapter.isInvalidatedAuthError(error)) {
        const purged = await this.purgeQuantaTokenBestEffort()
        const hint = purged
          ? "Local token deleted — run /login to sign in again."
          : "Token is managed externally (e.g. Codex CLI) — sign out and back in there."
        const status = error instanceof LLMError ? error.statusCode : undefined
        throw new LLMError(
          `ChatGPT-OAuth token invalidated by server${status !== undefined ? ` (${status})` : ""}. ${hint}`,
          {
            kind: "auth",
            provider: "chatgpt-oauth",
            cause: error,
            ...(status !== undefined ? { statusCode: status } : {}),
          },
        )
      }
      throw error
    }
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
