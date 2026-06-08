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
  FORBIDDEN_FRAMING,
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

describe("applyHeaderRules — FORBIDDEN-FRAMING guard (request-smuggling / domain-fronting defense)", () => {
  // The proxy re-originates the request over its OWN connection and runs a
  // framing-fix (Content-Length recompute, Connection: close, hop-by-hop strip)
  // AFTER these rules. A set/append of a framing/routing header would re-inject a
  // conflicting Transfer-Encoding/Content-Length (request-smuggling) or rewrite
  // the Host/routing (domain-fronting) past that fix. Mirrors the FORBIDDEN-INJECT
  // op-policy: set/append are REFUSED (silent + value-free audit 'forbidden-
  // framing'); strip/rewrite of an already-present framing header stays allowed.
  const FRAMING = [
    "transfer-encoding",
    "content-length",
    "host",
    "connection",
    "proxy-connection",
    "keep-alive",
    "te",
    "upgrade",
  ] as const

  for (const name of FRAMING) {
    test(`set ${name} is refused (silent-ignore + audit refused:forbidden-framing, header NOT written)`, () => {
      const { headers, audit } = applyHeaderRules(H(), [{ name, op: "set", value: "smuggled" }])
      // host pre-seeded by H() must be UNTOUCHED; every other framing header ABSENT.
      if (name !== "host") expect(headers[name]).toBeUndefined()
      else expect(headers.host).toBe("allowed.test") // a forbidden `set host` did NOT overwrite
      expect(audit).toEqual([
        { index: 0, headerName: name, op: "set", fired: false, refused: "forbidden-framing" },
      ])
    })

    test(`append ${name} is refused (header NOT written, audit refused:forbidden-framing)`, () => {
      const { headers, audit } = applyHeaderRules(H(), [{ name, op: "append", value: "smuggled" }])
      if (name !== "host") expect(headers[name]).toBeUndefined()
      else expect(headers.host).toBe("allowed.test")
      expect(audit[0]?.fired).toBe(false)
      expect(audit[0]?.refused).toBe("forbidden-framing")
    })
  }

  test("STRIP of a framing header is ALLOWED (removing a present hop-by-hop header is fine)", () => {
    const { headers, audit } = applyHeaderRules(H({ "transfer-encoding": "chunked" }), [
      { name: "transfer-encoding", op: "strip" },
    ])
    expect(headers["transfer-encoding"]).toBeUndefined()
    expect(audit[0]?.fired).toBe(true)
  })

  test("REWRITE of an already-present framing header is ALLOWED (not re-injection)", () => {
    const { headers, audit } = applyHeaderRules(H({ connection: "keep-alive" }), [
      { name: "connection", op: "rewrite", value: "close" },
    ])
    expect(headers.connection).toBe("close")
    expect(audit[0]?.fired).toBe(true)
  })

  test("the forbidden-framing set is the documented SSOT (8 lowercase framing/routing headers)", () => {
    for (const name of FRAMING) expect(FORBIDDEN_FRAMING.has(name)).toBe(true)
    expect(FORBIDDEN_FRAMING.size).toBe(FRAMING.length)
  })

  test("forbidden-framing guard is case-insensitive (Transfer-Encoding is still refused)", () => {
    const { headers, audit } = applyHeaderRules(H(), [
      { name: "Transfer-Encoding", op: "set", value: "chunked" },
    ])
    expect(headers["transfer-encoding"]).toBeUndefined()
    expect(audit[0]?.refused).toBe("forbidden-framing")
  })
})

describe("applyHeaderRules — NO-THROW header-NAME validation (RFC7230 token / DoS guard)", () => {
  // An illegal header name would make the caller's http.request() throw
  // SYNCHRONOUSLY inside a void-invoked async (mitmForwardUpstream) → unhandled
  // rejection + client hang. We REFUSE such a rule as 'malformed' (never throw,
  // header map untouched + still forwardable).
  for (const badName of [
    "x\ttrace", // TAB inside the name
    "x trace", // SPACE inside the name
    "x(trace)", // parens — not a tchar
    "x:trace", // colon — header field separator
    "x\x00trace", // NUL byte
  ]) {
    test(`set with illegal NAME ${JSON.stringify(badName)} ⇒ refused malformed, never thrown`, () => {
      const before = H({ keep: "yes" })
      let res: ReturnType<typeof applyHeaderRules> | undefined
      expect(() => {
        res = applyHeaderRules(before, [{ name: badName, op: "set", value: "v" }])
      }).not.toThrow()
      const { headers, audit } = res as ReturnType<typeof applyHeaderRules>
      // The illegal name was NEVER written into the forwardable map.
      expect(headers[badName]).toBeUndefined()
      expect(headers[badName.toLowerCase()]).toBeUndefined()
      expect(headers.keep).toBe("yes") // map otherwise untouched + forwardable
      expect(audit[0]?.fired).toBe(false)
      expect(audit[0]?.refused).toBe("malformed")
    })
  }

  test("an ALL-WHITESPACE name ⇒ malformed (empty token after trim is not a valid name)", () => {
    const { headers, audit } = applyHeaderRules(H(), [{ name: "   ", op: "set", value: "v" }])
    expect(headers[""]).toBeUndefined()
    expect(audit[0]?.fired).toBe(false)
    expect(audit[0]?.refused).toBe("malformed")
  })

  test("STRIP with an illegal NAME is refused malformed (name validation applies to EVERY op)", () => {
    const before = H({ "x-trace": "v" })
    const { headers, audit } = applyHeaderRules(before, [{ name: "x\ttrace", op: "strip" }])
    expect(headers["x-trace"]).toBe("v") // a non-matching strip never touched the real header
    expect(audit[0]?.fired).toBe(false)
    expect(audit[0]?.refused).toBe("malformed")
  })
})

