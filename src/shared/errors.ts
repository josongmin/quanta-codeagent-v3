/**
 * ── Project error-handling convention ──────────────────────────────────────
 *
 * THROW (via the {@link QuantaError} hierarchy below) for exceptional /
 * programmer errors and unrecoverable faults — the agent, LLM and permission
 * slices follow this. RETURN `Result<T, E>` (`src/shared/types`) for EXPECTED
 * domain failures — tool-execution outcomes and input validation — which is
 * why the tool slice is Result-shaped. The split is by design; do not
 * mass-convert one to the other.
 *
 * Classify an external / SDK error EXACTLY ONCE, at the boundary
 * (e.g. {@link LLMError.fromSdkError}), into a discriminated `.kind`.
 * Downstream policy code branches on `.kind` (and `.statusCode`) — it must
 * NEVER re-parse `error.message` to recover meaning the boundary already
 * captured.
 * ───────────────────────────────────────────────────────────────────────────
 */

/** Base error carrying a stable machine-readable code. */
export class QuantaError extends Error {
  readonly code: string

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = new.target.name
    this.code = code
  }
}

/** Tool failed during execution (input was valid, runtime failed). */
export class ToolExecutionError extends QuantaError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("tool_execution", message, options)
  }
}

/** Tool input failed schema validation. */
export class ToolInputError extends QuantaError {
  constructor(message: string) {
    super("tool_input", message)
  }
}

/** Action blocked by the permission policy. */
export class PermissionDeniedError extends QuantaError {
  constructor(message: string) {
    super("permission_denied", message)
  }
}

/**
 * Structured classification of an `LLMError`. Replaces the prior
 * "string-substring match on `e.message`" pattern in `src/llm/fallback.ts`
 * and `src/agent/retry.ts`. Adapters classify ONCE at the boundary
 * (via {@link LLMError.fromSdkError}); retry/fallback callers branch on
 * `kind`/`statusCode` only.
 *
 * Categories (no overlap):
 *   - `overloaded`      Provider-capacity overflow (Anthropic 529, "overloaded_error").
 *                       Retrying the same provider is hopeless → fall back.
 *   - `rate_limit`      Per-account rate cap (HTTP 429). Same-turn retry w/ backoff.
 *   - `server_error`    Generic 5xx other than 529. Retry-eligible.
 *   - `network`         Transport failure (ECONNRESET, EPIPE, ETIMEDOUT, DNS).
 *                       Retry-eligible AND fall-back-eligible.
 *   - `auth`            HTTP 401/403. NEVER retry, NEVER fall back (every provider would fail too).
 *   - `bad_request`     HTTP 400/422 — caller bug. NEVER retry.
 *   - `not_found`       HTTP 404 — model/route missing. NEVER retry.
 *   - `not_implemented` Adapter is a deliberate stub (e.g. ADR-0094 Phase 1
 *                       `chatgpt-oauth`). Retry against the SAME provider is
 *                       hopeless (the stub will throw identically); fall back
 *                       to the next provider so the chain can still produce
 *                       output. Distinct from `bad_request` (caller bug) and
 *                       `auth` (every provider would fail too).
 *   - `stream_corrupt`  SDK shape drift / malformed tool-input JSON. NEVER silent retry.
 *   - `aborted`         AbortSignal fired. NEVER retry; propagate cause.
 *   - `unknown`         Last-resort bucket when no structured signal is available.
 *
 * Codex-spec additions (ADR-0214 — typed-error enum 11→16 absorption of Codex
 * 0.131.0-alpha.9's `CodexErr` taxonomy). These five kinds carry actionable
 * routing signal that the prior 11-kind set conflated into `unknown` or
 * `bad_request`. All five MUST be mapped explicitly by `recovery-router.ts`
 * (the exhaustiveness check in `codexSpecRoute` will fail compile if a new
 * kind is added without a route):
 *   - `context_window_exceeded`  Prompt > model context window. Same-turn
 *                                retry of the oversized prompt fails
 *                                identically → reactive compaction. Distinct
 *                                from `bad_request` (other 400s are caller
 *                                bugs, NOT compactable).
 *   - `cyber_policy`             Provider's safety/policy refusal that the
 *                                user (not the agent) must resolve.
 *                                Hand-off to HITL — neither retry nor swap
 *                                can recover.
 *   - `too_many_failed_attempts` Provider's "you've burned the retry budget"
 *                                signal. Already retried — must give up.
 *                                Distinct from `rate_limit` (which IS
 *                                retryable after backoff).
 *   - `thread_rollback_failed`   Server-side conversation/thread state
 *                                desync. Reactive compaction (rebuild
 *                                shorter prefix) is the only structured
 *                                recovery.
 *   - `sandbox_error`            Sandboxed-exec layer failure (host capability,
 *                                NOT the model's fault). HITL review — the
 *                                user must inspect and either re-enable the
 *                                sandbox or downgrade the request.
 *
 * NEVER classify by message text downstream. If you find yourself doing
 * `e.message.includes(...)`, the fix is in this file (extend classification),
 * not in your call site.
 */
