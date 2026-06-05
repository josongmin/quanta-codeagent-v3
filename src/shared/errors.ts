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
 *   - `invalid_image`            Provider rejected the request because an
 *                                attached image / document block was
 *                                unprocessable (corrupt bytes, oversize,
 *                                unsupported type, dimension cap). Distinct
 *                                from `bad_request` (other 400s are caller
 *                                bugs the agent cannot mechanically fix) and
 *                                from `cyber_policy` (content-safety refusal
 *                                that requires HITL): the AGENT can recover
 *                                by SANITIZING the offending block out of the
 *                                history (ADR-0323 `HistorySanitizationPort`)
 *                                and re-sampling. Codex parity
 *                                (`codex-rs/core/src/session/turn.rs:363-381`
 *                                `CodexErr::InvalidImageRequest`). After
 *                                sanitize-and-retry exhausts, the error
 *                                propagates as fatal (same policy as
 *                                `bad_request`).
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
  // ADR-0328 — Codex parity (`codex-rs/core/src/session/turn.rs:363-381`).
  // Provider-emitable: surfaced from the adapter boundary on a 400 with an
  // image-related marker. Recovery is handled by ADR-0323's
  // `HistorySanitizationPort` (default-OFF wrap in
  // `src/llm/image-sanitization-retry/`).
  | "invalid_image"

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
  /** ADR-0208: server-instructed delay (ms) parsed from the response's
   *  `retry-after` / `retry-after-ms` / `x-ratelimit-reset` headers at THIS
   *  boundary. When present and the error is retry-eligible, the agent's
   *  backoff (`src/agent/retry.ts`) honors it over blind exponential backoff
   *  — a 429 already told us when capacity returns, so guessing a smaller
   *  delay just guarantees a second 429 and burns the limited retry budget.
   *  Absent ⇒ no parsable header ⇒ exponential fallback is used unchanged. */
  readonly retryAfterMs?: number

  constructor(
    message: string,
    options?: {
      cause?: unknown
      kind?: LLMErrorKind
      statusCode?: number
      providerCode?: string
      provider?: LLMProvider
      retryAfterMs?: number
    },
  ) {
    super("llm", message, options?.cause !== undefined ? { cause: options.cause } : undefined)
    this.kind = options?.kind ?? "unknown"
    if (options?.statusCode !== undefined) this.statusCode = options.statusCode
    if (options?.providerCode !== undefined) this.providerCode = options.providerCode
    if (options?.provider !== undefined) this.provider = options.provider
    if (options?.retryAfterMs !== undefined) this.retryAfterMs = options.retryAfterMs
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
    // ADR-0208: parse the server's "when to retry" instruction once, here at
    // the boundary (the SDK error still carries the response headers; once it
    // is wrapped in an LLMError that shape is gone). Only meaningful for the
    // retry-eligible arms, but parsing unconditionally is cheap + harmless
    // (the agent only consults it on a retry-eligible error).
    const retryAfterMs = parseRetryAfterMs(extractHeaders(e))
    const head = prefix ?? `${provider} request failed`
    return new LLMError(`${head}: ${message}`, {
      cause: e,
      kind,
      ...(statusCode !== undefined ? { statusCode } : {}),
      ...(providerCode !== undefined ? { providerCode } : {}),
      provider,
      ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    })
  }
}

/** Header bag in the two shapes the Anthropic / OpenAI SDKs surface on their
 *  `APIError.headers`: a plain lowercased-key record
 *  (`Record<string, string | null | undefined>` — Anthropic) OR a WHATWG
 *  `Headers`-like with a `.get()` accessor (some OpenAI builds / raw `fetch`
 *  responses). {@link extractHeaders} normalizes both into a single
 *  case-insensitive lookup so {@link parseRetryAfterMs} stays shape-agnostic. */
export type HeaderLookup = (name: string) => string | null

/** Pull a case-insensitive header accessor out of an arbitrary thrown SDK
 *  error. Returns `null` accessor results when no header bag is present, so
 *  the caller never has to special-case "no headers". No-throw: a hostile
 *  getter on `.headers` degrades to "header absent". */
