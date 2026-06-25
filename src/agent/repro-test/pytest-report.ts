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

/**
 * Exception types that NEVER count as a reproduction even when they surface in
 * the call phase. These are infra / invalid-test signatures, not the symptom of
 * the bug under test:
 *
 *   - `SyntaxError` / `IndentationError` / `TabError` — the LLM emitted a broken
 *     test file. (These normally surface at COLLECTION, but a deferred
 *     `compile()`/`exec()` could raise one mid-call; exclude regardless.)
 *   - `ImportError` / `ModuleNotFoundError` — the project / a dependency is not
 *     importable in the exec env. A deferred (in-test) import that fails is an
 *     ENV break, not the issue's behavioural symptom. This is the astropy-13033
 *     false-red shape and is the single most dangerous leak to admit.
 *
 * Everything else raised from the code under test in the call phase (TypeError,
 * AttributeError, KeyError, ValueError, IndexError, RuntimeError, …) IS a real
 * crash reproduction.
 */
const infraExcTypesAtCall = new Set([
  "SyntaxError",
  "IndentationError",
  "TabError",
  "ImportError",
  "ModuleNotFoundError",
])

/** A call-phase FAILED report (`when === "call"`, `outcome === "failed"`).
 *  Collection (`when === "collect"`), setup/teardown, and pytest `ERROR`
 *  (which pytest surfaces via a non-call `when` with `outcome === "failed"`)
 *  are all excluded HERE — only the body of the test function executing and
 *  failing reaches this predicate. */
const isCallPhaseFailure = (record: PytestReportRecord): boolean =>
  record.when === "call" && record.outcome === "failed"

const isAssertionCallFailure = (record: PytestReportRecord): boolean =>
  isCallPhaseFailure(record) &&
  record.exc_type !== undefined &&
  assertionFailureTypes.has(record.exc_type)

/**
 * A call-phase FAILED whose exception is a RAW exception thrown by the code
 * under test (e.g. TypeError/AttributeError/KeyError/ValueError) — a legitimate
 * crash-bug reproduction. Excludes:
 *   - the assertion shapes (already counted by {@link isAssertionCallFailure});
 *   - infra/invalid-test exception types ({@link infraExcTypesAtCall});
 *   - a FAILED report with NO `exc_type` recorded (cannot attribute the failure
 *     to the code under test ⇒ stay conservative, treat as infra).
 */
const isRawExceptionCallFailure = (record: PytestReportRecord): boolean =>
  isCallPhaseFailure(record) &&
  record.exc_type !== undefined &&
  !assertionFailureTypes.has(record.exc_type) &&
  !infraExcTypesAtCall.has(record.exc_type)

/** A reproduction witness in the call phase: either an assertion failure or a
 *  raw code-under-test exception. */
const isReproducingCallFailure = (record: PytestReportRecord): boolean =>
  isAssertionCallFailure(record) || isRawExceptionCallFailure(record)

/** A FAILED report that is NEITHER a reproduction witness: collection/setup/
 *  teardown failures, pytest `ERROR` (non-call `when`), import/syntax infra
 *  exceptions even at call phase, and call-phase FAILED with no `exc_type`.
 *  These are infra / invalid-test failures, not reproduction authority. */
const isInfraFailure = (record: PytestReportRecord): boolean =>
  record.outcome === "failed" && !isReproducingCallFailure(record)

/**
 * Classify only from the deterministic pytest hook sidecar.
 *
 * A red witness is admitted only when pytest reached the test CALL phase and the
 * call failed through (a) AssertionError/pytest.fail, OR (b) a raw exception
 * thrown by the code under test (TypeError/AttributeError/…). For a large class
 * of real SWE-bench bugs the symptom IS a raw exception, so withholding those
 * biased the oracle toward "no base repro established".
 *
 * STRICTLY excluded (stay `exec_failed`): collection errors, setup/teardown
 * failures, pytest `ERROR` (non-call `when`), top-level import crashes, syntax
 * errors, and any import/syntax exception even if it leaks into the call phase.
 * These are infra / invalid-test failures, not issue reproduction authority.
 */
export const classifyPytestExecutionReport = (
  report: PytestExecutionReport | null,
): ReproTestOutcome => {
  if (report === null) return "exec_failed"
  if (report.collected <= 0 || report.exitstatus === PYTEST_EXIT_NO_TESTS) return "unknown"
  if (report.reports.some(isInfraFailure)) return "exec_failed"
  if (report.reports.some(isReproducingCallFailure)) return "reproduced"
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
