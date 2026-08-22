/**
 * BFND-02 — the canonical bench-report envelope: ONE discriminated union, ONE
 * writer, ONE canonical mirror, ONE read boundary.
 *
 * ```
 * CanonicalBenchReport = SweBenchReport | TerminalBenchReport
 * ```
 *
 * The two branches stay SEPARATE interfaces on purpose. A SWE report carries
 * official-grade dispositions (`scoreTotals` / `proofTotals` / per-instance grade
 * breakdowns); a Terminal report carries Harbor trial receipts. Forcing them into
 * one payload type would make every consumer defensive about fields that cannot
 * coexist — so the union shares only the *identity* (`benchmarkSuite`) and the
 * persistence path, never the receipt semantics.
 *
 * ## Persisted encoding vs in-memory identity
 *
 * In memory every report carries its full identity (that is what makes the union
 * a real discriminated union). On disk the SWE branch keeps its LEGACY encoding —
 * no suite key, and `datasetFamily` emitted only for non-verified families (the
 * landed R4 byte-identical rule). {@link encodeCanonicalReport} is the single
 * place that strips it and {@link decodeCanonicalReport} is the single place that
 * puts it back, so the two are exact inverses.
 *
 * New Terminal artifacts persist EXPLICIT identity — suite, version and dataset
 * ref — because there is no legacy encoding to be compatible with, and because
 * identity must never be guessed from a filename, a field, or a dataset string.
 */
import { quantaHomePath, runtimeConfig } from "@/shared"
import type { BenchReport } from "./report"
import { decodeOfficialGradeSection } from "./report-official-grade"

/** Canonical SWE dataset-family union (RFC jun-29 R4). ProMax (PMX-05) is a
 *  member of this family AXIS — never a top-level suite: `benchmarkSuite:"promax"`
 *  stays refused below, and `pro` / `promax` never share a report partition. */
export type DatasetFamily = "verified" | "live" | "pro" | "promax"

/** Registration floor for the family axis. Fail-closed membership test: a family
 *  the registry does not admit is refused, never defaulted to verified. */
export const DATASET_FAMILIES: readonly DatasetFamily[] = ["verified", "live", "pro", "promax"]

export const isDatasetFamily = (raw: unknown): raw is DatasetFamily =>
  typeof raw === "string" && (DATASET_FAMILIES as readonly string[]).includes(raw)

/** Top-level benchmark suite discriminator (BFND-01's `BenchmarkSuite`, mirrored
 *  here so the batch layer does not depend on the bench CLI surface). */
export type BenchReportSuite = "swe-bench" | "terminal-bench"

/** The SWE branch: the existing report body plus explicit identity. */
export interface SweBenchReport extends BenchReport {
  readonly benchmarkSuite: "swe-bench"
  /** Required in memory; persisted only when non-verified (legacy encoding). */
  readonly datasetFamily: DatasetFamily
}

/** One Harbor trial, verbatim. Kept per-trial (never folded into a headline) so
 *  the receipt stays lossless for post-hoc RCA. */
export interface TerminalTrialReceipt {
  readonly id: string
  readonly passed: boolean
  readonly turns: number
  readonly durationMs: number
  /** D1 (RFC jul-3): an INFRA fault, not a capability outcome. */
  readonly error?: { readonly kind: "agent-timeout" | "agent-crash" }
}

/** The Terminal-Bench branch: versioned, dataset-pinned, family-less. */
export interface TerminalBenchReport {
  readonly benchmarkSuite: "terminal-bench"
  readonly benchmarkVersion: TerminalBenchVersion
  /** The pinned Harbor dataset the trials were graded against. */
  readonly datasetRef: string
  readonly timestamp: string
  /** Never fabricated — an unknown model stays undefined (P3-A). */
  readonly model: string | undefined
  readonly source: string
  readonly arm?: "baseline" | "levers"
  readonly knobs: {
    readonly preset: string
    readonly resolved: Record<string, never>
    readonly inactive: readonly never[]
  }
  /** Precomputed official-shaped metrics — downstream formats, never recomputes. */
  readonly totals: {
    readonly total: number
    readonly resolved: number
    readonly resolvedPct: number
  }
  /** Lossless per-trial receipts. */
  readonly perInstance: readonly TerminalTrialReceipt[]
}

/** The only Terminal-Bench version this envelope admits. */
export const TERMINAL_BENCH_VERSION = "2.1"
export type TerminalBenchVersion = typeof TERMINAL_BENCH_VERSION

export type CanonicalBenchReport = SweBenchReport | TerminalBenchReport

/** Thrown by {@link decodeCanonicalReport} when a report's identity is missing,
 *  unknown, or self-contradictory. Fail-closed: never a silent default. */
