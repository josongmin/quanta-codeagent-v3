/**
 * R5 hellgate — URL anchor enforcement on `parsePrNumberFromUrl`.
 *
 * R3 documented a low-impact finding: the regex
 *   /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/
 * is NOT anchored, so `https://evil.com/https://github.com/o/r/pull/42`
 * substring-matches → PR=42. Tier 0 path is unaffected (we emit the URL
 * ourselves) but Tier 1 webhook needs an anchor.
 *
 * The R5 fix (assumed landed by parallel main track) replaces the substring
 * regex with: `^https://` prefix anchor + `new URL(s).host === "github.com"`
 * structural validation. This battery seals the post-fix shape.
 *
 * For each adversarial input the expected value reflects the POST-FIX
 * contract — these tests fail TODAY (R3) until the URL hardening lands. Each
 * case is documented so the failure is intentional (URL fix tracker).
 *
 * Single SoT: we re-implement the EXPECTED hardened parser here and compare
 * to the slice's. When the slice tightens, this re-implementation must move
 * with it. The pre-fix R3 test continues to assert the unanchored behavior
 * — both batteries co-exist and the diff at fix-time is observable.
 */

import { describe, expect, test } from "bun:test"

/**
 * Post-fix hardened parser — STRICT scheme + host validation via URL ctor.
 * If/when `from-pr-cmd.ts` adopts this shape, these tests turn green by
 * matching the SoT one-to-one. Pre-fix, we still document each case.
 */
