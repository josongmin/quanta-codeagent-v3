/**
 * jul-02 Best@K-vs-Pass@K offline analyzer — leaf unit (fully injected: fs + backend,
 * so NO docker / harness / network / build). Proves:
 *
 *   - scanCandidatePool: instanceId from the DIR (not the filename), {round,index}
 *     from the filename; `candidates.jsonl` ignored; fail-loud on a bad filename.
 *   - buildSlotPredictions: one row per instance per slot, REAL instance_id only
 *     (no synthetic `<id>::rNiM`), patch body read from disk.
 *   - aggregateBestKPassK: per-instance ANY-slot-resolved OR (not per-slot), bestK =
 *     submitted∩pool, gap = passK − bestK, fail-loud when a submitted winner in the
 *     pool never re-grades resolved.
 *   - runBestKPassKGrade: SERIAL (never concurrent) backend.grade with max_workers:1.
 *
 * RED-on-injection batteries: a malformed filename throws; a Promise.all regression is
 * caught by an in-flight overlap flag; max_workers≠1 assertion has teeth.
 */

import { describe, expect, test } from "bun:test"
import {
  aggregateBestKPassK,
  buildSlotPredictions,
  type CandidatePoolFs,
  type Prediction,
  parseCandFilename,
  runBestKPassKGrade,
  type SlotKey,
  scanCandidatePool,
} from "@/apps/bench/analyze/bestk-passk-grade"
import type { GradeBackend, GradeOptions, GradeOutcome } from "@/apps/bench/remote/backend"
import { buildReport } from "@/runner/batch/report"
import type { InstanceResult } from "@/runner/batch/types"

describe("bestKPassKGap is OBSERVE-ONLY — live report byte-identical (default-OFF)", () => {
  const meta = { model: "m", provider: "p", n: 1, timestamp: "t" }
  const base: InstanceResult = { id: "a", passed: true, patch: "x", turns: 1 }

  test("buildReport NEVER sets bestKPassKGap (the live/submission path is unchanged)", () => {
    const report = buildReport(meta, [base])
    // The field exists on the type (offline analyzer fills it) but the live batch
    // path must never populate it — absent ⇒ not serialized ⇒ byte-identical.
    expect("bestKPassKGap" in report).toBe(false)
    const json = JSON.stringify(report)
    expect(json.includes("bestKPassKGap")).toBe(false)
  })

  test("RED-on-injection: a report WITH the field would serialize it (guard has teeth)", () => {
    // Prove the golden above is not vacuous — if a writer ever set the field, it
    // WOULD appear in the JSON (so the `in`/`includes` assertions actually bite).
    const injected = {
      ...buildReport(meta, [base]),
      bestKPassKGap: { k: 1, passK: 1, bestK: 0, gap: 1 },
    }
    expect(JSON.stringify(injected).includes("bestKPassKGap")).toBe(true)
  })
})

/** In-memory fs over a { dir -> [names] } + { path -> text } map. Fail-loud on absence. */
const makeFs = (
  dirs: Record<string, string[]>,
  files: Record<string, string>,
): CandidatePoolFs => ({
  listDir: (dir) => {
    const key = dir.replace(/\/+$/, "")
    const entry = dirs[key]
    if (entry === undefined) throw new Error(`ENOENT listDir ${key}`)
    return entry
  },
  readText: (path) => {
    const t = files[path]
    if (t === undefined) throw new Error(`ENOENT readText ${path}`)
    return t
  },
})

describe("parseCandFilename", () => {
  test("extracts {round,index} from the producer format", () => {
    expect(parseCandFilename("cand-r0-i0.patch")).toEqual({ round: 0, index: 0 })
    expect(parseCandFilename("cand-r3-i12.patch")).toEqual({ round: 3, index: 12 })
  })

  test("fail-loud: a non-matching basename throws (no silent skip)", () => {
    expect(() => parseCandFilename("candidates.jsonl")).toThrow(/does not match/)
    expect(() => parseCandFilename("cand-r1.patch")).toThrow()
    expect(() => parseCandFilename("cand-rX-i0.patch")).toThrow()
  })
})