export type LLMErrorKind =
  | "overloaded"
  | "rate_limit"
  | "server_error"
  | "network"
  | "auth"
  | "bad_request"
  | "not_found"
  | "not_implemented"
  | "stream_corrupt"
  | "aborted"
  | "unknown"
  // Codex-spec additions (ADR-0214). Order matters only for readability; the
  // union is set-equivalent. Adding a new kind requires extending
  // `recovery-router.ts`'s switch (exhaustiveness check enforces this).
  | "context_window_exceeded"
  | "cyber_policy"
  | "too_many_failed_attempts"
  | "thread_rollback_failed"
  | "sandbox_error"

/** Provider id used by the adapter→error classifier. Kept narrow so a typo at
 *  the adapter boundary fails to compile. `chatgpt-oauth` (ADR-0094) is the
 *  subscription-based provider — separate billing line + endpoint from BYOK
 *  `openai`. */
export type LLMProvider = "anthropic" | "openai" | "chatgpt-oauth"

/** LLM provider failed (network, auth, rate limit, malformed response).
 *
 *  Always carries a {@link LLMErrorKind}. Adapters MUST construct via
 *  {@link LLMError.fromSdkError} so the SDK-specific status/error-code
 *  extraction happens in ONE place and downstream policy never has to
 *  re-classify. */
export class LLMError extends QuantaError {
  readonly kind: LLMErrorKind
  readonly statusCode?: number
  readonly providerCode?: string
  readonly provider?: LLMProvider

  constructor(
    message: string,
    options?: {
      cause?: unknown
      kind?: LLMErrorKind
      statusCode?: number
      providerCode?: string
      provider?: LLMProvider
    },
  ) {
    super("llm", message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.kind = options?.kind ?? "unknown"
    if (options?.statusCode !== undefined) this.statusCode = options.statusCode
    if (options?.providerCode !== undefined) this.providerCode = options.providerCode
    if (options?.provider !== undefined) this.provider = options.provider
  }

  /** Classify an arbitrary SDK-thrown error into a typed LLMError. This is
   *  the ONLY place that touches SDK-specific shape. Subsequent retry /
   *  fallback policy MUST branch off the returned `kind`/`statusCode`,
   *  NEVER off the `message` string. */
  static fromSdkError(provider: LLMProvider, e: unknown, prefix?: string): LLMError {
    if (e instanceof LLMError) return e
    const message = errMessage(e)
    const statusCode = extractStatus(e)
    const providerCode = extractProviderCode(e)
    const kind = classify(statusCode, e, message)
    const head = prefix ?? `${provider} request failed`
    return new LLMError(`${head}: ${message}`, {
      cause: e,
      kind,
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(providerCode !== undefined ? { providerCode } : {}),
      provider,
    })
  }
}

const extractStatus = (e: unknown): number | undefined => {
  if (typeof e !== "object" || e === null) return undefined
  const direct = (e as { status?: unknown }).status
  if (typeof direct === "number") return direct
  // OpenAI/Anthropic SDKs sometimes nest under `.response.status` on http errors.
  const resp = (e as { response?: { status?: unknown } }).response
  const nested = resp?.status
  return typeof nested === "number" ? nested : undefined
}

const extractProviderCode = (e: unknown): string | undefined => {
  if (typeof e !== "object" || e === null) return undefined
  const err = (e as { error?: { type?: unknown } }).error
  if (err !== undefined && err !== null && typeof err.type === "string") return err.type
  const code = (e as { code?: unknown }).code
  if (typeof code === "string") return code
  const type = (e as { type?: unknown }).type
  if (typeof type === "string") return type
  return undefined
}

/** Marker substrings used ONLY as a last-resort tag when no `status` field is
 *  present (Node transport errors carry these as `code`/`errno`, not status).
 *  These are intentionally distinct from the prior `FALLBACK_MARKERS`: they
 *  do NOT classify provider-overload (that requires a real 529 / 429), only
 *  transport-layer "did not reach the server" cases. */
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
])

