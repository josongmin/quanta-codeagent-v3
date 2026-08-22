/**
 * BFND-03 — the SWE-bench suite projector.
 *
 * SWE runs keep the dashboard's original behavior verbatim: the view tab IS the
 * dataset family, Verified takes no campaign prefix (so every pre-existing
 * campaign key stays byte-identical), and the page keeps counting per-instance
 * rows because a SWE artifact carries no official-shaped headline metric.
 *
 * Family PRESENTATION is delegated to the one UI family-view registry; this
 * module never enumerates families itself.
 */

import type { CanonicalBenchReport } from "@/runner/batch/report-envelope"
import { CanonicalReportIdentityError } from "@/runner/batch/report-envelope"
import { formatOfficialGradeTotals } from "@/runner/batch/report-official-grade"
import { DEFAULT_SWE_VIEW, sweFamilyClientAssets, sweFamilyViews } from "./swe-bench/registry"
import type { BenchmarkView, ProjectedRun, SuiteProjector } from "./types"

const project = (report: CanonicalBenchReport): ProjectedRun => {
  if (report.benchmarkSuite !== "swe-bench") {
    throw new CanonicalReportIdentityError(
      `the swe-bench projector was handed a ${report.benchmarkSuite} report`,
    )
  }
  const family = report.datasetFamily
  // PMX-05: pass the report's OWN aggregation through, formatted once by the
  // report layer's single formatter. This projector performs no arithmetic — it
  // could not, because it never sees a per-instance row from here.
  const section = report.officialGrade
  return {
    benchmarkSuite: "swe-bench",
    // Official-grade dispositions per instance (classified failure + gold verdict).
    instanceRowKind: "swe-grade",
    viewId: family,
    datasetFamily: family,
    // R4 partition: Verified keeps the bare legacy key; every other family gets
    // its own campaign space so resolved-rates are never averaged across datasets.
    campaignIdentity: family === DEFAULT_SWE_VIEW ? "" : family,
    ...(section !== undefined
      ? {
          officialGrade: {
            totals: section.totals,
            display: formatOfficialGradeTotals(section.totals),
          },
          // The generic row-counting headline, taken off the persisted totals so
          // the shell stops counting rows for a graded run.
          //
          // The denominator is `assigned`, DELIBERATELY not `grading_valid`: this
          // slot is rendered in places that show no coverage beside it (the tab
          // badge, the runs table), and the whole point of PMX-05 is that the
          // flattering valid denominator is never quotable on its own. `raw_rate`
          // is the one rate that is safe without context — it can only understate.
          headline: { resolved: section.totals.resolved, total: section.totals.assigned },
        }
      : {}),
  }
}

/**
 * C-C residual (aug-22) — this suite had NO refusal claim at all.
 *
 * A refused artifact is dropped from the run set, which drops it from its
 * campaign's `members` AND from the campaign denominator — the same shrunken
 * denominator C-C closed for ungraded members, arriving through the refusal
 * channel. C-B widened that channel: a section that cannot be reconciled against
 * its own run rows is now refused at decode. An unclaimed refusal renders on NO
 * surface, so the loss was both silent and invisible.
 *
 * Claimed by EXPLICIT identity, or by this branch's own provenance marker — the
 * `officialGrade` section, which only the SWE writer emits (the terminal branch
 * has no such key). A `datasetFamily` VALUE is never read as a suite id; that
 * reading is what BFND-02 removed and it stays removed.
 */
const claimsRefused = (raw: Record<string, unknown>): boolean =>
  raw.benchmarkSuite === "swe-bench" ||
  (typeof raw.officialGrade === "object" &&
    raw.officialGrade !== null &&
    !Array.isArray(raw.officialGrade))

const viewsFor = (seen: ReadonlySet<string>): readonly BenchmarkView[] =>
  sweFamilyViews()
    .filter((view) => view.family === DEFAULT_SWE_VIEW || seen.has(view.family))
    .map((view) => ({ id: view.family, label: view.label, suite: "swe-bench" as const }))

export const sweBenchProjector: SuiteProjector = {
  suite: "swe-bench",
  claimsRefused,
  project,
  viewsFor,
  // The SWE render path IS the page's default shell, so this suite contributes no
  // suite-level client code. What it DOES contribute is the generic family-view
  // dispatch table plus whatever bundles the registered families brought with
  // them — which is how a family gets its own cards/matrix without the shell (or
  // this module) ever naming one.
  client: sweFamilyClientAssets(),
}