describe("scanCandidatePool", () => {
  const observeRoot = "/obs"
  const dirs: Record<string, string[]> = {
    "/obs/repair-candidates": ["django__django-1", "sympy__sympy-2"],
    "/obs/repair-candidates/django__django-1": [
      "candidates.jsonl",
      "cand-r0-i0.patch",
      "cand-r1-i0.patch",
      "cand-r1-i1.patch",
    ],
    "/obs/repair-candidates/sympy__sympy-2": ["cand-r0-i0.patch"],
  }
  const fs = makeFs(dirs, {})

  test("instanceId comes from the DIR, {round,index} from the filename", () => {
    const pool = scanCandidatePool(observeRoot, fs)
    expect([...pool.keys()].sort()).toEqual(["django__django-1", "sympy__sympy-2"])
    const dj = pool.get("django__django-1")
    expect(dj).toBeDefined()
    // candidates.jsonl is ignored; 3 patches parsed.
    expect(dj?.length).toBe(3)
    expect(dj?.map((c) => `r${c.round}i${c.index}`).sort()).toEqual(["r0i0", "r1i0", "r1i1"])
    // patchPath is under the instance dir (id embedded in DIR, not re-derived).
    for (const c of dj ?? []) {
      expect(c.patchPath.startsWith("/obs/repair-candidates/django__django-1/")).toBe(true)
    }
  })

  test("fail-loud: a bad candidate filename in a pool dir throws", () => {
    const bad = makeFs(
      {
        "/obs/repair-candidates": ["x-1"],
        "/obs/repair-candidates/x-1": ["cand-BROKEN.patch"],
      },
      {},
    )
    expect(() => scanCandidatePool(observeRoot, bad)).toThrow(/does not match/)
  })

  test("fail-loud: a missing observe root throws (not empty pool)", () => {
    expect(() => scanCandidatePool("/nope", makeFs({}, {}))).toThrow(/ENOENT/)
  })
})

describe("buildSlotPredictions", () => {
  const pool = new Map([
    [
      "django__django-1",
      [
        { round: 0, index: 0, patchPath: "/p/dj-r0i0" },
        { round: 1, index: 0, patchPath: "/p/dj-r1i0" },
      ],
    ],
    ["sympy__sympy-2", [{ round: 0, index: 0, patchPath: "/p/sy-r0i0" }]],
  ])
  const files = {
    "/p/dj-r0i0": "DIFF-DJ-R0I0",
    "/p/dj-r1i0": "DIFF-DJ-R1I0",
    "/p/sy-r0i0": "DIFF-SY-R0I0",
  }
  const fs = makeFs({}, files)

  test("one row per instance per slot, REAL instance_id only, patch body from disk", () => {
    const slots = buildSlotPredictions(pool, "gpt-x", fs)
    // slots ascending (round,index): r0i0 (2 instances), r1i0 (1 instance).
    expect(slots.map((s) => `r${s.slot.round}i${s.slot.index}`)).toEqual(["r0i0", "r1i0"])
    const r0 = slots[0]
    expect(r0?.predictions.map((p) => p.instance_id).sort()).toEqual([
      "django__django-1",
      "sympy__sympy-2",
    ])
    // NARROWING: no synthetic id — real ids never contain "::".
    for (const s of slots) {
      for (const p of s.predictions) {
        expect(p.instance_id.includes("::")).toBe(false)
        expect(p.model_name_or_path).toBe("gpt-x")
      }
    }
    // Patch body read from the candidate's own file.
    const dj = r0?.predictions.find((p) => p.instance_id === "django__django-1")
    expect(dj?.model_patch).toBe("DIFF-DJ-R0I0")
  })
})

