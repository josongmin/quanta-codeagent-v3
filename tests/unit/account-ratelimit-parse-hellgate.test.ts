import { describe, expect, test } from "bun:test"
import type { HeaderLookup } from "@/llm/ratelimit-snapshot"
import { parseRateLimitResetMs, parseRateLimitSnapshot } from "@/llm/ratelimit-snapshot"
import { parseRetryAfterMs } from "@/shared"

/**
 * jun-6 account-ratelimit snapshot — PARSE hellgate (pure parser).
 *
 * The parser reads the provider's live quota meter off EVERY response
 * (`anthropic-ratelimit-*` primary+secondary, `x-ratelimit-*` mirror) and the
 * server-advertised reset, REUSING B3's magnitude-band reset discipline. It must
 * be NO-THROW on garbage, return `undefined` (byte-identical fall-through to
 * today's reactive 429-retry) when no recognized header is present, and never
 * invent a number.
 *
 * Determinism: `now` is injected (NO Date.now in the slice).
 */

/** Build a case-insensitive HeaderLookup from a plain record (the Anthropic SDK
 *  shape) so tests exercise the exact accessor contract `errors.ts` uses. */
const lookup = (h: Record<string, string>): HeaderLookup => {
  const lower = new Map<string, string>()
  for (const [k, v] of Object.entries(h)) lower.set(k.toLowerCase(), v)
  return (name) => lower.get(name.toLowerCase()) ?? null
}

const FIXED_NOW = 1_700_000_000_000 // a fixed ms-epoch "now"
const now = () => FIXED_NOW

describe("parseRateLimitSnapshot — vendor-spelling allowlist", () => {
  test("Anthropic primary spelling parses requests+tokens remaining", () => {
    const s = parseRateLimitSnapshot(
      lookup({
        "anthropic-ratelimit-requests-remaining": "42",
        "anthropic-ratelimit-requests-reset": "30",
        "anthropic-ratelimit-tokens-remaining": "1000",
        "anthropic-ratelimit-tokens-reset": "45",
      }),
      now,
    )
    expect(s).toBeDefined()
    expect(s?.requestsRemaining).toBe(42)
    expect(s?.requestsResetMs).toBe(30_000)
    expect(s?.tokensRemaining).toBe(1000)
    expect(s?.tokensResetMs).toBe(45_000)
    expect(s?.observedAt).toBe(FIXED_NOW)
  })

  test("OpenAI mirror spelling parses too", () => {
    const s = parseRateLimitSnapshot(
      lookup({
        "x-ratelimit-remaining-requests": "7",
        "x-ratelimit-reset-requests": "12",
        "x-ratelimit-remaining-tokens": "0",
        "x-ratelimit-reset-tokens": "5",
      }),
      now,
    )
    expect(s?.requestsRemaining).toBe(7)
    expect(s?.requestsResetMs).toBe(12_000)
    expect(s?.tokensRemaining).toBe(0)
    expect(s?.tokensResetMs).toBe(5_000)
  })

  test("an unknown header is ignored; absent ALL recognized ⇒ undefined", () => {
    expect(parseRateLimitSnapshot(lookup({ "x-something-else": "99" }), now)).toBeUndefined()
    expect(parseRateLimitSnapshot(lookup({}), now)).toBeUndefined()
  })

  test("a remaining present with NO reset still yields a snapshot (reset undefined)", () => {
    const s = parseRateLimitSnapshot(lookup({ "anthropic-ratelimit-tokens-remaining": "500" }), now)
    expect(s?.tokensRemaining).toBe(500)
    expect(s?.tokensResetMs).toBeUndefined()
  })

  test("a reset present with NO remaining still yields a snapshot (carries reset)", () => {
    const s = parseRateLimitSnapshot(lookup({ "anthropic-ratelimit-tokens-reset": "10" }), now)
    expect(s?.tokensResetMs).toBe(10_000)
    expect(s?.tokensRemaining).toBeUndefined()
  })
})

