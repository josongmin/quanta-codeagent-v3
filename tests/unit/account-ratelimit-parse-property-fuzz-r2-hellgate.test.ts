/**
 * Hellgate ROUND 2 (PROPERTY / DIFFERENTIAL FUZZ) — account rate-limit snapshot
 * parser (`src/llm/ratelimit-snapshot/parse.ts`; jun-6 §B3-parity slice).
 *
 * Round 1 enumerated crafted band-boundary cases. This round 2 FUZZES random
 * header values (epoch-ms / epoch-s / relative / negative / huge / garbage /
 * empty / whitespace / HTTP-date) against the parser's three invariants with
 * ZERO tolerance:
 *
 *   D1  DIFFERENTIAL PARITY with B3 (`parseRetryAfterMs` via `x-ratelimit-reset`)
 *       on the SHARED NUMERIC BAND. The snapshot's `parseRateLimitResetMs` is a
 *       closed duplicate of B3's private band split; it must agree EXACTLY,
 *       EXCEPT the two DOCUMENTED divergences:
 *         (a) B3 yields a value > MAX_RESET_HORIZON_MS (1 year) ⇒ snapshot
 *             clamps to undefined (surfaced-raw hardening).
 *         (b) the raw is an HTTP-date ⇒ snapshot accepts (superset), B3 drops.
 *       For every OTHER input, `mine === b3` BYTE-FOR-BYTE.
 *   D2  NO-THROW on ANY string (hostile getter, garbage, control chars, huge).
 *   D3  `parseRemaining` admits ONLY a non-negative SAFE integer (a `1e308` /
 *       fractional / negative ⇒ field ABSENT, never a fabricated count).
 *
 * Clock is INJECTED (fake), no Date.now / Math.random.
 */

import { describe, expect, test } from "bun:test"
import { parseRateLimitResetMs, parseRateLimitSnapshot } from "@/llm/ratelimit-snapshot"
import { parseRetryAfterMs } from "@/shared"

const FIXED_NOW = 1_700_000_000_000 // fixed ms-epoch (≈ 2023-11-14)
const now = () => FIXED_NOW
const MAX_RESET_HORIZON_MS = 365 * 24 * 60 * 60 * 1000

const lcg = (seed: number): (() => number) => {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}
// B3 reset value via the x-ratelimit-reset key (the other two keys are absent so
// the chain falls straight through to parseRateLimitResetHeader).
const b3Reset = (raw: string): number | undefined =>
  parseRetryAfterMs((name) => (name.toLowerCase() === "x-ratelimit-reset" ? raw : null), now)

// Generate a random header value spanning every shape a provider/proxy might emit.
const mkResetRaw = (rng: () => number): string => {
  switch (Math.floor(rng() * 12)) {
    case 0:
      return String(Math.floor(rng() * 3600)) // small relative seconds
    case 1:
      return String(FIXED_NOW / 1000 + Math.floor(rng() * 100000) - 50000) // epoch-s near now
    case 2:
      return String(FIXED_NOW + Math.floor(rng() * 200000) - 100000) // epoch-ms near now
    case 3:
      return String(-Math.floor(rng() * 1e6)) // negative
    case 4:
      return `${rng() * 100}` // fractional relative
    case 5:
      return ["NaN", "Infinity", "-Infinity", "", "   ", "abc", "0x1f", "1e3", "  60  "][
        Math.floor(rng() * 9)
      ] as string
    case 6:
      return "1e" + Math.floor(rng() * 320) // power-of-ten exponent (huge/absurd)
    case 7:
      return "9".repeat(1 + Math.floor(rng() * 25)) // long digit run
    case 8:
      return new Date(FIXED_NOW + Math.floor(rng() * 1e8) - 5e7).toUTCString() // HTTP-date
    case 9:
      return String(FIXED_NOW / 1000 + MAX_RESET_HORIZON_MS / 1000 + rng() * 1e6) // epoch-s far future (> horizon)
    case 10:
      return String(FIXED_NOW + MAX_RESET_HORIZON_MS + 1 + Math.floor(rng() * 1e9)) // epoch-ms > horizon
    default: {
      // pure garbage string
      let g = ""
      const n = Math.floor(rng() * 14)
      for (let i = 0; i < n; i++) g += String.fromCharCode(0x20 + Math.floor(rng() * 0x5e))
      return g
    }
  }
}

