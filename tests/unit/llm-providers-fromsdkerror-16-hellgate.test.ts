/**
 * ★ CONTRACT — ADR-0234 §fromSdkError-16-kind hellgate.
 *
 * Pins the ADAPTER-BOUNDARY classification of SDK-thrown errors into the
 * extended 16-kind LLMErrorKind enum (ADR-0214). Prior to this wire,
 * `LLMError.fromSdkError` only emitted the original 11 kinds — the 5 Codex-
 * spec additions (`context_window_exceeded` / `cyber_policy` /
 * `too_many_failed_attempts` / `thread_rollback_failed` / `sandbox_error`)
 * surfaced ONLY through the router-stage `classify(e)` heuristic in
 * `src/shared/error-classifier.ts`, leaving the adapter layer's typed
 * `.kind` blind to two kinds the provider DOES emit at the boundary.
 *
 * Two kinds are wire-able at the adapter boundary (provider signals them
 * directly via status + provider code + message):
 *   - `context_window_exceeded` — Anthropic 400 `invalid_request_error`
 *     with "context length"/"prompt is too long" in the body; OpenAI 400
 *     with `code === "context_length_exceeded"`; Bedrock/Vertex/Foundry
 *     surface comparable shapes.
 *   - `cyber_policy` — Anthropic 400 `permission_error`; OpenAI 400 with
 *     "content policy"/"policy violation" in the body.
 *
 * The remaining 3 kinds are NOT wire-able at this boundary by design:
 *   - `too_many_failed_attempts` — emitted by the retry layer's own budget
 *     counter, not by any provider directly.
 *   - `thread_rollback_failed` — emitted by the conversation-checkpoint
 *     rollback API failure, not by any provider directly.
 *   - `sandbox_error` — emitted by the host-side sandbox tool layer, not
 *     by any provider directly.
 * Verifying those would couple this hellgate to layers that legitimately
 * own those kinds; they have their own dedicated hellgates.
 *
 * Invariants pinned (15+ hard cases):
 *   - F-CTX-1..5: context_window_exceeded mapping per provider shape
 *   - F-POL-1..5: cyber_policy mapping per provider shape
 *   - F-PRE-1..3: cyber_policy outranks context_window (a refusal that
 *     ALSO mentions "context length" routes to HITL, not compaction)
 *   - F-REG-1..6: 11-original-kind regressions (overloaded/rate_limit/
 *     auth/not_found/bad_request/server_error/network/aborted) stay put
 *   - F-EDGE-1..4: unknown shapes / circular toString / missing fields /
 *     pre-wrapped LLMError pass-through
 *   - F-CON-1..2: LLMError construction echoes typed `.kind` + `.provider`
 *
 * Coverage count: 25 hard cases. Well above the spec's "15+" floor.
 */

import { describe, expect, test } from "bun:test"
import { LLMError } from "@/shared/errors"

// ────────────────────────────────────────────────────────────────────────
// F-CTX: context_window_exceeded mapping per provider shape
// ────────────────────────────────────────────────────────────────────────

describe("ADR-0234 — fromSdkError context_window_exceeded mapping", () => {
  test("F-CTX-1: Anthropic 400 invalid_request_error with 'context length' → context_window_exceeded", () => {
    const sdkErr = {
      status: 400,
      error: { type: "invalid_request_error" },
      message: "prompt is too long: context length exceeded",
    }
    const wrapped = LLMError.fromSdkError("anthropic", sdkErr)
    expect(wrapped.kind).toBe("context_window_exceeded")
    expect(wrapped.provider).toBe("anthropic")
    expect(wrapped.statusCode).toBe(400)
  })

  test("F-CTX-2: OpenAI 400 code='context_length_exceeded' → context_window_exceeded", () => {
    const sdkErr = {
      status: 400,
      code: "context_length_exceeded",
      message: "This model's maximum context length is 128000 tokens",
    }
    const wrapped = LLMError.fromSdkError("openai", sdkErr)
    expect(wrapped.kind).toBe("context_window_exceeded")
    expect(wrapped.provider).toBe("openai")
  })

  test("F-CTX-3: 422 with 'context window' marker → context_window_exceeded (Bedrock shape)", () => {
    const sdkErr = {
      status: 422,
      message: "Request would exceed the model's context window of 200000 tokens",
    }
    const wrapped = LLMError.fromSdkError("anthropic", sdkErr)
    expect(wrapped.kind).toBe("context_window_exceeded")
  })

  test("F-CTX-4: 400 nested under response.status with 'tokens exceed' marker", () => {
    const sdkErr = {
      response: { status: 400 },
      message: "the requested tokens exceed the per-request cap",
    }
    const wrapped = LLMError.fromSdkError("openai", sdkErr)
    expect(wrapped.kind).toBe("context_window_exceeded")
    expect(wrapped.statusCode).toBe(400)
  })

  test("F-CTX-5: 400 with 'maximum context' marker (case-insensitive)", () => {
    const sdkErr = {
      status: 400,
      message: "Maximum Context Reached — please shorten input",
    }
    const wrapped = LLMError.fromSdkError("anthropic", sdkErr)
    expect(wrapped.kind).toBe("context_window_exceeded")
  })
})

