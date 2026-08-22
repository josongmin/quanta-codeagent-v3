/**
 * Hellgate ROUND 2 (PROPERTY / DIFFERENTIAL FUZZ) — prompt-cache TTL resolver
 * (`resolveCacheTtl` / `normalizeModelFamily` / `CACHE_1H_ALLOWLIST`,
 * `src/llm/factory.ts`; RFC jun-6-prompt-cache-1h-ttl §4).
 *
 * Round 1 enumerated the known allowlist members across cloud-slug shapes. This
 * round 2 FUZZES the OPEN input space — random model slugs assembled from random
 * vendor prefixes, family stems, date suffixes, version tags, `@`-pins, and
 * garbage — against three load-bearing invariants with ZERO tolerance:
 *
 *   I1  KNOB-OFF  ⇒ resolveCacheTtl(any, {cacheTtl:"5m"}) === "5m"  ALWAYS.
 *       (The codec stays byte-identical fixed-5m when the knob is off; a single
 *        "1h" here is a silent behavior change / wire-400 risk.)
 *   I2  NON-ALLOWLISTED family ⇒ resolveCacheTtl(model, {cacheTtl:"1h"}) is
 *       NEVER "1h". Granting 1h to an unsupported model is an API 400 / cost
 *       surprise. (We derive "allowlisted-ness" from the SAME normalize+set the
 *       resolver uses, so this is a differential check of the gate against its
 *       own parts — any divergence = a resolver that doesn't honor its gate.)
 *   I3  normalize is IDEMPOTENT: normalize(normalize(x)) === normalize(x), for
 *       any string (the family key must be a fixpoint or the allowlist lookup is
 *       non-deterministic across call sites).
 *
 * Output is always one of the two CacheTtl literals (no throw, no undefined).
 *
 * Deterministic LCG (no Math.random).
 */

import { describe, expect, test } from "bun:test"
import { CACHE_1H_ALLOWLIST, normalizeModelFamily, resolveCacheTtl } from "@/llm/factory"
import type { CacheTtl } from "@/llm/types"

const lcg = (seed: number): (() => number) => {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}
const pick = <T>(rng: () => number, xs: readonly T[]): T => xs[Math.floor(rng() * xs.length)] as T

const OFF = { cacheTtl: "5m" as CacheTtl }
const ON = { cacheTtl: "1h" as CacheTtl }

// Fragments the fuzzer assembles into a slug. Mixes real family stems, real
// allowlist members, real cloud affixes, and pure garbage.
const PREFIXES = ["", "anthropic.", "ANTHROPIC.", "us.anthropic.", "  ", "x.", "anthropic"]
const STEMS = [
  "claude-opus-4-8",
  "claude-opus-4-7",
  "claude-sonnet-4-6",
  "claude-haiku-4-5",
  "claude-3-5-sonnet",
  "claude-opus-4-9", // not allowlisted
  "gpt-5",
  "gemini-2-flash",
  "",
  "garbage",
  "claude-OPUS-4-8", // case
]
const SUFFIXES = [
  "",
  "-20250101",
  "-v1:0",
  "-v12:7",
  "@20250101",
  "@2025010199",
  "-20250101-20250102", // double date (idempotency stress)
  ":latest",
  "-v1:0-20250101",
  "   ",
  "-1234", // 4 digits, NOT the 8-digit date rule
]

const mkSlug = (rng: () => number): string =>
  pick(rng, PREFIXES) + pick(rng, STEMS) + pick(rng, SUFFIXES)

