import { describe, expect, test } from "bun:test"
import {
  classifyPytestExecutionReport,
  classifyPytestReportText,
  parsePytestExecutionReport,
} from "@/agent/repro-test/pytest-report"

const report = (args: {
  collected: number
  exitstatus: number
  reports?: readonly Record<string, unknown>[]
}): string =>
  JSON.stringify({
    schema: 1,
    collected: args.collected,
    exitstatus: args.exitstatus,
    reports: args.reports ?? [],
  })

describe("pytest sidecar repro outcome", () => {
  test("AssertionError call failure is the only red witness shape", () => {
    expect(
      classifyPytestReportText(
        report({
          collected: 1,
          exitstatus: 1,
          reports: [
            {
              nodeid: "t.py::test_x",
              when: "call",
              outcome: "failed",
              exc_type: "AssertionError",
            },
          ],
        }),
      ),
    ).toBe("reproduced")
  })

  test("pytest.fail call failure is red", () => {
    expect(
      classifyPytestReportText(
        report({
          collected: 1,
          exitstatus: 1,
          reports: [{ nodeid: "t.py::test_x", when: "call", outcome: "failed", exc_type: "Failed" }],
        }),
      ),
    ).toBe("reproduced")
  })

  test("raw call exception is exec_failed, not reproduced", () => {
    expect(
      classifyPytestReportText(
        report({
          collected: 1,
          exitstatus: 1,
          reports: [{ nodeid: "t.py::test_x", when: "call", outcome: "failed", exc_type: "TypeError" }],
        }),
      ),
    ).toBe("exec_failed")
  })

  test("collection/setup failure is exec_failed", () => {
    expect(
      classifyPytestReportText(
        report({
          collected: 1,
          exitstatus: 1,
          reports: [{ nodeid: "t.py::test_x", when: "setup", outcome: "failed", exc_type: "RuntimeError" }],
        }),
      ),
    ).toBe("exec_failed")
  })

  test("green, no-tests, internal, and malformed cases are closed", () => {
    expect(
      classifyPytestReportText(
        report({
          collected: 1,
          exitstatus: 0,
          reports: [{ nodeid: "t.py::test_x", when: "call", outcome: "passed" }],
        }),
      ),
    ).toBe("resolved")
    expect(classifyPytestReportText(report({ collected: 0, exitstatus: 5 }))).toBe("unknown")
    expect(classifyPytestReportText(report({ collected: 1, exitstatus: 3 }))).toBe("other")
    expect(classifyPytestReportText("1 failed in 0.1s")).toBe("exec_failed")
    expect(classifyPytestExecutionReport(parsePytestExecutionReport("not json"))).toBe("exec_failed")
  })
})