const extractHeaders = (e: unknown): HeaderLookup => {
  if (typeof e !== "object" || e === null) return () => null
  // SDK errors attach the response headers under `.headers`; some shapes nest
  // them under `.response.headers` (matching `extractStatus`'s nesting probe).
  const bag =
    (e as { headers?: unknown }).headers ??
    (e as { response?: { headers?: unknown } }).response?.headers
  if (bag === null || bag === undefined) return () => null
  // WHATWG Headers-like (`.get()`): OpenAI builds / raw fetch responses.
  const getter = (bag as { get?: unknown }).get
  if (typeof getter === "function") {
    return (name) => {
      try {
        const v = (getter as (n: string) => unknown).call(bag, name)
        return typeof v === "string" ? v : null
      } catch {
        return null
      }
    }
  }
  // Plain record (Anthropic `Record<string, string | null | undefined>`).
  // HTTP header names are case-insensitive; the SDK lowercases keys, but probe
  // case-insensitively to be robust against a record that did not.
  if (typeof bag === "object") {
    const rec = bag as Record<string, unknown>
    return (name) => {
      const direct = rec[name]
      if (typeof direct === "string") return direct
      const lower = name.toLowerCase()
      for (const k of Object.keys(rec)) {
        if (k.toLowerCase() === lower) {
          const v = rec[k]
          return typeof v === "string" ? v : null
        }
      }
      return null
    }
  }
  return () => null
}

/**
 * ADR-0208: parse a server-instructed retry delay (ms) from rate-limit /
 * overload response headers. Pure + reusable — given a case-insensitive
 * {@link HeaderLookup}, returns the delay in ms or `undefined` when no header
 * gives a finite, non-negative value.
 *
 * Precedence (most-precise first):
 *   1. `retry-after-ms`        — explicit millisecond delta (OpenAI / some
 *                                proxies). Integer ms, used verbatim.
 *   2. `retry-after`           — RFC 9110 §10.2.3: EITHER delta-seconds
 *                                (non-negative integer) OR an HTTP-date. Both
 *                                forms parsed; HTTP-date is converted to a
 *                                delta against the parse `now`.
 *   3. `x-ratelimit-reset`     — provider rate-limit reset hint. Ambiguous in
 *                                the wild: either an absolute UNIX epoch
 *                                (seconds) OR a relative delta-seconds. We
 *                                disambiguate by magnitude — a value far in the
 *                                future of the current epoch is absolute and is
 *                                converted to a delta; a small value is a
 *                                relative delta-seconds.
 *
 * No magic delay constants: every returned value derives from what the server
 * sent. A negative / NaN / past value yields `undefined` (fall back to the
 * caller's own backoff). `now` is injectable for deterministic tests.
 */
export const parseRetryAfterMs = (
  get: HeaderLookup,
  now: () => number = Date.now,
): number | undefined => {
  // Precedence, most-precise first. Each helper returns `undefined` when its
  // header is absent or unparsable, so the chain falls through cleanly.
  const fromMs = parseRetryAfterMsHeader(get("retry-after-ms"))
  if (fromMs !== undefined) return fromMs
  const fromRa = parseRetryAfterHeader(get("retry-after"), now)
  if (fromRa !== undefined) return fromRa
  return parseRateLimitResetHeader(get("x-ratelimit-reset"), now)
}

/** `retry-after-ms`: explicit millisecond delta (OpenAI / some proxies). */
const parseRetryAfterMsHeader = (raw: string | null): number | undefined => {
  if (raw === null) return undefined
  const ms = Number(raw)
  return Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : undefined
}

/** `retry-after`: RFC 9110 §10.2.3 — delta-seconds integer OR HTTP-date. */
const parseRetryAfterHeader = (raw: string | null, now: () => number): number | undefined => {
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (trimmed === "") return undefined
  // delta-seconds: a bare non-negative number (integer per RFC, but accept
  // fractional defensively — never a date).
  const secs = Number(trimmed)
  if (Number.isFinite(secs) && secs >= 0) return Math.round(secs * 1000)
  // HTTP-date form (e.g. "Wed, 21 Oct 2026 07:28:00 GMT").
  const at = Date.parse(trimmed)
  if (!Number.isFinite(at)) return undefined
  const delta = at - now()
  return delta >= 0 ? delta : undefined
}

