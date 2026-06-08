/**
 * Maestro nicknames HELL e2e (Cluster E / F17, ADR-0042 part 2).
 *
 * Heavy invariants:
 *   - 39 unique ASCII names, length 1..12.
 *   - Determinism: 10,000 seeds × 2 calls each ⇒ identical result.
 *   - Uniformity smoke: 100,000 seeds ⇒ no zero-occurrence name, and
 *     max/min ratio < 3.0 (loose; not a hard statistical test).
 *   - nextSequentialNickname: empty / 1-used / 38-used (middle hole) / all-used.
 */
import { describe, expect, test } from "bun:test"
import { assignNickname, MAESTRO_NICKNAMES, nextSequentialNickname } from "@/subagent/nicknames"

/* ── 1. pool invariants (39 unique ASCII names ≤ 12 chars) ──────────────── */

describe("MAESTRO_NICKNAMES — pool invariants", () => {
  test("exactly 39 entries", () => {
    expect(MAESTRO_NICKNAMES.length).toBe(39)
  })

  test("all 39 entries unique (Set size == 39)", () => {
    expect(new Set(MAESTRO_NICKNAMES).size).toBe(39)
  })

  test("every name is ASCII letters only, length 1..12", () => {
    for (const n of MAESTRO_NICKNAMES) {
      expect(n.length).toBeGreaterThanOrEqual(1)
      expect(n.length).toBeLessThanOrEqual(12)
      expect(/^[A-Za-z]+$/.test(n)).toBe(true)
    }
  })

  test("pool array is Object.frozen", () => {
    expect(Object.isFrozen(MAESTRO_NICKNAMES)).toBe(true)
  })

  test("no name contains whitespace, punctuation or digits", () => {
    for (const n of MAESTRO_NICKNAMES) {
      expect(/\s/.test(n)).toBe(false)
      expect(/[0-9]/.test(n)).toBe(false)
      expect(/[^A-Za-z]/.test(n)).toBe(false)
    }
  })
})

/* ── 2. determinism over 10,000 seeds ───────────────────────────────────── */

/**
 * Tiny seedable PRNG — Mulberry32. Deterministic, no Math.random.
 * Returns a 32-bit unsigned integer per call.
 */
const mulberry32 = (seed: number): (() => number) => {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let x = t
    x = Math.imul(x ^ (x >>> 15), x | 1)
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61)
    return (x ^ (x >>> 14)) >>> 0
  }
}

describe("assignNickname determinism — 10,000 seeds, 2 calls each", () => {
  test("same seed produces identical name on repeat invocation", () => {
    const rng = mulberry32(0xc0ffee)
    let checked = 0
    for (let i = 0; i < 10_000; i++) {
      const seed = `seed_${rng().toString(36)}_${i}`
      const a = assignNickname(seed)
      const b = assignNickname(seed)
      if (a !== b) {
        throw new Error(`non-determinism at seed='${seed}': '${a}' vs '${b}'`)
      }
      checked += 1
    }
    expect(checked).toBe(10_000)
  })

  test("numeric seed determinism over 1,000 numeric seeds", () => {
    for (let n = -500; n < 500; n++) {
      const a = assignNickname(n)
      const b = assignNickname(n)
      expect(a).toBe(b)
    }
  })

  test("number n and string String(n) collide (documented coercion)", () => {
    for (const n of [0, 1, 42, 123456, -7]) {
      expect(assignNickname(n)).toBe(assignNickname(String(n)))
    }
  })
})

/* ── 3. distribution uniformity smoke (100,000 seeds) ──────────────────── */

