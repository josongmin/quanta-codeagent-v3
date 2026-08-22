import { describe, expect, test } from "bun:test"
import type { HeaderLookup } from "@/llm/ratelimit-snapshot"
import {
  MAX_RESET_HORIZON_MS,
  parseRateLimitResetMs,
  parseRateLimitSnapshot,
} from "@/llm/ratelimit-snapshot"
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

describe("parseRateLimitSnapshot — ABSURD-MAGNITUDE hardening (jun-6 audit findings)", () => {
  // FINDING 1 (ABSURD-VALUE remaining): `Number.isInteger(1e308) === true`, so the
  // pre-fix `Number.isInteger && >= 0` check let `"1e308"` / `"1e21"` poison the
  // snapshot with a count far above any real quota (the 1e308 class the B3
  // `parseRetryAfterMs` audit caught for delays). Counterexample BEFORE fix:
  // requestsRemaining === 1e308.
  test('COUNTEREXAMPLE: remaining "1e308" ⇒ field dropped (not 1e308)', () => {
    const s = parseRateLimitSnapshot(
      lookup({ "anthropic-ratelimit-tokens-remaining": "1e308" }),
      now,
    )
    expect(s?.tokensRemaining).toBeUndefined()
  })

  test('remaining "1e21" (> MAX_SAFE_INTEGER) ⇒ dropped; a safe-int boundary is kept', () => {
    expect(
      parseRateLimitSnapshot(lookup({ "anthropic-ratelimit-tokens-remaining": "1e21" }), now)
        ?.tokensRemaining,
    ).toBeUndefined()
    expect(
      parseRateLimitSnapshot(
        lookup({ "anthropic-ratelimit-tokens-remaining": String(Number.MAX_SAFE_INTEGER) }),
        now,
      )?.tokensRemaining,
    ).toBe(Number.MAX_SAFE_INTEGER)
  })

  // FINDING 2 (ABSURD-DELAY reset): a hostile epoch `"1e308"` / `"9".repeat(20)`
  // lands in the ms-epoch band as a finite-but-absurd delta that `finiteMs` (which
  // only rejects NON-finite) let through. The snapshot is surfaced raw, so it must
  // clamp. Counterexample BEFORE fix: tokensResetMs === 1e308.
  test('COUNTEREXAMPLE: reset "1e308" ⇒ resetMs dropped (not 1e308)', () => {
    const s = parseRateLimitSnapshot(lookup({ "anthropic-ratelimit-tokens-reset": "1e308" }), now)
    expect(s?.tokensResetMs).toBeUndefined()
  })

  test('reset "9".repeat(20) (~1e20 epoch) ⇒ resetMs dropped (no ~1e20 ms delay)', () => {
    const s = parseRateLimitSnapshot(
      lookup({ "anthropic-ratelimit-tokens-reset": "9".repeat(20) }),
      now,
    )
    expect(s?.tokensResetMs).toBeUndefined()
  })

  test("a legitimate reset just under the 1-year horizon is NOT clamped", () => {
    // 364 days out, expressed as a relative delta-seconds (< 1e9 band).
    const days364Secs = 364 * 24 * 60 * 60
    const s = parseRateLimitSnapshot(
      lookup({ "anthropic-ratelimit-tokens-reset": String(days364Secs) }),
      now,
    )
    expect(s?.tokensResetMs).toBe(days364Secs * 1000)
  })
})