/** `x-ratelimit-reset`: ambiguous in the wild — three encodings a provider may
 *  send. Disambiguate by MAGNITUDE (UNIX epochs and plausible relative deltas
 *  live in non-overlapping bands), most-absolute first:
 *
 *    - `n ≥ 1e12`  absolute epoch-MILLISECONDS. Current ms-epoch ≈ 1.7e12; a
 *                  seconds-epoch never reaches 1e12 until the year ~33658, and
 *                  a relative delta-seconds of 1e12 (≈ 31700 years) is absurd.
 *                  Delta = `n − nowMs` (NO ×1000 — it is already ms). Treating
 *                  this as seconds (the prior bug) multiplied by 1000 AND scaled
 *                  the epoch, yielding a ~53000-year delay that silently pinned
 *                  every such provider to the downstream 60s clamp.
 *    - `n ≥ 1e9`   absolute epoch-SECONDS. Near-future epoch-seconds is ≳ 1.7e9
 *                  (year 2023+), far above any plausible relative wait. Delta =
 *                  `n×1000 − nowMs`.
 *    - otherwise   relative delta-seconds (`Retry-After`-style). `n×1000`.
 *
 *  Each absolute band requires the computed delta to be non-negative (a reset
 *  in the past ⇒ `undefined`, caller falls back to its own backoff). */
