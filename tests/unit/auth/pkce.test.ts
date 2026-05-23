import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  deriveChallengeS256,
  generateCodeVerifier,
  generateState,
} from "../../../src/auth/chatgpt-oauth/pkce"

const BASE64URL_RE = /^[A-Za-z0-9_-]+$/

describe("pkce", () => {
  test("code_verifier is URL-safe base64 with no padding", () => {
    const v = generateCodeVerifier()
    expect(BASE64URL_RE.test(v)).toBe(true)
    expect(v.endsWith("=")).toBe(false)
  })

  test("code_verifier length lands in RFC 7636 43..128 range (64 random bytes → 86 chars)", () => {
    const v = generateCodeVerifier()
    expect(v.length).toBeGreaterThanOrEqual(43)
    expect(v.length).toBeLessThanOrEqual(128)
  })

  test("two verifiers are different (entropy sanity check)", () => {
    expect(generateCodeVerifier()).not.toBe(generateCodeVerifier())
  })

  test("S256 challenge matches BASE64URL(SHA256(verifier))", () => {
    const v = "test-verifier-fixed-string-for-determinism"
    const expected = createHash("sha256")
      .update(v, "utf8")
      .digest("base64")
      .replace(/=+$/, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
    expect(deriveChallengeS256(v)).toBe(expected)
  })

  test("S256 challenge is URL-safe base64 with no padding", () => {
    const c = deriveChallengeS256(generateCodeVerifier())
    expect(BASE64URL_RE.test(c)).toBe(true)
  })

  test("state is URL-safe base64 and high-entropy (32 bytes)", () => {
    const s = generateState()
    expect(BASE64URL_RE.test(s)).toBe(true)
    expect(s.length).toBeGreaterThanOrEqual(43)
    expect(generateState()).not.toBe(s)
  })
})
