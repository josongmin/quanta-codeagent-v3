import type { RepairReproOutcome } from "./types"

export const MARKER_REPRODUCED = "Issue reproduced"
export const MARKER_RESOLVED = "Issue resolved"
export const MARKER_OTHER = "Other issues"

const PYTEST_EXIT_OK = 0
const PYTEST_EXIT_NO_TESTS = 5
const PYTEST_EXIT_INTERNAL = 3
const PYTEST_EXIT_USAGE = 4
const RE_FAILED = /\b\d+\s+failed\b/
const RE_ERROR = /\b\d+\s+errors?\b/
const RE_PASSED = /\b\d+\s+passed\b/
const RE_NO_TESTS = /\bno tests ran\b/

export const classifyReproOutcome = (stdout: string, code: number): RepairReproOutcome => {
  const s = typeof stdout === "string" ? stdout : ""
  const iReproduced = s.lastIndexOf(MARKER_REPRODUCED)
  const iResolved = s.lastIndexOf(MARKER_RESOLVED)
  const iOther = s.lastIndexOf(MARKER_OTHER)
  const max = Math.max(iReproduced, iResolved, iOther)
  if (max < 0) return code !== 0 ? "exec_failed" : "unknown"
  if (max === iResolved) return "resolved"
  if (max === iReproduced) return "reproduced"
  return "other"
}

/**
 * Local pytest-grounded repro verdict for repair validation. Keeps the
 * validator slice importing only local repair helpers while preserving the
 * execution-grounded pass/fail mapping.
 */
export const classifyPytestReproOutcome = (
  stdout: string,
  stderr: string,
  code: number,
): RepairReproOutcome => {
  const text = `${typeof stdout === "string" ? stdout : ""}\n${typeof stderr === "string" ? stderr : ""}`
  if (RE_FAILED.test(text)) return "reproduced"
  if (RE_ERROR.test(text)) return "exec_failed"
  if (RE_PASSED.test(text)) return "resolved"
  if (RE_NO_TESTS.test(text) || code === PYTEST_EXIT_NO_TESTS) return "unknown"
  if (code === PYTEST_EXIT_OK) return "unknown"
  if (code === PYTEST_EXIT_INTERNAL || code === PYTEST_EXIT_USAGE) return "other"
  return "exec_failed"
}