/** Tally `assignNickname` output across `n` deterministic draws. */
const tallyNicknames = (n: number, rngSeed: number): Map<string, number> => {
  const counts = new Map<string, number>()
  for (const name of MAESTRO_NICKNAMES) counts.set(name, 0)
  const rng = mulberry32(rngSeed)
  for (let i = 0; i < n; i++) {
    const seed = `s${rng()}_${i}`
    const name = assignNickname(seed)
    counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return counts
}

/** Return {min,max} count across every nickname (skipping none). */
const minMax = (counts: ReadonlyMap<string, number>): { min: number; max: number } => {
  let min = Number.POSITIVE_INFINITY
  let max = 0
  for (const n of MAESTRO_NICKNAMES) {
    const c = counts.get(n) ?? 0
    if (c < min) min = c
    if (c > max) max = c
  }
  return { min, max }
}

describe("assignNickname distribution — uniformity smoke over 100,000 seeds", () => {
  test("every nickname is hit at least once and max/min ratio < 3.0", () => {
    const N = 100_000
    const counts = tallyNicknames(N, 0xdeadbeef)
    const { min, max } = minMax(counts)
    if (min === 0) {
      throw new Error(
        `uniformity failure: at least one nickname had 0 occurrences out of ${N} draws`,
      )
    }
    const ratio = max / min
    if (!(ratio < 3.0)) {
      throw new Error(
        `uniformity failure: max/min ratio ${ratio.toFixed(3)} (max=${max}, min=${min}) >= 3.0`,
      )
    }
    expect(min).toBeGreaterThan(0)
    expect(ratio).toBeLessThan(3.0)
  })
})

/* ── 4. nextSequentialNickname exhaustion paths ─────────────────────────── */

describe("nextSequentialNickname", () => {
  test("empty set ⇒ returns the FIRST nickname in the pool", () => {
    const first = MAESTRO_NICKNAMES[0]
    if (first === undefined) throw new Error("pool is empty — impossible")
    expect(nextSequentialNickname(new Set())).toBe(first)
  })

  test("with 1 used ⇒ returns the 2nd", () => {
    const a = MAESTRO_NICKNAMES[0]
    const b = MAESTRO_NICKNAMES[1]
    if (a === undefined || b === undefined) throw new Error("pool < 2 — impossible")
    expect(nextSequentialNickname(new Set([a]))).toBe(b)
  })

  test("with 2 used (first two) ⇒ returns the 3rd", () => {
    const a = MAESTRO_NICKNAMES[0]
    const b = MAESTRO_NICKNAMES[1]
    const c = MAESTRO_NICKNAMES[2]
    if (a === undefined || b === undefined || c === undefined) throw new Error("pool < 3")
    expect(nextSequentialNickname(new Set([a, b]))).toBe(c)
  })

  test("with all 39 used ⇒ returns null (NO reuse, NO throw)", () => {
    expect(nextSequentialNickname(new Set(MAESTRO_NICKNAMES))).toBeNull()
  })

  test("with 38 used and a MIDDLE hole ⇒ returns the specific missing name", () => {
    const HOLE_INDEX = 17 // arbitrary middle index
    const hole = MAESTRO_NICKNAMES[HOLE_INDEX]
    if (hole === undefined) throw new Error(`pool < ${HOLE_INDEX + 1} — impossible`)
    const used = new Set(MAESTRO_NICKNAMES.filter((n) => n !== hole))
    expect(used.size).toBe(38)
    expect(nextSequentialNickname(used)).toBe(hole)
  })

  test("39 sequential draws never repeat; 40th returns null", () => {
    const used = new Set<string>()
    const drawn: string[] = []
    for (let i = 0; i < 39; i++) {
      const n = nextSequentialNickname(used)
      if (n === null) throw new Error(`unexpected null at draw ${i}`)
      if (used.has(n)) throw new Error(`reuse at draw ${i}: '${n}'`)
      drawn.push(n)
      used.add(n)
    }
    expect(new Set(drawn).size).toBe(39)
    expect(nextSequentialNickname(used)).toBeNull()
  })
})

/*
 * NOTE: removed source-token grep guard (section 5) — it asserted on source
 * text (no Math.random / Date.now / crypto.* in nicknames.ts) rather than
 * behavior. The determinism contract it proxied is covered far more robustly,
 * and against ANY non-determinism source regardless of spelling, by section 2
 * (11,000 seed-pairs asserting identical output) and section 3 (100,000
 * deterministic draws).
 */
