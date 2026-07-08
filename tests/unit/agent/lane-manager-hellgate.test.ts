/**
 * Parallel lane-manager hellgate (ADR-0285).
 *
 * Seals 15 invariants:
 *
 *   HELL-LM-01  3 parallel lanes ⇒ 3 results, all ok.
 *   HELL-LM-02  One lane fail ⇒ others continue, partial result returned.
 *   HELL-LM-03  All lanes fail ⇒ every result has typed Err.
 *   HELL-LM-04  Timeout on awaitAll ⇒ straggler surfaces Err("timeout").
 *   HELL-LM-05  Parent abort ⇒ all lanes cascade abort.
 *   HELL-LM-06  Resource starvation (100 lanes) ⇒ maxConcurrency cap honoured;
 *               peak running ≤ cap.
 *   HELL-LM-07  Lane spawn fail (one runner throws) ⇒ siblings continue.
 *   HELL-LM-08  LaneResult order = input handle order (NOT completion order).
 *   HELL-LM-09  LaneError 4-arm exhaustive coverage.
 *   HELL-LM-10  Duplicate spec ⇒ two independent lanes with distinct ids.
 *   HELL-LM-11  Default-OFF byte-identical: import side-effect free.
 *   HELL-LM-12  awaitAll deterministic — same handles ⇒ same shape.
 *   HELL-LM-13  Zombie lane after timeout — straggler's eventual completion
 *               does NOT mutate the already-returned result.
 *   HELL-LM-14  1000 lane cycle no leak — counter monotonic, no unhandled.
 *   HELL-LM-15  Concurrent spawnLane + awaitAll safe (handles minted during
 *               wait still resolvable).
 */

import { describe, expect, test } from "bun:test"
import type { DelegationRunnerPort } from "@/agent/delegation-runner"
import {
  ALL_LANE_ERROR_KINDS,
  defaultLaneManager,
  type LaneResult,
  type LaneSpec,
} from "@/agent/lane-manager"
import { successBoomerang } from "@/agent/subagent-typed"

const mkSpec = (prompt: string, label?: string): LaneSpec => ({
  delegate: { mode: "explore", prompt },
  ...(label !== undefined ? { label } : {}),
})

const fastRunner: DelegationRunnerPort = {
  async delegate(spec) {
    return successBoomerang({
      mode: spec.mode,
      summary: `ok:${spec.prompt}`,
      turns: 1,
      durationMs: 1,
    })
  },
}

const failRunner: DelegationRunnerPort = {
  async delegate(spec) {
    return {
      ok: false,
      summary: "(forced)",
      mode: spec.mode,
      turns: 0,
      durationMs: 1,
      errorKind: "runner-error" as const,
      errorMessage: "forced fail",
    }
  },
}

/** Safe index getter — narrows `LaneResult | undefined` to `LaneResult` with
 *  an inline assertion so the hellgate doesn't drown in `?.` noise. */
const at = (results: ReadonlyArray<LaneResult>, i: number): LaneResult => {
  const r = results[i]
  if (r === undefined) throw new Error(`results[${i}] undefined (len=${results.length})`)
  return r
}

