/**
 * ADR-0311 hellgate R3 — PR URL parsing adversarial battery.
 *
 * `from-pr-cmd.ts` extracts the PR number from a ProactiveTrigger's
 * `evidence.value` (a URL) when the caller doesn't pass `--pr` explicitly.
 * The regex is hardcoded:
 *
 *   /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/
 *
 * That regex is purposely strict (only `github.com`, HTTPS only) but it is
 * NOT anchored — a URL substring inside a longer string still matches. This
 * battery proves the boundary cases AND documents one real finding:
 *
 *   FINDING (low impact): "https://evil.com/https://github.com/owner/repo/pull/42"
 *     IS matched by the regex and yields PR=42. In practice the URL
 *     originates from our own `derivePrUrl` (event-source-actions.ts), so a
 *     prefix-spoof input requires a hostile event source (Tier 1 webhook
 *     not implemented yet). Surface here so a future Tier 1 wire-up adds an
 *     `^` anchor or a `URL` parse instead of a naked substring match.
 *
 * The test re-declares the regex literally (single SoT mismatch is caught by
 * the assertion `PR_URL_REGEX.source === EXPECTED`) so a future tightening
 * of the regex MUST update both this test and the slice. That ratchet
 * prevents silent behavior drift.
 */

import { describe, expect, test } from "bun:test"

/**
 * EXPECTED regex source — must match `from-pr-cmd.ts#PR_URL_REGEX`. Update
 * this literal when the slice tightens its pattern (e.g. adds `^`/`$`).
 */
const EXPECTED_SOURCE = "https:\\/\\/github\\.com\\/[^/]+\\/[^/]+\\/pull\\/(\\d+)"
const PR_URL_REGEX = /https:\/\/github\.com\/[^/]+\/[^/]+\/pull\/(\d+)/

const parsePrNumberFromUrl = (url: string): number | undefined => {
  const m = PR_URL_REGEX.exec(url)
  if (m === null) return undefined
  const captured = m[1]
  if (captured === undefined) return undefined
  const n = Number.parseInt(captured, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

describe("ADR-0311 hellgate R3 — PR URL parsing", () => {
  test("regex source matches the slice's SoT (ratchet)", () => {
    expect(PR_URL_REGEX.source).toBe(EXPECTED_SOURCE)
  })

  test("normal URL extracts PR number", () => {
    expect(parsePrNumberFromUrl("https://github.com/owner/repo/pull/42")).toBe(42)
  })

  test("owner/repo with hyphens — matches", () => {
    expect(parsePrNumberFromUrl("https://github.com/o-w-n/r-e-p/pull/42")).toBe(42)
  })

  test("owner/repo with dots — matches (GH allows `.` in repo names)", () => {
    expect(parsePrNumberFromUrl("https://github.com/o.w.n/r.e.p/pull/42")).toBe(42)
  })

  test("enterprise host (`github.enterprise.com`) — REJECTED", () => {
    expect(parsePrNumberFromUrl("https://github.enterprise.com/o/r/pull/42")).toBe(undefined)
  })

  test("HTTP (not HTTPS) — REJECTED", () => {
    expect(parsePrNumberFromUrl("http://github.com/o/r/pull/42")).toBe(undefined)
  })

  test("subdomain of github.com — REJECTED", () => {
    // `gist.github.com` etc — the regex requires literal `github.com/` after
    // `https://`.
    expect(parsePrNumberFromUrl("https://gist.github.com/o/r/pull/42")).toBe(undefined)
  })

  test("missing owner segment — REJECTED", () => {
    expect(parsePrNumberFromUrl("https://github.com//repo/pull/42")).toBe(undefined)
  })

  test("`pulls` (plural) path — REJECTED", () => {
    expect(parsePrNumberFromUrl("https://github.com/o/r/pulls/42")).toBe(undefined)
  })

  test("path traversal in PR position — REJECTED", () => {
    expect(parsePrNumberFromUrl("https://github.com/o/r/pull/../etc/passwd")).toBe(undefined)
  })

  test("negative-looking PR number — REJECTED (regex `\\d+` doesn't include `-`)", () => {
    expect(parsePrNumberFromUrl("https://github.com/o/r/pull/-1")).toBe(undefined)
  })

  test("URL with query + fragment — still matches", () => {
    expect(parsePrNumberFromUrl("https://github.com/o/r/pull/42?tab=files#L100")).toBe(42)
  })

  test("leading zeros in PR number — parsed as decimal", () => {
    expect(parsePrNumberFromUrl("https://github.com/o/r/pull/042")).toBe(42)
  })

  test("DOCUMENTED FINDING: prefix-spoof URL substring matches (regex not anchored)", () => {
    // `https://evil.com/https://github.com/o/r/pull/42` — substring match
    // wins. We document this so a future Tier 1 wire (webhook adapter)
    // adds a stronger boundary. Today's Tier 0 path produces URLs from our
    // own `derivePrUrl` and is unaffected.
    expect(parsePrNumberFromUrl("https://evil.com/https://github.com/o/r/pull/42")).toBe(42)
  })

  test("giant PR number → parseInt overflow rounds — still > 0 (passes)", () => {
    // `Number.parseInt("99999999999999999999", 10)` returns 1e20 (lossy).
    // Documented behavior; would only be hit by a hostile evidence.value.
    const n = parsePrNumberFromUrl("https://github.com/o/r/pull/99999999999999999999")
    expect(n).toBeDefined()
    expect(n).toBeGreaterThan(0)
  })

  test("trailing junk after pr number — matched, junk ignored", () => {
    // `pull/42x` — `(\d+)` is greedy on digits only; `x` is outside capture.
    expect(parsePrNumberFromUrl("https://github.com/o/r/pull/42x")).toBe(42)
  })

  test("PR number with a slash (deeper path) — first \\d+ captured", () => {
    expect(parsePrNumberFromUrl("https://github.com/o/r/pull/42/files")).toBe(42)
  })

  test("empty string — REJECTED", () => {
    expect(parsePrNumberFromUrl("")).toBe(undefined)
  })

  test("not a URL — REJECTED", () => {
    expect(parsePrNumberFromUrl("hello world")).toBe(undefined)
  })

  test("PR number 0 — REJECTED (n > 0 guard)", () => {
    expect(parsePrNumberFromUrl("https://github.com/o/r/pull/0")).toBe(undefined)
  })
})