const isAbortError = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false
  const name = (e as { name?: unknown }).name
  if (name === "AbortError" || name === "TimeoutError") return true
  return false
}

/** ADR-0234: marker substrings (lowercased) for prompt-too-long / context-window
 *  overflow at the ADAPTER boundary. Distinct from the ROUTER-stage list in
 *  `error-classifier.ts` (same intent, narrower set): the adapter only fires
 *  these when the provider ALSO returned a 400/422 — never on a bare 200 stream
 *  or a 429 (those routes belong to bad_request / rate_limit respectively). The
 *  "match on message" the codebase otherwise bans is acceptable HERE because:
 *
 *  1. The adapter is the boundary where provider-specific shape is allowed to
 *     leak in. The ban targets downstream code that re-parses a wrapped
 *     LLMError's `.message` to recover meaning the boundary already lost.
 *  2. Anthropic / OpenAI / Bedrock / Vertex / Foundry surface
 *     context-window-exceeded as `400 invalid_request_error` with the marker
 *     in the body. There is no structured field to pin on — the SDK union
 *     does not break it out. Without this heuristic the loop's reactive
 *     compaction never fires and the same oversize prompt retries forever.
 *  3. Only fired when `status ∈ {400,422}` — a brand-new `unknown` arm
 *     (which would be the most expensive misclassification) cannot regress. */
const ADAPTER_CONTEXT_WINDOW_MARKERS: readonly string[] = [
  "prompt is too long",
  "prompt too long",
  "context length",
  "context_length",
  "context window",
  "context_length_exceeded",
  "maximum context",
  "tokens exceed",
] as const

/** ADR-0234: marker substrings (lowercased) for provider safety / content
 *  policy refusals at the ADAPTER boundary. Same heuristic-at-boundary
 *  rationale as {@link ADAPTER_CONTEXT_WINDOW_MARKERS}; only fired when the
 *  provider also signaled `permission_error` / `policy_violation` via
 *  `.error.type` / `.code` / `.type` OR returned 400 with a policy marker
 *  in the body. The HITL is the only structured recovery — neither retry
 *  nor swap can bypass a safety refusal. */
const ADAPTER_POLICY_MARKERS: readonly string[] = [
  "content policy",
  "policy violation",
  "policy_violation",
  "safety policy",
  "cyberpolicy",
  "cyber_policy",
] as const

/** Lowercased message text for marker scanning. Mirrors `safeLower` in
 *  `error-classifier.ts`. No-throw on circular / throwing toString — catch
 *  swallows; an empty string means "no marker matched", never a crash. */
const lowerMessage = (e: unknown): string => {
  try {
    if (e instanceof Error) return e.message.toLowerCase()
    if (typeof e === "object" && e !== null) {
      const m = (e as { message?: unknown }).message
      if (typeof m === "string") return m.toLowerCase()
    }
    return ""
  } catch {
    return ""
  }
}