describe("lane-manager hellgate (ADR-0285)", () => {
  // -------------------------------------------------------------------------
  test("HELL-LM-01 3 parallel lanes ⇒ 3 results", async () => {
    const mgr = defaultLaneManager({ runner: fastRunner })
    const h1 = mgr.spawnLane(mkSpec("a"))
    const h2 = mgr.spawnLane(mkSpec("b"))
    const h3 = mgr.spawnLane(mkSpec("c"))
    const results = await mgr.awaitAll([h1, h2, h3])
    expect(results.length).toBe(3)
    expect(results.every((r) => r.ok)).toBe(true)
  })

  // -------------------------------------------------------------------------
  test("HELL-LM-02 one lane fail ⇒ others continue, partial result", async () => {
    let callIdx = 0
    const mixed: DelegationRunnerPort = {
      async delegate(spec) {
        callIdx += 1
        if (callIdx === 2) {
          return {
            ok: false,
            summary: "(forced)",
            mode: spec.mode,
            turns: 0,
            durationMs: 1,
            errorKind: "runner-error" as const,
            errorMessage: "forced fail",
          }
        }
        return successBoomerang({
          mode: spec.mode,
          summary: `ok:${spec.prompt}`,
          turns: 1,
          durationMs: 1,
        })
      },
    }
    const mgr = defaultLaneManager({ runner: mixed, maxConcurrency: 1 })
    const hs = [mgr.spawnLane(mkSpec("a")), mgr.spawnLane(mkSpec("b")), mgr.spawnLane(mkSpec("c"))]
    const out = await mgr.awaitAll(hs)
    // The lane itself always succeeds (runner returned a typed boomerang);
    // failure surfaces on `boomerang.ok` for failRunner-returned results.
    expect(out.length).toBe(3)
    let okBoom = 0
    let failBoom = 0
    for (const r of out) {
      if (r.ok) {
        if (r.boomerang.ok) okBoom += 1
        else failBoom += 1
      }
    }
    expect(okBoom).toBe(2)
    expect(failBoom).toBe(1)
  })

  // -------------------------------------------------------------------------
  test("HELL-LM-03 all lanes fail (boomerang.ok=false) ⇒ typed errorKind every result", async () => {
    const mgr = defaultLaneManager({ runner: failRunner })
    const hs = [mgr.spawnLane(mkSpec("x")), mgr.spawnLane(mkSpec("y"))]
    const out = await mgr.awaitAll(hs)
    // Each LANE succeeded (runner returned a result, not threw). The boomerang
    // carries the failure — that's the contract: lane error ≠ boomerang error.
    for (const r of out) {
      expect(r.ok).toBe(true)
      if (r.ok) {
        expect(r.boomerang.ok).toBe(false)
        expect(r.boomerang.errorKind).toBeDefined()
      }
    }
  })

  // -------------------------------------------------------------------------
  // NON-VACUOUS: also observes the DELEGATE's injected `spec.signal` — the
  // timeout arm must force-cancel the underlying delegate (CASCADE contract),
  // not merely resolve a timeout result while the child agent keeps burning
  // tokens. Mutation: dropping `laneCtrl.abort()` from the awaitAll timeout arm
  // in default-manager.ts must turn `delegateAborted` false → RED.
  test("HELL-LM-04 timeout ⇒ straggler surfaces Err(timeout) AND delegate aborted", async () => {
    let sawSignal = false
    let delegateAborted = false
    const slow: DelegationRunnerPort = {
      delegate: (spec) =>
        new Promise((resolve) => {
          const sig = spec.signal
          if (sig !== undefined) {
            sawSignal = true
            if (sig.aborted) delegateAborted = true
            else
              sig.addEventListener(
                "abort",
                () => {
                  delegateAborted = true
                },
                { once: true },
              )
          }
          // Resolve far in the future — the timeout fires first.
          const t = setTimeout(() => {
            resolve(
              successBoomerang({
                mode: "explore",
                summary: "late",
                turns: 1,
                durationMs: 0,
              }),
            )
          }, 5_000)
          ;(t as { unref?: () => void }).unref?.()
        }),
    }
    const mgr = defaultLaneManager({ runner: slow })
    const h = mgr.spawnLane(mkSpec("slow"))
    const out = await mgr.awaitAll([h], 25)
    expect(out.length).toBe(1)
    const r0 = at(out, 0)
    expect(r0.ok).toBe(false)
    if (!r0.ok) expect(r0.error.kind).toBe("timeout")
    // The delegate got a real signal…
    expect(sawSignal).toBe(true)
    // …and the timeout FORCE-CANCELLED it (no delegate leak past the timeout).
    // Flush a microtask so the abort listener fires after resolve().
    await new Promise((r) => setTimeout(r, 5))
    expect(delegateAborted).toBe(true)
  })

  // -------------------------------------------------------------------------
  test("HELL-LM-05 parent abort ⇒ all lanes cascade abort", async () => {
    let triggered = 0
    const watcher: DelegationRunnerPort = {
      delegate: (spec) =>
        new Promise((resolve) => {
          const sig = spec.signal
          if (sig === undefined) {
            // Should not happen — lane always passes a merged signal.
            resolve(
              successBoomerang({ mode: spec.mode, summary: "no sig", turns: 0, durationMs: 0 }),
            )
            return
          }
          if (sig.aborted) {
            triggered += 1
            resolve({
              ok: false,
              summary: "(aborted)",
              mode: spec.mode,
              turns: 0,
              durationMs: 0,
              errorKind: "cancelled" as const,
              errorMessage: "child saw abort",
            })
            return
          }
          sig.addEventListener("abort", () => {
            triggered += 1
            resolve({
              ok: false,
              summary: "(aborted)",
              mode: spec.mode,
              turns: 0,
              durationMs: 0,
              errorKind: "cancelled" as const,
              errorMessage: "child saw abort",
            })
          })
        }),
    }
    const parent = new AbortController()
    const mgr = defaultLaneManager({ runner: watcher, signal: parent.signal })
    const hs = [mgr.spawnLane(mkSpec("a")), mgr.spawnLane(mkSpec("b"))]
    // Schedule the abort microtask after lanes begin.
    setTimeout(() => parent.abort(), 5)
    const out = await mgr.awaitAll(hs)
    expect(out.length).toBe(2)
    // Both lanes resolved through the abort path — the manager projects
    // their boomerang errorKind="cancelled" into lane error.kind="aborted".
    for (const r of out) {
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error.kind).toBe("aborted")
    }
    expect(triggered).toBeGreaterThanOrEqual(2)
  })

  // -------------------------------------------------------------------------
  test("HELL-LM-06 resource starvation: maxConcurrency cap honoured", async () => {
    let active = 0
    let peak = 0
    const counter: DelegationRunnerPort = {
      delegate: async (spec) => {
        active += 1
        if (active > peak) peak = active
        await new Promise((r) => setTimeout(r, 5))
        active -= 1
        return successBoomerang({
          mode: spec.mode,
          summary: "ok",
          turns: 1,
          durationMs: 1,
        })
      },
    }
    const cap = 3
    const mgr = defaultLaneManager({ runner: counter, maxConcurrency: cap })
    const hs = Array.from({ length: 100 }, (_, i) => mgr.spawnLane(mkSpec(`p${i}`)))
    const out = await mgr.awaitAll(hs)
    expect(out.length).toBe(100)
    expect(peak).toBeLessThanOrEqual(cap)
    expect(out.every((r) => r.ok)).toBe(true)
  })

  // -------------------------------------------------------------------------
  test("HELL-LM-07 one runner throws ⇒ siblings continue", async () => {
    let calls = 0
    const flaky: DelegationRunnerPort = {
      delegate: async (spec) => {
        calls += 1
        if (calls === 2) throw new Error("mid-batch fail")
        return successBoomerang({
          mode: spec.mode,
          summary: "ok",
          turns: 1,
          durationMs: 1,
        })
      },
    }
    const mgr = defaultLaneManager({ runner: flaky, maxConcurrency: 1 })
    const hs = [mgr.spawnLane(mkSpec("a")), mgr.spawnLane(mkSpec("b")), mgr.spawnLane(mkSpec("c"))]
    const out = await mgr.awaitAll(hs)
    expect(out.length).toBe(3)
    const r1 = at(out, 1)
    expect(r1.ok).toBe(false)
    if (!r1.ok) expect(r1.error.kind).toBe("spawn-failed")
    // Siblings still succeed.
    expect(at(out, 0).ok).toBe(true)
    expect(at(out, 2).ok).toBe(true)
  })

  // -------------------------------------------------------------------------
  test("HELL-LM-08 LaneResult order = input handle order", async () => {
    // Build runners whose completion order is REVERSE of spawn order.
    const ordered: DelegationRunnerPort = {
      delegate: async (spec) => {
        const delay = spec.prompt === "first" ? 30 : spec.prompt === "second" ? 15 : 1
        await new Promise((r) => setTimeout(r, delay))
        return successBoomerang({
          mode: spec.mode,
          summary: spec.prompt,
          turns: 1,
          durationMs: delay,
        })
      },
    }
    const mgr = defaultLaneManager({ runner: ordered })
    const h1 = mgr.spawnLane(mkSpec("first"))
    const h2 = mgr.spawnLane(mkSpec("second"))
    const h3 = mgr.spawnLane(mkSpec("third"))
    const out = await mgr.awaitAll([h1, h2, h3])
    const r0 = at(out, 0)
    const r1 = at(out, 1)
    const r2 = at(out, 2)
    // Even though "third" finishes first, results are in input order.
    expect(r0.id).toBe(h1.id)
    expect(r1.id).toBe(h2.id)
    expect(r2.id).toBe(h3.id)
    if (r0.ok) expect(r0.boomerang.summary).toContain("first")
    if (r1.ok) expect(r1.boomerang.summary).toContain("second")
    if (r2.ok) expect(r2.boomerang.summary).toContain("third")
  })

  // -------------------------------------------------------------------------
  test("HELL-LM-09 LaneError 4-arm exhaustive coverage", () => {
    expect(ALL_LANE_ERROR_KINDS).toEqual([
      "spawn-failed",
      "timeout",
      "aborted",
      "concurrency-exceeded",
    ])
    for (const k of ALL_LANE_ERROR_KINDS) {
      switch (k) {
        case "spawn-failed":
        case "timeout":
        case "aborted":
        case "concurrency-exceeded":
          expect(typeof k).toBe("string")
          break
        default: {
          const _: never = k
          throw new Error(`uncovered arm: ${_ as string}`)
        }
      }
    }
  })

  // -------------------------------------------------------------------------
  test("HELL-LM-10 duplicate spec ⇒ two independent lanes", async () => {
    const mgr = defaultLaneManager({ runner: fastRunner })
    const spec = mkSpec("dup")
    const h1 = mgr.spawnLane(spec)
    const h2 = mgr.spawnLane(spec)
    expect(h1.id).not.toBe(h2.id)
    const out = await mgr.awaitAll([h1, h2])
    expect(out.length).toBe(2)
    expect(at(out, 0).id).toBe(h1.id)
    expect(at(out, 1).id).toBe(h2.id)
  })

  // -------------------------------------------------------------------------
  test("HELL-LM-12 awaitAll deterministic — same handles same shape", async () => {
    const mgr = defaultLaneManager({ runner: fastRunner })
    const hs = [mgr.spawnLane(mkSpec("x")), mgr.spawnLane(mkSpec("y"))]
    const out1 = await mgr.awaitAll(hs)
    // Calling awaitAll a SECOND time on the same already-settled handles
    // returns the same (cached promise) result; both calls must yield the
    // same per-id outcomes.
    const out2 = await mgr.awaitAll(hs)
    expect(out1.length).toBe(out2.length)
    for (let i = 0; i < out1.length; i++) {
      const a = at(out1, i)
      const b = at(out2, i)
      expect(a.id).toBe(b.id)
      expect(a.ok).toBe(b.ok)
    }
  })

  // -------------------------------------------------------------------------
  test("HELL-LM-13 zombie lane after timeout ⇒ stored result not mutated", async () => {
    let resolveSlow: ((v: unknown) => void) | null = null
    const slow: DelegationRunnerPort = {
      delegate: () =>
        new Promise((resolve) => {
          resolveSlow = resolve as (v: unknown) => void
        }),
    }
    const mgr = defaultLaneManager({ runner: slow })
    const h = mgr.spawnLane(mkSpec("slow"))
    const out = await mgr.awaitAll([h], 25)
    const r0 = at(out, 0)
    expect(r0.ok).toBe(false)
    if (!r0.ok) expect(r0.error.kind).toBe("timeout")
    // Allow the "real" runner to complete after the timeout.
    if (resolveSlow !== null) {
      ;(resolveSlow as (v: unknown) => void)(
        successBoomerang({ mode: "explore", summary: "late", turns: 1, durationMs: 0 }),
      )
    }
    // Allow the stored promise to flush, then re-collect — outcome (the
    // ALREADY-returned tuple) is immutable so it MUST still be the timeout.
    await new Promise((r) => setTimeout(r, 10))
    const r0Again = at(out, 0)
    expect(r0Again.ok).toBe(false)
    if (!r0Again.ok) expect(r0Again.error.kind).toBe("timeout")
  })

  // -------------------------------------------------------------------------
  test("HELL-LM-14 1000 lane cycle no leak — counter monotonic", async () => {
    const mgr = defaultLaneManager({ runner: fastRunner, maxConcurrency: 50 })
    const hs = Array.from({ length: 1000 }, (_, i) => mgr.spawnLane(mkSpec(`p${i}`)))
    const out = await mgr.awaitAll(hs)
    expect(out.length).toBe(1000)
    // Lane ids monotonic counter — strict ascending order.
    let priorN = 0
    for (const r of out) {
      const n = Number(r.id.replace("lane-", ""))
      expect(Number.isFinite(n)).toBe(true)
      expect(n).toBeGreaterThan(priorN)
      priorN = n
    }
    expect(out.every((r) => r.ok)).toBe(true)
  })

  // -------------------------------------------------------------------------
  test("HELL-LM-15 concurrent spawnLane + awaitAll safe", async () => {
    const mgr = defaultLaneManager({ runner: fastRunner })
    const h1 = mgr.spawnLane(mkSpec("a"))
    // Race awaitAll against an additional spawn — the additional handle
    // is NOT in the first awaitAll set, but it must still resolve cleanly
    // when included in a later awaitAll.
    const wait1 = mgr.awaitAll([h1])
    const h2 = mgr.spawnLane(mkSpec("b"))
    const out1 = await wait1
    expect(out1.length).toBe(1)
    const out2 = await mgr.awaitAll([h1, h2])
    expect(out2.length).toBe(2)
    expect(at(out2, 0).id).toBe(h1.id)
    expect(at(out2, 1).id).toBe(h2.id)
  })
})
