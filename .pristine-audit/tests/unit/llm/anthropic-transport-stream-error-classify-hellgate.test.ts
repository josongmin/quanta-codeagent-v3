/**
 * ★ DRIFT-LOCK — `classifyAnthropicTransportStreamError`
 *
 * Foundry and Mantle are Anthropic-grammar enterprise transports that previously
 * each open-coded an IDENTICAL stream-open error triage (a ProviderError
 * pass-through + an `/AccessDenied|Unauthorized|InvalidAuthentication/i` auth
 * regex + an `LLMError.fromSdkError("anthropic", …)` fallback). A regex that
 * drifted in one adapter and not the other would silently mis-route an auth
 * failure for that vendor only. Both now route through the single shared owner;
 * this battery pins the contract directly so a future edit cannot regress it.
 *
 * The two adapter hellgates (foundry-adapter-hellgate / mantle-real-stream)
 * additionally prove the helper is actually wired into each `openRawStream`.
 */
import { describe, expect, test } from "bun:test"
import { classifyAnthropicTransportStreamError } from "@/llm/adapters/shared"
import { ProviderError } from "@/llm/providers/provider-port"
import { LLMError } from "@/shared/errors"

// The helper RETURNS the error the adapter should throw (so the call site keeps
// an explicit `throw` TS recognises as terminal). Each adapter does
// `throw classifyAnthropicTransportStreamError(...)`.
const run = (e: unknown, label: "Foundry" | "Mantle", providerId: "foundry" | "mantle"): unknown =>
  classifyAnthropicTransportStreamError(e, label, providerId)

describe("classifyAnthropicTransportStreamError — shared triage", () => {
  test("a ProviderError passes through UNTOUCHED (identity, not re-wrapped)", () => {
    const original = new ProviderError("provider-missing-dependency", "sdk absent", {
      providerId: "foundry",
    })
    expect(run(original, "Foundry", "foundry")).toBe(original)
  })

  for (const sig of ["AccessDenied", "Unauthorized", "InvalidAuthentication"]) {
    test(`auth signature "${sig}" → ProviderError(provider-misconfigured) tagged by label`, () => {
      const e = new Error(`${sig}: creds rejected`)
      const out = run(e, "Foundry", "foundry")
      expect(out).toBeInstanceOf(ProviderError)
      expect((out as ProviderError).code).toBe("provider-misconfigured")
      expect((out as ProviderError).providerId).toBe("foundry")
      expect((out as ProviderError).message).toBe(`Foundry stream auth failed: ${e.message}`)
      // cause preserved for forensic.
      expect((out as { cause?: unknown }).cause).toBe(e)
    })
  }

  test("the regex is case-insensitive (lowercased SDK message still classifies)", () => {
    const out = run(new Error("unauthorized request"), "Mantle", "mantle")
    expect(out).toBeInstanceOf(ProviderError)
    expect((out as ProviderError).code).toBe("provider-misconfigured")
  })

  test("a generic wire error → LLMError (anthropic), NOT a ProviderError", () => {
    const out = run(new Error("ETIMEDOUT"), "Foundry", "foundry")
    expect(out).toBeInstanceOf(LLMError)
    expect(out).not.toBeInstanceOf(ProviderError)
  })

  test("LABEL/providerId are the ONLY per-adapter difference (Foundry vs Mantle parity)", () => {
    const e = new Error("AccessDenied: x")
    const f = run(e, "Foundry", "foundry") as ProviderError
    const m = run(e, "Mantle", "mantle") as ProviderError
    // Same code, same shape — only the human label + tag differ.
    expect(f.code).toBe(m.code)
    expect(f.message).toBe("Foundry stream auth failed: AccessDenied: x")
    expect(m.message).toBe("Mantle stream auth failed: AccessDenied: x")
    expect(f.providerId).toBe("foundry")
    expect(m.providerId).toBe("mantle")
  })

  test("a hostile throw whose stringifier throws does NOT escape the classifier", () => {
    const hostile = {
      get message() {
        throw new Error("nope")
      },
    }
    // errMessage survives this; the classifier must still produce a typed throw
    // (a generic LLMError here, since the salvaged tag does not match the regex).
    const out = run(hostile, "Mantle", "mantle")
    expect(out).toBeInstanceOf(LLMError)
  })
})
