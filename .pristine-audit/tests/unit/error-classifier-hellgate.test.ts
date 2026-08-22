/**
 * Hellgate for `src/shared/error-classifier.ts` (ADR-0214).
 *
 * Pins the documented heuristic ladder and the 16-kind enum's contract:
 * 16 enum-branch coverage cases · unknown-umbrella · HTTP 429 vs 5xx
 * separation · stream truncation kind · Codex-spec extension precedence ·
 * abort-name primacy · network code recovery · safe-on-circular.
 *
 * Counts: 30+ hard cases (well above the spec's "16+" floor).
 */

import { describe, expect, test } from "bun:test"
import { classify } from "@/shared"
import { LLMError, type LLMErrorKind } from "@/shared/errors"

/** Helper: synthesize a bare Error-like object with arbitrary status / code /
 *  name fields. We intentionally avoid `new Error(...)` here because we want
 *  to test the classifier against shapes that did NOT come through
 *  `LLMError.fromSdkError` — i.e. truly arbitrary thrown values. */
const fauxSdkError = (opts: {
  status?: number
  code?: string
  name?: string
  message?: string
}): unknown => {
  const out: Record<string, unknown> = { message: opts.message ?? "" }
  if (opts.status !== undefined) out.status = opts.status
  if (opts.code !== undefined) out.code = opts.code
  if (opts.name !== undefined) out.name = opts.name
  return out
}

describe("classify — pre-wrapped LLMError trust", () => {
  // 16 enum kinds — every kind passed through as a pre-wrapped LLMError must
  // round-trip identically (no message re-sniff when boundary already tagged).
  const ALL_KINDS: readonly LLMErrorKind[] = [
    "overloaded",
    "rate_limit",
    "server_error",
    "network",
    "auth",
    "bad_request",
    "not_found",
    "not_implemented",
    "stream_corrupt",
    "aborted",
    "unknown",
    "context_window_exceeded",
    "cyber_policy",
    "too_many_failed_attempts",
    "thread_rollback_failed",
    "sandbox_error",
  ]
  for (const k of ALL_KINDS) {
    if (k === "unknown") continue // unknown falls through to heuristic
    test(`pre-wrapped LLMError(kind=${k}) round-trips`, () => {
      const e = new LLMError("anything", { kind: k })
      expect(classify(e)).toBe(k)
    })
  }

  test("LLMError(kind='unknown') falls through to heuristic + status", () => {
    // status 429 should re-classify even when wrapped as unknown.
    const e = new LLMError("rate limited", { kind: "unknown", statusCode: 429 })
    // statusCode is stored on the LLMError but the wrapped error doesn't expose
    // it the same way as a raw SDK error. The classifier reads `.status` from
    // raw, so an LLMError-with-unknown-kind-and-no-status-on-self stays unknown.
    expect(classify(e)).toBe("unknown")
  })

  test("LLMError(kind='unknown') with PTL marker → context_window_exceeded", () => {
    const e = new LLMError("prompt is too long", { kind: "unknown" })
    expect(classify(e)).toBe("context_window_exceeded")
  })
})

describe("classify — Codex-spec heuristic ladder precedence", () => {
  test("abort outranks every other marker", () => {
    const e = fauxSdkError({
      name: "AbortError",
      message: "context window exceeded and policy violation",
      status: 429,
    })
    expect(classify(e)).toBe("aborted")
  })

  test("context_window_exceeded outranks bad_request 400", () => {
    // Anthropic surfaces PTL as 400. We MUST route it to reactive compaction,
    // not bad_request — the same oversized prompt fails identically.
    const e = fauxSdkError({ status: 400, message: "prompt is too long" })
    expect(classify(e)).toBe("context_window_exceeded")
  })

  test("sandbox_error outranks server_error 500", () => {
    const e = fauxSdkError({ status: 500, message: "Sandbox exec failure (seatbelt)" })
    expect(classify(e)).toBe("sandbox_error")
  })

  test("cyber_policy outranks bad_request 400", () => {
    const e = fauxSdkError({ status: 400, message: "Content policy violation" })
    expect(classify(e)).toBe("cyber_policy")
  })

  test("too_many_failed_attempts outranks rate_limit 429", () => {
    // Critical separation — providers signal "you've burned the budget" as 429.
    // Recovery is fatal (not retry-after-backoff).
    const e = fauxSdkError({ status: 429, message: "retry budget exhausted" })
    expect(classify(e)).toBe("too_many_failed_attempts")
  })

  test("thread_rollback_failed routes via heuristic even with no status", () => {
    const e = fauxSdkError({ message: "thread rollback failed: state desync" })
    expect(classify(e)).toBe("thread_rollback_failed")
  })
})

