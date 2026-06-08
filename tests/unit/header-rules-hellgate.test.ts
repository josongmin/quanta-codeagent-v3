/**
 * ticket-13 (§12.2) — outbound header-rewrite PURE-CORE hellgate.
 *
 * Proves the pure transform (the e2e socket proof lives in
 * tests/integration/header-rewrite-proxy-e2e.test.ts):
 *  - strip removes · set overwrites/creates · append adds (multi-value, distinct
 *    from set) · rewrite ONLY-IF-present.
 *  - ORDER: a later rule undoes an earlier one.
 *  - malformed (value-requiring op, no value) → silent-ignore (+ audit fired:false).
 *  - FORBIDDEN-INJECT: set/append on authorization/cookie/… → silent-ignore + warn
 *    (audit fired:false, refused:"forbidden-inject"); strip/rewrite on them is OK.
 *  - case-insensitivity (rule name vs header name).
 *  - NO-RULES pass-through is BYTE-IDENTICAL (same object by reference, zero audit)
 *    AND the input is never mutated in place when rules ARE present.
 *  - audit-log entries NEVER carry the value (only index/name/op/fired).
 *  - shouldStripOnRedirect: cross-origin (scheme/host/port differ) → true;
 *    same-origin (incl. default-port normalization) → false; unparseable → true.
 */

import { describe, expect, test } from "bun:test"
import {
  applyHeaderRules,
  CROSS_ORIGIN_STRIP_HEADERS,
  FORBIDDEN_INJECT,
  type HeaderRule,
  type MutableHeaders,
  shouldStripOnRedirect,
} from "@/runtime/network-proxy"

const H = (over: MutableHeaders = {}): MutableHeaders => ({ host: "allowed.test", ...over })

describe("applyHeaderRules — strip", () => {
  test("strip removes a present header", () => {
    const { headers, audit } = applyHeaderRules(H({ "x-trace": "abc" }), [
      { name: "x-trace", op: "strip" },
    ])
    expect(headers["x-trace"]).toBeUndefined()
    expect(headers.host).toBe("allowed.test")
    expect(audit).toEqual([{ index: 0, headerName: "x-trace", op: "strip", fired: true }])
  })

  test("strip on an ABSENT header is a no-op (audit fired:false, refused:absent)", () => {
    const { headers, audit } = applyHeaderRules(H(), [{ name: "x-missing", op: "strip" }])
    expect(headers).toEqual(H())
    expect(audit).toEqual([
      { index: 0, headerName: "x-missing", op: "strip", fired: false, refused: "absent" },
    ])
  })
})

describe("applyHeaderRules — set", () => {
  test("set OVERWRITES an existing single value", () => {
    const { headers } = applyHeaderRules(H({ "x-env": "dev" }), [
      { name: "x-env", op: "set", value: "prod" },
    ])
    expect(headers["x-env"]).toBe("prod")
  })

  test("set CREATES a header that did not exist", () => {
    const { headers, audit } = applyHeaderRules(H(), [
      { name: "x-source", op: "set", value: "quanta" },
    ])
    expect(headers["x-source"]).toBe("quanta")
    expect(audit[0]?.fired).toBe(true)
  })

  test("set REPLACES a multi-value header with a single value (overwrite semantics)", () => {
    const { headers } = applyHeaderRules(H({ "x-tag": ["a", "b"] }), [
      { name: "x-tag", op: "set", value: "only" },
    ])
    expect(headers["x-tag"]).toBe("only")
  })
})

describe("applyHeaderRules — append (multi-value, DISTINCT from set)", () => {
  test("append ADDS to an existing single value → array of both", () => {
    const { headers } = applyHeaderRules(H({ "x-tag": "first" }), [
      { name: "x-tag", op: "append", value: "second" },
    ])
    expect(headers["x-tag"]).toEqual(["first", "second"])
  })

  test("append to an existing ARRAY keeps all prior values", () => {
    const { headers } = applyHeaderRules(H({ "x-tag": ["a", "b"] }), [
      { name: "x-tag", op: "append", value: "c" },
    ])
    expect(headers["x-tag"]).toEqual(["a", "b", "c"])
  })

  test("append to an ABSENT header creates it as a single value", () => {
    const { headers } = applyHeaderRules(H(), [{ name: "x-tag", op: "append", value: "v" }])
    expect(headers["x-tag"]).toBe("v")
  })

  test("set then append builds a multi-value header (set ≠ append)", () => {
    const { headers } = applyHeaderRules(H(), [
      { name: "x-tag", op: "set", value: "one" },
      { name: "x-tag", op: "append", value: "two" },
    ])
    expect(headers["x-tag"]).toEqual(["one", "two"])
  })
})

