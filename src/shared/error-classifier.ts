/**
 * Single-call classifier mapping any thrown value → `LLMErrorKind` (ADR-0214).
 *
 * ── Why a separate file from `errors.ts::LLMError.fromSdkError` ──────────────
 * `fromSdkError` is the ADAPTER boundary — it WRAPS an SDK error into an
 * `LLMError` and stamps `.kind`. It is provider-aware (`provider: LLMProvider`)
 * and constructs a new error object.
 *
 * `classify(e)` is the ROUTER boundary — it consumes any thrown value (a
 * pre-wrapped `LLMError`, a raw `Error`, a string, etc.) and returns a tag
 * without allocating. The codex spec router (`src/llm/retry/codex-spec-router.ts`)
 * branches on that tag. Keeping the two seams separate matters because:
 *   1. The router sees errors that did NOT come from an LLM adapter
 *      (e.g. a sandbox tool failure carried in a downstream try/catch), so it
 *      cannot assume `LLMError` shape.
 *   2. Heuristic message-pattern recovery for the 5 Codex-spec kinds lives
 *      ONLY here. Adapters MUST NOT match on `message` — that's the bug class
 *      `fromSdkError` killed. The router being a separate stage means the
 *      adapter contract stays clean.
 *
 * ── Heuristic policy (Codex-spec extensions) ─────────────────────────────────
 * When the input is an `LLMError` with a definitive kind (anything other than
 * `unknown`), that kind WINS — no message re-sniffing. Only when the kind is
 * `unknown` or the input is a non-LLMError do we run the heuristic matchers
 * below, in this strict precedence order:
 *
 *   1. abort signal name (kind: aborted)
 *   2. context-window markers (kind: context_window_exceeded) — BEFORE
 *      bad_request because providers surface PTL as a 400.
 *   3. sandbox-error markers (kind: sandbox_error) — host-side failure
 *      carries no HTTP status, distinguish from server_error.
 *   4. policy-refusal markers (kind: cyber_policy)
 *   5. invalid-image markers (kind: invalid_image) — ADR-0328. AFTER
 *      policy (a refusal about an image must still route to HITL), but
 *      BEFORE the status-based bad_request bucket so a 400 with image
 *      markers routes to sanitize-and-retry instead of fatal abort.
 *   6. too-many-failed-attempts markers (kind: too_many_failed_attempts) —
 *      BEFORE rate_limit (429), since providers signal this as a 429 with
 *      "exhausted" wording and we must NOT retry exhausted budget.
 *   7. thread-rollback-failed markers (kind: thread_rollback_failed)
 *   8. fall through to status-based classification (identical to
 *      `fromSdkError`'s `classify`).
 *
 * Heuristic markers are intentionally narrow — every marker added without a
 * positive test in `error-classifier-hellgate.test.ts` is forbidden.
 *
 * ── Contract ─────────────────────────────────────────────────────────────────
 * - PURE: no IO, no clock, no env, no allocation beyond a returned string
 *   literal.
 * - NO-THROW: every input (including `null`, `undefined`, circular objects)
 *   returns a defined `LLMErrorKind`. `"unknown"` is the last-resort bucket.
 * - DETERMINISTIC: same input → same output.
 */

import { errMessage, LLMError, type LLMErrorKind } from "./errors"

/** Marker substrings (lowercased) for prompt-too-long / context-window
 *  overflow. Distinct from `bad_request` because reactive compaction is the
 *  recovery action. Drawn from the existing `PTL_MARKERS` in `agent/retry.ts`
 *  plus Codex's `ContextWindowExceeded` wording. */
const CONTEXT_WINDOW_MARKERS: readonly string[] = [
  "prompt is too long",
  "prompt too long",
  "context length",
  "context_length",
  "context window",
  "context_window_exceeded",
  "maximum context",
  "too many tokens",
  "tokens exceed",
] as const

/** Marker substrings (lowercased) for sandbox-layer failures (Codex
 *  `SandboxError`). Host-side, NOT a model fault — HITL review the only
 *  structured recovery. */
const SANDBOX_MARKERS: readonly string[] = [
  "sandbox",
  "seatbelt",
  "landlock",
  "seccomp",
  "sandboxerror",
  "sandbox_error",
] as const

/** Marker substrings (lowercased) for provider policy/safety refusals (Codex
 *  `CyberPolicy`). The user — not the agent — must resolve. */
const POLICY_MARKERS: readonly string[] = [
  "cyberpolicy",
  "cyber_policy",
  "cyber policy",
  "content policy",
  "policy violation",
  "policy_violation",
  "safety policy",
  "guardrail",
  "guardrail_intervened",
] as const

/** Marker substrings (lowercased) for "you've burned your retry budget"
 *  signals (Codex `ResponseTooManyFailedAttempts`). MUST be checked BEFORE
 *  rate_limit (429), since the provider often surfaces this as a 429 with a
 *  distinct "exhausted" wording — we cannot retry an exhausted budget. */
const TOO_MANY_FAILED_MARKERS: readonly string[] = [
  "too many failed attempts",
  "too_many_failed_attempts",
  "retry budget exhausted",
  "max_retries exceeded",
  "exhausted retries",
  "exhausted_retries",
] as const

