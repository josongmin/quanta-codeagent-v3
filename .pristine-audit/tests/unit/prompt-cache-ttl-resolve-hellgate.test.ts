/**
 * Hellgate — prompt-cache 1h TTL RESOLUTION GATE (factory side, RFC
 * jun-6-prompt-cache-1h-ttl §4).
 *
 * The codec ({@link prompt-cache-1h-ttl-codec-hellgate}) proves that GIVEN a
 * `CacheTtl` the breakpoints are byte-identical at 5m. This battery proves the
 * OTHER half — the factory's `resolveCacheTtl` / `normalizeModelFamily` /
 * `CACHE_1H_ALLOWLIST` gate that DECIDES which `CacheTtl` reaches the codec. It
 * is the load-bearing guard: a drift here silently grants `ttl:"1h"` to a model
 * the API does not support 1h on (a wire 400 / a cost surprise), or — the
 * inverse — withholds it from an allowlisted model.
 *
 * The sacred invariants under attack:
 *   1. knob-off (`cacheTtl:"5m"`) ⇒ ALWAYS "5m", for EVERY model (byte-identity).
 *   2. knob-on + allowlisted family ⇒ "1h" — and a DATE-suffixed / `anthropic.`-
 *      prefixed / Bedrock-version / Vertex-@date cloud slug of an allowlisted
 *      model normalizes to the SAME family ⇒ still "1h".
 *   3. knob-on + NON-allowlisted model ⇒ NEVER "1h" (stays 5m, byte-identical).
 *   4. knob-on + unknown / garbage / empty model ⇒ SAFE 5m (no throw, no 1h).
 *
 * Pure resolution (no wire). `resolveCacheTtl` is the single decision site both
 * the legacy `createLLM` and the multicloud `createMulticloudLLM` consult.
 */

import { describe, expect, test } from "bun:test"
import { CACHE_1H_ALLOWLIST, normalizeModelFamily, resolveCacheTtl } from "@/llm/factory"
import type { CacheTtl } from "@/llm/types"

const off = { cacheTtl: "5m" as CacheTtl }
const on = { cacheTtl: "1h" as CacheTtl }

// Every allowlisted family, expressed across the cloud-slug shapes
// `normalizeModelFamily` must collapse. If a member is added to the allowlist
// without a corresponding normalize rule, one of these breaks.
const ALLOWLISTED = [...CACHE_1H_ALLOWLIST]

describe("resolveCacheTtl — knob-OFF is unconditionally 5m (byte-identity)", () => {
  const models = [
    ...ALLOWLISTED,
    "claude-3-5-sonnet-20241022",
    "anthropic.claude-opus-4-8-v1:0",
    "gpt-4o",
    "",
    "  ",
    "garbage-model-name",
  ]
  for (const model of models) {
    test(`knob-off ⇒ 5m for ${JSON.stringify(model)} (no model ever earns 1h with knob off)`, () => {
      expect(resolveCacheTtl(model, off)).toBe("5m")
    })
  }
})

describe("resolveCacheTtl — knob-ON grants 1h ONLY to allowlisted families", () => {
  for (const fam of ALLOWLISTED) {
    test(`public slug ${fam} ⇒ 1h`, () => {
      expect(resolveCacheTtl(fam, on)).toBe("1h")
    })
    test(`date-suffixed ${fam}-20250101 ⇒ 1h (date suffix stripped)`, () => {
      expect(resolveCacheTtl(`${fam}-20250101`, on)).toBe("1h")
    })
    test(`Bedrock anthropic.${fam}-v1:0 ⇒ 1h (vendor prefix + version stripped)`, () => {
      expect(resolveCacheTtl(`anthropic.${fam}-v1:0`, on)).toBe("1h")
    })
    test(`Vertex ${fam}@20250101 ⇒ 1h (@date pin stripped)`, () => {
      expect(resolveCacheTtl(`${fam}@20250101`, on)).toBe("1h")
    })
    test(`UPPERCASE ${fam.toUpperCase()} ⇒ 1h (case-insensitive)`, () => {
      expect(resolveCacheTtl(fam.toUpperCase(), on)).toBe("1h")
    })
    test(`whitespace-padded "  ${fam}  " ⇒ 1h (trimmed)`, () => {
      expect(resolveCacheTtl(`  ${fam}  `, on)).toBe("1h")
    })
  }
})

