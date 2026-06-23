import type { ReproTestOutcome } from "./types"

export const PYTEST_REPORT_SUFFIX = ".pytest-report.json"

export const pytestReportPathFor = (scriptPath: string): string =>
  `${scriptPath}${PYTEST_REPORT_SUFFIX}`

export interface PytestReportRecord {
  readonly nodeid: string
  readonly when: "collect" | "setup" | "call" | "teardown" | string
  readonly outcome: "passed" | "failed" | "skipped" | string
  readonly exc_type?: string
  readonly exc_module?: string
}

export interface PytestExecutionReport {
  readonly schema: 1
  readonly collected: number
  readonly exitstatus: number
  readonly reports: readonly PytestReportRecord[]
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const isReportRecord = (value: unknown): value is PytestReportRecord => {
  if (!isRecord(value)) return false
  return (
    typeof value.nodeid === "string" &&
    typeof value.when === "string" &&
    typeof value.outcome === "string" &&
    (value.exc_type === undefined || typeof value.exc_type === "string") &&
    (value.exc_module === undefined || typeof value.exc_module === "string")
  )
}

export const parsePytestExecutionReport = (raw: string): PytestExecutionReport | null => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (!isRecord(parsed)) return null
  if (parsed.schema !== 1) return null
  if (typeof parsed.collected !== "number" || !Number.isFinite(parsed.collected)) return null
  if (typeof parsed.exitstatus !== "number" || !Number.isFinite(parsed.exitstatus)) return null
  if (!Array.isArray(parsed.reports) || !parsed.reports.every(isReportRecord)) return null
  return {
    schema: 1,
    collected: parsed.collected,
    exitstatus: parsed.exitstatus,
    reports: parsed.reports,
  }
}

const PYTEST_EXIT_OK = 0
const PYTEST_EXIT_NO_TESTS = 5
const PYTEST_EXIT_INTERNAL = 3
const PYTEST_EXIT_USAGE = 4

const assertionFailureTypes = new Set(["AssertionError", "Failed"])

const isAssertionCallFailure = (record: PytestReportRecord): boolean =>
  record.when === "call" &&
  record.outcome === "failed" &&
  record.exc_type !== undefined &&
  assertionFailureTypes.has(record.exc_type)

const isNonAssertionFailure = (record: PytestReportRecord): boolean =>
  record.outcome === "failed" && !isAssertionCallFailure(record)

/**
 * Classify only from the deterministic pytest hook sidecar.
 *
 * A red witness is admitted only when pytest reached the test call phase and the
 * call failed through AssertionError/pytest.fail. Raw TypeError/AttributeError,
 * collection errors, setup failures, and malformed/missing reports are infra or
 * invalid-test failures, not issue reproduction authority.
 */
export const classifyPytestExecutionReport = (
  report: PytestExecutionReport | null,
): ReproTestOutcome => {
  if (report === null) return "exec_failed"
  if (report.collected <= 0 || report.exitstatus === PYTEST_EXIT_NO_TESTS) return "unknown"
  if (report.reports.some(isNonAssertionFailure)) return "exec_failed"
  if (report.reports.some(isAssertionCallFailure)) return "reproduced"
  if (report.exitstatus === PYTEST_EXIT_OK && report.reports.some((r) => r.outcome === "passed")) {
    return "resolved"
  }
  if (report.exitstatus === PYTEST_EXIT_INTERNAL || report.exitstatus === PYTEST_EXIT_USAGE) {
    return "other"
  }
  if (report.exitstatus !== PYTEST_EXIT_OK) return "exec_failed"
  return "unknown"
}

export const classifyPytestReportText = (raw: string): ReproTestOutcome =>
  classifyPytestExecutionReport(parsePytestExecutionReport(raw))
