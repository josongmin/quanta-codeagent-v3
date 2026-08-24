/**
 * Characterization pin for the P² streaming-quantile sketch.
 *
 * The sketch is the ONLY source of `p50`/`p95`/`p99` once a histogram passes
 * `histogramMaxObservations` and its exact samples are dropped. It is ~25 lines
 * of index arithmetic over five marker slots, it has no closed-form check a
 * reader can eyeball, and until now nothing pinned its OUTPUT — the observability
 * suites assert that percentiles are present and ordered, which every wrong
 * implementation also satisfies.
 *
 * That mattered when the adjust step was rewritten to drop ~30 non-null
 * assertions (`positions[i]!` → literal-indexed `positions[next]`). The
 * assertions were noise, but removing them meant re-deriving `i - 1` / `i + 1` /
 * `i + direction` by hand, and an off-by-one there degrades every percentile
 * silently: the numbers stay plausible, stay ordered, and stay wrong.
 *
 * So this pins the actual values, captured from the pre-refactor implementation
 * and reproduced bit-for-bit after it.
 *
 * ## Why these inputs
 *
 * The seed size decides how many samples the sketch sees versus how many the
 * exact path handles, so each shape is run at several caps around the
 * `MIN_P2_SEED_SIZE` boundary. `max: 100000` never compacts and therefore
 * exercises the EXACT percentile path instead — it is the control: if a change
 * moved a percentile there too, the fault is in `percentile()`, not the sketch.
 *
 * Shapes: a deterministic LCG (no `Math.random` — this must be reproducible),
 * a monotone ramp and its reverse (P² adapts differently to ordered input),
 * a skew with periodic 100× outliers (tests the parabolic-vs-linear fallback),
 * a constant stream (every marker gap is zero — the division-by-gap terms),
 * a bimodal stream, and a run only two samples past the cap (the sketch is
 * consulted having barely been initialized).
 *
 * ## Sensitivity (measured, not assumed)
 *
 * Two mutations were injected into the adjust step and both are caught here:
 * bumping positions at `i >= bucket` instead of `i > bucket` moves 73 of the
 * pinned numbers, and inverting the linear fallback's neighbour moves 34.
 * A third — relaxing the parabolic guard's `<` to `<=` — is NOT caught, because
 * it only differs when a parabolic estimate lands exactly on a marker height,
 * which none of these streams produce. That boundary is genuinely untested here;
 * it is recorded rather than papered over.
 */

import { describe, expect, test } from "bun:test"

import { defaultMetricsRegistry } from "@/observability/metrics/in-memory-registry"

type Row = {
  readonly p50: number
  readonly p95: number
  readonly p99: number
  readonly count: number
}

/** A fixed LCG. Reproducibility is the whole point — `Math.random` would make
 *  this pin meaningless on the second run. */
const lcg = (seed: number): (() => number) => {
  let s = seed
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648
    return s / 2147483648
  }
}

const observed = (max: number, n: number, gen: (i: number) => number): Row => {
  const registry = defaultMetricsRegistry({ histogramMaxObservations: max })
  for (let i = 0; i < n; i += 1) registry.observe("h", gen(i))
  const row = registry.snapshot().find((r) => r.name === "h")
  if (row === undefined || row.kind !== "histogram") {
    throw new Error("the histogram series is missing from the snapshot")
  }
  return { p50: row.p50, p95: row.p95, p99: row.p99, count: row.count }
}

const rand = (max: number): Row => {
  const next = lcg(12345)
  return observed(max, 400, () => Math.round(next() * 1000) / 10)
}

describe("P² quantile sketch — pinned output", () => {
  test("the compacted sketch reproduces its captured percentiles", () => {
    // Identical across every cap: with 400 samples from one sequence the markers
    // converge to the same attractor regardless of where compaction began. That
    // convergence is itself the property worth pinning — it is what lets the
    // default cap change without moving reported percentiles.
    for (const max of [5, 6, 7, 8, 13, 64, 255]) {
      expect({ max, ...rand(max) }).toEqual({
        max,
        p50: 51.08886792398639,
        p95: 94.4908534451693,
        p99: 98.35948113299317,
        count: 400,
      })
    }
  })

  test("CONTROL — the exact path (never compacted) gives different, exact values", () => {
    // Anti-vacuity: proves the cap is actually wired and that the numbers above
    // come from the SKETCH, not from the exact path leaking through.
    expect(rand(100_000)).toEqual({ p50: 49.5, p95: 93.7, p99: 99.1, count: 400 })
  })

  const shapes: ReadonlyArray<readonly [string, (i: number) => number, number]> = [
    ["ramp", (i) => i, 300],
    ["desc", (i) => 300 - i, 300],
    ["skew", (i) => (i % 17 === 0 ? 5000 : i), 300],
    ["const", () => 42, 300],
    ["bimodal", (i) => (i % 2 === 0 ? 1 : 900), 300],
  ]

  const PINNED: Readonly<Record<string, readonly [number, number, number]>> = {
    "bimodal/16": [300.66666666666663, 899.9999999999999, 900],
    "bimodal/5": [300.66666666666663, 899.9999999999999, 900],
    "bimodal/64": [300.66666666666663, 899.9999999999999, 900],
    "bimodal/9": [300.66666666666663, 899.9999999999999, 900],
    "const/16": [42, 42, 42],
    "const/5": [42, 42, 42],
    "const/64": [42, 42, 42],
    "const/9": [42, 42, 42],
    "desc/16": [151, 286, 298],
    "desc/5": [151, 286, 298],
    "desc/64": [151, 286, 298],
    "desc/9": [151, 286, 298],
    "ramp/16": [149, 284, 295],
    "ramp/5": [149, 284, 295],
    "ramp/64": [149, 284, 295],
    "ramp/9": [149, 284, 295],
    "skew/16": [223.95008095290936, 3778.658581752913, 4999.985677332903],
    "skew/5": [223.95008095290936, 3778.658581752913, 4999.985677332903],
    "skew/64": [223.95008095290936, 3778.658581752913, 4999.985677332903],
    "skew/9": [223.95008095290936, 3778.658581752913, 4999.985677332903],
  }

  test("each stream shape reproduces its captured percentiles", () => {
    for (const [name, gen, n] of shapes) {
      for (const max of [5, 9, 16, 64]) {
        const row = observed(max, n, gen)
        expect(row.count).toBe(n)
        // Ordering holds for every shape — the weak property the pre-existing
        // suites already covered, kept as a floor.
        expect(row.p50).toBeLessThanOrEqual(row.p95)
        expect(row.p95).toBeLessThanOrEqual(row.p99)
        const pinned = PINNED[`${name}/${max}`]
        if (pinned === undefined) throw new Error(`no pin captured for ${name}/${max}`)
        expect([row.p50, row.p95, row.p99]).toEqual([...pinned])
      }
    }
  })

  test("a stream that ends two samples past the cap is still answerable", () => {
    // The sketch is read having seen almost nothing beyond its seed. It must
    // produce finite, ordered numbers rather than the `?? 0` fallback.
    for (const max of [5, 9, 16, 64]) {
      const row = observed(max, max + 2, (i) => i * 3)
      expect(Number.isFinite(row.p50)).toBe(true)
      expect(row.p50).toBeGreaterThan(0)
      expect(row.p50).toBeLessThanOrEqual(row.p99)
    }
  })
})
