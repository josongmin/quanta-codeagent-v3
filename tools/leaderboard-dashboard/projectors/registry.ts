/**
 * BFND-03 — THE dashboard's suite dispatch.
 *
 * Every persisted bench artifact the dashboard renders enters here, is decoded
 * through the one canonical read boundary, and is handed to the projector that
 * owns its `benchmarkSuite`. Nothing downstream branches on a suite id again.
 *
 * Adding a benchmark = one projector module + one `registerSuiteProjector` line.
 * Adding a SWE dataset family = one line in `swe-bench/registry.ts` instead; the
 * two levels are deliberately different, which is why ProMax (a family) can
 * never be admitted here as a suite.
 */
import { type CanonicalBenchReport, decodeCanonicalReport } from "@/runner/batch/report-envelope"
import { sweBenchProjector } from "./swe-bench"
import { terminalBenchProjector } from "./terminal-bench"
import type {
  BenchmarkSuiteId,
  BenchmarkView,
  ProjectedRun,
  SuiteClientAssets,
  SuiteDataOpts,
  SuiteProjector,
} from "./types"

/** Thrown when a suite id has no registered projector. Fail-closed: an unknown
 *  suite is never silently rendered as SWE. */
export class UnknownBenchmarkSuiteError extends Error {
  constructor(suite: string) {
    super(`no dashboard projector registered for benchmark suite ${JSON.stringify(suite)}`)
    this.name = "UnknownBenchmarkSuiteError"
  }
}

/** Insertion order is display order. */
const PROJECTORS = new Map<BenchmarkSuiteId, SuiteProjector>()

export const registerSuiteProjector = (projector: SuiteProjector): void => {
  PROJECTORS.set(projector.suite, projector)
}

export const registeredSuites = (): readonly BenchmarkSuiteId[] => [...PROJECTORS.keys()]

export const projectorFor = (suite: string): SuiteProjector => {
  const projector = PROJECTORS.get(suite as BenchmarkSuiteId)
  if (projector === undefined) throw new UnknownBenchmarkSuiteError(suite)
  return projector
}

/** Give each suite a chance to claim a pre-canonical encoding as its own. */
const adoptLegacyEncoding = (raw: unknown): unknown => {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw
  const body = raw as Record<string, unknown>
  for (const projector of PROJECTORS.values()) {
    const adopted = projector.adoptLegacy?.(body)
    if (adopted !== null && adopted !== undefined) return adopted
  }
  return raw
}

/**
 * MED-C — THE entry point for a persisted artifact of unknown vintage.
 *
 * Exactly two stages, in this order and nowhere else:
 *   1. per-suite `adoptLegacy` rewrites a PRE-canonical ENCODING into canonical
 *      bytes (the only sanctioned place a legacy identity may be interpreted),
 *   2. `decodeCanonicalReport` — the single IDENTITY normalizer — validates it.
 *
 * Any tool that reads the `*.report.json` trove enters here rather than parsing
 * raw JSON and re-deriving a suite for itself. Throws
 * `CanonicalReportIdentityError` on an unidentifiable report; callers scanning a
 * mixed report root skip those.
 */
export const decodeReportArtifact = (raw: unknown): CanonicalBenchReport =>
  decodeCanonicalReport(adoptLegacyEncoding(raw))

/**
 * Project one persisted artifact. Throws `CanonicalReportIdentityError` on an
 * unidentifiable report (callers scanning a mixed report root skip those) and
 * `UnknownBenchmarkSuiteError` if a decoded suite has no projector.
 */
export const projectReport = (raw: unknown): ProjectedRun => {
  const report = decodeReportArtifact(raw)
  return projectorFor(report.benchmarkSuite).project(report)
}

/** The selectable benchmark tabs, given the view ids present in the runs. */
export const benchmarkViewsOf = (seenViewIds: Iterable<string>): readonly BenchmarkView[] => {
  const seen = new Set(seenViewIds)
  const views: BenchmarkView[] = []
  for (const projector of PROJECTORS.values()) views.push(...projector.viewsFor(seen))
  return views
}

/** Suite-owned payloads merged into the page's data envelope. */
export const suiteData = (opts: SuiteDataOpts): Record<string, unknown> => {
  const merged: Record<string, unknown> = {}
  for (const projector of PROJECTORS.values()) Object.assign(merged, projector.data?.(opts) ?? {})
  return merged
}

/** The suite-owned client render code the page ships. */
export const suiteClientAssets = (): SuiteClientAssets => {
  const style: string[] = []
  const script: string[] = []
  for (const projector of PROJECTORS.values()) {
    if (projector.client.style !== "") style.push(projector.client.style)
    if (projector.client.script !== "") script.push(projector.client.script)
  }
  return { style: style.join("\n"), script: script.join("\n") }
}

registerSuiteProjector(sweBenchProjector)
registerSuiteProjector(terminalBenchProjector)
