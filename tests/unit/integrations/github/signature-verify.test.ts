/**
 * ADR-0312 — verifyHubSignature256 happy paths.
 */

import { describe, expect, test } from "bun:test"
import { createHmac } from "node:crypto"

import { verifyHubSignature256 } from "@/integrations/github"

const sign = (body: Uint8Array, secret: string): string => {
  const h = createHmac("sha256", secret).update(body).digest("hex")
  return `sha256=${h}`
}

describe("ADR-0312 — verifyHubSignature256", () => {
  test("happy: matching signature ⇒ true", () => {
    const body = new TextEncoder().encode('{"hello":"world"}')
    const sig = sign(body, "shh")
    expect(verifyHubSignature256(body, sig, "shh")).toBe(true)
  })

  test("wrong secret ⇒ false", () => {
    const body = new TextEncoder().encode("payload")
    const sig = sign(body, "right")
    expect(verifyHubSignature256(body, sig, "wrong")).toBe(false)
  })

  test("tampered body ⇒ false", () => {
    const body = new TextEncoder().encode("original")
    const sig = sign(body, "shh")
    const tampered = new TextEncoder().encode("tampered")
    expect(verifyHubSignature256(tampered, sig, "shh")).toBe(false)
  })

  test("empty secret ⇒ false (no open bypass)", () => {
    const body = new TextEncoder().encode("x")
    const sig = sign(body, "")
    expect(verifyHubSignature256(body, sig, "")).toBe(false)
  })

  test("missing sha256= prefix ⇒ false", () => {
    const body = new TextEncoder().encode("x")
    const sig = sign(body, "shh").replace("sha256=", "")
    expect(verifyHubSignature256(body, sig, "shh")).toBe(false)
  })

  test("malformed hex ⇒ false", () => {
    const body = new TextEncoder().encode("x")
    expect(verifyHubSignature256(body, "sha256=zzzznothex", "shh")).toBe(false)
  })
})
