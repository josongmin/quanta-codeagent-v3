/**
 * ★ CONTRACT — ADR-0139 §provider-port:
 *   - ProviderError carries a closed-union `code` (`provider-unsupported` |
 *     `provider-misconfigured` | `provider-missing-dependency`).
 *   - `cause` is forwarded to the Error superclass ONLY when defined
 *     (exactOptional discipline).
 *   - `providerId` is attached when present, never as `undefined`.
 *   - `name` is fixed to `"ProviderError"` so loop-level classifiers can
 *     instanceof-check or string-discriminate.
 */
import { describe, expect, test } from "bun:test"
import type { ProviderErrorCode, ProviderId } from "@/llm/providers/provider-port"
import { ProviderError } from "@/llm/providers/provider-port"

describe("ProviderError — hellgate", () => {
  test("HELL-A1: name is the stable class tag", () => {
    const err = new ProviderError("provider-unsupported", "x")
    expect(err.name).toBe("ProviderError")
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(ProviderError)
  })

  test("HELL-A2: code is preserved verbatim across the three arms", () => {
    const codes: ProviderErrorCode[] = [
      "provider-unsupported",
      "provider-misconfigured",
      "provider-missing-dependency",
    ]
    for (const c of codes) {
      expect(new ProviderError(c, "m").code).toBe(c)
    }
  })

  test("HELL-A3: message round-trips", () => {
    const err = new ProviderError("provider-unsupported", "human readable")
    expect(err.message).toBe("human readable")
  })

  test("HELL-B1: cause is forwarded when supplied", () => {
    const inner = new Error("underlying")
    const err = new ProviderError("provider-missing-dependency", "x", { cause: inner })
    expect(err.cause).toBe(inner)
  })

  test("HELL-B2: cause stays undefined when options omitted", () => {
    const err = new ProviderError("provider-unsupported", "x")
    expect(err.cause).toBeUndefined()
  })

  test("HELL-B3: cause stays undefined when options.cause undefined (exactOptional)", () => {
    const err = new ProviderError("provider-unsupported", "x", { providerId: "default" })
    expect(err.cause).toBeUndefined()
  })

  test("HELL-C1: providerId attached when supplied", () => {
    const ids: ProviderId[] = ["default", "bedrock", "vertex", "foundry"]
    for (const id of ids) {
      const err = new ProviderError("provider-misconfigured", "x", { providerId: id })
      expect(err.providerId).toBe(id)
    }
  })

  test("HELL-C2: providerId stays absent when not supplied", () => {
    const err = new ProviderError("provider-misconfigured", "x")
    expect(err.providerId).toBeUndefined()
  })

  test("HELL-D1: throw/catch round-trip preserves code", () => {
    try {
      throw new ProviderError("provider-missing-dependency", "boom", { providerId: "bedrock" })
    } catch (e) {
      expect(e).toBeInstanceOf(ProviderError)
      const err = e as ProviderError
      expect(err.code).toBe("provider-missing-dependency")
      expect(err.providerId).toBe("bedrock")
    }
  })
})
