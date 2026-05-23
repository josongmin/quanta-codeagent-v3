import { describe, expect, test } from "bun:test"
import {
  JwtDecodeError,
  decodeJwtClaims,
  isFreePlan,
} from "../../../src/auth/chatgpt-oauth/jwt"

const toBase64Url = (s: string): string =>
  Buffer.from(s, "utf8")
    .toString("base64")
    .replace(/=+$/, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")

const fakeJwt = (payload: object): string => {
  const header = toBase64Url('{"alg":"RS256","typ":"JWT"}')
  const body = toBase64Url(JSON.stringify(payload))
  return `${header}.${body}.sig-stub`
}

describe("jwt.decodeJwtClaims", () => {
  test("extracts auth-namespace claims (plan / account / user)", () => {
    const token = fakeJwt({
      sub: "user-1",
      email: "x@example.com",
      exp: 1717000000,
      "https://api.openai.com/auth": {
        chatgpt_plan_type: "plus",
        chatgpt_account_id: "acct_abc",
        chatgpt_user_id: "user_xyz",
      },
    })
    const c = decodeJwtClaims(token)
    expect(c.sub).toBe("user-1")
    expect(c.email).toBe("x@example.com")
    expect(c.exp).toBe(1717000000)
    expect(c.chatgpt_plan_type).toBe("plus")
    expect(c.chatgpt_account_id).toBe("acct_abc")
    expect(c.chatgpt_user_id).toBe("user_xyz")
  })

  test("absent fields stay absent (no `undefined` placeholders)", () => {
    const token = fakeJwt({ sub: "u" })
    const c = decodeJwtClaims(token)
    expect("chatgpt_plan_type" in c).toBe(false)
    expect("email" in c).toBe(false)
  })

  test("throws on wrong segment count", () => {
    expect(() => decodeJwtClaims("a.b")).toThrow(JwtDecodeError)
    expect(() => decodeJwtClaims("solo")).toThrow(JwtDecodeError)
  })

  test("throws on non-JSON payload", () => {
    const t = `${toBase64Url("hdr")}.${toBase64Url("not json")}.sig`
    expect(() => decodeJwtClaims(t)).toThrow(JwtDecodeError)
  })

  test("throws when payload is not an object (e.g. number)", () => {
    const t = `${toBase64Url("hdr")}.${toBase64Url("42")}.sig`
    expect(() => decodeJwtClaims(t)).toThrow(JwtDecodeError)
  })

  test("auth namespace at top level (non-namespaced) is ignored", () => {
    // Make sure we don't accidentally accept `chatgpt_plan_type` at the
    // top level — Codex's tokens nest it under the namespace key.
    const token = fakeJwt({ chatgpt_plan_type: "plus" })
    const c = decodeJwtClaims(token)
    expect(c.chatgpt_plan_type).toBeUndefined()
  })
})

describe("jwt.isFreePlan", () => {
  test("true for 'free' (case-insensitive)", () => {
    expect(isFreePlan({ chatgpt_plan_type: "free" })).toBe(true)
    expect(isFreePlan({ chatgpt_plan_type: "FREE" })).toBe(true)
    expect(isFreePlan({ chatgpt_plan_type: "Free" })).toBe(true)
  })

  test("false for plus/pro/team/business/enterprise", () => {
    for (const p of ["plus", "pro", "team", "business", "enterprise"]) {
      expect(isFreePlan({ chatgpt_plan_type: p })).toBe(false)
    }
  })

  test("false when absent (unknown plan should NOT auto-fail; backend is authoritative)", () => {
    expect(isFreePlan({})).toBe(false)
  })
})