// ────────────────────────────────────────────────────────────────────────
// F-POL: cyber_policy mapping per provider shape
// ────────────────────────────────────────────────────────────────────────

describe("ADR-0234 — fromSdkError cyber_policy mapping", () => {
  test("F-POL-1: Anthropic 400 permission_error → cyber_policy", () => {
    const sdkErr = {
      status: 400,
      error: { type: "permission_error" },
      message: "request blocked by safety policy",
    }
    const wrapped = LLMError.fromSdkError("anthropic", sdkErr)
    expect(wrapped.kind).toBe("cyber_policy")
    expect(wrapped.providerCode).toBe("permission_error")
  })

  test("F-POL-2: OpenAI 400 with 'content policy' marker → cyber_policy", () => {
    const sdkErr = {
      status: 400,
      message: "this request was blocked by content policy",
    }
    const wrapped = LLMError.fromSdkError("openai", sdkErr)
    expect(wrapped.kind).toBe("cyber_policy")
  })

  test("F-POL-3: 400 with 'policy_violation' marker (snake_case)", () => {
    const sdkErr = {
      status: 400,
      message: "Detected policy_violation in user prompt",
    }
    const wrapped = LLMError.fromSdkError("anthropic", sdkErr)
    expect(wrapped.kind).toBe("cyber_policy")
  })

  test("F-POL-4: 400 with 'safety policy' marker", () => {
    const sdkErr = { status: 400, message: "Refused — violates our safety policy guidelines" }
    const wrapped = LLMError.fromSdkError("openai", sdkErr)
    expect(wrapped.kind).toBe("cyber_policy")
  })

  test("F-POL-5: 422 with permission_error code → cyber_policy (status-tier 400/422 both honoured)", () => {
    const sdkErr = {
      status: 422,
      code: "permission_error",
      message: "operation forbidden by policy",
    }
    const wrapped = LLMError.fromSdkError("anthropic", sdkErr)
    expect(wrapped.kind).toBe("cyber_policy")
  })
})

// ────────────────────────────────────────────────────────────────────────
// F-PRE: precedence — cyber_policy outranks context_window
// ────────────────────────────────────────────────────────────────────────

describe("ADR-0234 — fromSdkError precedence ordering", () => {
  test("F-PRE-1: 400 with BOTH 'content policy' AND 'context length' → cyber_policy wins", () => {
    // A refusal that ALSO happens to mention context length must route to HITL,
    // not to reactive compaction. The user must resolve the policy block.
    const sdkErr = {
      status: 400,
      message: "blocked: content policy violation (also context length issue)",
    }
    const wrapped = LLMError.fromSdkError("openai", sdkErr)
    expect(wrapped.kind).toBe("cyber_policy")
  })

  test("F-PRE-2: 400 with permission_error code AND 'prompt too long' → cyber_policy wins", () => {
    const sdkErr = {
      status: 400,
      error: { type: "permission_error" },
      message: "prompt too long but also policy-blocked",
    }
    const wrapped = LLMError.fromSdkError("anthropic", sdkErr)
    expect(wrapped.kind).toBe("cyber_policy")
  })

  test("F-PRE-3: 400 with neither cyber nor context markers → falls back to bad_request", () => {
    const sdkErr = { status: 400, message: "missing required field 'model'" }
    const wrapped = LLMError.fromSdkError("openai", sdkErr)
    expect(wrapped.kind).toBe("bad_request")
  })
})

// ────────────────────────────────────────────────────────────────────────
// F-REG: 11-original-kind regressions stay put
// ────────────────────────────────────────────────────────────────────────