describe("aggregateBestKPassK", () => {
  const pool = new Map([
    ["a", [{ round: 0, index: 0, patchPath: "/a0" }]],
    [
      "b",
      [
        { round: 0, index: 0, patchPath: "/b0" },
        { round: 1, index: 0, patchPath: "/b1" },
      ],
    ],
    ["c", [{ round: 0, index: 0, patchPath: "/c0" }]],
  ])
  const outcome = (resolved: string[]): GradeOutcome => ({
    reportPath: "/r",
    resolved,
    unresolved: [],
    errored: [],
    emptyPatch: [],
  })

  test("per-instance ANY-slot OR: b resolved only in slot r1 still counts", () => {
    const perSlot = [
      outcome(["a"]), // slot r0: a resolved
      outcome(["b"]), // slot r1: b resolved (b did NOT resolve in r0)
    ]
    // submitted (=report.resolved_ids): only a was the winning submission.
    const res = aggregateBestKPassK(pool, perSlot, ["a"])
    expect(res.k).toBe(3)
    expect(res.passK).toBe(2) // a + b
    expect(res.bestK).toBe(1) // a
    expect(res.gap).toBe(1)
    expect(res.missedWinners).toEqual(["b"]) // b is the missed winner
  })

  test("submitted id outside the pool is ignored in bestK", () => {
    const res = aggregateBestKPassK(pool, [outcome(["a"])], ["a", "not-pooled"])
    expect(res.bestK).toBe(1)
  })

  test("fail-loud: submitted winner in pool that never re-grades resolved throws", () => {
    // 'c' is submitted-resolved AND pooled, but no slot outcome resolves it.
    expect(() => aggregateBestKPassK(pool, [outcome(["a"])], ["a", "c"])).toThrow(
      /disagrees with the live submission/,
    )
  })
})

describe("runBestKPassKGrade — SERIAL contract + max_workers:1", () => {
  const observeRoot = "/obs"
  const dirs: Record<string, string[]> = {
    "/obs/repair-candidates": ["a", "b"],
    "/obs/repair-candidates/a": ["cand-r0-i0.patch"],
    "/obs/repair-candidates/b": ["cand-r0-i0.patch", "cand-r1-i0.patch"],
  }
  const files: Record<string, string> = {
    "/obs/repair-candidates/a/cand-r0-i0.patch": "PATCH-A-R0I0",
    "/obs/repair-candidates/b/cand-r0-i0.patch": "PATCH-B-R0I0",
    "/obs/repair-candidates/b/cand-r1-i0.patch": "PATCH-B-R1I0",
  }
  const fs = makeFs(dirs, files)

  /** Backend that (a) records maxWorkers per call, (b) flags concurrent invocation. */
  const makeSerialBackend = (
    onCall: (opts: GradeOptions) => GradeOutcome,
  ): { backend: GradeBackend; sawConcurrent: () => boolean; calls: () => number } => {
    let inFlight = 0
    let concurrent = false
    let n = 0
    const backend: GradeBackend = {
      name: "fake",
      grade: async (_pred, opts) => {
        n += 1
        inFlight += 1
        if (inFlight > 1) concurrent = true
        // Yield the event loop so a Promise.all regression WOULD overlap here.
        await new Promise((r) => setTimeout(r, 1))
        inFlight -= 1
        return onCall(opts)
      },
    }
    return { backend, sawConcurrent: () => concurrent, calls: () => n }
  }

  test("grades slots SERIALLY with max_workers:1 and aggregates", async () => {
    const seenMaxWorkers: Array<number | undefined> = []
    const { backend, sawConcurrent, calls } = makeSerialBackend((opts) => {
      seenMaxWorkers.push(opts.maxWorkers)
      // slot r0 resolves a; slot r1 resolves b.
      return {
        reportPath: "/r",
        resolved: opts.runId === "bestk-r0i0" ? ["a"] : opts.runId === "bestk-r1i0" ? ["b"] : [],
        unresolved: [],
        errored: [],
        emptyPatch: [],
      }
    })
    const written: Array<{ rows: readonly Prediction[]; slot: SlotKey }> = []
    const res = await runBestKPassKGrade(
      {
        observeRoot,
        datasetPath: "/ds.jsonl",
        modelName: "gpt-x",
        submittedResolvedIds: ["a"],
      },
      {
        fs,
        writePredictions: async (rows, slot) => {
          written.push({ rows, slot })
          return `/tmp/preds-r${slot.round}i${slot.index}.jsonl`
        },
        backend,
      },
    )
    // Two slots (r0i0 across a+b, r1i0 for b only) ⇒ two SERIAL grade calls.
    expect(calls()).toBe(2)
    expect(sawConcurrent()).toBe(false) // NEVER concurrent (red-on-injection: Promise.all trips this)
    // max_workers MUST be 1 on every call (backend default is 4 — false-neg risk).
    expect(seenMaxWorkers).toEqual([1, 1])
    // Ceiling: passK = {a,b}=2, bestK={a}=1, gap=1.
    expect(res.passK).toBe(2)
    expect(res.bestK).toBe(1)
    expect(res.gap).toBe(1)
    expect(res.missedWinners).toEqual(["b"])
  })
})