describe("applyHeaderRules — NO-THROW header-VALUE validation (CR/LF/NUL injection / DoS guard)", () => {
  for (const badValue of [
    "a\rb", // bare CR
    "a\nb", // bare LF
    "a\r\nInjected: 1", // CRLF header-injection attempt
    "a\x00b", // NUL byte
  ]) {
    test(`set with illegal VALUE ${JSON.stringify(badValue)} ⇒ refused malformed, header untouched`, () => {
      const before = H({ "x-h": "keep" })
      let res: ReturnType<typeof applyHeaderRules> | undefined
      expect(() => {
        res = applyHeaderRules(before, [{ name: "x-h", op: "set", value: badValue }])
      }).not.toThrow()
      const { headers, audit } = res as ReturnType<typeof applyHeaderRules>
      expect(headers["x-h"]).toBe("keep") // untouched — the bad value never landed
      expect(audit[0]?.fired).toBe(false)
      expect(audit[0]?.refused).toBe("malformed")
    })
  }

  test("APPEND with an illegal VALUE is refused (the multi-value array is not built)", () => {
    const before = H({ "x-tag": "first" })
    const { headers, audit } = applyHeaderRules(before, [
      { name: "x-tag", op: "append", value: "bad\r\nInjected: 1" },
    ])
    expect(headers["x-tag"]).toBe("first") // untouched, NOT ["first", "bad…"]
    expect(audit[0]?.fired).toBe(false)
    expect(audit[0]?.refused).toBe("malformed")
  })

  test("a REFUSED illegal value NEVER appears in the audit (value is never recorded)", () => {
    const secretish = "leak\r\nX-Evil: pwned"
    const { audit } = applyHeaderRules(H(), [{ name: "x-h", op: "set", value: secretish }])
    expect(audit[0]?.refused).toBe("malformed")
    expect(JSON.stringify(audit).includes("pwned")).toBe(false)
    expect(JSON.stringify(audit).includes("leak")).toBe(false)
  })
})

describe("applyHeaderRules — FORBIDDEN-INJECT whitespace-bypass (mutation-kill of missing .trim())", () => {
  // norm() trims THEN lowercases; the resulting `headerName` feeds BOTH the
  // NO-THROW name-validation and the FORBIDDEN_INJECT lookup.
  //
  // NAME-VALIDATION-FIRST REALITY: with the no-`.trim()` mutant, `headerName`
  // keeps its padding (' authorization '), and the every-op name-validation runs
  // FIRST on that padded value — which is NOT an RFC7230 tchar token (a space is
  // illegal in a header name) — so the rule is refused as 'malformed' BEFORE the
  // credential guard is even reached. So the no-`.trim()` mutant is now killed via
  // the 'malformed' path (a padded credential name NEVER reaches the wire under
  // any key), not via the forbidden-inject path. Either refusal kills it; these
  // cases assert the credential header is ABSENT under BOTH padded + canonical key.
  for (const padded of [" Authorization ", "  Cookie  "]) {
    test(`set ${JSON.stringify(padded)} ⇒ REFUSED (header ABSENT under padded + canonical key)`, () => {
      const canonical = padded.trim().toLowerCase()
      const { headers, audit } = applyHeaderRules(H(), [
        { name: padded, op: "set", value: "forged" },
      ])
      // The credential header is ABSENT under BOTH the padded and canonical keys.
      expect(headers[padded]).toBeUndefined()
      expect(headers[canonical]).toBeUndefined()
      expect(audit[0]?.fired).toBe(false)
      // Real code: norm() trims → name-validation PASSES on the legal token →
      // forbidden-inject fires. (A no-trim mutant would instead refuse 'malformed'.)
      expect(audit[0]?.refused).toBe("forbidden-inject")
    })
  }

  // CREDENTIAL-GUARD-TRIM load-bearing: a forbidden name padded ONLY with leading/
  // trailing whitespace that String.trim() removes. Once normed, the name is a
  // LEGAL RFC7230 token (so name-validation PASSES) — therefore the ONLY thing that
  // routes it to the credential guard is the `.trim()` inside norm(): the raw
  // padded form is NOT in FORBIDDEN_INJECT (.has is exact), only the trimmed form
  // is. This pins the trim as load-bearing for the credential lookup specifically.
  test("a trim-padded forbidden name is bridged to the credential guard by norm()'s trim", () => {
    const padded = " authorization " // pads are trimmable whitespace; core token is legal
    // The Set lookup is EXACT: the padded key misses, only the trimmed key hits —
    // so without the trim the guard would NOT recognize this as a credential.
    expect(FORBIDDEN_INJECT.has(padded)).toBe(false)
    expect(FORBIDDEN_INJECT.has(padded.trim())).toBe(true)

    const { headers, audit } = applyHeaderRules(H(), [
      { name: padded, op: "set", value: "Bearer forged" },
    ])
    expect(headers.authorization).toBeUndefined() // never injected under the canonical key
    expect(headers[padded]).toBeUndefined() // nor the padded key
    expect(audit[0]?.fired).toBe(false)
    expect(audit[0]?.refused).toBe("forbidden-inject")
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
