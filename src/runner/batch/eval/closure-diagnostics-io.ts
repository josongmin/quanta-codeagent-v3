/**
 * T-101 — closure diagnostics IO (OFFLINE). Bridges the pure compute layer
 * ({@link computeClosureDiagnostics}) to bench run artifacts + the eval oracle,
 * and writes the sibling `*.closure-diagnostics.json`.
 *
 * ⚠️ EVAL-ONLY. `buildOracle` reads the dataset's gold patch / FAIL_TO_PASS —
 * this file must only be invoked from the post-run sidecar path, never from the
 * agent loop. Gating lives at the single call site (default-OFF), so the no-knob
 * runtime path is byte-identical.
 */
import { readFileSync, writeFileSync } from "node:fs"
import type { InstanceResult } from "../types"
import {
  type ClosureDiagnostics,
  type ClosureOracle,
  type ClosureRunFact,
  computeClosureDiagnostics,
} from "./closure-diagnostics"
import { buildPatchHygiene } from "./patch-hygiene"

const GIT_FILE = /^diff --git a\/(\S+) b\/\S+/gm
/** Repo-relative paths a unified diff touches, in diff order. */
export const patchFiles = (diff: string): string[] =>
  [...diff.matchAll(GIT_FILE)].map((m) => m[1] as string)

/** Stray-file detection reuses the authoritative T-401 patch-hygiene checker
 *  so the diagnostic sidecar and the (later) hygiene gate agree by construction. */
export const strayFilesOf = (diff: string): string[] => buildPatchHygiene(diff).strayAddedFiles

/** session_end-style reason inferred from per-attempt outcomes (until the
 *  stream tap threads the real reason in a later wave). */
const endReasonOf = (r: InstanceResult): string | null => {
  const outs = r.budget?.attemptOutcomes ?? []
  if (outs.some((o) => o.kind === "admission-blocked")) return "admission_blocked"
  if (outs.some((o) => o.kind === "real-fail" && o.subkind === "budget_exhausted"))
    return "budget_exhausted"
  if (outs.some((o) => o.kind === "real-fail" && o.subkind === "max_turns_exhausted"))
    return "max_turns"
  if (outs.some((o) => o.kind === "timeout")) return "timeout"
  if (outs.some((o) => o.kind === "infra-fail")) return "infra"
  return null
}

/** Whether the agentless repro-test pipeline produced a base-RED reproduction.
 *  null ⇒ repro-test was off / never ran (signal unavailable, not "false"). */
const reproReproducedOf = (r: InstanceResult): boolean | null => {
  const t = r.reproTest
  if (t === undefined) return null
  if (!t.installed) return false
  return (t.reproducedCount ?? 0) > 0
}

const resolvedOf = (r: InstanceResult): boolean | null =>
  r.verdict === undefined || r.verdict === "ok" ? r.passed : null

const patchBudgetFieldsOf = (
  r: InstanceResult,
): Pick<ClosureRunFact, "overBudget" | "newDef" | "crossFile"> => ({
  overBudget: r.patchBudget !== undefined ? !r.patchBudget.withinBudget : null,
  newDef: r.patchBudget !== undefined ? r.patchBudget.budget.newDefs > 0 : null,
  crossFile: r.patchBudget !== undefined ? r.patchBudget.budget.crossFile : null,
})

const telemetryFieldsOf = (
  r: InstanceResult,
): Omit<
  ClosureRunFact,
  | "instanceId"
  | "resolved"
  | "patchFiles"
  | "strayFiles"
  | "emptyPatch"
  | "endReason"
  | "overBudget"
  | "newDef"
  | "crossFile"
> => ({
  firstEditFile: r.firstEditFile ?? null,
  editCount: r.editCount ?? null,
  turnsToFirstEdit: r.turnsToFirstEdit ?? null,
  reproReproduced: reproReproducedOf(r),
  primaryRailPresent: r.primaryRailPresent ?? null,
  requiredVerificationCovered: r.requiredVerificationCovered ?? null,
  primaryFalseGreen: r.primaryFalseGreen ?? null,
  primaryFalseRed: r.primaryFalseRed ?? null,
  gateEntered: r.gateEntered ?? null,
  gateBypassed: r.gateBypassed ?? null,
  verifyRounds: r.verifyRounds ?? null,
  synthReproBaseRed: r.synthReproBaseRed ?? null,
  outOfScopeFiles: r.outOfScopeFiles ?? null,
})

const buildFact = (r: InstanceResult): ClosureRunFact => {
  const patch = r.patch ?? ""
  return {
    instanceId: r.id,
    resolved: resolvedOf(r),
    patchFiles: patchFiles(patch),
    strayFiles: strayFilesOf(patch),
    emptyPatch: patch === "",
    endReason: endReasonOf(r),
    ...telemetryFieldsOf(r),
    ...patchBudgetFieldsOf(r),
  }
}

/** InstanceResult[] -> closure facts (no oracle). Verdict-excluded instances
 *  (degraded / env_prep_failed / grader_invalid) are treated as ungraded. */
export const buildFacts = (results: ReadonlyArray<InstanceResult>): ClosureRunFact[] =>
  results.map(buildFact)

/** Dataset JSONL (official SWE-bench rows) -> eval oracle. EVAL-ONLY. */
export const buildOracle = (datasetPath: string): Map<string, ClosureOracle> => {
  const map = new Map<string, ClosureOracle>()
  for (const line of readFileSync(datasetPath, "utf8").split("\n")) {
    if (line.trim() === "") continue
    try {
      const rec = JSON.parse(line) as {
        instance_id?: string
        patch?: string
        FAIL_TO_PASS?: string | string[]
      }
      if (!rec.instance_id) continue
      const f2p = Array.isArray(rec.FAIL_TO_PASS)
        ? rec.FAIL_TO_PASS
        : typeof rec.FAIL_TO_PASS === "string"
          ? (JSON.parse(rec.FAIL_TO_PASS) as string[])
          : []
      map.set(rec.instance_id, {
        instanceId: rec.instance_id,
        goldFiles: patchFiles(rec.patch ?? ""),
        failToPass: f2p,
      })
    } catch {
      // skip malformed line — diagnostics degrade, never crash the run
    }
  }
  return map
}

/** Build the diagnostics object from results + dataset (no fs write). */
export const diagnoseRun = (
  results: ReadonlyArray<InstanceResult>,
  datasetPath: string | undefined,
): ClosureDiagnostics => {
  const oracle = datasetPath ? buildOracle(datasetPath) : new Map<string, ClosureOracle>()
  return computeClosureDiagnostics(buildFacts(results), oracle)
}

/** Sidecar path next to the report (`x.json` -> `x.closure-diagnostics.json`). */
export const sidecarPath = (reportPath: string): string =>
  `${reportPath.replace(/\.json$/i, "")}.closure-diagnostics.json`

/** Write the sibling artifact. Returns the path written. Never throws on a
 *  malformed run — callers gate this and treat failure as best-effort. */
export const writeClosureSidecar = (
  reportPath: string,
  results: ReadonlyArray<InstanceResult>,
  datasetPath: string | undefined,
): string => {
  const out = sidecarPath(reportPath)
  writeFileSync(out, `${JSON.stringify(diagnoseRun(results, datasetPath), null, 2)}\n`)
  return out
}
