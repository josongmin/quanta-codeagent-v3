/**
 * BFND-03 / PMX-05 — the dashboard's Run + per-instance ROW SHAPES.
 *
 * Extracted out of `server.ts` (which calls `Bun.serve` at import and therefore
 * cannot be imported by anything, tests included) so the shapes every consumer
 * reasons about are readable, importable, and out of the shell's line budget.
 *
 * Types only — no logic, no IO. The predicates that read these shapes
 * (`instanceIsUnmeasured`, `classifyFail`, `tallyOf`) stay with the server, which
 * is where the parse pipeline lives.
 */
import type { BenchmarkSuiteId, OfficialGradeView, ProjectedInstanceRow } from "./projectors/types"

/** Fields every run carries regardless of suite. Nothing suite-specific lives
 *  here — that is what {@link Run}'s two branches are for. */
export interface RunBase {
  label: string
  file: string
  model: string
  preset: string
  /** Top-level view tab (benchmark selector) this run renders under. */
  viewId: string
  /** Suite-scoped campaign identity segment (see family-partition.ts). */
  campaignIdentity: string
  /** P1-C — explicit A/B arm (`baseline`/`levers`) from report.arm; absent on old reports. */
  arm?: string
  /** BFND-03 — the benchmark suite this artifact belongs to, from the projector
   *  registry. Carried for display/telemetry; the shell NEVER branches on it. */
  benchmarkSuite: BenchmarkSuiteId
  mtime: number
  resolved: number
  // Denominator EXCLUDING re-runnable measurement-holes (FLAG-B). A campaign
  // throttled on N instances no longer shows a deflated resolved/total %.
  total: number
  // Count of attempts dropped from `total` because they were unmeasured
  // (throttle / infra / env-degraded) — surfaced beside the ratio.
  unmeasured: number
}

/** Per-instance fields shared by every suite (identity + the raw attempt facts). */
export interface InstanceRowBase {
  id: string
  passed: boolean
  turns: number
  durationMs: number
}

/** MED-D — the SWE per-instance row. `fail` / `goldResolved` are SWE grading
 *  dispositions and exist ONLY here: a Terminal row has no verifier and no gold
 *  patch, so carrying either on it would be a shared broad shape by another name. */
export interface SweInstanceRow extends InstanceRowBase {
  fail: FailInfo | null
  // SOLVABILITY (RFC jun-29): did the GOLD patch pass the instance's verifier?
  //   true  = instance solvable + verifier sound (a fail here is a genuine model miss)
  //   false = gold FAILED / verifier broken → NOT a model miss, exclude from blame
  //   undefined = not checked
  goldResolved?: boolean
}

/**
 * TB21-05 — a suite-shaped per-instance row, produced by the suite's OWN
 * projector.
 *
 * It replaced the shell-shaped `TerminalInstanceRow` (`{id, passed, turns,
 * durationMs, error?}`). Two things forced the change: the persisted 2.1 channel
 * is `trials`, not `perInstance`, so the shell cannot shape it; and the `error`
 * field encoded the D1 exclusion that TB21-04 REVERSED (an errored trial has no
 * reward, so it scores zero and stays in the official denominator). The shell now
 * reads only `{id, passed}` — everything else is the suite's business.
 */
export type SuiteInstanceRow = ProjectedInstanceRow

export interface SweRun extends RunBase {
  /**
   * PMX-05 — the artifact's PERSISTED official-grade totals + their one
   * server-side formatting, straight off the projector. The dashboard FORMATS
   * these; it never recomputes them from `perInstance`, which is what keeps a
   * filter or display bug from moving `assigned`. Absent on every report that
   * never ran an official grader.
   */
  officialGrade?: OfficialGradeView
  /** MED-D discriminant — the per-instance VOCABULARY, declared by the suite's
   *  projector. The SWE-only rollups below narrow on THIS, so the shell needs no
   *  knowledge of which suites exist. */
  instanceRowKind: "swe-grade"
  /** Dataset family (RFC jun-29 R4) — the SWE axis ONLY. */
  datasetFamily?: string
  perInstance: SweInstanceRow[]
}

export interface TerminalRun extends RunBase {
  instanceRowKind: "trial-receipt"
  /** A trial-receipt suite has NO family axis — that is the whole point of
   *  BFND-02. Declaring it as `never` keeps `run.datasetFamily` readable across
   *  the union while making it impossible to ever assign one here. */
  datasetFamily?: never
  perInstance: readonly SuiteInstanceRow[]
  /** TB21-05 — the suite's own per-run payload (provenance, the persisted
   *  admission, the persisted official metrics), carried verbatim to the suite's
   *  client view. The shell never reads inside it. */
  suiteView?: Record<string, unknown>
}

/** MED-D — one Run type per per-instance vocabulary, not one broad shape holding
 *  both. A trial-receipt row cannot carry a grading disposition and vice versa. */
export type Run = SweRun | TerminalRun

export interface FailInfo {
  termination: string // completed_unresolved / error / timeout / …
  klass: string // 못고침 / regression(기존깨짐) / timeout / error / 미해결
  repro: string // reproTest.reason (no_reproduced_candidate / execution_failed / …)
  f2p: number // FAIL_TO_PASS still failing
  p2p: number // PASS_TO_PASS broken (regression signal)
  // Re-runnable measurement-hole (throttle / harness / grader-infra /
  // env-degraded) — EXCLUDED from the solve-rate denominator and from the
  // "real gap" card, mirroring src/apps/bench/analyze/verdicts.ts. NOT a
  // capability miss: re-running the instance can still resolve it.
  reRunnable: boolean
}