describe("parseRateLimitSnapshot — seeded fuzz: NEVER NaN / negative / absurd", () => {
  // Deterministic PRNG (mulberry32) — NO Math.random (project rule). The header
  // VALUE is drawn from the full hostile alphabet; the snapshot's numeric fields
  // must ALWAYS be a safe non-negative integer (remaining) / a finite reset within
  // the 1-year horizon (reset) — or absent. Never NaN, never negative, never absurd.
  const mulberry32 = (seed: number) => () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  const ALPHABET = "0123456789.eE+-,xXabcInfity NaN:GMT"
  const HORIZON = 365 * 24 * 60 * 60 * 1000

  const assertCount = (v: number | undefined) => {
    if (v === undefined) return
    expect(Number.isSafeInteger(v)).toBe(true)
    expect(v).toBeGreaterThanOrEqual(0)
  }
  const assertReset = (v: number | undefined) => {
    if (v === undefined) return
    expect(Number.isFinite(v)).toBe(true)
    expect(v).toBeGreaterThanOrEqual(0)
    expect(v).toBeLessThanOrEqual(HORIZON)
    expect(Object.is(v, -0)).toBe(false)
  }

  test("10000 random header values never poison the snapshot", () => {
    const rng = mulberry32(0xc0ffee)
    const draw = () => {
      const len = Math.floor(rng() * 30)
      let s = ""
      for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(rng() * ALPHABET.length)]
      return s
    }
    let iterations = 0
    for (let i = 0; i < 10_000; i++) {
      iterations++
      const s = parseRateLimitSnapshot(
        lookup({
          "anthropic-ratelimit-tokens-remaining": draw(),
          "anthropic-ratelimit-tokens-reset": draw(),
          "x-ratelimit-remaining-requests": draw(),
          "x-ratelimit-reset-requests": draw(),
        }),
        now,
      )
      if (s === undefined) continue
      assertCount(s.requestsRemaining)
      assertCount(s.tokensRemaining)
      assertReset(s.requestsResetMs)
      assertReset(s.tokensResetMs)
      expect(Number.isFinite(s.observedAt)).toBe(true)
    }
    expect(iterations).toBe(10_000)
  })
})

describe("differential parity — reset band logic matches B3 (shared numeric band)", () => {
  // The snapshot's reset parser agrees byte-for-byte with B3's
  // `parseRateLimitResetHeader` (consulted via the exported `parseRetryAfterMs`
  // through the `x-ratelimit-reset` key) ON THE SHARED NUMERIC BAND. This locks
  // the duplicated band split (epoch-ms / epoch-s / relative-s + past⇒undefined)
  // to the proven original.
  //
  // EXCLUDED from this parity set (asserted as DELIBERATE divergences below):
  //   - "1e308" — B3 leaks a finite-but-absurd 1e308 and relies on the downstream
  //     60s retry clamp; the snapshot is surfaced raw so it clamps to undefined.
  //   - an HTTP-date — B3's band parser has no date branch (NaN⇒drop); the
  //     snapshot accepts it (strict superset).
  const cases = [
    "30",
    "60",
    "0",
    String(FIXED_NOW / 1000 + 90),
    String(FIXED_NOW + 7_500),
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
      // DOCUMENTED divergence (R2 hardening): an absurd magnitude (> 1-year
      // horizon, e.g. "1e308") that B3 surfaces raw is clamped to `undefined`
      // here so a junk meter never drives a multi-millennium proactive delay.
      // Everywhere else the snapshot parser is byte-for-byte identical to B3.
      if (b3 !== undefined && b3 > MAX_RESET_HORIZON_MS) {
        expect(mine).toBeUndefined()
      } else {
        expect(mine).toBe(b3)
      }
    })
  }

  test("DELIBERATE divergence: 1e308 — B3 leaks 1e308, snapshot clamps to undefined", () => {
    const b3 = parseRetryAfterMs(
      (name) => (name.toLowerCase() === "x-ratelimit-reset" ? "1e308" : null),
      now,
    )
    expect(b3).toBe(1e308) // B3's documented finite-but-absurd leak (downstream-clamped)
    expect(parseRateLimitResetMs("1e308", now)).toBeUndefined() // snapshot is stricter at the boundary
  })

  test("DELIBERATE divergence: HTTP-date — B3 band drops it, snapshot accepts it", () => {
    const at = new Date(FIXED_NOW + 20_000).toUTCString()
    const b3 = parseRetryAfterMs(
      (name) => (name.toLowerCase() === "x-ratelimit-reset" ? at : null),
      now,
    )
    expect(b3).toBeUndefined() // B3 band parser has no date branch
    expect(parseRateLimitResetMs(at, now)).toBe(20_000) // snapshot superset
  })
})
