/**
 * The top-level gate scheduler, asserted on a fake clock.
 *
 * `stepGatePlan` awaits every gate in manifest order whether or not one depends
 * on the previous, so the top-level wall time is the SUM of the gates rather
 * than the critical path through them. Dependency was also under-expressed: one
 * `consumes: string` cannot say "wait for A and B", and nothing could say "these
 * two both write the checkout, never overlap them".
 *
 * These run the real scheduler with an injected clock and an injected `run`, so
 * ordering, resource exclusion and failure propagation are measured in
 * milliseconds of test time rather than by sleeping.
 */

import { describe, expect, test } from "bun:test"

import {
  criticalPathLength,
  type DagGate,
  type DagGateResult,
  dagSpan,
  runGateDag,
} from "../../../tools/dev/gate-dag"

/**
 * A clock that only moves when a gate finishes, so wall time is deterministic.
 *
 * `advanceTo` rather than `advance` — a first draft added each gate's duration
 * to a shared counter, which makes two CONCURRENT gates cost the sum of their
 * durations in fake time and reports no saving at all. Real concurrency overlaps,
 * so a gate that started at t and ran for d ends at `max(now, t + d)`.
 */
const fakeClock = (): { now: () => number; advanceTo: (at: number) => void } => {
  let t = 1_000
  return {
    now: () => t,
    advanceTo: (at: number) => {
      t = Math.max(t, at)
    },
  }
}

interface Recorder {
  readonly run: (gate: DagGate) => Promise<{ readonly ok: boolean }>
  readonly order: string[]
  readonly peak: () => number
  readonly overlaps: () => readonly string[]
}

/**
 * Runs each gate as one macrotask of `durations[id]` fake-milliseconds, tracking
 * concurrent occupancy so a test can assert both the cap and which pairs
 * actually overlapped.
 */
const recorder = (
  clock: ReturnType<typeof fakeClock>,
  durations: Readonly<Record<string, number>>,
  failing: ReadonlySet<string> = new Set(),
): Recorder => {
  const order: string[] = []
  const inFlight = new Set<string>()
  const overlaps = new Set<string>()
  let peak = 0
  return {
    order,
    peak: () => peak,
    overlaps: () => [...overlaps].sort(),
    run: async (gate) => {
      const startedAt = clock.now()
      order.push(gate.id)
      for (const peer of inFlight) overlaps.add([gate.id, peer].sort().join("+"))
      inFlight.add(gate.id)
      peak = Math.max(peak, inFlight.size)
      // Yield twice so peers admitted in the same pass are genuinely in flight
      // together before any of them completes.
      await Promise.resolve()
      await Promise.resolve()
      inFlight.delete(gate.id)
      clock.advanceTo(startedAt + (durations[gate.id] ?? 1))
      return { ok: !failing.has(gate.id) }
    },
  }
}

const outcomes = (results: readonly DagGateResult[]): Record<string, string> =>
  Object.fromEntries(results.map((row) => [row.id, row.outcome]))