const parseRateLimitResetHeader = (raw: string | null, now: () => number): number | undefined => {
  if (raw === null) return undefined
  const n = Number(raw.trim())
  if (!Number.isFinite(n) || n < 0) return undefined
  const nowMs = now()
  // Absolute epoch-milliseconds: already ms, do NOT scale by 1000.
  if (n >= 1_000_000_000_000) {
    const delta = n - nowMs
    return delta >= 0 ? Math.round(delta) : undefined
  }
  // Absolute epoch-seconds: scale to ms then subtract now.
  if (n >= 1_000_000_000) {
    const delta = n * 1000 - nowMs
    return delta >= 0 ? delta : undefined
  }
  // Otherwise treat as relative delta-seconds.
  return Math.round(n * 1000)
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

/**
 * Canonical cancellation classifier — the ONE source of truth for "is this
 * thrown value an abort / deadline cancellation". Every slice that needs to
 * distinguish a cancellation from a real fault imports THIS (re-exported from
 * `@/shared`) instead of open-coding its own copy (the prior drift: a
 * substring-on-`.message` variant in the memory auto-trigger, a name-only
 * variant in the retrieval embedders, etc.).
 *
 * Reconciled semantics — two deliberate choices:
 *
 *   1. NO `instanceof Error` requirement. A cancellation may arrive as a
 *      platform `DOMException` ("AbortError" / "TimeoutError"), which is NOT
 *      an `Error` instance in every runtime. Requiring `instanceof Error`
 *      would FALSE-NEGATIVE on exactly the platform aborts we most need to
 *      catch (Node `fetch` / web-stream cancellation). We duck-type on the
 *      structural `.name` field instead.
 *
 *   2. NO message-substring `"abort"` branch. Classifying by scanning
 *      `.message` for the word "abort" is the precise anti-pattern this
 *      module's header bans ("NEVER classify by message text"): it both
 *      false-positives (a real fault whose text happens to mention "aborted
 *      the transaction") and false-negatives (a localized / reworded abort
 *      message). The structured `.name` (`"AbortError"` / `"TimeoutError"`)
 *      set by the platform, by `@/shared` `AbortError`, and by `throwIfAborted`
 *      is the authoritative signal — message text is not.
 */
export const isAbortError = (e: unknown): boolean => {
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

/** ADR-0328: marker substrings (lowercased) for provider rejection of an
 *  attached image / document block at the ADAPTER boundary. Same
 *  heuristic-at-boundary rationale as {@link ADAPTER_CONTEXT_WINDOW_MARKERS}.
 *  Only fired when the provider ALSO returned a 400/422 — never on a bare
 *  200 stream or a 429.
 *
 *  Marker basis (conservative — no SDK error code is currently broken out
 *  for this case so the only available signal is the body text):
 *    - Anthropic surfaces this as `400 invalid_request_error` with phrases
 *      like "could not process image", "unable to process image", "image
 *      dimensions exceed", "unsupported image type". The marker set is the
 *      INTERSECTION of those phrases lowercased, narrowed to the most
 *      distinctive substrings ("invalid image", "could not process image",
 *      "unable to process image", "image dimensions", "unsupported image
 *      type", "image format"). A future provider-code (e.g.
 *      `.error.type === "invalid_image"`) extension would short-circuit
 *      the marker scan and is encoded BEFORE the substring fallback.
 *    - "document" parity is intentional: Anthropic native-document blocks
 *      (`type:"document"`, ADR-0137) surface the same failure shape.
 *
 *  Precedence: this fires AFTER cyber_policy (a refusal that ALSO mentions
 *  "invalid image" must route to HITL, not sanitize-retry) and AFTER
 *  context_window (oversize prompt with an image still routes to compaction,
 *  not sanitize). See {@link classifyBadRequest} for the order. */
const ADAPTER_INVALID_IMAGE_MARKERS: readonly string[] = [
  "invalid image",
  "could not process image",
  "unable to process image",
  "image dimensions",
  "unsupported image type",
  "image format",
  "invalid document",
  "could not process document",
  "unable to process document",
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

/** ADR-0234/0328: classify a 400/422 SDK response into one of four buckets:
 *  cyber_policy (HITL), context_window_exceeded (reactive compaction),
 *  invalid_image (history sanitization + retry), or the catch-all
 *  bad_request (caller bug). Extracted to keep the parent `classify`'s
 *  cyclomatic complexity under the biome cap. Precedence:
 *
 *    cyber_policy > context_window > invalid_image > bad_request
 *
 *  Rationale: a refusal that ALSO mentions "context length" must route to
 *  HITL, not compaction. A 400 that mentions BOTH "context length" and
 *  "invalid image" should route to compaction (the prompt is the primary
 *  fault — sanitizing one image won't shrink an oversize prompt). Only when
 *  policy and context-window are both ruled out does invalid_image fire and
 *  drive ADR-0323's history sanitization + retry (`ADR-0328`). */
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
  if (
    providerCode === "invalid_image" ||
    providerCode === "invalid_image_request" ||
    containsAnyAdapter(lowerMsg, ADAPTER_INVALID_IMAGE_MARKERS)
  ) {
    return "invalid_image"
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
export const errMessage = (e: unknown): string => {
  if (e instanceof Error) return e.message
  // R5 audit-H: `String(e)` re-throws when e.toString / Symbol.toPrimitive
  // throw — those exceptions would escape the originating catch and crash
  // the host. The whole point of `errMessage` is "extract a label even from
  // hostile throws", so a throwing stringifier degrades to a typed sentinel
  // that preserves forensic info (R8 audit-M closure — bare `<unstringifiable>`
  // erased the throw's shape, breaking forensic).
  try {
    return String(e)
  } catch {
    return `<unstringifiable:${unstringifiableTag(e)}>`
  }
}

/** Best-effort throw shape tag for the `<unstringifiable>` sentinel. Probes
 *  typeof + constructor name without invoking any user-defined `.toString` /
 *  `@@toPrimitive` (those are what threw). Every probe is independently
 *  try/caught so a deeply hostile object cannot escape this function either. */
const unstringifiableTag = (e: unknown): string => {
  let kind = "unknown"
  try {
    kind = typeof e
  } catch {
    /* ignore — typeof should never throw, but defense in depth */
  }
  if (kind !== "object" || e === null) return kind
  try {
    const ctor = (e as { constructor?: { name?: unknown } }).constructor
    const name = ctor?.name
    if (typeof name === "string" && name.length > 0 && name.length <= 64) {
      return `object/${name}`
    }
  } catch {
    /* hostile getter — fall through to plain "object" */
  }
  return "object"
}
