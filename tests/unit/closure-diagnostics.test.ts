/**
 * T-101 — closure diagnostic rail (offline sidecar).
 *
 * Hellgate teeth: the metric compute is a PURE function over (run facts, eval
 * oracle). The oracle is eval-only and must never touch runtime routing — this
 * test exercises the compute layer in isolation with in-memory fixtures, so a
 * regression that (a) miscounts owner recall, (b) conflates #9296 no-patch
 * exhaustion with model-miss, (c) silently invents a value for a not-yet-
 * instrumented gate metric, or (d) crashes on empty input — all go RED.
 */
import { describe, expect, test } from "bun:test"
import {
  type ClosureOracle,
  type ClosureRunFact,
  computeClosureDiagnostics,
} from "@/runner/batch/eval/closure-diagnostics"

const oracle = (id: string, goldFiles: string[], failToPass: string[] = ["t"]): ClosureOracle => ({
  instanceId: id,
  goldFiles,
  failToPass,
})

/** Minimal fact with the defaults of an un-instrumented run (gate fields absent). */
const fact = (over: Partial<ClosureRunFact> & { instanceId: string }): ClosureRunFact => ({
  resolved: null,
  patchFiles: [],
  strayFiles: [],
  emptyPatch: false,
  endReason: null,
  ...over,
})

