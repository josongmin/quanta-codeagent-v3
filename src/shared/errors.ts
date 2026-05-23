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

const classify = (status: number | undefined, e: unknown, _msg: string): LLMErrorKind => {
  if (isAbortError(e)) return "aborted"
  if (status === 529) return "overloaded"
  if (status === 429) return "rate_limit"
  if (status === 401 || status === 403) return "auth"
  if (status === 404) return "not_found"
  if (status === 400 || status === 422) return "bad_request"
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