export class CanonicalReportIdentityError extends Error {
  constructor(message: string) {
    super(`canonical report identity: ${message}`)
    this.name = "CanonicalReportIdentityError"
  }
}

/**
 * Keys the Terminal branch declares that the SWE body does not — the type-DERIVED
 * candidate set, so a field added to {@link TerminalBenchReport} cannot quietly
 * escape the branch-exclusion guard.
 *
 * `source` is carved out deliberately: the type only happens to declare it on the
 * Terminal branch, but it is a SHARED provenance field that real pre-canonical SWE
 * artifacts carry (`report-campaign-recovered-*` write `source:
 * "recovered-from-campaign-log"`). Refusing it would refuse those reports.
 *
 * `totals` is NOT here and must never be: {@link BenchReport} declares it as a
 * REQUIRED field, so it is shared by construction — listing it would refuse every
 * SWE report ever written.
 */
type TerminalOnlyKey = Exclude<
  keyof TerminalBenchReport,
  keyof BenchReport | "benchmarkSuite" | "source"
>

/** Exhaustive by construction: `satisfies` fails to compile both when a new
 *  Terminal-only field is added without listing it AND when a shared field is
 *  listed by mistake. */
const TERMINAL_ONLY_KEY_SET = {
  arm: true,
  benchmarkVersion: true,
  datasetRef: true,
} as const satisfies Record<TerminalOnlyKey, true>

/** Fields that belong exclusively to the Terminal branch. Their presence without
 *  an explicit `benchmarkSuite:"terminal-bench"` is a REFUSAL, not a hint — the
 *  legacy fallback normalizes only to swe-bench, so identity is never inferred. */
export const TERMINAL_ONLY_KEYS = Object.keys(TERMINAL_ONLY_KEY_SET) as readonly TerminalOnlyKey[]

/**
 * Lift a legacy-encoded SWE report body into the canonical union. Absent family
 * ⇒ verified, matching the persisted encoding's meaning exactly.
 */
export const toCanonicalSweReport = (report: BenchReport): SweBenchReport => ({
  ...report,
  benchmarkSuite: "swe-bench",
  datasetFamily: report.datasetFamily ?? "verified",
})

/**
 * Project a canonical report onto its PERSISTED encoding.
 *
 * SWE: drop the implicit identity (suite key, verified family) so the bytes stay
 * byte-identical to the pre-BFND-02 report. Key order is preserved by rebuilding
 * the object in iteration order — a spread-and-reappend would move
 * `datasetFamily` to the tail and change the serialized bytes.
 *
 * Terminal: verbatim — a new artifact persists its identity explicitly.
 */
export const encodeCanonicalReport = (report: CanonicalBenchReport): Record<string, unknown> => {
  if (report.benchmarkSuite === "terminal-bench") return { ...report }
  const encoded: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(report)) {
    if (key === "benchmarkSuite") continue
    if (key === "datasetFamily" && value === "verified") continue
    encoded[key] = value
  }
  return encoded
}

/** Reject a terminal-only field that leaked onto a SWE (or identity-less) body. */
const refuseTerminalMarkers = (raw: Record<string, unknown>, context: string): void => {
  for (const key of TERMINAL_ONLY_KEYS) {
    if (key in raw) {
      throw new CanonicalReportIdentityError(`${context} must not carry the terminal-only "${key}"`)
    }
  }
}

// ── field decoders: every read of a persisted value goes through one of these ──

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const refuse = (what: string, why: string, got: unknown): never => {
  throw new CanonicalReportIdentityError(
    `${what} ${why} (got ${JSON.stringify(got) ?? "undefined"})`,
  )
}

const asStringField = (value: unknown, what: string): string =>
  typeof value === "string" ? value : refuse(what, "must be a string", value)

const asFiniteField = (value: unknown, what: string): number =>
  typeof value === "number" && Number.isFinite(value)
    ? value
    : refuse(what, "must be a finite number", value)

const asBooleanField = (value: unknown, what: string): boolean =>
  typeof value === "boolean" ? value : refuse(what, "must be a boolean", value)

const asRecordField = (value: unknown, what: string): Record<string, unknown> =>
  isRecord(value) ? value : refuse(what, "must be an object", value)

// ── SWE branch ────────────────────────────────────────────────────────────────

/**
 * MED-B — the two branches both spell their fault channel `error`, but they are
 * DIFFERENT channels: SWE persists a free-text message, Terminal persists an
 * infra-fault record `{kind}`. Neither may be read as the other, so each branch
 * refuses the other's shape at the boundary instead of letting a cast decide.
 */