const containsAnyAdapter = (msg: string, markers: readonly string[]): boolean => {
  for (const m of markers) {
    if (msg.includes(m)) return true
  }
  return false
}

/** Provider-code probe: returns the raw `.error.type` / `.code` / `.type`
 *  string (lowercased) or `""` when absent. Used by the cyber_policy gate so
 *  a `permission_error` provider code escalates a 400 from bad_request →
 *  cyber_policy. Matches the extraction policy in {@link extractProviderCode}
 *  but does not allocate a new error object. */
const lowerProviderCode = (e: unknown): string => {
  if (typeof e !== "object" || e === null) return ""
  const err = (e as { error?: { type?: unknown } }).error
  if (err !== undefined && err !== null && typeof err.type === "string") {
    return err.type.toLowerCase()
  }
  const code = (e as { code?: unknown }).code
  if (typeof code === "string") return code.toLowerCase()
  const type = (e as { type?: unknown }).type
  if (typeof type === "string") return type.toLowerCase()
  return ""
}

/** ADR-0234: classify a 400/422 SDK response into one of three buckets:
 *  cyber_policy (HITL), context_window_exceeded (reactive compaction), or
 *  the catch-all bad_request (caller bug). Extracted to keep the parent
 *  `classify`'s cyclomatic complexity under the biome cap. Precedence:
 *  cyber_policy > context_window > bad_request — a refusal that ALSO
 *  mentions "context length" must route to HITL, not compaction. */
const classifyBadRequest = (e: unknown): LLMErrorKind => {
  const lowerMsg = lowerMessage(e)
  const providerCode = lowerProviderCode(e)
  if (providerCode === "permission_error" || containsAnyAdapter(lowerMsg, ADAPTER_POLICY_MARKERS)) {
    return "cyber_policy"
  }
  if (
    providerCode === "context_length_exceeded" ||
    containsAnyAdapter(lowerMsg, ADAPTER_CONTEXT_WINDOW_MARKERS)
  ) {
    return "context_window_exceeded"
  }
  return "bad_request"
}

const classify = (status: number | undefined, e: unknown, _msg: string): LLMErrorKind => {
  if (isAbortError(e)) return "aborted"
  if (status === 529) return "overloaded"
  if (status === 429) return "rate_limit"
  if (status === 401 || status === 403) return "auth"
  if (status === 404) return "not_found"
  if (status === 400 || status === 422) return classifyBadRequest(e)
  if (status !== undefined && status >= 500 && status < 600) return "server_error"
  if (status !== undefined) return "unknown"
  // No status — last-resort transport detection via Node's `code` field.
  // This branch DOES NOT match on message text (the bug class we're killing).
  if (typeof e === "object" && e !== null) {
    const errnoCode = (e as { code?: unknown }).code
    if (typeof errnoCode === "string" && NETWORK_CODES.has(errnoCode)) return "network"
  }
  return "unknown"
}

export const toError = (e: unknown): Error =>
  e instanceof Error ? e : new Error(typeof e === "string" ? e : JSON.stringify(e))

/**
 * Extract a message string from any thrown value with EXACTLY the semantics
 * of the inline `e instanceof Error ? e.message : String(e)` pattern (which
 * was duplicated across 18+ files). Distinct from {@link toError}, which
 * constructs an Error and JSON-stringifies non-Error / non-string bodies
 * (a richer log policy that produces `'{"k":1}'` instead of
 * `"[object Object]"`); kept separate so the legacy call sites stay
 * byte-identical when they switch to this helper.
 *
 * IMPORTANT — do NOT change the body to `errMessage(e)` (e.g. by an over-eager
 * find/replace pass). That re-introduces the infinite recursion that ate the
 * `e instanceof Error ? e.message : String(e)` literal during the 2026-05-23
 * mass migration. The `tests/unit/errors.test.ts` "regression: does NOT
 * recurse on itself" case will hang every consumer if it does.
 */
export const errMessage = (e: unknown): string =>
  e instanceof Error ? e.message : String(e)