describe("parseRateLimitSnapshot — magnitude-band reset (s vs ms vs epoch)", () => {
  test("relative delta-seconds", () => {
    const s = parseRateLimitSnapshot(lookup({ "anthropic-ratelimit-tokens-reset": "60" }), now)
    expect(s?.tokensResetMs).toBe(60_000)
  })

  test("absolute epoch-SECONDS (≥1e9) ⇒ delta from now", () => {
    const epochS = FIXED_NOW / 1000 + 90 // 90s in the future, in seconds
    const s = parseRateLimitSnapshot(
      lookup({ "anthropic-ratelimit-tokens-reset": String(epochS) }),
      now,
    )
    expect(s?.tokensResetMs).toBe(90_000)
  })

  test("absolute epoch-MILLISECONDS (≥1e12) ⇒ delta, NO ×1000", () => {
    const epochMs = FIXED_NOW + 7_500 // 7.5s in the future, in ms
    const s = parseRateLimitSnapshot(
      lookup({ "anthropic-ratelimit-tokens-reset": String(epochMs) }),
      now,
    )
    expect(s?.tokensResetMs).toBe(7_500)
  })

  test("HTTP-date reset form parses to a relative delta", () => {
    const at = new Date(FIXED_NOW + 20_000).toUTCString()
    const s = parseRateLimitSnapshot(lookup({ "anthropic-ratelimit-tokens-reset": at }), now)
    expect(s?.tokensResetMs).toBe(20_000)
  })

  test("a reset in the PAST ⇒ reset undefined (no negative delay)", () => {
    const past = FIXED_NOW - 5_000
    const s = parseRateLimitSnapshot(
      lookup({
        "anthropic-ratelimit-tokens-remaining": "0",
        "anthropic-ratelimit-tokens-reset": String(past),
      }),
      now,
    )
    expect(s?.tokensRemaining).toBe(0)
    expect(s?.tokensResetMs).toBeUndefined()
  })
})

describe("parseRateLimitSnapshot — NO-THROW on malformed / garbage", () => {
  const garbage = [
    "NaN",
    "",
    "   ",
    "1e308",
    "-5",
    "Infinity",
    "0x1F",
    "abc",
    "12,34",
    "9".repeat(400),
  ]
  for (const g of garbage) {
    test(`garbage remaining=${JSON.stringify(g)} ⇒ no throw, no fabricated number`, () => {
      let s: ReturnType<typeof parseRateLimitSnapshot>
      expect(() => {
        s = parseRateLimitSnapshot(
          lookup({
            "anthropic-ratelimit-tokens-remaining": g,
            "anthropic-ratelimit-tokens-reset": g,
          }),
          now,
        )
      }).not.toThrow()
      // garbage remaining ⇒ field absent (never coerced to 0 / NaN)
      if (s !== undefined) {
        expect(s.tokensRemaining === undefined || Number.isInteger(s.tokensRemaining)).toBe(true)
        if (s.tokensResetMs !== undefined) {
          expect(Number.isFinite(s.tokensResetMs)).toBe(true)
          expect(s.tokensResetMs).toBeGreaterThanOrEqual(0)
        }
      }
    })
  }

  test("a hostile throwing header getter degrades to undefined (no throw)", () => {
    const hostile: HeaderLookup = () => {
      throw new Error("boom")
    }
    let out: unknown
    expect(() => {
      out = parseRateLimitSnapshot(hostile, now)
    }).not.toThrow()
    expect(out).toBeUndefined()
  })

  test("negative remaining string is rejected (not coerced)", () => {
    const s = parseRateLimitSnapshot(lookup({ "anthropic-ratelimit-tokens-remaining": "-3" }), now)
    // negative remaining is nonsensical from the provider; drop the field.
    expect(s?.tokensRemaining).toBeUndefined()
  })
})

describe("differential parity — reset band logic matches B3", () => {
  // The snapshot's reset parser must agree byte-for-byte with B3's
  // `parseRateLimitResetHeader` (consulted via the exported `parseRetryAfterMs`
  // through the `x-ratelimit-reset` key). This locks the duplication to the
  // proven original.
  const cases = [
    "30",
    "60",
    "0",
    String(FIXED_NOW / 1000 + 90),
    String(FIXED_NOW + 7_500),
    "1e308",
    "-1",
    "NaN",
    "",
  ]
  for (const raw of cases) {
    test(`reset ${JSON.stringify(raw)} parity vs parseRetryAfterMs`, () => {
      const mine = parseRateLimitResetMs(raw, now)
      const b3 = parseRetryAfterMs(
        (name) => (name.toLowerCase() === "x-ratelimit-reset" ? raw : null),
        now,
      )
      expect(mine).toBe(b3)
    })
  }
})