const refuseCrossBranchError = (
  rows: unknown,
  reject: (error: unknown) => boolean,
  why: string,
): void => {
  if (!Array.isArray(rows)) return
  rows.forEach((row, index) => {
    if (!isRecord(row) || row.error === undefined) return
    if (reject(row.error)) refuse(`perInstance[${index}].error`, why, row.error)
  })
}

const decodeSweReport = (raw: Record<string, unknown>, legacy: boolean): SweBenchReport => {
  refuseTerminalMarkers(raw, legacy ? "a legacy (suite-less) report" : "a swe-bench report")
  const family = raw.datasetFamily
  if (family !== undefined && !isDatasetFamily(family)) {
    throw new CanonicalReportIdentityError(
      `unknown datasetFamily ${JSON.stringify(family)} (expected ${DATASET_FAMILIES.join("|")})`,
    )
  }
  refuseCrossBranchError(
    raw.perInstance,
    (error) => typeof error !== "string",
    "is the SWE branch's free-text message, never the terminal branch's {kind} record",
  )
  return {
    ...(raw as unknown as BenchReport),
    benchmarkSuite: "swe-bench",
    datasetFamily: family ?? "verified",
    // PMX-05: an official-grade section is re-validated against its own covering
    // partition on the way IN. A report whose totals drifted — a hand edit, a
    // truncated merge, a filter that dropped rows before the writer saw them —
    // fails closed here instead of putting a flattering number on a dashboard.
    // Re-assigning an EXISTING key keeps its original position, so the persisted
    // byte order survives a decode → encode round trip.
    ...(raw.officialGrade !== undefined
      ? { officialGrade: decodeOfficialGradeSection(raw.officialGrade) }
      : {}),
  }
}

// ── Terminal branch ───────────────────────────────────────────────────────────

const TERMINAL_ERROR_KINDS: readonly string[] = ["agent-timeout", "agent-crash"]

const decodeTerminalReceipt = (raw: unknown, index: number): TerminalTrialReceipt => {
  const at = `perInstance[${index}]`
  const row = asRecordField(raw, at)
  const receipt = {
    id: asStringField(row.id, `${at}.id`),
    passed: asBooleanField(row.passed, `${at}.passed`),
    turns: asFiniteField(row.turns, `${at}.turns`),
    durationMs: asFiniteField(row.durationMs, `${at}.durationMs`),
  }
  if (row.error === undefined) return receipt
  const kind = asRecordField(row.error, `${at}.error`).kind
  if (typeof kind !== "string" || !TERMINAL_ERROR_KINDS.includes(kind)) {
    refuse(`${at}.error.kind`, `must be one of ${TERMINAL_ERROR_KINDS.join("|")}`, kind)
  }
  return { ...receipt, error: { kind: kind as "agent-timeout" | "agent-crash" } }
}

const decodeTerminalKnobs = (raw: unknown): TerminalBenchReport["knobs"] => {
  const knobs = asRecordField(raw, "knobs")
  const resolved = asRecordField(knobs.resolved, "knobs.resolved")
  if (Object.keys(resolved).length > 0) {
    refuse("knobs.resolved", "carries no per-knob entries on the terminal branch", resolved)
  }
  if (!Array.isArray(knobs.inactive) || knobs.inactive.length > 0) {
    refuse("knobs.inactive", "must be an empty array on the terminal branch", knobs.inactive)
  }
  return { preset: asStringField(knobs.preset, "knobs.preset"), resolved: {}, inactive: [] }
}

const decodeTerminalArm = (raw: unknown): "baseline" | "levers" | undefined => {
  if (raw === undefined) return undefined
  if (raw !== "baseline" && raw !== "levers") refuse("arm", "must be baseline|levers", raw)
  return raw as "baseline" | "levers"
}

/**
 * HIGH-A — a real decode, not a cast. This is THE read boundary for the Terminal
 * branch: every field the type promises is checked and REBUILT here, so a
 * malformed or hostile artifact fails closed instead of entering the type system
 * as a well-typed value. Downstream consumers (the dashboard projector) therefore
 * do not need to re-validate `totals` defensively.
 */