describe("computeClosureDiagnostics", () => {
  const oracleMap = new Map<string, ClosureOracle>([
    ["resolved-1", oracle("resolved-1", ["pkg/a.py"])],
    ["miss-owner", oracle("miss-owner", ["pkg/right.py"])],
    ["miss-multi", oracle("miss-multi", ["pkg/base.py", "pkg/pg.py"])],
    ["nopatch-9296", oracle("nopatch-9296", ["pkg/paginator.py"])],
    ["stray-1", oracle("stray-1", ["pkg/r.py"])],
  ])

  const facts: ClosureRunFact[] = [
    // resolved, first+only edited file is the gold owner
    fact({
      instanceId: "resolved-1",
      resolved: true,
      patchFiles: ["pkg/a.py"],
      firstEditFile: "pkg/a.py",
    }),
    // model-miss: edited the WRONG file (owner miss) — non-empty patch, resolved=false
    fact({
      instanceId: "miss-owner",
      resolved: false,
      patchFiles: ["pkg/wrong.py"],
      firstEditFile: "pkg/wrong.py",
    }),
    // model-miss multi-site: got ONE of two gold owners (recall@1 hit via first file, but unresolved)
    fact({
      instanceId: "miss-multi",
      resolved: false,
      patchFiles: ["pkg/base.py"],
      firstEditFile: "pkg/base.py",
    }),
    // #9296 class: empty patch + max_turns → no_patch_exhausted, NOT model_miss
    fact({
      instanceId: "nopatch-9296",
      resolved: false,
      patchFiles: [],
      emptyPatch: true,
      endReason: "max_turns",
    }),
    // resolved-ish but with a stray file polluting the diff
    fact({
      instanceId: "stray-1",
      resolved: true,
      patchFiles: ["pkg/r.py"],
      strayFiles: ["test.html.Z"],
      firstEditFile: "pkg/r.py",
    }),
  ]

  const d = computeClosureDiagnostics(facts, oracleMap)

  test("total counts every fact", () => {
    expect(d.total).toBe(5)
  })

  test("classifies #9296 no-patch-exhaustion separately from model-miss", () => {
    const cls = Object.fromEntries(d.perInstance.map((p) => [p.instanceId, p.class]))
    expect(cls["nopatch-9296"]).toBe("no_patch_exhausted")
    expect(cls["miss-owner"]).toBe("model_miss")
    expect(cls["resolved-1"]).toBe("resolved")
  })

  test("no_patch_exhausted_rate = 1/5", () => {
    expect(d.metrics.no_patch_exhausted_rate.available).toBe(true)
    expect(d.metrics.no_patch_exhausted_rate.value).toBeCloseTo(1 / 5)
  })

  test("budget_exhausted empty patch is also classified as no_patch_exhausted", () => {
    const exhausted = computeClosureDiagnostics(
      [
        fact({
          instanceId: "budget-nopatch",
          resolved: false,
          patchFiles: [],
          emptyPatch: true,
          endReason: "budget_exhausted",
        }),
      ],
      new Map(),
    )
    expect(exhausted.perInstance[0]?.class).toBe("no_patch_exhausted")
    expect(exhausted.metrics.no_patch_exhausted_rate.value).toBeCloseTo(1)
  })

  test("owner_recall@1 counts first-edited-file == gold owner (over patch-bearing+oracle)", () => {
    // patch-bearing with oracle: resolved-1(hit), miss-owner(miss), miss-multi(hit base.py), stray-1(hit) = 3/4
    expect(d.metrics["owner_recall@1"].n).toBe(4)
    expect(d.metrics["owner_recall@1"].value).toBeCloseTo(3 / 4)
  })

  test("first_edit_owner_match uses the first mutating edit, not the final diff", () => {
    // firstEditFile present on 4 patch-bearing; matches gold on resolved-1, miss-multi, stray-1 = 3/4
    expect(d.metrics.first_edit_owner_match.available).toBe(true)
    expect(d.metrics.first_edit_owner_match.value).toBeCloseTo(3 / 4)
  })

  test("stray_file_rate = 1/4 over patch-bearing runs", () => {
    expect(d.metrics.stray_file_rate.value).toBeCloseTo(1 / 4)
  })

  test("not-yet-instrumented gate metrics degrade to unavailable (value null), never invented", () => {
    for (const k of [
      "gate_enter_rate",
      "gate_bypass_rate",
      "verify_rounds_per_run",
      "synth_repro_base_red_rate",
      "primary_false_green_rate",
      "primary_rail_present_rate",
    ]) {
      expect(d.metrics[k]?.available).toBe(false)
      expect(d.metrics[k]?.value).toBeNull()
    }
  })

  test("empty input degrades cleanly to metrics-unavailable, not crash", () => {
    const empty = computeClosureDiagnostics([], new Map())
    expect(empty.total).toBe(0)
    expect(empty.metrics.no_patch_exhausted_rate.available).toBe(false)
    expect(empty.metrics["owner_recall@1"].available).toBe(false)
    expect(empty.perInstance).toEqual([])
  })

  test("strict admission block is tracked separately from no_patch/model_miss", () => {
    const blocked = computeClosureDiagnostics(
      [
        fact({
          instanceId: "strict-block",
          resolved: false,
          patchFiles: [],
          emptyPatch: true,
          endReason: "admission_blocked",
        }),
      ],
      new Map(),
    )
    expect(blocked.perInstance[0]?.class).toBe("admission_blocked")
    expect(blocked.metrics.admission_blocked_rate.available).toBe(true)
    expect(blocked.metrics.admission_blocked_rate.value).toBeCloseTo(1)
  })

  test("gate metrics become available once instrumented (forward-compat)", () => {
    const instrumented = computeClosureDiagnostics(
      [
        fact({
          instanceId: "resolved-1",
          resolved: true,
          patchFiles: ["pkg/a.py"],
          gateEntered: true,
          gateBypassed: false,
          verifyRounds: 2,
        }),
      ],
      oracleMap,
    )
    expect(instrumented.metrics.gate_enter_rate.available).toBe(true)
    expect(instrumented.metrics.gate_enter_rate.value).toBeCloseTo(1)
    expect(instrumented.metrics.verify_rounds_per_run.value).toBeCloseTo(2)
  })

  describe("F6 exploration-efficiency", () => {
    test("edit_count_per_run / turns_to_first_edit are raw means (no thresholds)", () => {
      const d6 = computeClosureDiagnostics(
        [
          fact({ instanceId: "a", patchFiles: ["pkg/a.py"], editCount: 6, turnsToFirstEdit: 12 }),
          fact({ instanceId: "b", patchFiles: ["pkg/b.py"], editCount: 2, turnsToFirstEdit: 4 }),
        ],
        new Map(),
      )
      expect(d6.metrics.edit_count_per_run.value).toBeCloseTo(4) // (6+2)/2
      expect(d6.metrics.turns_to_first_edit.value).toBeCloseTo(8) // (12+4)/2
    })

    test("repro_red_but_unresolved_rate: among reproduced repros, the unresolved fraction", () => {
      const d6 = computeClosureDiagnostics(
        [
          // had a base-RED repro, still missed → contributes 1 (the #10914 signal)
          fact({
            instanceId: "miss",
            resolved: false,
            patchFiles: ["x.py"],
            reproReproduced: true,
          }),
          // had a repro and resolved → contributes 0
          fact({ instanceId: "win", resolved: true, patchFiles: ["y.py"], reproReproduced: true }),
          // no repro → excluded from the denominator entirely
          fact({
            instanceId: "norepro",
            resolved: false,
            patchFiles: ["z.py"],
            reproReproduced: null,
          }),
        ],
        new Map(),
      )
      expect(d6.metrics.repro_red_but_unresolved_rate.n).toBe(2)
      expect(d6.metrics.repro_red_but_unresolved_rate.value).toBeCloseTo(1 / 2)
    })

    test("F6 metrics unavailable when uninstrumented (null, never invented)", () => {
      const d6 = computeClosureDiagnostics(
        [fact({ instanceId: "a", patchFiles: ["x.py"] })],
        new Map(),
      )
      expect(d6.metrics.edit_count_per_run.available).toBe(false)
      expect(d6.metrics.turns_to_first_edit.available).toBe(false)
      expect(d6.metrics.repro_red_but_unresolved_rate.available).toBe(false)
    })
  })
})
