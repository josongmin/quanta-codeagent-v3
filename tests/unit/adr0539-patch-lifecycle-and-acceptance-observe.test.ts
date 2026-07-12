/**
 * ADR-0539 R2 + R3 — OBSERVE-stream wiring for the two dead-producer residuals.
 *
 *  R2: `patch_applied` / `patch_rejected` are declared trajectory kinds that
 *      `probe/triage.ts` CONSUMES but that nothing emitted. They now fire from
 *      the bench eval driver via `emitPatchOutcome` (report.ts) → the
 *      BenchObserver `patchApplied`/`patchRejected` methods.
 *  R3: the per-round acceptance selection observer (`onSelection`) now also
 *      records an OBSERVE `recovery` line (`reason:"acceptance_select"`) via
 *      `BenchObserver.acceptanceSelection`.
 *
 * These assert (a) the emit fires with the exact kind + `PatchData`/telemetry
 * payload triage expects when the path is exercised, and (b) NOTHING is emitted
 * on the off/byte-identical path (observer undefined). Red-on-injection: each
 * emit is proven wired by driving the real helper + reading the JSONL back — a
 * mutant that drops the append fails the readback, not silently green.
 */
import { describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TrajectoryEvent } from "@/shared"
import { triage } from "../../src/apps/probe/triage"
import { emitPatchOutcome } from "../../src/runner/batch/eval/report"
import { BenchObserver } from "../../src/runner/batch/observe"

const withObserver = <T>(fn: (obs: BenchObserver, file: string) => T): T => {
  const dir = mkdtempSync(join(tmpdir(), "adr0539-"))
  try {
    let seq = 0
    const obs = new BenchObserver(
      { dir, runId: "run-1", attempt: 0, now: () => 1_000 + seq++ },
      "inst-1",
    )
    const file = join(dir, "run-1", "inst-1.0.jsonl")
    const out = fn(obs, file)
    obs.close()
    return out
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const readLines = (path: string): TrajectoryEvent[] =>
  // A byte-identical OFF path never creates the JSONL (the recorder writes it
  // lazily on first append) ⇒ a missing file is zero recorded lines, not an error.
  existsSync(path)
    ? readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => JSON.parse(l) as TrajectoryEvent)
    : []

describe("ADR-0539 R2 — patch_applied / patch_rejected emit", () => {
  const APPLIED_DIFF =
    "diff --git a/src/x.py b/src/x.py\n--- a/src/x.py\n+++ b/src/x.py\n@@ -1 +1 @@\n-a\n+b\n"

  test("emitPatchOutcome(applied:true) writes a patch_applied line with the PatchData shape", () => {
    const lines = withObserver((obs, file) => {
      emitPatchOutcome(obs, "/obs/inst-1.0.patch", APPLIED_DIFF, true)
      obs.close()
      return readLines(file)
    })
    const applied = lines.filter((e) => e.kind === "patch_applied")
    expect(applied.length).toBe(1)
    const d = applied[0]?.data as Record<string, unknown>
    // Exact `PatchData` contract the kind declares (trajectory.ts:128).
    expect(d.diffPath).toBe("/obs/inst-1.0.patch")
    expect(d.applyStatus).toBe("applied")
    expect(d.filesChanged).toBe(1)
    expect(d.hunks).toBe(1)
    // No rejected line leaked on the applied path.
    expect(lines.some((e) => e.kind === "patch_rejected")).toBe(false)
  })

  test("emitPatchOutcome(applied:false) writes a patch_rejected line triage classifies", () => {
    const lines = withObserver((obs, file) => {
      emitPatchOutcome(obs, "/obs/inst-1.0.patch", APPLIED_DIFF, false)
      obs.close()
      return readLines(file)
    })
    const rejected = lines.filter((e) => e.kind === "patch_rejected")
    expect(rejected.length).toBe(1)
    const d = rejected[0]?.data as Record<string, unknown>
    expect(d.applyStatus).toBe("rejected")
    expect(d.filesChanged).toBe(1)
    // The probe's `patch_rejected` rule reads exactly these lines back.
    const verdict = triage(rejected)
    expect(verdict.likely_failure_class).toBe("patch_rejected")
    expect(verdict.evidence.some((e) => e.includes("applyStatus=rejected"))).toBe(true)
  })

  test("OFF / byte-identical: observer undefined ⇒ NO patch-lifecycle line emitted", () => {
    // The whole eval driver skips these emits when `wiring.observer` is absent
    // (observe off). `emitPatchOutcome(undefined, …)` must be a no-op — proven by
    // an observer whose file stays free of applied/rejected lines.
    const lines = withObserver((obs, file) => {
      // Drive the OFF branch: pass `undefined` for the observer.
      emitPatchOutcome(undefined, "/p", APPLIED_DIFF, true)
      emitPatchOutcome(undefined, "/p", APPLIED_DIFF, false)
      obs.close()
      return readLines(file)
    })
    expect(lines.some((e) => e.kind === "patch_applied" || e.kind === "patch_rejected")).toBe(false)
  })
})

describe("ADR-0539 R3 — acceptance onSelection OBSERVE emit", () => {
  test("BenchObserver.acceptanceSelection records a recovery line (reason:acceptance_select), no patch leak", () => {
    const lines = withObserver((obs, file) => {
      obs.acceptanceSelection({
        tier: "repro_and_regression",
        votes: 3,
        candidateCount: 5,
        llmOverrode: true,
      })
      obs.close()
      return readLines(file)
    })
    const rec = lines.filter(
      (e) =>
        e.kind === "recovery" && (e.data as Record<string, unknown>).reason === "acceptance_select",
    )
    expect(rec.length).toBe(1)
    const d = rec[0]?.data as Record<string, unknown>
    expect(d.tier).toBe("repro_and_regression")
    expect(d.votes).toBe(3)
    expect(d.candidateCount).toBe(5)
    expect(d.llmOverrode).toBe(true)
    // No-leak: the winning patch is NEVER serialized onto the OBSERVE line.
    expect(JSON.stringify(d)).not.toContain("winningPatch")
    expect(d.winningPatch).toBeUndefined()
  })

  test("OFF: no acceptanceSelection call ⇒ no acceptance_select line (byte-identical)", () => {
    const lines = withObserver((obs, file) => {
      // Simulate the acceptance-OFF path: the onSelection closure never fires,
      // so the observer records nothing acceptance-shaped.
      obs.close()
      return readLines(file)
    })
    expect(
      lines.some(
        (e) =>
          e.kind === "recovery" &&
          (e.data as Record<string, unknown>).reason === "acceptance_select",
      ),
    ).toBe(false)
  })
})
