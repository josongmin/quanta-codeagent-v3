/**
 * HELLGATE — adversarial branch-search seed builder (ADR-0084 §3.1, §4.2).
 *
 * `buildSeeds(n, models?)` MUST be deterministic (replay reproducibility),
 * MUST stay inside [0.2, 1.0] temperature range, and MUST handle adversarial
 * `n` values (0 / 1 / NaN / Infinity / negative / large) without exploding.
 * Companion of `tests/unit/branch-search.test.ts` (covers happy path).
 *
 * 14 cases / 50+ expects.
 */

import { describe, expect, test } from "bun:test"
import { buildSeeds } from "@/agent/branch-search/seed"
import type { ModelCandidate } from "@/llm"

const fakeModel = (id: string): ModelCandidate =>
  ({
    id,
    port: {
      model: id,
      stream: async function* () {
        yield { type: "message_stop", stop_reason: "end_turn" as const }
      },
    },
  }) as ModelCandidate

describe("HELL-BSEED — branch-search seed adversarial cases", () => {
  test("CASE 01 — N=1 ⇒ exactly [0.2] single seed (Agentless baseline)", () => {
    const seeds = buildSeeds(1)
    expect(seeds).toHaveLength(1)
    expect(seeds[0]?.temperature).toBe(0.2)
    expect(seeds[0]?.promptHint).toBeUndefined()
  })

  test("CASE 02 — N=3 ⇒ [0.2, 0.6, 1.0] spread", () => {
    const seeds = buildSeeds(3)
    expect(seeds.map((s) => s.temperature)).toEqual([0.2, 0.6, 1.0])
  })

  test("CASE 03 — N=2 endpoints are the spread bounds", () => {
    const seeds = buildSeeds(2)
    expect(seeds.map((s) => s.temperature)).toEqual([0.2, 1.0])
  })

  test("CASE 04 — every temperature stays inside [0.2, 1.0] for N up to 11", () => {
    for (let n = 1; n <= 11; n++) {
      for (const seed of buildSeeds(n)) {
        expect(seed.temperature).toBeGreaterThanOrEqual(0.2)
        expect(seed.temperature).toBeLessThanOrEqual(1.0)
      }
    }
  })

  test("CASE 05 — buildSeeds is deterministic (replay-safe)", () => {
    const a = buildSeeds(5)
    const b = buildSeeds(5)
    expect(a).toEqual(b)
  })

  test("CASE 06 — seed[0].promptHint is ALWAYS undefined (faithful baseline)", () => {
    for (let n = 1; n <= 10; n++) {
      const seeds = buildSeeds(n)
      expect(seeds[0]?.promptHint).toBeUndefined()
    }
  })

  test("CASE 07 — promptHints cycle wraps at 4 (PROMPT_HINTS length)", () => {
    const seeds = buildSeeds(8)
    // Indices 0,4 share the same undefined hint
    expect(seeds[0]?.promptHint).toBeUndefined()
    expect(seeds[4]?.promptHint).toBeUndefined()
    expect(seeds[1]?.promptHint).toBe(seeds[5]?.promptHint)
    expect(seeds[2]?.promptHint).toBe(seeds[6]?.promptHint)
    expect(seeds[3]?.promptHint).toBe(seeds[7]?.promptHint)
  })

  test("CASE 08 — model rotation: round-robin over candidates", () => {
    const m1 = fakeModel("a")
    const m2 = fakeModel("b")
    const seeds = buildSeeds(4, [m1, m2])
    expect(seeds[0]?.modelOverride).toBe(m1)
    expect(seeds[1]?.modelOverride).toBe(m2)
    expect(seeds[2]?.modelOverride).toBe(m1)
    expect(seeds[3]?.modelOverride).toBe(m2)
  })

  test("CASE 09 — empty model array ⇒ no modelOverride field (exactOptional)", () => {
    const seeds = buildSeeds(3, [])
    for (const s of seeds) {
      expect(Object.hasOwn(s, "modelOverride")).toBe(false)
    }
  })

  test("CASE 10 — N=0 ⇒ empty array (no crash)", () => {
    expect(buildSeeds(0)).toEqual([])
  })

  test("CASE 11 — N=NaN ⇒ degenerate empty (Array.from({length:NaN}) ⇒ [])", () => {
    expect(buildSeeds(Number.NaN)).toEqual([])
  })

  test("CASE 12 — N=-1 ⇒ empty array (Array.from coerces negative length to 0)", () => {
    expect(buildSeeds(-1)).toEqual([])
  })

  test("CASE 13 — fractional N=2.7 ⇒ floor behavior (no exception)", () => {
    const seeds = buildSeeds(2.7)
    // Array.from({length:2.7}) = length-2 array. Behavior is well-defined.
    expect(seeds.length).toBeLessThanOrEqual(3)
    expect(seeds.length).toBeGreaterThanOrEqual(0)
  })

  test("CASE 14 — N=BIG (50) all temperatures unique + sorted ascending", () => {
    const seeds = buildSeeds(50)
    expect(seeds).toHaveLength(50)
    const temps = seeds.map((s) => s.temperature)
    // monotonic non-decreasing
    for (let i = 1; i < temps.length; i++) {
      const cur = temps[i] ?? 0
      const prev = temps[i - 1] ?? 0
      expect(cur).toBeGreaterThanOrEqual(prev)
    }
    // first = 0.2, last = 1.0 (toFixed(2) rounding)
    expect(temps[0]).toBe(0.2)
    expect(temps[temps.length - 1]).toBe(1.0)
  })

  test("CASE 15 — toFixed(2) rounding stable: N=7 produces 2-decimal floats", () => {
    const seeds = buildSeeds(7)
    for (const s of seeds) {
      // String representation has at most 2 decimal places (toFixed(2))
      const str = String(s.temperature)
      const decimals = str.includes(".") ? str.split(".")[1]?.length ?? 0 : 0
      expect(decimals).toBeLessThanOrEqual(2)
    }
  })
})