/** ADR-0328: marker substrings (lowercased) for provider-rejected image /
 *  document blocks. Mirror of {@link ADAPTER_INVALID_IMAGE_MARKERS} in
 *  `errors.ts` — kept in sync so a raw thrown Error (never wrapped by
 *  `fromSdkError`) still routes to `invalid_image`. Precedence: AFTER
 *  cyber_policy / context_window (policy refusals about images route to
 *  HITL; oversize prompts with images route to compaction). */
const INVALID_IMAGE_MARKERS: readonly string[] = [
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

/** Marker substrings (lowercased) for server-side conversation/thread rollback
 *  desync (Codex `ThreadRollbackFailed`). Reactive compaction (rebuild shorter
 *  prefix) is the only structured recovery. */
const THREAD_ROLLBACK_MARKERS: readonly string[] = [
  "thread rollback failed",
  "thread_rollback_failed",
  "rollback failed",
  "conversation rollback",
  "thread state desync",
] as const

/** Substrings (lowercased) marking Node transport failures (no HTTP status —
 *  `code`/`errno` only). Mirror of `NETWORK_CODES` in `errors.ts` so the
 *  router can recover the network kind from raw Errors that never went through
 *  `fromSdkError`. */
const NETWORK_CODES: ReadonlySet<string> = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
])

const isAbortLike = (e: unknown): boolean => {
  if (typeof e !== "object" || e === null) return false
  const name = (e as { name?: unknown }).name
  return name === "AbortError" || name === "TimeoutError"
}

const extractStatus = (e: unknown): number | undefined => {
  if (typeof e !== "object" || e === null) return undefined
  const direct = (e as { status?: unknown }).status
  if (typeof direct === "number") return direct
  const resp = (e as { response?: { status?: unknown } }).response
  const nested = resp?.status
  return typeof nested === "number" ? nested : undefined
}

const containsAny = (msg: string, markers: readonly string[]): boolean => {
  for (const m of markers) {
    if (msg.includes(m)) return true
  }
  return false
}

/** Safely lowercase a message string from an arbitrary thrown value.
 *
 *  Unlike `errMessage` (which `String(e)`s non-Errors and produces
 *  `"[object Object]"` for SDK-shaped plain objects), this function ALSO
 *  reads a top-level `.message` property when present. SDK-thrown shapes
 *  carry their message there, and the heuristic ladder needs to see it.
 *
 *  No-throw on circular objects or throwing `toString` (catch swallows). */
const safeLower = (e: unknown): string => {
  try {
    // Fast-path: a real Error carries `.message`.
    if (e instanceof Error) return e.message.toLowerCase()
    // SDK-shaped plain object with `.message: string`.
    if (typeof e === "object" && e !== null) {
      const msg = (e as { message?: unknown }).message
      if (typeof msg === "string") return msg.toLowerCase()
      return ""
    }
    // Primitive: fall back to the legacy helper.
    return errMessage(e).toLowerCase()
  } catch {
    return ""
  }
}

/**
 * Classify any thrown value into an `LLMErrorKind`.
 *
 * Honors a pre-wrapped `LLMError`'s `.kind` when it is definitive (not
 * `"unknown"`). For unknown / non-LLMError inputs, falls back to the
 * documented heuristic ladder (abort → context_window → sandbox → cyber_policy
 * → too_many_failed_attempts → thread_rollback_failed → status-based).
 *
 * High cyclomatic-complexity is intrinsic: the 16-kind output × the heuristic
 * ladder is the contract. Splitting would obscure precedence (the WHOLE POINT
 * of the function), so the biome rule is suppressed here.
 */
// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: 16-kind closed-vocabulary classifier (see header)
export const classify = (e: unknown): LLMErrorKind => {
  // Pre-wrapped LLMError: trust the boundary's tag unless it was the catch-all.
  if (e instanceof LLMError && e.kind !== "unknown") {
    return e.kind
  }

  // Abort first — it can ride atop any other shape.
  if (isAbortLike(e)) return "aborted"

  const lower = safeLower(e)

  // Codex-spec heuristics (precedence-ordered, see file header).
  if (containsAny(lower, CONTEXT_WINDOW_MARKERS)) return "context_window_exceeded"
  if (containsAny(lower, SANDBOX_MARKERS)) return "sandbox_error"
  if (containsAny(lower, POLICY_MARKERS)) return "cyber_policy"
  if (containsAny(lower, INVALID_IMAGE_MARKERS)) return "invalid_image"
  if (containsAny(lower, TOO_MANY_FAILED_MARKERS)) return "too_many_failed_attempts"
  if (containsAny(lower, THREAD_ROLLBACK_MARKERS)) return "thread_rollback_failed"

  // Status-based classification (mirrors `errors.ts::classify`).
  const status = extractStatus(e)
  if (status === 529) return "overloaded"
  if (status === 429) return "rate_limit"
  if (status === 401 || status === 403) return "auth"
  if (status === 404) return "not_found"
  if (status === 400 || status === 422) return "bad_request"
  if (status !== undefined && status >= 500 && status < 600) return "server_error"
  if (status !== undefined) return "unknown"

  // No status — Node transport via `code`.
  if (typeof e === "object" && e !== null) {
    const errnoCode = (e as { code?: unknown }).code
    if (typeof errnoCode === "string" && NETWORK_CODES.has(errnoCode)) return "network"
  }

  // Last-resort: a pre-wrapped LLMError that was definitively `"unknown"`
  // passes through here (we already returned for non-unknown above).
  if (e instanceof LLMError) return e.kind
  return "unknown"
}