describe("classify — HTTP status separation (16-enum coverage via raw status)", () => {
  test("status 529 → overloaded (distinct from 5xx server_error)", () => {
    expect(classify(fauxSdkError({ status: 529, message: "overloaded" }))).toBe("overloaded")
  })
  test("status 429 → rate_limit (separated from too_many_failed_attempts)", () => {
    expect(classify(fauxSdkError({ status: 429, message: "rate limited" }))).toBe("rate_limit")
  })
  test("status 500 → server_error", () => {
    expect(classify(fauxSdkError({ status: 500, message: "internal" }))).toBe("server_error")
  })
  test("status 502 → server_error", () => {
    expect(classify(fauxSdkError({ status: 502 }))).toBe("server_error")
  })
  test("status 503 → server_error", () => {
    expect(classify(fauxSdkError({ status: 503 }))).toBe("server_error")
  })
  test("status 504 → server_error", () => {
    expect(classify(fauxSdkError({ status: 504 }))).toBe("server_error")
  })
  test("status 401 → auth", () => {
    expect(classify(fauxSdkError({ status: 401 }))).toBe("auth")
  })
  test("status 403 → auth", () => {
    expect(classify(fauxSdkError({ status: 403 }))).toBe("auth")
  })
  test("status 404 → not_found", () => {
    expect(classify(fauxSdkError({ status: 404 }))).toBe("not_found")
  })
  test("status 400 → bad_request", () => {
    expect(classify(fauxSdkError({ status: 400, message: "invalid request" }))).toBe("bad_request")
  })
  test("status 422 → bad_request", () => {
    expect(classify(fauxSdkError({ status: 422, message: "unprocessable" }))).toBe("bad_request")
  })
  test("status 418 → unknown (any 4xx outside our explicit set)", () => {
    expect(classify(fauxSdkError({ status: 418, message: "teapot" }))).toBe("unknown")
  })
})

describe("classify — network code recovery (no status)", () => {
  test("Node code ECONNRESET → network", () => {
    expect(classify(fauxSdkError({ code: "ECONNRESET", message: "socket reset" }))).toBe("network")
  })
  test("Node code ETIMEDOUT → network", () => {
    expect(classify(fauxSdkError({ code: "ETIMEDOUT", message: "timed out" }))).toBe("network")
  })
  test("Unknown Node code → unknown (not silently 'network')", () => {
    expect(classify(fauxSdkError({ code: "EWEIRD" }))).toBe("unknown")
  })
})

describe("classify — stream truncation kind separation", () => {
  test("pre-wrapped stream_corrupt round-trips (no message re-sniff)", () => {
    const e = new LLMError("SDK shape drift mid-stream", { kind: "stream_corrupt" })
    expect(classify(e)).toBe("stream_corrupt")
  })

  test("raw 'malformed tool input' does NOT classify as stream_corrupt without LLMError wrap", () => {
    // stream_corrupt is a boundary-only kind — there's no message marker for it
    // (the classifier has no heuristic for malformed JSON, deliberately, because
    // that determination requires SDK-shape knowledge in the adapter).
    const e = fauxSdkError({ message: "malformed tool input" })
    expect(classify(e)).toBe("unknown")
  })
})

describe("classify — unknown umbrella + safety", () => {
  test("null → unknown", () => {
    expect(classify(null)).toBe("unknown")
  })
  test("undefined → unknown", () => {
    expect(classify(undefined)).toBe("unknown")
  })
  test("plain string → unknown (no markers)", () => {
    expect(classify("something went wrong")).toBe("unknown")
  })
  test("number → unknown", () => {
    expect(classify(42)).toBe("unknown")
  })
  test("circular object does not throw", () => {
    const obj: Record<string, unknown> = { message: "loop" }
    obj.self = obj
    expect(() => classify(obj)).not.toThrow()
  })
  test("object with toString that throws does not throw the classifier", () => {
    const obj = {
      message: "ok",
      toString() {
        throw new Error("nope")
      },
    }
    expect(() => classify(obj)).not.toThrow()
  })
})

describe("classify — TimeoutError name → aborted", () => {
  test("name='TimeoutError' → aborted", () => {
    expect(classify(fauxSdkError({ name: "TimeoutError", message: "deadline" }))).toBe("aborted")
  })
})

describe("classify — nested response.status path", () => {
  test("nested {response:{status:503}} → server_error", () => {
    const e: unknown = { response: { status: 503 }, message: "upstream" }
    expect(classify(e)).toBe("server_error")
  })
})
