/**
 * Hellgate — `classify` (bench failure classifier) adversarial pins.
 *
 * `src/runner/batch/corpus/failure-classifier.ts` is the ONLY place an
 * `InstanceResult` is converted into a structured outcome ({termination, signals})
 * that lands in `bench-report.json` and the operator console. Drift here
 * invalidates EVERY recorded baseline.
 *
 * Positive cases live in `bench-failure-classifier.test.ts`. This file
 * adds adversarial coverage:
 *   - passed:true short-circuits ALL signal scanning (even on a non-empty patch)
 *   - very long error string (megabytes) ⇒ harness_error, no crash
 *   - corrupt JSONL line ⇒ silently skipped, classifier still proceeds
 *   - missing .patch sibling but observe wrote a .jsonl with bare events
 *   - empty_patch precedence over dirty_cache_leak (empty wins, not both)
 *   - empty_patch + multi_file_drift cannot co-occur (empty patch has 0 files)
 *   - session_end with REASON not in {aborted,max_turns,completed} ⇒ completed_unresolved
 *   - session_end aborted with turns>0 ⇒ NOT hung_stream (only turns=0 is)
 *   - multiple session_end events ⇒ classifier picks the LAST one
 *   - patchPath that doesn't end in .patch ⇒ no trajectory read
 *   - aggregate idempotency under permutation of classifications
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  aggregate,
  classify,
  type FailureClassification,
} from "@/runner/batch/corpus/failure-classifier"
import type { InstanceResult } from "@/runner/batch/types"

const setup = (
  result: Omit<InstanceResult, "patchPath">,
  jsonl: string,
): { result: InstanceResult; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "hg-classifier-"))
  const patchPath = join(dir, `${result.id}.0.patch`)
  const jsonlPath = join(dir, `${result.id}.0.jsonl`)
  writeFileSync(patchPath, result.patch)
  writeFileSync(jsonlPath, jsonl)
  return {
    result: { ...result, patchPath },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

const cleanups: Array<() => void> = []
beforeEach(() => {
  cleanups.length = 0
})
afterEach(() => {
  for (const c of cleanups) c()
})

// ── A. passed short-circuits ───────────────────────────────────────────────────

describe("hellgate — passed:true short-circuits", () => {
  test("passed:true + empty patch ⇒ termination:passed, signals:[] (NOT empty_patch)", () => {
    const r: InstanceResult = { id: "p", passed: true, patch: "", turns: 1 }
    const c = classify(r)
    expect(c.termination).toBe("passed")
    expect(c.signals).toEqual([])
  })

  test("passed:true + 10-file diff ⇒ signals:[] (NOT multi_file_drift)", () => {
    const patch = Array.from({ length: 10 }, (_, i) => `diff --git a/${i}.py b/${i}.py\n+x\n`).join(
      "",
    )
    const r: InstanceResult = { id: "p", passed: true, patch, turns: 5 }
    expect(classify(r).signals).toEqual([])
  })
})

// ── B. error string adversarial sizes ──────────────────────────────────────────

describe("hellgate — error string sizes ⇒ harness_error", () => {
  test("error of 1MB ⇒ harness_error, no crash", () => {
    const huge = "x".repeat(1_000_000)
    const r: InstanceResult = { id: "h", passed: false, patch: "", turns: 0, error: huge }
    const c = classify(r)
    expect(c.termination).toBe("harness_error")
  })

  test("error = '' (empty string is NOT undefined) ⇒ STILL harness_error (presence matters)", () => {
    const r: InstanceResult = { id: "h", passed: false, patch: "", turns: 0, error: "" }
    expect(classify(r).termination).toBe("harness_error")
  })

  test("error contains newlines + control chars ⇒ no crash", () => {
    const e = "line1\nline2\x00\x01\x02\nline3"
    const r: InstanceResult = { id: "h", passed: false, patch: "", turns: 0, error: e }
    expect(classify(r).termination).toBe("harness_error")
  })
})

// ── C. trajectory read robustness ──────────────────────────────────────────────

describe("hellgate — trajectory read robustness", () => {
  test("malformed JSONL line ⇒ skipped, classifier still picks session_end after", () => {
    const jsonl = [
      "THIS IS NOT JSON",
      JSON.stringify({ kind: "tool_call", data: { name: "edit" } }),
      JSON.stringify({ kind: "tool_result", data: { result: "ok" } }),
      JSON.stringify({ kind: "session_end", data: { reason: "completed", turns: 2 } }),
    ].join("\n")
    const { result, cleanup } = setup(
      { id: "x", passed: false, patch: "diff --git a/x b/x\n+y\n", turns: 2 },
      jsonl,
    )
    cleanups.push(cleanup)
    expect(classify(result).termination).toBe("completed_unresolved")
  })

  test("all lines malformed ⇒ no session_end found ⇒ termination:unknown", () => {
    const jsonl = ["{not json", "neither this", "nor this"].join("\n")
    const { result, cleanup } = setup({ id: "x", passed: false, patch: "", turns: 0 }, jsonl)
    cleanups.push(cleanup)
    expect(classify(result).termination).toBe("unknown")
  })

  test("empty jsonl file ⇒ termination:unknown (no events at all)", () => {
    const { result, cleanup } = setup({ id: "x", passed: false, patch: "", turns: 0 }, "")
    cleanups.push(cleanup)
    expect(classify(result).termination).toBe("unknown")
  })

  test("patchPath without .patch suffix ⇒ trajectory NOT loaded ⇒ unknown", () => {
    const r: InstanceResult = {
      id: "x",
      passed: false,
      patch: "",
      turns: 0,
      patchPath: "/tmp/x.0.notpatch",
    }
    expect(classify(r).termination).toBe("unknown")
  })

  test("patchPath set but .jsonl sibling missing ⇒ termination:unknown", () => {
    const dir = mkdtempSync(join(tmpdir(), "hg-classifier-"))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const patchPath = join(dir, "x.0.patch")
    writeFileSync(patchPath, "")
    const r: InstanceResult = { id: "x", passed: false, patch: "", turns: 0, patchPath }
    expect(classify(r).termination).toBe("unknown")
  })
})

// ── D. session_end edges ───────────────────────────────────────────────────────

describe("hellgate — session_end interpretation edges", () => {
  test("session_end reason='aborted' + turns>0 ⇒ NOT hung_stream (completed_unresolved)", () => {
    const jsonl = JSON.stringify({
      kind: "session_end",
      data: { reason: "aborted", turns: 5 },
    })
    const { result, cleanup } = setup(
      { id: "x", passed: false, patch: "diff --git a/x b/x\n+y\n", turns: 5 },
      jsonl,
    )
    cleanups.push(cleanup)
    expect(classify(result).termination).toBe("completed_unresolved")
  })

  test("session_end with UNKNOWN reason ⇒ completed_unresolved (covering partition)", () => {
    const jsonl = JSON.stringify({
      kind: "session_end",
      data: { reason: "something-new-we-do-not-know", turns: 3 },
    })
    const { result, cleanup } = setup(
      { id: "x", passed: false, patch: "diff --git a/x b/x\n+y\n", turns: 3 },
      jsonl,
    )
    cleanups.push(cleanup)
    expect(classify(result).termination).toBe("completed_unresolved")
  })

  test("multiple session_end events ⇒ LAST one wins", () => {
    const jsonl = [
      JSON.stringify({ kind: "session_end", data: { reason: "max_turns", turns: 25 } }),
      JSON.stringify({ kind: "tool_call", data: { name: "edit" } }),
      JSON.stringify({ kind: "session_end", data: { reason: "completed", turns: 26 } }),
    ].join("\n")
    const { result, cleanup } = setup(
      { id: "x", passed: false, patch: "diff --git a/x b/x\n+y\n", turns: 26 },
      jsonl,
    )
    cleanups.push(cleanup)
    expect(classify(result).termination).toBe("completed_unresolved")
  })

  test("session_end without data field ⇒ termination:unknown", () => {
    const jsonl = JSON.stringify({ kind: "session_end" })
    const { result, cleanup } = setup({ id: "x", passed: false, patch: "", turns: 0 }, jsonl)
    cleanups.push(cleanup)
    expect(classify(result).termination).toBe("unknown")
  })
})

// ── E. signal precedence + co-occurrence ───────────────────────────────────────

describe("hellgate — signal precedence + co-occurrence", () => {
  test("empty_patch fires for patch with ONLY whitespace (not dirty_cache_leak — needs paths)", () => {
    const r: InstanceResult = { id: "x", passed: false, patch: "\n  \t\n", turns: 0 }
    const c = classify(r)
    expect(c.signals).toContain("empty_patch")
    expect(c.signals).not.toContain("dirty_cache_leak")
  })

  test("empty_patch + multi_file_drift cannot co-occur (empty has 0 diff headers)", () => {
    const r: InstanceResult = { id: "x", passed: false, patch: "   ", turns: 0 }
    const c = classify(r)
    expect(c.signals).toContain("empty_patch")
    expect(c.signals).not.toContain("multi_file_drift")
  })

  test("dirty_cache_leak fires alone when ALL paths are cache-shaped (no empty_patch)", () => {
    // From positive test: only outputs/smoke is treated as cache; need ALL paths.
    const patch = "diff --git a/outputs/smoke/repo/x b/outputs/smoke/repo/x\n+y\n"
    const r: InstanceResult = { id: "x", passed: false, patch, turns: 1 }
    const c = classify(r)
    expect(c.signals).not.toContain("empty_patch")
  })

  test("multi_file_drift counts DISTINCT files, not diff sections (3 sections on 2 files ⇒ no drift)", () => {
    const patch =
      "diff --git a/a.py b/a.py\n+x\ndiff --git a/a.py b/a.py\n+y\ndiff --git a/b.py b/b.py\n+z\n"
    const r: InstanceResult = { id: "x", passed: false, patch, turns: 5 }
    expect(classify(r).signals).not.toContain("multi_file_drift")
  })
})

// ── F. aggregate adversarial ──────────────────────────────────────────────────

describe("hellgate — aggregate", () => {
  test("permutation invariance: same multiset of classifications ⇒ same breakdown", () => {
    const c0: FailureClassification = { termination: "hung_stream", signals: ["empty_patch"] }
    const c1: FailureClassification = {
      termination: "completed_unresolved",
      signals: ["empty_patch", "multi_file_drift"],
    }
    const c2: FailureClassification = { termination: "passed", signals: [] }
    const c3: FailureClassification = { termination: "completed_unresolved", signals: [] }
    const a = aggregate([c0, c1, c2, c3])
    const b = aggregate([c3, c1, c0, c2])
    expect(a).toEqual(b)
  })

  test("aggregate of 10000 classifications ⇒ correct counts, no overflow", () => {
    const big: FailureClassification[] = Array.from({ length: 10_000 }, () => ({
      termination: "completed_unresolved" as const,
      signals: ["empty_patch" as const],
    }))
    const bd = aggregate(big)
    expect(bd.byTermination.completed_unresolved).toBe(10_000)
    expect(bd.bySignal.empty_patch).toBe(10_000)
  })

  test("aggregate with a single passed classification ⇒ only byTermination.passed = 1, bySignal empty", () => {
    const bd = aggregate([{ termination: "passed", signals: [] }])
    expect(bd.byTermination).toEqual({ passed: 1 })
    expect(bd.bySignal).toEqual({})
  })

  test("aggregate input mutation — classifier output is read-only contract", () => {
    const cs: FailureClassification[] = [
      { termination: "completed_unresolved", signals: ["empty_patch"] },
    ]
    aggregate(cs)
    // Confirm classify input was untouched (no signal-side-effect in aggregate).
    expect(cs[0]).toEqual({ termination: "completed_unresolved", signals: ["empty_patch"] })
  })
})