describe("gate DAG scheduler", () => {
  test("independent gates overlap; the cap is respected", async () => {
    const clock = fakeClock()
    const rec = recorder(clock, { a: 10, b: 10, c: 10 })
    const gates: DagGate[] = [{ id: "a" }, { id: "b" }, { id: "c" }]
    const results = await runGateDag({
      gates,
      failFast: true,
      concurrency: 2,
      run: rec.run,
      now: clock.now,
    })
    expect(outcomes(results)).toEqual({ a: "passed", b: "passed", c: "passed" })
    expect(rec.peak()).toBe(2)
    // ANTI-VACUITY: something must actually have overlapped, or "cap respected"
    // is a statement about a serial run.
    expect(rec.overlaps().length).toBeGreaterThan(0)
  })

  test("concurrency 1 is fully serial and nothing overlaps", async () => {
    const clock = fakeClock()
    const rec = recorder(clock, { a: 10, b: 10, c: 10 })
    await runGateDag({
      gates: [{ id: "a" }, { id: "b" }, { id: "c" }],
      failFast: true,
      concurrency: 1,
      run: rec.run,
      now: clock.now,
    })
    expect(rec.peak()).toBe(1)
    expect(rec.overlaps()).toEqual([])
  })

  test("gates sharing a resource never overlap, even under a high cap", async () => {
    const clock = fakeClock()
    const rec = recorder(clock, { w1: 10, w2: 10, free: 10 })
    await runGateDag({
      gates: [
        { id: "w1", resources: ["checkout"] },
        { id: "w2", resources: ["checkout"] },
        { id: "free" },
      ],
      failFast: true,
      concurrency: 8,
      run: rec.run,
      now: clock.now,
    })
    expect(rec.overlaps()).not.toContain("w1+w2")
    // …but a resource-free gate still overlaps one of them, or the exclusion
    // would be indistinguishable from running everything serially.
    expect(rec.overlaps().length).toBeGreaterThan(0)
  })

  test("a gate waits for EVERY producer it consumes, not just one", async () => {
    // The shape the single `consumes: string` could not express.
    const clock = fakeClock()
    const rec = recorder(clock, { a: 5, b: 5, c: 5 })
    await runGateDag({
      gates: [{ id: "a" }, { id: "b" }, { id: "c", consumes: ["a", "b"] }],
      failFast: true,
      concurrency: 4,
      run: rec.run,
      now: clock.now,
    })
    expect(rec.order.indexOf("c")).toBeGreaterThan(rec.order.indexOf("a"))
    expect(rec.order.indexOf("c")).toBeGreaterThan(rec.order.indexOf("b"))
    expect(rec.overlaps()).not.toContain("a+c")
    expect(rec.overlaps()).not.toContain("b+c")
  })

  test("a failed producer poisons its consumer, transitively", async () => {
    const clock = fakeClock()
    const rec = recorder(clock, { a: 5, b: 5, c: 5 }, new Set(["a"]))
    const results = await runGateDag({
      gates: [{ id: "a" }, { id: "b", consumes: ["a"] }, { id: "c", consumes: ["b"] }],
      failFast: false,
      concurrency: 4,
      run: rec.run,
      now: clock.now,
    })
    expect(outcomes(results)).toEqual({ a: "failed", b: "skipped-input", c: "skipped-input" })
    expect(rec.order).toEqual(["a"])
    const reason = results.find((row) => row.id === "b")?.reason
    expect(reason).toBe("producer a failed")
  })

  test("dependsOn orders without poisoning", async () => {
    // The distinction the old single field could not draw: "run after" is not
    // "read the artifact of". A failed predecessor must not silently skip a gate
    // that merely needed to go second.
    const clock = fakeClock()
    const rec = recorder(clock, { a: 5, b: 5 }, new Set(["a"]))
    const results = await runGateDag({
      gates: [{ id: "a" }, { id: "b", dependsOn: ["a"] }],
      failFast: false,
      concurrency: 4,
      run: rec.run,
      now: clock.now,
    })
    expect(outcomes(results)).toEqual({ a: "failed", b: "passed" })
    expect(rec.order).toEqual(["a", "b"])
  })

  test("fail-fast stops new dispatch; keep-going continues independent branches", async () => {
    const gates: DagGate[] = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }]
    const fastClock = fakeClock()
    const fast = recorder(fastClock, {}, new Set(["a"]))
    const fastResults = await runGateDag({
      gates,
      failFast: true,
      concurrency: 1,
      run: fast.run,
      now: fastClock.now,
    })
    expect(fastResults.filter((row) => row.outcome === "not-run").map((row) => row.id)).toEqual([
      "b",
      "c",
      "d",
    ])
    expect(fastResults.find((row) => row.id === "b")?.reason).toBe("fail-fast")

    const keepClock = fakeClock()
    const keep = recorder(keepClock, {}, new Set(["a"]))
    const keepResults = await runGateDag({
      gates,
      failFast: false,
      concurrency: 1,
      run: keep.run,
      now: keepClock.now,
    })
    expect(outcomes(keepResults)).toEqual({ a: "failed", b: "passed", c: "passed", d: "passed" })
  })

  test("results come back in manifest order, not completion order", async () => {
    const clock = fakeClock()
    const rec = recorder(clock, { slow: 100, quick: 1 })
    const results = await runGateDag({
      gates: [{ id: "slow" }, { id: "quick" }],
      failFast: true,
      concurrency: 2,
      run: rec.run,
      now: clock.now,
    })
    expect(results.map((row) => row.id)).toEqual(["slow", "quick"])
  })

  test("the span reports wall against serial rather than asserting a saving", async () => {
    // Reported, not asserted as a win: how much a DAG buys depends entirely on
    // the graph, and "saved 0" over a fully-serial manifest is a useful fact.
    // Asserted as INVARIANTS rather than as numbers — a first draft pinned
    // `serialMs === 20` and broke, because two gates overlapping on one shared
    // fake clock both observe the other's advance, which is correct behaviour
    // for a shared clock and not a scheduler defect.
    const serialClock = fakeClock()
    const serialRec = recorder(serialClock, { a: 10, b: 10 })
    const serial = dagSpan(
      await runGateDag({
        gates: [{ id: "a" }, { id: "b" }],
        failFast: true,
        concurrency: 1,
        run: serialRec.run,
        now: serialClock.now,
      }),
    )
    // Serial: nothing overlaps, so the wall IS the sum.
    expect(serialRec.overlaps()).toEqual([])
    expect(serial.wallMs).toBe(serial.serialMs)
    expect(serial.serialMs).toBe(20)

    const parClock = fakeClock()
    const parRec = recorder(parClock, { a: 10, b: 10 })
    const parallel = dagSpan(
      await runGateDag({
        gates: [{ id: "a" }, { id: "b" }],
        failFast: true,
        concurrency: 2,
        run: parRec.run,
        now: parClock.now,
      }),
    )
    // ANTI-VACUITY: the second run must genuinely have overlapped, or the
    // comparison below is between two serial runs.
    expect(parRec.overlaps()).toEqual(["a+b"])
    expect(parallel.wallMs).toBeLessThan(parallel.serialMs)
    expect(parallel.wallMs).toBeLessThan(serial.serialMs)
  })

  test("criticalPathLength is the floor any scheduler must pay", () => {
    expect(criticalPathLength([{ id: "a" }, { id: "b" }, { id: "c" }])).toBe(1)
    expect(
      criticalPathLength([{ id: "a" }, { id: "b", consumes: ["a"] }, { id: "c", consumes: ["b"] }]),
    ).toBe(3)
    expect(criticalPathLength([{ id: "a" }, { id: "b" }, { id: "c", consumes: ["a", "b"] }])).toBe(
      2,
    )
    // An edge naming a gate that is not in this tier is not a dependency here —
    // the contract validator rejects dangling producers at manifest level, and a
    // producer staged elsewhere is simply absent at run time.
    expect(criticalPathLength([{ id: "a", consumes: ["elsewhere"] }])).toBe(1)
  })

  test("every gate gets exactly one terminal result", async () => {
    // ANTI-VACUITY for the whole file: a scheduler that dropped a gate would
    // make several assertions above pass over a shorter list.
    const clock = fakeClock()
    const rec = recorder(clock, {}, new Set(["a"]))
    const gates: DagGate[] = [
      { id: "a" },
      { id: "b", consumes: ["a"] },
      { id: "c", dependsOn: ["b"] },
      { id: "d", resources: ["checkout"] },
      { id: "e", resources: ["checkout"] },
    ]
    const results = await runGateDag({
      gates,
      failFast: false,
      concurrency: 3,
      run: rec.run,
      now: clock.now,
    })
    expect(results.map((row) => row.id).sort()).toEqual(["a", "b", "c", "d", "e"])
    expect(new Set(results.map((row) => row.id)).size).toBe(gates.length)
    for (const row of results) {
      expect({ id: row.id, terminal: row.outcome !== undefined }).toEqual({
        id: row.id,
        terminal: true,
      })
    }
  })
})