describe("prompt-cache TTL property fuzz R2 — gate invariants on the open slug space", () => {
  test("I1: knob-OFF ⇒ ALWAYS '5m' (≥500 random slugs)", () => {
    for (let seed = 1; seed <= 600; seed++) {
      const slug = mkSlug(lcg(seed * 2654435761))
      const ttl = resolveCacheTtl(slug, OFF)
      if (ttl !== "5m") throw new Error(`I1 VIOLATION slug=${JSON.stringify(slug)} ⇒ ${ttl}`)
      expect(ttl).toBe("5m")
    }
  })

  test("I2: knob-ON but NON-allowlisted family ⇒ NEVER '1h' (≥500 random slugs)", () => {
    let nonAllowlisted = 0
    for (let seed = 1; seed <= 700; seed++) {
      const slug = mkSlug(lcg(seed * 40503 + 11))
      const fam = normalizeModelFamily(slug)
      const result = resolveCacheTtl(slug, ON)
      if (!CACHE_1H_ALLOWLIST.has(fam)) {
        nonAllowlisted++
        if (result === "1h") {
          throw new Error(
            `I2 VIOLATION slug=${JSON.stringify(slug)} fam=${JSON.stringify(fam)} granted 1h`,
          )
        }
        expect(result).toBe("5m")
      } else {
        // Differential: the resolver MUST grant 1h iff the gate (same parts) says so.
        expect(result).toBe("1h")
      }
      // Output is always a valid CacheTtl literal — no throw, no undefined.
      expect(result === "5m" || result === "1h").toBe(true)
    }
    // Sanity: the fuzz space actually exercises the non-allowlisted branch.
    expect(nonAllowlisted).toBeGreaterThan(0)
  })

  test("I3: normalizeModelFamily is IDEMPOTENT (≥500 random slugs + pure garbage)", () => {
    const garbageRng = lcg(0xc0ffee)
    for (let seed = 1; seed <= 600; seed++) {
      // structured slug
      const slug = mkSlug(lcg(seed * 7919 + 3))
      const once = normalizeModelFamily(slug)
      expect(normalizeModelFamily(once)).toBe(once)

      // pure-garbage slug (random unicode + digits + affixes)
      let g = ""
      const glen = 1 + Math.floor(garbageRng() * 30)
      for (let i = 0; i < glen; i++) {
        g += String.fromCharCode(0x20 + Math.floor(garbageRng() * 0x5e))
      }
      const gOnce = normalizeModelFamily(g)
      expect(normalizeModelFamily(gOnce)).toBe(gOnce)
    }
  })

  test("REGRESSION (R2 fuzz find): combined version+date affix collapses to family", () => {
    // SHRUNK minimal case: a Bedrock-versioned, date-pinned slug of an
    // ALLOWLISTED model. A single ordered suffix pass peeled the trailing date
    // first, EXPOSING `-v1:0` (the version rule, `$`-anchored, had skipped it)
    // and stopping at `claude-opus-4-8-v1:0` — NOT a family key — so the model
    // was wrongly DENIED ttl:"1h". The fixpoint peel collapses both affixes.
    const combined = "claude-opus-4-8-v1:0-20250101"
    expect(normalizeModelFamily(combined)).toBe("claude-opus-4-8")
    // idempotent (was NOT before the fix: normalize once ≠ normalize twice).
    expect(normalizeModelFamily(normalizeModelFamily(combined))).toBe(
      normalizeModelFamily(combined),
    )
    // and the gate now grants 1h for this legitimately-allowlisted model.
    expect(resolveCacheTtl(combined, ON)).toBe("1h")
    // double-date too (date peel exposing another date).
    expect(normalizeModelFamily("claude-opus-4-8-20250101-20250102")).toBe("claude-opus-4-8")
  })

  test("normalizeModelFamily never throws on adversarial strings", () => {
    const hostile = [
      "",
      "   ",
      "\x00\x00",
      "@".repeat(1000),
      "-".repeat(1000),
      `${"anthropic.".repeat(50)}claude-opus-4-8`,
      `claude-opus-4-8${"@".repeat(100)}1234567890`,
      "claude-opus-4-8-99999999".repeat(40),
    ]
    for (const h of hostile) {
      expect(() => normalizeModelFamily(h)).not.toThrow()
      expect(() => resolveCacheTtl(h, ON)).not.toThrow()
      expect(resolveCacheTtl(h, OFF)).toBe("5m")
    }
  })
})