const decodeTerminalReport = (raw: Record<string, unknown>): TerminalBenchReport => {
  if ("datasetFamily" in raw) {
    throw new CanonicalReportIdentityError(
      "a terminal-bench report must not carry a datasetFamily (families are the SWE axis)",
    )
  }
  if (raw.benchmarkVersion !== TERMINAL_BENCH_VERSION) {
    throw new CanonicalReportIdentityError(
      `unsupported benchmarkVersion ${JSON.stringify(raw.benchmarkVersion)} (expected ${TERMINAL_BENCH_VERSION})`,
    )
  }
  if (typeof raw.datasetRef !== "string" || raw.datasetRef.trim() === "") {
    throw new CanonicalReportIdentityError(
      "a terminal-bench report requires a non-empty datasetRef",
    )
  }
  const totals = asRecordField(raw.totals, "totals")
  if (!Array.isArray(raw.perInstance)) {
    refuse("perInstance", "must be an array of trial receipts", raw.perInstance)
  }
  const arm = decodeTerminalArm(raw.arm)
  return {
    benchmarkSuite: "terminal-bench",
    benchmarkVersion: TERMINAL_BENCH_VERSION,
    datasetRef: raw.datasetRef,
    timestamp: asStringField(raw.timestamp, "timestamp"),
    // Never fabricated: an absent model stays undefined, a non-string is refused.
    model: raw.model === undefined ? undefined : asStringField(raw.model, "model"),
    source: asStringField(raw.source, "source"),
    ...(arm !== undefined ? { arm } : {}),
    knobs: decodeTerminalKnobs(raw.knobs),
    totals: {
      total: asFiniteField(totals.total, "totals.total"),
      resolved: asFiniteField(totals.resolved, "totals.resolved"),
      resolvedPct: asFiniteField(totals.resolvedPct, "totals.resolvedPct"),
    },
    perInstance: (raw.perInstance as readonly unknown[]).map(decodeTerminalReceipt),
  }
}

/**
 * THE read-normalization boundary. Every consumer of a persisted bench report
 * enters the typed union here and nowhere else.
 *
 * - Explicit identity is validated, never trusted.
 * - A report with NO `benchmarkSuite` normalizes to legacy `swe-bench` only.
 * - Anything else — an unknown suite, a terminal-shaped body with no identity, a
 *   family the registry does not admit — is refused.
 */
export const decodeCanonicalReport = (raw: unknown): CanonicalBenchReport => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new CanonicalReportIdentityError("expected a report object")
  }
  const body = raw as Record<string, unknown>
  const suite = body.benchmarkSuite
  if (suite === undefined) return decodeSweReport(body, true)
  if (suite === "swe-bench") return decodeSweReport(body, false)
  if (suite === "terminal-bench") return decodeTerminalReport(body)
  throw new CanonicalReportIdentityError(
    `unknown benchmarkSuite ${JSON.stringify(suite)} (expected swe-bench|terminal-bench)`,
  )
}

/** Canonical SSOT sink for ALL bench reports — regardless of the caller-chosen
 *  `--report` path. Override with `QUANTA_BENCH_RESULTS_DIR`; disable the mirror
 *  with `QUANTA_BENCH_RESULTS_DIR=off`. Default `~/.quanta/bench/results`.
 *  THE single results-dir owner: no other module may derive one. */
export const benchResultsDir = (): string | null => {
  const override = runtimeConfig().benchResultsDir
  if (override === "off" || override === "0") return null
  if (override && override.length > 0) return override
  return quantaHomePath("bench", "results")
}

/** Mirror an already-written report's CONTENT into the canonical SSOT dir so
 *  results never scatter again — independent of the caller-chosen `--report`
 *  path. The mirror name is the sanitised source path, so re-runs to the same
 *  destination overwrite their own mirror (idempotent, no accumulation).
 *  Best-effort: a mirror failure never throws (the primary write already
 *  succeeded). Shared by `writeReport` (local batch) and the full-remote
 *  sidecar saver, so EVERY report path is covered by one canonical sink.
 *
 *  A source that ALREADY lives in the canonical dir is left alone — mirroring it
 *  would drop a mangled `*.report.json` twin beside the original and every
 *  report-scanning consumer would count the same run twice. */
export const mirrorReportToSsot = async (sourceFile: string, content: string): Promise<void> => {
  const dir = benchResultsDir()
  if (!dir) return
  try {
    const { dirname, resolve } = await import("node:path")
    const absolute = resolve(sourceFile)
    if (dirname(absolute) === resolve(dir)) return
    const mirrorName = absolute.replace(/^[/\\]+/, "").replace(/[^a-zA-Z0-9._-]/g, "__")
    await Bun.write(`${dir}/${mirrorName}`, content)
  } catch {
    // canonical mirror is best-effort — the source report already landed
  }
}

/** THE bench-report writer. Both union branches persist through here (pretty
 *  JSON, trailing newline) and through the one canonical mirror. Product code
 *  builds a typed report and calls this — never `Bun.write` on its own. */
export const writeReport = async (file: string, report: CanonicalBenchReport): Promise<void> => {
  const json = `${JSON.stringify(encodeCanonicalReport(report), null, 2)}\n`
  await Bun.write(file, json)
  await mirrorReportToSsot(file, json)
}
