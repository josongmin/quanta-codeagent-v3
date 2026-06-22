/**
 * Hellgate: full-remote INSTANCE-AWARE relaunch retry.
 *
 * RCA (2026-06-18): a full-remote run is held by ONE blocking ssh on a SPOT box.
 * A spot reclaim / ssh-255 drop kills the box mid-run. The first fix relaunched
 * on an ALL-EMPTY result only — but grade-concurrency pipelines grading across
 * the run, so a mid-run death leaves a PARTIAL report. The all-or-nothing check
 * missed that: the lost instances were silently under-counted (reported as if
 * the run only ever had the few that finished).
 *
 * `runWithRelaunch` reconciles against the EXPECTED instance set: each attempt
 * re-runs ONLY the instances still missing a verdict (resolved/unresolved/
 * errored/emptyPatch), on a fresh box, merging results. So a 49/50 partial loss
 * re-runs 1 (not 50), a total loss re-runs all, and anything still missing after
 * the bound is SURFACED in `missing` (never silently dropped).
 *
 * Red-on-injection: drop the partial-loss reconcile (relaunch on all-empty only)
 * and TEST "partial loss re-runs only the missing" fails — the lost instance is
 * neither recovered nor reported.
 */
import { describe, expect, test } from "bun:test"
import { coveredInstances, runWithRelaunch } from "../../src/apps/bench/remote/full"

describe("coveredInstances", () => {
  test("union of all four verdict categories", () => {
    const c = coveredInstances({
      resolved: ["a__1"],
      unresolved: ["b__2"],
      errored: ["c__3"],
      emptyPatch: ["d__4"],
    })
    expect([...c].sort()).toEqual(["a__1", "b__2", "c__3", "d__4"])
  })
  test("empty result covers nothing (total box loss)", () => {
    expect(coveredInstances({}).size).toBe(0)
  })
})

describe("runWithRelaunch — instance-aware, fresh box per loss", () => {
  test("clean first run ⇒ ONE box, no relaunch, nothing missing", async () => {
    const calls: string[][] = []
    const out = await runWithRelaunch(
      (ids) => {
        calls.push([...ids])
        return { run: async () => ({ resolved: ["a__1"], unresolved: ["b__2"] }) }
      },
      { expected: ["a__1", "b__2"], maxRelaunch: 2 },
    )
    expect(calls.length).toBe(1)
    expect(calls[0]).toEqual(["a__1", "b__2"]) // first attempt runs the whole set
    expect(out.attempts).toBe(1)
    expect(out.resolved).toEqual(["a__1"])
    expect(out.missing).toEqual([])
  })

  test("PARTIAL loss: 4 expected, box dies after 2 ⇒ relaunch runs ONLY the missing 2", async () => {
    const calls: string[][] = []
    const out = await runWithRelaunch(
      (ids) => {
        calls.push([...ids])
        return {
          run: async () =>
            calls.length === 1
              ? // attempt 1: box died mid-grade — only c,d got verdicts
                { resolved: ["c__3"], unresolved: ["d__4"], reportPath: "/r1" }
              : // attempt 2 (the relaunch): the missing a,b now graded
                { resolved: ["a__1"], unresolved: ["b__2"], reportPath: "/r2" },
        }
      },
      { expected: ["a__1", "b__2", "c__3", "d__4"], maxRelaunch: 2 },
    )
    expect(calls.length).toBe(2)
    expect(calls[0]).toEqual(["a__1", "b__2", "c__3", "d__4"]) // attempt 1 = full set
    expect(calls[1]).toEqual(["a__1", "b__2"]) // relaunch = ONLY the lost two (no waste)
    expect(out.resolved.sort()).toEqual(["a__1", "c__3"]) // merged across attempts
    expect(out.unresolved.sort()).toEqual(["b__2", "d__4"])
    expect(out.missing).toEqual([]) // nothing silently dropped
    expect(out.reportPaths).toEqual(["/r1", "/r2"])
    expect(out.attempts).toBe(2)
  })

  test("TOTAL loss then success: empty attempt re-runs the full set", async () => {
    const calls: string[][] = []
    const out = await runWithRelaunch(
      (ids) => {
        calls.push([...ids])
        return {
          run: async () => (calls.length === 1 ? {} : { resolved: ["a__1", "b__2"] }),
        }
      },
      { expected: ["a__1", "b__2"], maxRelaunch: 2 },
    )
    expect(calls.length).toBe(2)
    expect(calls[1]).toEqual(["a__1", "b__2"]) // total loss ⇒ re-run everything
    expect(out.resolved).toEqual(["a__1", "b__2"])
    expect(out.missing).toEqual([])
  })

  test("a THROWN attempt re-runs the same remaining set, not fatal", async () => {
    const calls: string[][] = []
    const out = await runWithRelaunch(
      (ids) => {
        calls.push([...ids])
        return {
          run: async () => {
            if (calls.length === 1) throw new Error("no spot capacity")
            return { resolved: ["a__1"] }
          },
        }
      },
      { expected: ["a__1"], maxRelaunch: 2 },
    )
    expect(calls.length).toBe(2)
    expect(out.resolved).toEqual(["a__1"])
  })

  test("bounded + SURFACES loss: persistent total loss stops and reports `missing`", async () => {
    let calls = 0
    const out = await runWithRelaunch(
      () => {
        calls += 1
        return { run: async () => ({}) }
      },
      { expected: ["a__1", "b__2"], maxRelaunch: 2 },
    )
    expect(calls).toBe(3) // 1 + 2 relaunches, then stop (no infinite loop)
    expect(out.attempts).toBe(3)
    expect(out.resolved).toEqual([])
    expect(out.missing.sort()).toEqual(["a__1", "b__2"]) // NOT silently 0 — surfaced
  })

  test("maxRelaunch=0 ⇒ single attempt; a partial loss is surfaced, not retried", async () => {
    let calls = 0
    const out = await runWithRelaunch(
      () => {
        calls += 1
        return { run: async () => ({ resolved: ["a__1"] }) } // b__2 lost
      },
      { expected: ["a__1", "b__2"], maxRelaunch: 0 },
    )
    expect(calls).toBe(1)
    expect(out.resolved).toEqual(["a__1"])
    expect(out.missing).toEqual(["b__2"]) // still surfaced even with no retry
  })

  test("errored/emptyPatch count as covered (a verdict, not a box loss) — not retried", async () => {
    let calls = 0
    const out = await runWithRelaunch(
      () => {
        calls += 1
        return { run: async () => ({ errored: ["a__1"], emptyPatch: ["b__2"] }) }
      },
      { expected: ["a__1", "b__2"], maxRelaunch: 3 },
    )
    expect(calls).toBe(1) // both got a verdict ⇒ nothing missing ⇒ no relaunch
    expect(out.missing).toEqual([])
  })

  test("later attempts overwrite an earlier bucket for the same instance instead of keeping split-brain verdicts", async () => {
    const out = await runWithRelaunch(
      (() => {
        let calls = 0
        return () => {
          calls += 1
          return {
            run: async () =>
              calls === 1
                ? { unresolved: ["a__1"] }
                : { resolved: ["a__1", "b__2"] },
          }
        }
      })(),
      { expected: ["a__1", "b__2"], maxRelaunch: 1 },
    )
    expect(out.resolved).toEqual(["a__1", "b__2"])
    expect(out.unresolved).toEqual([])
    expect(out.missing).toEqual([])
  })
})
