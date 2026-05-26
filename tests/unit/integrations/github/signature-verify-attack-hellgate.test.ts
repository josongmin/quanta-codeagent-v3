/**
 * ADR-0312 hellgate — verifyHubSignature256 against forged / malformed sigs.
 */

import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"

import { verifyHubSignature256 } from "@/integrations/github"

const sign = (body: Uint8Array, secret: string): string =>
  `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`

describe("ADR-0312 hellgate — signature verifier", () => {
  test("empty signature header ⇒ false", () => {
    expect(verifyHubSignature256(new Uint8Array(), "", "shh")).toBe(false)
  })

  test("undefined-shaped header ⇒ false (defensive cast)", () => {
    // biome-ignore lint/suspicious/noExplicitAny: testing tolerance
    expect(verifyHubSignature256(new Uint8Array(), undefined as any, "shh")).toBe(false)
  })

  test("sha1 prefix instead of sha256 ⇒ false", () => {
    const body = new TextEncoder().encode("x")
    const tag = createHmac("sha1", "shh").update(body).digest("hex")
    expect(verifyHubSignature256(body, `sha1=${tag}`, "shh")).toBe(false)
  })

  test("typo prefix 'sha256:' ⇒ false", () => {
    const body = new TextEncoder().encode("x")
    expect(verifyHubSignature256(body, `sha256:${"a".repeat(64)}`, "shh")).toBe(false)
  })

  test("uppercase hex still matches (case-insensitive hex)", () => {
    const body = new TextEncoder().encode("uppercase")
    const lower = sign(body, "shh")
    const upper = `sha256=${lower.slice(7).toUpperCase()}`
    expect(verifyHubSignature256(body, upper, "shh")).toBe(true)
  })

  test("signature with non-hex byte ⇒ false", () => {
    const body = new TextEncoder().encode("x")
    expect(verifyHubSignature256(body, `sha256=zz${"a".repeat(62)}`, "shh")).toBe(false)
  })

  test("signature too short ⇒ false", () => {
    const body = new TextEncoder().encode("x")
    expect(verifyHubSignature256(body, "sha256=abcd", "shh")).toBe(false)
  })

  test("signature too long ⇒ false", () => {
    const body = new TextEncoder().encode("x")
    expect(verifyHubSignature256(body, `sha256=${"a".repeat(65)}`, "shh")).toBe(false)
  })

  test("length-extension probe: appending bytes to body invalidates", () => {
    const body = new TextEncoder().encode("orig")
    const sig = sign(body, "shh")
    const extended = new TextEncoder().encode("origEXTRA")
    expect(verifyHubSignature256(extended, sig, "shh")).toBe(false)
  })

  test("empty body but valid signature ⇒ true", () => {
    const body = new Uint8Array()
    const sig = sign(body, "shh")
    expect(verifyHubSignature256(body, sig, "shh")).toBe(true)
  })

  test("empty secret returns false even with valid-shaped sig", () => {
    const body = new TextEncoder().encode("x")
    expect(verifyHubSignature256(body, `sha256=${"a".repeat(64)}`, "")).toBe(false)
  })

  test("constant-time semantics: malformed-hex never throws", () => {
    const body = new TextEncoder().encode("x")
    expect(() => verifyHubSignature256(body, "sha256=", "shh")).not.toThrow()
  })

  test("signature with whitespace ⇒ false", () => {
    const body = new TextEncoder().encode("x")
    const sig = sign(body, "shh")
    expect(verifyHubSignature256(body, ` ${sig}`, "shh")).toBe(false)
  })

  test("random forged signature ⇒ false", () => {
    const body = new TextEncoder().encode("payload")
    expect(verifyHubSignature256(body, `sha256=${"f".repeat(64)}`, "shh")).toBe(false)
  })

  test("repeated calls with same input are deterministic", () => {
    const body = new TextEncoder().encode("y")
    const sig = sign(body, "shh")
    for (let i = 0; i < 10; i++) {
      expect(verifyHubSignature256(body, sig, "shh")).toBe(true)
    }
  })
})
