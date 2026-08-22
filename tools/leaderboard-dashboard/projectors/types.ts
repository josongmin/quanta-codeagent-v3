/**
 * BFND-03 — the dashboard's suite-projector contract.
 *
 * A projector is the ONE place that knows how a benchmark suite's persisted
 * artifact turns into dashboard state: which view tab it belongs to, which
 * campaign it may coalesce with, and (for suites whose artifacts carry official-
 * shaped metrics) what its headline reads. It also owns the suite's client-side
 * render code, so the page shell never branches on a suite id.
 *
 * A projector FORMATS persisted metrics. It never re-derives them.
 */
import type { CanonicalBenchReport, DatasetFamily } from "@/runner/batch/report-envelope"
import type {
  OfficialGradeDisplay,
  OfficialGradeTotals,
} from "@/runner/batch/report-official-grade"

/**
 * PMX-05 — a run's PERSISTED official-grade result, carried to the client
 * verbatim.
 *
 * `totals` is the report's own aggregation (never recomputed here) and `display`
 * is the ONE server-side formatter's output. The browser bundle cannot import the
 * formatter, so shipping its strings is what makes the dashboard byte-identical
 * to the CLI and the markdown export by CONSTRUCTION rather than by three copies
 * of a rounding rule. A family view renders these; it owns no denominator.
 */
export interface OfficialGradeView {
  readonly totals: OfficialGradeTotals
  readonly display: OfficialGradeDisplay
}

/** Derived from the canonical union so the dashboard axis cannot drift from the
 *  report envelope's. ProMax is a FAMILY, so it can never appear here. */
export type BenchmarkSuiteId = CanonicalBenchReport["benchmarkSuite"]

/** One selectable top-level benchmark tab. */
export interface BenchmarkView {
  readonly id: string
  readonly label: string
  readonly suite: BenchmarkSuiteId
}

/**
 * MED-D — which per-instance VOCABULARY a suite's artifact rows speak.
 *
 * `swe-grade` rows carry official-grade dispositions (a classified failure, a
 * gold-verifier verdict); `trial-receipt` rows carry a Harbor trial's infra-fault
 * record. They are different shapes, and the dashboard builds a different row
 * type from each — so the page shell shapes its consumer rows from THIS
 * declaration and never branches on a suite id to decide.
 *
 * A new suite that grades like SWE reuses `swe-grade` and needs no shell change.
 */
export type InstanceRowKind = "swe-grade" | "trial-receipt"

/** What a projector extracts from one persisted report. */
export interface ProjectedRun {
  readonly benchmarkSuite: BenchmarkSuiteId
  /** The per-instance vocabulary this suite's rows speak (see {@link InstanceRowKind}). */
  readonly instanceRowKind: InstanceRowKind
  /** Top-level view tab this run renders under. */
  readonly viewId: string
  /** SWE axis only. Terminal runs have NO family — that is the whole point. */
  readonly datasetFamily?: DatasetFamily
  /**
   * Suite-scoped identity segment for the campaign key. Two runs coalesce only
   * when their segments match, so a Terminal run can never roll up with a SWE
   * one (nor a Pro run with a Verified one). Empty ⇒ no prefix, which is what
   * keeps every pre-existing Verified campaign key byte-identical.
   */
  readonly campaignIdentity: string
  /** Suite-owned preset label. Absent ⇒ the page's generic labeler decides. */
  readonly presetLabel?: string
  /**
   * PERSISTED headline metrics, when the artifact carries them. Absent ⇒ the
   * page counts rows as it always has. A projector must never compute this from
   * raw per-instance rows — that would make it a second scoring authority.
   */
  readonly headline?: { readonly resolved: number; readonly total: number }
  /**
   * PMX-05 — the artifact's persisted official-grade totals, passed through
   * untouched. Absent on every report that never ran an official grader, which is
   * why the shell's existing row-counting stays byte-identical.
   */
  readonly officialGrade?: OfficialGradeView
}

/** Client-side render code a suite contributes to the dashboard page. */
export interface SuiteClientAssets {
  readonly style: string
  readonly script: string
}

export interface SuiteProjector {
  readonly suite: BenchmarkSuiteId
  /**
   * Rewrite a PRE-canonical on-disk encoding of this suite into canonical shape.
   * The single sanctioned place a legacy identity may be interpreted; returns
   * null when the raw artifact is not this suite's legacy encoding.
   */
  readonly adoptLegacy?: (raw: Record<string, unknown>) => Record<string, unknown> | null
  readonly project: (report: CanonicalBenchReport) => ProjectedRun
  /** Views this suite offers, given the view ids actually present in the runs. */
  readonly viewsFor: (seen: ReadonlySet<string>) => readonly BenchmarkView[]
  /**
   * Suite-owned payload merged into the page's data envelope (e.g. a public
   * competitor matrix this suite's view renders against). Keeps the shell from
   * knowing that any such file exists.
   */
  readonly data?: (opts: SuiteDataOpts) => Record<string, unknown>
  readonly client: SuiteClientAssets
}

/** What a projector may consult when loading its own payload. */
export interface SuiteDataOpts {
  /** The dashboard's vendored-data directory. */
  readonly rawdataDir: string
  /** The server's CLI flag reader, so a suite can expose its own override. */
  readonly argOf: (flag: string) => string | undefined
}
