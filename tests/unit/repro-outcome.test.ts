import { describe, expect, test } from "bun:test"
import {
  classifyPytestExecutionReport,
  classifyPytestReportText,
  parsePytestExecutionReport,
} from "@/agent/repro-test/pytest-report"
import { selectReproTest } from "@/agent/repro-test/select"
import type { ReproTestSample } from "@/agent/repro-test/types"

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
  test("AssertionError call failure is a red witness shape", () => {
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
          reports: [
            { nodeid: "t.py::test_x", when: "call", outcome: "failed", exc_type: "Failed" },
          ],
        }),
      ),
    ).toBe("reproduced")
  })

  test("call-phase raw TypeError from code under test is a reproduction", () => {
    expect(
      classifyPytestReportText(
        report({
          collected: 1,
          exitstatus: 1,
          reports: [
            { nodeid: "t.py::test_x", when: "call", outcome: "failed", exc_type: "TypeError" },
          ],
        }),
      ),
    ).toBe("reproduced")
  })

  test("call-phase raw AttributeError from code under test is a reproduction", () => {
    expect(
      classifyPytestReportText(
        report({
          collected: 1,
          exitstatus: 1,
          reports: [
            { nodeid: "t.py::test_x", when: "call", outcome: "failed", exc_type: "AttributeError" },
          ],
        }),
      ),
    ).toBe("reproduced")
  })

  test("GUARDRAIL: setup-phase RuntimeError (pytest ERROR) stays exec_failed", () => {
    expect(
      classifyPytestReportText(
        report({
          collected: 1,
          exitstatus: 1,
          reports: [
            { nodeid: "t.py::test_x", when: "setup", outcome: "failed", exc_type: "RuntimeError" },
          ],
        }),
      ),
    ).toBe("exec_failed")
  })

  test("GUARDRAIL: collection-phase failure stays exec_failed", () => {
    expect(
      classifyPytestReportText(
        report({
          collected: 1,
          exitstatus: 2,
          reports: [{ nodeid: "t.py", when: "collect", outcome: "failed", exc_type: "NameError" }],
        }),
      ),
    ).toBe("exec_failed")
  })

  test("GUARDRAIL: call-phase ImportError (env/import break) stays exec_failed", () => {
    expect(
      classifyPytestReportText(
        report({
          collected: 1,
          exitstatus: 1,
          reports: [
            { nodeid: "t.py::test_x", when: "call", outcome: "failed", exc_type: "ImportError" },
          ],
        }),
      ),
    ).toBe("exec_failed")
  })

  test("GUARDRAIL: call-phase ModuleNotFoundError stays exec_failed", () => {
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
              exc_type: "ModuleNotFoundError",
            },
          ],
        }),
      ),
    ).toBe("exec_failed")
  })

  test("GUARDRAIL: call-phase SyntaxError stays exec_failed", () => {
    expect(
      classifyPytestReportText(
        report({
          collected: 1,
          exitstatus: 1,
          reports: [
            { nodeid: "t.py::test_x", when: "call", outcome: "failed", exc_type: "SyntaxError" },
          ],
        }),
      ),
    ).toBe("exec_failed")
  })

  test("GUARDRAIL: call-phase FAILED with NO exc_type stays exec_failed", () => {
    expect(
      classifyPytestReportText(
        report({
          collected: 1,
          exitstatus: 1,
          reports: [{ nodeid: "t.py::test_x", when: "call", outcome: "failed" }],
        }),
      ),
    ).toBe("exec_failed")
  })

  test("GUARDRAIL: a raw-exception reproduction is suppressed when ANY infra failure co-occurs", () => {
    // A call-phase TypeError (would-be reproduction) AND a setup RuntimeError
    // (env untrustworthy) ⇒ exec_failed, never reproduced.
    expect(
      classifyPytestReportText(
        report({
          collected: 1,
          exitstatus: 1,
          reports: [
            { nodeid: "t.py::test_x", when: "setup", outcome: "failed", exc_type: "RuntimeError" },
            { nodeid: "t.py::test_x", when: "call", outcome: "failed", exc_type: "TypeError" },
          ],
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
    expect(classifyPytestExecutionReport(parsePytestExecutionReport("not json"))).toBe(
      "exec_failed",
    )
  })

  test("patched-side resolution is unchanged: a green test is 'resolved', never affected by this change", () => {
    // The candidate-is-resolved path keys ONLY on a passing call report. A raw
    // exception classified as "reproduced" can never produce a false-green here.
    expect(
      classifyPytestReportText(
        report({
          collected: 1,
          exitstatus: 0,
          reports: [{ nodeid: "t.py::test_x", when: "call", outcome: "passed" }],
        }),
      ),
    ).toBe("resolved")
    // A patched candidate whose test STILL raises a TypeError is NOT resolved —
    // it is "reproduced" (still red), so it cannot be admitted as a fix.
    expect(
      classifyPytestReportText(
        report({
          collected: 1,
          exitstatus: 1,
          reports: [
            { nodeid: "t.py::test_x", when: "call", outcome: "failed", exc_type: "TypeError" },
          ],
        }),
      ),
    ).not.toBe("resolved")
  })
})

describe("repro classify → vote admission (end-to-end witness)", () => {
  const sampleFrom = (source: string, sidecar: string): ReproTestSample => ({
    source,
    stdout: "",
    outcome: classifyPytestReportText(sidecar),
  })

  const callFailure = (excType: string): string =>
    report({
      collected: 1,
      exitstatus: 1,
      reports: [{ nodeid: "t.py::test_repro", when: "call", outcome: "failed", exc_type: excType }],
    })

  const collectionFailure = (): string =>
    report({
      collected: 1,
      exitstatus: 2,
      reports: [{ nodeid: "t.py", when: "collect", outcome: "failed", exc_type: "ImportError" }],
    })

  test("a call-phase raw-exception reproduction is ADMITTED to the majority vote", () => {
    const src = "def test_repro():\n    crash()\n"
    const samples = [sampleFrom(src, callFailure("TypeError"))]
    const selection = selectReproTest(samples)
    expect(selection.reproducedCount).toBe(1)
    expect(selection.selected).toBe(src)
  })

  test("CONTROL: an import/collection error is NOT admitted to the vote", () => {
    const src = "def test_repro():\n    crash()\n"
    const samples = [sampleFrom(src, collectionFailure())]
    const selection = selectReproTest(samples)
    expect(selection.reproducedCount).toBe(0)
    expect(selection.selected).toBeNull()
  })

  test("CONTROL: a call-phase ImportError is NOT admitted to the vote", () => {
    const src = "def test_repro():\n    import broken\n"
    const samples = [sampleFrom(src, callFailure("ImportError"))]
    const selection = selectReproTest(samples)
    expect(selection.reproducedCount).toBe(0)
    expect(selection.selected).toBeNull()
  })

  test("TEETH: reverting to AssertionError-only classification drops the raw-exception case", () => {
    // Mirror the OLD predicate. If the fix regresses to assertion-only, the
    // TypeError sidecar classifies as exec_failed and the vote loses it.
    const oldAssertionOnlyClassify = (sidecar: string): ReproTestSample["outcome"] => {
      const parsed = parsePytestExecutionReport(sidecar)
      if (parsed === null) return "exec_failed"
      const assertionOnly = new Set(["AssertionError", "Failed"])
      const isAssertionCall = (r: { when: string; outcome: string; exc_type?: string }): boolean =>
        r.when === "call" &&
        r.outcome === "failed" &&
        r.exc_type !== undefined &&
        assertionOnly.has(r.exc_type)
      if (parsed.reports.some((r) => r.outcome === "failed" && !isAssertionCall(r))) {
        return "exec_failed"
      }
      if (parsed.reports.some(isAssertionCall)) return "reproduced"
      return "unknown"
    }

    const src = "def test_repro():\n    crash()\n"
    const sidecar = callFailure("TypeError")

    // NEW behaviour: admitted.
    expect(classifyPytestReportText(sidecar)).toBe("reproduced")
    expect(selectReproTest([sampleFrom(src, sidecar)]).reproducedCount).toBe(1)

    // OLD behaviour: dropped. This is the teeth — if someone reverts the fix the
    // raw-exception reproduction silently vanishes from the oracle.
    const old: ReproTestSample = {
      source: src,
      stdout: "",
      outcome: oldAssertionOnlyClassify(sidecar),
    }
    expect(old.outcome).toBe("exec_failed")
    expect(selectReproTest([old]).reproducedCount).toBe(0)
  })
})