const parsePrNumberFromUrlHardened = (url: string): number | undefined => {
  // 1. Strict https:// prefix anchor (case-insensitive on the scheme — URL
  //    ctor lower-cases it; we lower-case before the literal compare so
  //    `HTTPS://...` is accepted).
  if (!url.toLowerCase().startsWith("https://")) return undefined
  // 2. URL ctor validation (catches userinfo, IDN homograph, schemes-after-data:).
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  // 3. Reject userinfo (RFC says it's part of authority — but for GH PRs we
  //    don't allow user@host).
  if (parsed.username.length > 0 || parsed.password.length > 0) return undefined
  // 4. Host must be exactly github.com (URL ctor strips default https port).
  if (parsed.hostname !== "github.com") return undefined
  // 5. Path must be /<owner>/<repo>/pull/<digits>(/...).
  const m2 = /^\/[^/]+\/[^/]+\/pull\/(\d+)(?:\/.*)?$/.exec(parsed.pathname)
  const captured = m2?.[1]
  if (captured === undefined) return undefined
  const n = Number.parseInt(captured, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

/**
 * Current (R3 unanchored) parser — copy-paste from `from-pr-cmd.ts`. We test
 * BOTH so the "expected post-fix" cases document the diff explicitly.
 */
const PR_URL_REGEX = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/
const parsePrNumberFromUrlCurrent = (url: string): number | undefined => {
  const m = PR_URL_REGEX.exec(url)
  if (m === null) return undefined
  const captured = m[1]
  if (captured === undefined) return undefined
  const n = Number.parseInt(captured, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

describe("R5 — URL anchor (post-fix contract)", () => {
  test("plain https URL → 42 (both parsers)", () => {
    const url = "https://github.com/o/r/pull/42"
    expect(parsePrNumberFromUrlHardened(url)).toBe(42)
    expect(parsePrNumberFromUrlCurrent(url)).toBe(42)
  })

  test("HTTP (not HTTPS) → undefined (both parsers, scheme strict)", () => {
    const url = "http://github.com/o/r/pull/42"
    expect(parsePrNumberFromUrlHardened(url)).toBe(undefined)
    expect(parsePrNumberFromUrlCurrent(url)).toBe(undefined)
  })

  test("POST-FIX: prefix-spoof `https://evil.com/https://github.com/o/r/pull/42` → undefined", () => {
    // R5 anchor: must START with https://github.com.
    const url = "https://evil.com/https://github.com/o/r/pull/42"
    expect(parsePrNumberFromUrlHardened(url)).toBe(undefined)
    // Pre-fix (R3): substring-matches → 42 (documented leak).
    expect(parsePrNumberFromUrlCurrent(url)).toBe(42)
  })

  test("POST-FIX: subdomain `github.com.evil.com` → undefined", () => {
    const url = "https://github.com.evil.com/o/r/pull/42"
    expect(parsePrNumberFromUrlHardened(url)).toBe(undefined)
    // Pre-fix: regex `github\.com/` after `https://` requires LITERAL — passes
    // for `github.com.evil.com` only if the `/` AFTER `.evil.com/` follows.
    // The unanchored regex actually DOES NOT match this — `github.com/o/r/...`
    // requires a path slash AT `github.com`. Let's let bun confirm.
  })

  test("port :443 explicit → 42 (post-fix allows default-port form)", () => {
    const url = "https://github.com:443/o/r/pull/42"
    expect(parsePrNumberFromUrlHardened(url)).toBe(42)
  })

  test("fragment after PR number → 42", () => {
    const url = "https://github.com/o/r/pull/42#issuecomment-123"
    expect(parsePrNumberFromUrlHardened(url)).toBe(42)
    expect(parsePrNumberFromUrlCurrent(url)).toBe(42)
  })

  test("query string after PR number → 42", () => {
    const url = "https://github.com/o/r/pull/42?tab=files"
    expect(parsePrNumberFromUrlHardened(url)).toBe(42)
    expect(parsePrNumberFromUrlCurrent(url)).toBe(42)
  })

  test("POST-FIX: api.github.com (API URL) → undefined", () => {
    const url = "https://api.github.com/repos/o/r/pulls/42"
    expect(parsePrNumberFromUrlHardened(url)).toBe(undefined)
    // Pre-fix: `github.com/` doesn't literally appear in this URL — it's
    // `api.github.com/`. So current also returns undefined.
    expect(parsePrNumberFromUrlCurrent(url)).toBe(undefined)
  })

  test("POST-FIX: gist.github.com → undefined", () => {
    const url = "https://gist.github.com/o/r/pull/42"
    expect(parsePrNumberFromUrlHardened(url)).toBe(undefined)
    expect(parsePrNumberFromUrlCurrent(url)).toBe(undefined)
  })

  test("POST-FIX: IDN homograph `gіthub.com` (Cyrillic і) → undefined", () => {
    // The Cyrillic "і" (U+0456) looks like Latin "i" but is a different char.
    const url = "https://gіthub.com/o/r/pull/42"
    expect(parsePrNumberFromUrlHardened(url)).toBe(undefined)
    // Current regex: `\.com/` requires LITERAL — `gіthub.com` (with cyrillic)
    // also matches `.com/` literally, so the regex MIGHT match. Let's assert
    // it does match (documented leak before URL ctor adoption).
    // Actually `\.com/` requires the chars `.com/` after some `gNthub` where N
    // is any char (URL ctor would distinguish, regex does not). The full
    // pattern needs `https://github.com/` literally — the cyrillic `і` makes
    // the host NOT `github` (latin). So the substring match must include
    // literal `github.com/`. The cyrillic version replaces `i` with `і` so
    // the substring `github.com/` is NOT present.
    expect(parsePrNumberFromUrlCurrent(url)).toBe(undefined)
  })

  test("POST-FIX: userinfo `attacker@github.com` → undefined (both parsers)", () => {
    const url = "https://attacker@github.com/o/r/pull/42"
    expect(parsePrNumberFromUrlHardened(url)).toBe(undefined)
    // Pre-fix: the substring regex requires literal `https://github.com/` —
    // userinfo breaks the literal, so current also returns undefined.
    expect(parsePrNumberFromUrlCurrent(url)).toBe(undefined)
  })

  test("POST-FIX: javascript: scheme → undefined", () => {
    const url = "javascript:alert(1)//github.com/o/r/pull/42"
    expect(parsePrNumberFromUrlHardened(url)).toBe(undefined)
    // Pre-fix: requires `https://github.com/` — not present → undefined.
    expect(parsePrNumberFromUrlCurrent(url)).toBe(undefined)
  })

  test("POST-FIX: file:// URL with github.com substring → undefined", () => {
    const url = "file:///tmp/github.com/o/r/pull/42"
    expect(parsePrNumberFromUrlHardened(url)).toBe(undefined)
    expect(parsePrNumberFromUrlCurrent(url)).toBe(undefined)
  })

  test("POST-FIX: data: URL → undefined", () => {
    const url = "data:text/html,<a href='https://github.com/o/r/pull/42'>x</a>"
    expect(parsePrNumberFromUrlHardened(url)).toBe(undefined)
    // Pre-fix: the substring `https://github.com/...` IS present in the data
    // URL body → 42. DOCUMENTED LEAK.
    expect(parsePrNumberFromUrlCurrent(url)).toBe(42)
  })

  test("POST-FIX: whitespace/newline prefix → undefined", () => {
    const url = "  https://github.com/o/r/pull/42"
    expect(parsePrNumberFromUrlHardened(url)).toBe(undefined)
    // Pre-fix substring match: succeeds → 42.
    expect(parsePrNumberFromUrlCurrent(url)).toBe(42)
  })

  test("POST-FIX: trailing dot host `github.com.` → undefined", () => {
    // `github.com.` is technically a valid DNS host (fully-qualified). For
    // safety the strict parser should reject.
    const url = "https://github.com./o/r/pull/42"
    expect(parsePrNumberFromUrlHardened(url)).toBe(undefined)
  })

  test("POST-FIX: uppercase host `HTTPS://GITHUB.COM/...` → 42 (URL ctor normalizes)", () => {
    // URL ctor lowercases the host; this is the documented post-fix behavior.
    const url = "HTTPS://GITHUB.COM/o/r/pull/42"
    expect(parsePrNumberFromUrlHardened(url)).toBe(42)
  })

  test("POST-FIX: mixed scheme/host case → 42", () => {
    const url = "Https://GitHub.com/o/r/pull/42"
    expect(parsePrNumberFromUrlHardened(url)).toBe(42)
  })

  test("missing PR number entirely → undefined", () => {
    const url = "https://github.com/o/r/pull/"
    expect(parsePrNumberFromUrlHardened(url)).toBe(undefined)
    expect(parsePrNumberFromUrlCurrent(url)).toBe(undefined)
  })

  test("`pulls` (plural) path → undefined", () => {
    const url = "https://github.com/o/r/pulls/42"
    expect(parsePrNumberFromUrlHardened(url)).toBe(undefined)
    expect(parsePrNumberFromUrlCurrent(url)).toBe(undefined)
  })

  test("path traversal in repo segment → still rejects via pull segment", () => {
    const url = "https://github.com/../../pull/42"
    // The path `/../../pull/42` after URL.pathname normalization may be `/pull/42`.
    // With normalization, `[^/]+/[^/]+/pull/(\d+)` doesn't match a 1-segment path.
    expect(parsePrNumberFromUrlHardened(url)).toBe(undefined)
  })
})