describe("resolveCacheTtl — knob-ON NEVER grants 1h to a non-allowlisted model", () => {
  // These would be a COST / 400-WIRE bug if they ever resolved to 1h.
  const nonAllowlisted = [
    "claude-3-5-sonnet-20241022",
    "claude-3-5-haiku-20241022",
    "claude-opus-4-5", // not on the allowlist
    "claude-sonnet-4-5",
    "gpt-4o",
    "gpt-5",
    "o3-mini",
    "gemini-2.5-pro",
    "claude-opus-4-8-latest", // `-latest` is NOT a date suffix ⇒ family differs
    "us.anthropic.claude-opus-4-8-v1:0", // CRIS region prefix not stripped ⇒ conservative 5m
  ]
  for (const model of nonAllowlisted) {
    test(`knob-on + ${JSON.stringify(model)} ⇒ 5m (never 1h — stays byte-identical)`, () => {
      expect(resolveCacheTtl(model, on)).toBe("5m")
    })
  }
})

describe("resolveCacheTtl — unknown / garbage / empty model ⇒ SAFE 5m (no throw)", () => {
  const garbage = [
    "",
    "   ",
    "\n\t",
    "????",
    "claude",
    "claude-opus", // truncated family
    "x".repeat(500),
    "anthropic.", // prefix only
    "claude-opus-4-8-extra-tail-segments",
    "@20250101", // pin only
    "-v1:0", // version only
  ]
  for (const model of garbage) {
    test(`knob-on + garbage ${JSON.stringify(model)} ⇒ 5m, never throws`, () => {
      let ttl: CacheTtl | undefined
      expect(() => {
        ttl = resolveCacheTtl(model, on)
      }).not.toThrow()
      expect(ttl).toBe("5m")
    })
  }
})

describe("normalizeModelFamily — slug collapse invariants", () => {
  test("an allowlisted family is a FIXED POINT (normalize is idempotent on it)", () => {
    for (const fam of ALLOWLISTED) {
      expect(normalizeModelFamily(fam)).toBe(fam)
      expect(normalizeModelFamily(normalizeModelFamily(fam))).toBe(fam)
    }
  })

  test("every cloud-slug shape of an allowlisted model maps to its public family", () => {
    for (const fam of ALLOWLISTED) {
      expect(normalizeModelFamily(`${fam}-20250101`)).toBe(fam)
      expect(normalizeModelFamily(`anthropic.${fam}-v1:0`)).toBe(fam)
      expect(normalizeModelFamily(`${fam}@20250101`)).toBe(fam)
      expect(normalizeModelFamily(`anthropic.${fam}@20250101`)).toBe(fam)
      expect(normalizeModelFamily(fam.toUpperCase())).toBe(fam)
      expect(normalizeModelFamily(`  ${fam}  `)).toBe(fam)
    }
  })

  test("a 4-digit @suffix is NOT a date pin (only ≥6 digits stripped) ⇒ family differs", () => {
    // Guards the regex boundary: `@\d{6,}` must not strip a short non-date.
    expect(normalizeModelFamily("claude-opus-4-8@2025")).toBe("claude-opus-4-8@2025")
  })

  test("a 7-digit trailing group is NOT an 8-digit date ⇒ NOT stripped", () => {
    expect(normalizeModelFamily("claude-opus-4-8-1234567")).toBe("claude-opus-4-8-1234567")
  })

  test("garbage / empty never throws and returns a string", () => {
    for (const g of ["", "   ", "????", "\n"]) {
      expect(typeof normalizeModelFamily(g)).toBe("string")
    }
  })
})

describe("resolveCacheTtl — the knob is the ONLY thing that can flip 5m→1h", () => {
  test("for EVERY allowlisted family, off⇒5m and on⇒1h (the knob is the switch)", () => {
    for (const fam of ALLOWLISTED) {
      expect(resolveCacheTtl(fam, off)).toBe("5m")
      expect(resolveCacheTtl(fam, on)).toBe("1h")
    }
  })

  test("for a non-allowlisted model, BOTH knob positions ⇒ 5m (knob cannot reach it)", () => {
    const m = "claude-3-5-sonnet-20241022"
    expect(resolveCacheTtl(m, off)).toBe("5m")
    expect(resolveCacheTtl(m, on)).toBe("5m")
  })
})