describe("applyHeaderRules — rewrite (ONLY if present)", () => {
  test("rewrite REPLACES a present header", () => {
    const { headers, audit } = applyHeaderRules(H({ "user-agent": "curl/8" }), [
      { name: "user-agent", op: "rewrite", value: "quanta/1" },
    ])
    expect(headers["user-agent"]).toBe("quanta/1")
    expect(audit[0]?.fired).toBe(true)
  })

  test("rewrite on an ABSENT header does NOT create it (no-op, audit refused:absent)", () => {
    const { headers, audit } = applyHeaderRules(H(), [
      { name: "user-agent", op: "rewrite", value: "quanta/1" },
    ])
    expect(headers["user-agent"]).toBeUndefined()
    expect(audit).toEqual([
      { index: 0, headerName: "user-agent", op: "rewrite", fired: false, refused: "absent" },
    ])
  })
})

describe("applyHeaderRules — ORDER (later rule undoes earlier)", () => {
  test("set X then strip X ⇒ X removed", () => {
    const { headers, audit } = applyHeaderRules(H(), [
      { name: "x-flag", op: "set", value: "on" },
      { name: "x-flag", op: "strip" },
    ])
    expect(headers["x-flag"]).toBeUndefined()
    expect(audit.map((a) => a.fired)).toEqual([true, true])
  })

  test("strip X then set X ⇒ X present with the new value", () => {
    const { headers } = applyHeaderRules(H({ "x-flag": "old" }), [
      { name: "x-flag", op: "strip" },
      { name: "x-flag", op: "set", value: "new" },
    ])
    expect(headers["x-flag"]).toBe("new")
  })

  test("rewrite then strip vs strip then rewrite are order-sensitive", () => {
    // strip first ⇒ rewrite finds it absent ⇒ no-op.
    const a = applyHeaderRules(H({ "x-h": "v" }), [
      { name: "x-h", op: "strip" },
      { name: "x-h", op: "rewrite", value: "r" },
    ])
    expect(a.headers["x-h"]).toBeUndefined()
    // rewrite first ⇒ replaces, then strip removes.
    const b = applyHeaderRules(H({ "x-h": "v" }), [
      { name: "x-h", op: "rewrite", value: "r" },
      { name: "x-h", op: "strip" },
    ])
    expect(b.headers["x-h"]).toBeUndefined()
  })
})

describe("applyHeaderRules — malformed (value-requiring op, no value) → silent-ignore", () => {
  for (const op of ["set", "append", "rewrite"] as const) {
    test(`${op} with no value is silently ignored (audit refused:malformed)`, () => {
      const before = H({ "x-h": "keep" })
      const { headers, audit } = applyHeaderRules(before, [{ name: "x-h", op } as HeaderRule])
      expect(headers["x-h"]).toBe("keep") // untouched
      expect(audit).toEqual([
        { index: 0, headerName: "x-h", op, fired: false, refused: "malformed" },
      ])
    })
  }
})

describe("applyHeaderRules — FORBIDDEN-INJECT guard (operator-misconfig defense)", () => {
  for (const name of [...FORBIDDEN_INJECT]) {
    test(`set ${name} is refused (silent-ignore + audit refused:forbidden-inject)`, () => {
      const { headers, audit } = applyHeaderRules(H(), [{ name, op: "set", value: "forged" }])
      expect(headers[name]).toBeUndefined() // NEVER injected
      expect(audit).toEqual([
        { index: 0, headerName: name, op: "set", fired: false, refused: "forbidden-inject" },
      ])
    })

    test(`append ${name} is refused`, () => {
      const { headers, audit } = applyHeaderRules(H(), [{ name, op: "append", value: "forged" }])
      expect(headers[name]).toBeUndefined()
      expect(audit[0]?.refused).toBe("forbidden-inject")
    })
  }

  test("STRIP of a forbidden header is ALLOWED (removing a credential is fine)", () => {
    const { headers, audit } = applyHeaderRules(H({ authorization: "Bearer x" }), [
      { name: "authorization", op: "strip" },
    ])
    expect(headers.authorization).toBeUndefined()
    expect(audit[0]?.fired).toBe(true)
  })

  test("REWRITE of an already-present forbidden header is ALLOWED (not injection)", () => {
    const { headers, audit } = applyHeaderRules(H({ authorization: "Bearer old" }), [
      { name: "authorization", op: "rewrite", value: "Bearer new" },
    ])
    expect(headers.authorization).toBe("Bearer new")
    expect(audit[0]?.fired).toBe(true)
  })

  test("the forbidden set is the documented SSOT (auth/cookie/proxy-auth/www-auth)", () => {
    expect(FORBIDDEN_INJECT.has("authorization")).toBe(true)
    expect(FORBIDDEN_INJECT.has("cookie")).toBe(true)
    expect(FORBIDDEN_INJECT.has("set-cookie")).toBe(true)
    expect(FORBIDDEN_INJECT.has("proxy-authorization")).toBe(true)
  })
})