const isHttpDate = (raw: string): boolean => {
  const trimmed = raw.trim()
  // Numeric inputs are NOT dates; a date is what survives Date.parse but not Number.
  return !Number.isFinite(Number(trimmed)) && Number.isFinite(Date.parse(trimmed))
}

describe("account-ratelimit parse property fuzz R2 — differential parity vs B3", () => {
  test("D1: reset parity with B3 on the shared band (≥500 random raws, ZERO tolerance)", () => {
    let parityChecked = 0
    let horizonDiverged = 0
    let dateDiverged = 0
    for (let seed = 1; seed <= 1200; seed++) {
      const raw = mkResetRaw(lcg(seed * 2654435761))
      const mine = parseRateLimitResetMs(raw, now)
      const b3 = b3Reset(raw)

      if (isHttpDate(raw)) {
        // Documented divergence (b): snapshot is a superset for HTTP-dates.
        dateDiverged++
        continue
      }
      if (b3 !== undefined && b3 > MAX_RESET_HORIZON_MS) {
        // Documented divergence (a): snapshot clamps an absurd magnitude to undefined.
        expect(mine).toBeUndefined()
        horizonDiverged++
        continue
      }
      // Everywhere else: BYTE-FOR-BYTE parity.
      if (mine !== b3) {
        throw new Error(`D1 PARITY VIOLATION raw=${JSON.stringify(raw)} mine=${mine} b3=${b3}`)
      }
      expect(mine).toBe(b3)
      parityChecked++
    }
    // The fuzz space actually exercises all three regions.
    expect(parityChecked).toBeGreaterThan(0)
    expect(horizonDiverged).toBeGreaterThan(0)
    expect(dateDiverged).toBeGreaterThan(0)
  })

  test("D2: NO-THROW on any string + hostile getter (≥500 random raws)", () => {
    for (let seed = 1; seed <= 600; seed++) {
      const rng = lcg(seed * 40503 + 17)
      const raw = mkResetRaw(rng)
      expect(() => parseRateLimitResetMs(raw, now)).not.toThrow()
      // A reset result is always undefined OR a finite non-negative ms <= horizon.
      const r = parseRateLimitResetMs(raw, now)
      if (r !== undefined) {
        expect(Number.isFinite(r)).toBe(true)
        expect(r).toBeGreaterThanOrEqual(0)
        expect(r).toBeLessThanOrEqual(MAX_RESET_HORIZON_MS)
      }
    }
    // A throwing header getter degrades to "no snapshot", never propagates.
    const hostileGet = () => {
      throw new Error("boom")
    }
    expect(() => parseRateLimitSnapshot(hostileGet, now)).not.toThrow()
    expect(parseRateLimitSnapshot(hostileGet, now)).toBeUndefined()
  })

  test("D3: remaining admits ONLY non-negative SAFE integers (≥500 random raws)", () => {
    for (let seed = 1; seed <= 600; seed++) {
      const rng = lcg(seed * 7919 + 5)
      const raw = mkResetRaw(rng)
      const snap = parseRateLimitSnapshot(
        (name) => (name === "x-ratelimit-remaining-requests" ? raw : null),
        now,
      )
      const rem = snap?.requestsRemaining
      if (rem !== undefined) {
        // Populated ONLY when the provider sent a clean count.
        expect(Number.isSafeInteger(rem)).toBe(true)
        expect(rem).toBeGreaterThanOrEqual(0)
        // and it must equal the trimmed numeric parse (no fabrication).
        expect(rem).toBe(Number(raw.trim()))
      }
    }
    // Explicit absurd/garbage counts ⇒ field absent.
    for (const bad of ["1e308", "1e21", "-1", "3.5", "NaN", "", "  ", "abc", "Infinity"]) {
      const snap = parseRateLimitSnapshot(
        (name) => (name === "x-ratelimit-remaining-requests" ? bad : null),
        now,
      )
      expect(snap).toBeUndefined()
    }
  })
})