describe("ADR-0234 — fromSdkError 11-original-kind regression coverage", () => {
  test("F-REG-1: status 529 → overloaded (Anthropic overflow distinct from 5xx)", () => {
    const wrapped = LLMError.fromSdkError("anthropic", { status: 529, message: "overloaded" })
    expect(wrapped.kind).toBe("overloaded")
  })

  test("F-REG-2: status 429 → rate_limit (NOT too_many_failed_attempts at boundary)", () => {
    const wrapped = LLMError.fromSdkError("openai", { status: 429, message: "rate limit hit" })
    expect(wrapped.kind).toBe("rate_limit")
  })

  test("F-REG-3: status 401 → auth", () => {
    const wrapped = LLMError.fromSdkError("anthropic", {
      status: 401,
      message: "invalid api key",
    })
    expect(wrapped.kind).toBe("auth")
  })

  test("F-REG-4: status 404 → not_found", () => {
    const wrapped = LLMError.fromSdkError("openai", { status: 404, message: "model not found" })
    expect(wrapped.kind).toBe("not_found")
  })

  test("F-REG-5: status 500 → server_error", () => {
    const wrapped = LLMError.fromSdkError("anthropic", { status: 500, message: "server error" })
    expect(wrapped.kind).toBe("server_error")
  })

  test("F-REG-6: code ECONNRESET → network (no status, transport-level)", () => {
    const wrapped = LLMError.fromSdkError("openai", { code: "ECONNRESET", message: "reset" })
    expect(wrapped.kind).toBe("network")
  })

  test("F-REG-7: name AbortError → aborted", () => {
    const wrapped = LLMError.fromSdkError("anthropic", {
      name: "AbortError",
      message: "user aborted",
    })
    expect(wrapped.kind).toBe("aborted")
  })
})

// ────────────────────────────────────────────────────────────────────────
// F-EDGE: edge cases (unknown shapes / pre-wrapped / no-fields)
// ────────────────────────────────────────────────────────────────────────

describe("ADR-0234 — fromSdkError edge cases", () => {
  test("F-EDGE-1: empty object → unknown (no status, no code, no message)", () => {
    const wrapped = LLMError.fromSdkError("anthropic", {})
    expect(wrapped.kind).toBe("unknown")
  })

  test("F-EDGE-2: pre-wrapped LLMError passes through verbatim (no double-classify)", () => {
    const inner = new LLMError("test", {
      kind: "context_window_exceeded",
      provider: "anthropic",
    })
    const wrapped = LLMError.fromSdkError("openai", inner)
    // Per fromSdkError's contract: `if (e instanceof LLMError) return e`.
    expect(wrapped).toBe(inner)
    expect(wrapped.kind).toBe("context_window_exceeded")
    expect(wrapped.provider).toBe("anthropic")
  })

  test("F-EDGE-3: circular object with status + permission_error code → cyber_policy (no infinite loop)", () => {
    // The boundary's lowerMessage helper reads `.message` directly when the
    // value is a string — it does NOT stringify the whole object — so a
    // circular reference must NOT cause infinite recursion. Pins the
    // safe-on-circular contract documented in lowerMessage's header.
    interface Circular {
      status: number
      error: { type: string }
      message: string
      self?: Circular
    }
    const sdkErr: Circular = {
      status: 400,
      error: { type: "permission_error" },
      message: "blocked",
    }
    sdkErr.self = sdkErr
    const wrapped = LLMError.fromSdkError("anthropic", sdkErr)
    expect(wrapped.kind).toBe("cyber_policy")
  })

  test("F-EDGE-4: status missing, message 'context length' alone → unknown (NO message-only escalation outside 400/422)", () => {
    // The adapter-boundary heuristic is gated on status 400/422. Without a
    // status the only structured signal is Node `code` for network — the
    // marker MUST NOT escalate a bare-message error to context_window.
    const sdkErr = { message: "context length warning (no status)" }
    const wrapped = LLMError.fromSdkError("openai", sdkErr)
    expect(wrapped.kind).toBe("unknown")
  })
})

// ────────────────────────────────────────────────────────────────────────
// F-CON: LLMError construction echoes typed kind + provider
// ────────────────────────────────────────────────────────────────────────

describe("ADR-0234 — fromSdkError constructed LLMError surface", () => {
  test("F-CON-1: wrapped error carries provider id + status code + kind", () => {
    const wrapped = LLMError.fromSdkError("anthropic", {
      status: 400,
      error: { type: "permission_error" },
      message: "policy block",
    })
    expect(wrapped).toBeInstanceOf(LLMError)
    expect(wrapped.kind).toBe("cyber_policy")
    expect(wrapped.provider).toBe("anthropic")
    expect(wrapped.statusCode).toBe(400)
    expect(wrapped.providerCode).toBe("permission_error")
  })

  test("F-CON-2: prefix preserved in message", () => {
    const wrapped = LLMError.fromSdkError(
      "openai",
      { status: 400, code: "context_length_exceeded", message: "too long" },
      "OpenAI stream error",
    )
    expect(wrapped.message.startsWith("OpenAI stream error")).toBe(true)
    expect(wrapped.kind).toBe("context_window_exceeded")
  })
})