describe("applyHeaderRules — case-insensitive matching/normalization", () => {
  test("a rule name in MIXED case matches a lowercase header and normalizes the audit name", () => {
    const { headers, audit } = applyHeaderRules(H({ "x-trace": "v" }), [
      { name: "X-Trace", op: "strip" },
    ])
    expect(headers["x-trace"]).toBeUndefined()
    expect(audit[0]?.headerName).toBe("x-trace")
  })

  test("forbidden guard is case-insensitive (Authorization is still refused)", () => {
    const { headers, audit } = applyHeaderRules(H(), [
      { name: "Authorization", op: "set", value: "Bearer x" },
    ])
    expect(headers.authorization).toBeUndefined()
    expect(audit[0]?.refused).toBe("forbidden-inject")
  })
})

describe("applyHeaderRules — DEFAULT-OFF byte-identity", () => {
  test("rules ABSENT ⇒ the SAME object by reference + empty audit", () => {
    const input = H({ "x-h": "v" })
    const out = applyHeaderRules(input)
    expect(out.headers).toBe(input) // referential identity — byte-identical
    expect(out.audit).toEqual([])
  })

  test("rules EMPTY ⇒ the SAME object by reference", () => {
    const input = H({ "x-h": "v" })
    const out = applyHeaderRules(input, [])
    expect(out.headers).toBe(input)
  })

  test("when rules ARE present the INPUT object is never mutated in place", () => {
    const input = H({ "x-h": "v" })
    const snapshot = { ...input }
    const out = applyHeaderRules(input, [{ name: "x-h", op: "set", value: "changed" }])
    expect(input).toEqual(snapshot) // original untouched
    expect(out.headers).not.toBe(input) // a copy was returned
    expect(out.headers["x-h"]).toBe("changed")
  })
})

describe("applyHeaderRules — audit NEVER carries the value", () => {
  test("a fired set audit entry exposes only index/name/op/fired (no value field)", () => {
    const { audit } = applyHeaderRules(H(), [
      { name: "x-secret-ish", op: "set", value: "super-secret-token" },
    ])
    const entry = audit[0]
    expect(entry).toBeDefined()
    expect(Object.keys(entry as object).sort()).toEqual(["fired", "headerName", "index", "op"])
    expect(JSON.stringify(audit).includes("super-secret-token")).toBe(false)
  })
})

describe("shouldStripOnRedirect — cross-origin token-leak defense", () => {
  test("same origin ⇒ false (keep headers)", () => {
    expect(shouldStripOnRedirect("https://allowed.test/a", "https://allowed.test/b")).toBe(false)
  })

  test("default-port normalization: https://h vs https://h:443 is SAME origin", () => {
    expect(shouldStripOnRedirect("https://h/a", "https://h:443/b")).toBe(false)
    expect(shouldStripOnRedirect("http://h/a", "http://h:80/b")).toBe(false)
  })

  test("different HOST ⇒ true (strip)", () => {
    expect(shouldStripOnRedirect("https://a.test/x", "https://evil.test/x")).toBe(true)
  })

  test("different SCHEME ⇒ true (https→http downgrade)", () => {
    expect(shouldStripOnRedirect("https://a.test/x", "http://a.test/x")).toBe(true)
  })

  test("different PORT ⇒ true", () => {
    expect(shouldStripOnRedirect("https://a.test:443/x", "https://a.test:8443/x")).toBe(true)
  })

  test("an UNPARSEABLE url fails closed (strip)", () => {
    expect(shouldStripOnRedirect("not a url", "https://a.test/x")).toBe(true)
    expect(shouldStripOnRedirect("https://a.test/x", "::::")).toBe(true)
  })

  test("the cross-origin strip set is authorization/cookie/host (SSOT)", () => {
    expect(CROSS_ORIGIN_STRIP_HEADERS).toEqual(["authorization", "cookie", "host"])
  })
})
