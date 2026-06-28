/**
 * Repro-test execution — unit contract (structured pytest sidecar verdict).
 *
 *   - classifyPytest: verdict from the controlled pytest sidecar JSON, NOT a
 *     model-printed sentinel and NOT stdout summary text.
 *   - executeReproTests: writes each candidate to a unique path; invokes the
 *     exec port with argv form; returns one sample per input; survives
 *     individual write / exec failures.
 *   - empty source skips exec and records "unknown".
 *   - AbortSignal between samples stops dispatching.
 */
import { describe, expect, test } from "bun:test"
import {
  classifyPytest,
  defaultTempPath,
  type ExecuteReproTestsArgs,
  executeReproTests,
  pytestReportPathFor,
} from "../../../src/agent/repro-test/execute"

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

const REPORT_FAILED = report({
  collected: 1,
  exitstatus: 1,
  reports: [
    { nodeid: "t.py::test_x", when: "call", outcome: "failed", exc_type: "AssertionError" },
  ],
})
const REPORT_PYTEST_FAIL = report({
  collected: 1,
  exitstatus: 1,
  reports: [{ nodeid: "t.py::test_x", when: "call", outcome: "failed", exc_type: "Failed" }],
})
const REPORT_PASSED = report({
  collected: 1,
  exitstatus: 0,
  reports: [{ nodeid: "t.py::test_x", when: "call", outcome: "passed" }],
})
const REPORT_SETUP_ERROR = report({
  collected: 1,
  exitstatus: 1,
  reports: [{ nodeid: "t.py::test_x", when: "setup", outcome: "failed", exc_type: "RuntimeError" }],
})
const REPORT_NO_TESTS = report({ collected: 0, exitstatus: 5 })
const REPORT_RAW_EXCEPTION = report({
  collected: 1,
  exitstatus: 1,
  reports: [{ nodeid: "t.py::test_x", when: "call", outcome: "failed", exc_type: "TypeError" }],
})
const REPORT_INTERNAL = report({ collected: 1, exitstatus: 3 })

const mkArgs = (
  overrides: Partial<ExecuteReproTestsArgs> & {
    tests: readonly string[]
    exec?: ExecuteReproTestsArgs["exec"]
    writeFile?: ExecuteReproTestsArgs["writeFile"]
  },
): ExecuteReproTestsArgs => ({
  repoRoot: "/sandbox",
  exec: overrides.exec ?? (async () => ({ code: 0, stdout: "", stderr: "" })),
  writeFile: overrides.writeFile ?? (async () => {}),
  readFile: overrides.readFile ?? (async () => REPORT_PASSED),
  tempPath: (i: number) => `/sandbox/__repro_${i}.py`,
  ...overrides,
})

describe("classifyPytest — pytest sidecar → outcome", () => {
  test("AssertionError call failure ⇒ reproduced", () => {
    expect(classifyPytest(REPORT_FAILED, "", 1)).toBe("reproduced")
  })

  test("pytest.fail call failure ⇒ reproduced", () => {
    expect(classifyPytest(REPORT_PYTEST_FAIL, "", 1)).toBe("reproduced")
  })

  test("passed call report ⇒ resolved", () => {
    expect(classifyPytest(REPORT_PASSED, "", 0)).toBe("resolved")
  })

  test("setup/collection style failure ⇒ exec_failed", () => {
    expect(classifyPytest(REPORT_SETUP_ERROR, "", 1)).toBe("exec_failed")
  })

  test("no collected tests ⇒ unknown", () => {
    expect(classifyPytest(REPORT_NO_TESTS, "", 5)).toBe("unknown")
  })

  test("raw exception bubbling out of call phase ⇒ reproduced", () => {
    // A non-assertion exception thrown by the code under test in the CALL phase is
    // a legitimate crash-bug reproduction (collection/setup/import errors stay exec_failed).
    expect(classifyPytest(REPORT_RAW_EXCEPTION, "", 1)).toBe("reproduced")
  })

  test("malformed/missing sidecar ⇒ exec_failed", () => {
    expect(classifyPytest("", "", 1)).toBe("exec_failed")
    expect(classifyPytest("not json", "", 1)).toBe("exec_failed")
  })

  test("pytest internal/usage sidecar status ⇒ other", () => {
    expect(classifyPytest(REPORT_INTERNAL, "", 3)).toBe("other")
  })

  test("stdout-looking pytest summaries are not authority", () => {
    expect(classifyPytest("1 failed in 0.1s", "", 1)).toBe("exec_failed")
  })
})

describe("executeReproTests", () => {
  test("writes each test to a unique path with argv-form python invocation", async () => {
    const calls: { path: string; content: string }[] = []
    const execCalls: { argv: readonly string[]; cwd: string }[] = []
    const reports = new Map<string, string>()
    const out = await executeReproTests(
      mkArgs({
        tests: ["def test_a(): assert False", "def test_b(): assert True"],
        writeFile: async (path, content) => {
          calls.push({ path, content })
        },
        exec: async (argv, cwd) => {
          execCalls.push({ argv, cwd })
          const last = argv[argv.length - 1] ?? ""
          // Map test path → pytest result by index in path.
          const idx = last.includes("__repro_0") ? 0 : 1
          reports.set(pytestReportPathFor(last), idx === 0 ? REPORT_FAILED : REPORT_PASSED)
          return idx === 0
            ? { code: 1, stdout: "1 failed in 0.1s", stderr: "" }
            : { code: 0, stdout: "1 passed in 0.1s", stderr: "" }
        },
        readFile: async (path) => reports.get(path) ?? "",
      }),
    )
    expect(calls).toHaveLength(2)
    expect(calls[0]?.path).toBe("/sandbox/__repro_0.py")
    expect(calls[0]?.content).toBe("def test_a(): assert False")
    expect(execCalls).toHaveLength(2)
    expect(execCalls[0]?.argv).toEqual(["python3", "/sandbox/__repro_0.py"])
    expect(execCalls[0]?.cwd).toBe("/sandbox")
    expect(out).toHaveLength(2)
    // sidecar AssertionError ⇒ reproduced; sidecar pass ⇒ resolved.
    expect(out[0]?.outcome).toBe("reproduced")
    expect(out[1]?.outcome).toBe("resolved")
  })

  test("A1: the RAW pytest sidecar report is surfaced on the sample (sidecarReport)", async () => {
    const out = await executeReproTests(
      mkArgs({
        tests: ["def test_a(): assert False"],
        exec: async (argv) => {
          // readFile (mkArgs default) returns REPORT_PASSED for every path.
          void argv
          return { code: 0, stdout: "1 passed in 0.1s", stderr: "" }
        },
        readFile: async () => REPORT_PASSED,
      }),
    )
    // The sample carries the exact bytes readFile produced — RCA can reconstruct
    // which test nodes passed/failed, not just the derived outcome label.
    expect(out[0]?.sidecarReport).toBe(REPORT_PASSED)
    expect(out[0]?.outcome).toBe("resolved")
  })

  test("empty source ⇒ unknown, no write, no exec", async () => {
    let writeCount = 0
    let execCount = 0
    const reports = new Map<string, string>()
    const out = await executeReproTests(
      mkArgs({
        tests: ["", "def test_x(): assert False"],
        writeFile: async () => {
          writeCount++
        },
        exec: async () => {
          execCount++
          reports.set(pytestReportPathFor("/sandbox/__repro_1.py"), REPORT_FAILED)
          return { code: 1, stdout: "1 failed in 0.1s", stderr: "" }
        },
        readFile: async (path) => reports.get(path) ?? "",
      }),
    )
    expect(writeCount).toBe(1)
    expect(execCount).toBe(1)
    expect(out[0]).toEqual({ source: "", stdout: "", stderr: "", outcome: "unknown" })
    expect(out[1]?.outcome).toBe("reproduced")
  })

  test("writeFile failure ⇒ exec_failed for that sample, continues", async () => {
    const out = await executeReproTests(
      mkArgs({
        tests: ["def test_a(): assert False", "def test_b(): assert True"],
        writeFile: async (path) => {
          if (path.includes("__repro_0")) throw new Error("disk full")
        },
        exec: async () => ({ code: 0, stdout: "1 passed in 0.1s", stderr: "" }),
      }),
    )
    expect(out[0]?.outcome).toBe("exec_failed")
    expect(out[1]?.outcome).toBe("resolved")
  })

  test("exec throws ⇒ exec_failed for that sample, continues", async () => {
    let firstCall = true
    const reports = new Map<string, string>()
    const out = await executeReproTests(
      mkArgs({
        tests: ["a", "b"],
        exec: async (argv) => {
          if (firstCall) {
            firstCall = false
            throw new Error("python missing")
          }
          reports.set(pytestReportPathFor(argv[argv.length - 1] ?? ""), REPORT_FAILED)
          return { code: 1, stdout: "1 failed in 0.1s", stderr: "" }
        },
        readFile: async (path) => reports.get(path) ?? "",
      }),
    )
    expect(out[0]?.outcome).toBe("exec_failed")
    // The throw reason is captured into stderr (never silent) — this is what
    // attributes a missing-binary ENOENT vs a crashed script on a remote box.
    expect(out[0]?.stderr).toContain("python missing")
    expect(out[0]?.stderr).toContain("[exec threw]")
    expect(out[1]?.outcome).toBe("reproduced")
  })

  test("pythonBin overrides the default python3 interpreter", async () => {
    const seen: string[] = []
    await executeReproTests(
      mkArgs({
        tests: ["a"],
        pythonBin: "/venv/bin/python",
        exec: async (argv) => {
          seen.push(argv[0] ?? "")
          return { code: 1, stdout: "1 failed in 0.1s", stderr: "" }
        },
      }),
    )
    expect(seen[0]).toBe("/venv/bin/python")
  })

  test("AbortSignal triggered ⇒ stops dispatching", async () => {
    const ac = new AbortController()
    let calls = 0
    const out = await executeReproTests(
      mkArgs({
        tests: ["a", "b", "c"],
        signal: ac.signal,
        exec: async () => {
          calls++
          if (calls === 1) ac.abort()
          return { code: 1, stdout: "1 failed in 0.1s", stderr: "" }
        },
      }),
    )
    expect(calls).toBe(1)
    expect(out).toHaveLength(1)
  })

  test("exec returns malformed result and no sidecar ⇒ exec_failed", async () => {
    const out = await executeReproTests(
      mkArgs({
        tests: ["a"],
        readFile: async () => {
          throw new Error("missing report")
        },
        exec: async () => ({
          code: undefined as unknown as number,
          stdout: undefined as unknown as string,
          stderr: "",
        }),
      }),
    )
    expect(out[0]?.outcome).toBe("exec_failed")
  })

  test("returns empty array for empty input", async () => {
    const out = await executeReproTests(mkArgs({ tests: [] }))
    expect(out).toEqual([])
  })

  // G2 paired-control: the REAL field-population seam. A control supplied for a
  // sample is executed on the base tree via the SAME pytest bridge; its verdict
  // folds into `baseControl` ("green" all-pass / "red" any-fail). This proves
  // the admission gate's field is populated by real exec, not a test fixture.
  describe("G2 paired-control population", () => {
    // Route each exec to a report keyed by its temp path so symptom + control
    // scripts get independent verdicts.
    const routedExec =
      (verdictFor: (path: string) => string, reports: Map<string, string>) =>
      async (argv: readonly string[]) => {
        const path = argv[argv.length - 1] ?? ""
        reports.set(pytestReportPathFor(path), verdictFor(path))
        return { code: 0, stdout: "", stderr: "" }
      }

    test("symptom reproduced + control PASSES on base ⇒ baseControl green", async () => {
      const reports = new Map<string, string>()
      const out = await executeReproTests(
        mkArgs({
          tests: ["def test_symptom(): assert wrong()"],
          controlTests: [["def test_happy(): assert basic()"]],
          // Symptom script (index 0) ⇒ FAILED (reproduced); control script
          // (offset index 1000) ⇒ PASSED (resolved ⇒ control green).
          exec: routedExec(
            (path) => (path.includes("__repro_0.py") ? REPORT_FAILED : REPORT_PASSED),
            reports,
          ),
          tempPath: (i: number) => `/sandbox/__repro_${i}.py`,
          readFile: async (path) => reports.get(path) ?? "",
        }),
      )
      expect(out[0]?.outcome).toBe("reproduced")
      expect(out[0]?.baseControl).toBe("green")
    })

    test("env broken: symptom reproduced but control FAILS on base ⇒ baseControl red", async () => {
      const reports = new Map<string, string>()
      const out = await executeReproTests(
        mkArgs({
          tests: ["def test_symptom(): assert wrong()"],
          controlTests: [["def test_happy(): import broken_pkg"]],
          // Symptom ⇒ FAILED (reproduced); control ⇒ setup error (exec_failed,
          // i.e. the import broke) ⇒ NOT resolved ⇒ control red.
          exec: routedExec(
            (path) => (path.includes("__repro_0.py") ? REPORT_FAILED : REPORT_SETUP_ERROR),
            reports,
          ),
          tempPath: (i: number) => `/sandbox/__repro_${i}.py`,
          readFile: async (path) => reports.get(path) ?? "",
        }),
      )
      // This is the astropy-13033 false-red: the symptom looks reproduced but
      // the env is broken (control could not pass), so the gate must reject it.
      expect(out[0]?.outcome).toBe("reproduced")
      expect(out[0]?.baseControl).toBe("red")
    })

    test("any single control failing ⇒ baseControl red (all must pass)", async () => {
      const reports = new Map<string, string>()
      const out = await executeReproTests(
        mkArgs({
          tests: ["def test_symptom(): assert wrong()"],
          controlTests: [["def test_a(): pass", "def test_b(): assert False"]],
          exec: routedExec((path) => {
            if (path.includes("__repro_0.py")) return REPORT_FAILED // symptom
            // control index 0 (offset 1000) passes; control index 1 (1001) fails
            return path.includes("__repro_1000.py") ? REPORT_PASSED : REPORT_FAILED
          }, reports),
          tempPath: (i: number) => `/sandbox/__repro_${i}.py`,
          readFile: async (path) => reports.get(path) ?? "",
        }),
      )
      expect(out[0]?.baseControl).toBe("red")
    })

    test("no controls supplied ⇒ baseControl absent (undefined) — legacy shape", async () => {
      const reports = new Map<string, string>()
      const out = await executeReproTests(
        mkArgs({
          tests: ["def test_symptom(): assert wrong()"],
          exec: routedExec(() => REPORT_FAILED, reports),
          tempPath: (i: number) => `/sandbox/__repro_${i}.py`,
          readFile: async (path) => reports.get(path) ?? "",
        }),
      )
      expect(out[0]?.outcome).toBe("reproduced")
      expect(out[0]?.baseControl).toBeUndefined()
    })

    test("control temp paths never collide with symptom temp paths", async () => {
      const written: string[] = []
      const reports = new Map<string, string>()
      await executeReproTests(
        mkArgs({
          tests: ["def test_symptom(): assert wrong()"],
          controlTests: [["def test_happy(): pass"]],
          writeFile: async (path) => {
            written.push(path)
          },
          exec: routedExec(
            (path) => (path.includes("__repro_0.py") ? REPORT_FAILED : REPORT_PASSED),
            reports,
          ),
          tempPath: (i: number) => `/sandbox/__repro_${i}.py`,
          readFile: async (path) => reports.get(path) ?? "",
        }),
      )
      // symptom path is __repro_0.py; control path is __repro_1000.py — distinct.
      expect(new Set(written).size).toBe(written.length)
      expect(written).toContain("/sandbox/__repro_0.py")
      expect(written.some((p) => p.includes("__repro_1000.py"))).toBe(true)
    })
  })
})

describe("defaultTempPath — fallback collision-resistance (FIX B)", () => {
  test("with crypto present ⇒ paths inside repoRoot, embed index", () => {
    const p = defaultTempPath("/sandbox", 2)
    expect(p.startsWith("/sandbox/__repro_2_")).toBe(true)
    expect(p.endsWith(".py")).toBe(true)
  })

  test("crypto-undefined fallback ⇒ DISTINCT paths for same-ms same-index calls", () => {
    // Freeze the clock so Date.now() is identical across both calls — this is the
    // concurrent same-millisecond / same-index collision the old `${Date.now()}-${i}`
    // fallback produced (identical path ⇒ cross-contaminated repro scripts).
    const realNow = Date.now
    Date.now = () => 1_700_000_000_000
    try {
      const a = defaultTempPath("/sandbox", 0, null)
      const b = defaultTempPath("/sandbox", 0, null)
      expect(a).not.toBe(b) // RED on the old fallback: a === b
      expect(a.startsWith("/sandbox/__repro_0_")).toBe(true)
      expect(b.startsWith("/sandbox/__repro_0_")).toBe(true)
    } finally {
      Date.now = realNow
    }
  })

  test("fallback ids are unique across many same-ms same-index calls", () => {
    const realNow = Date.now
    Date.now = () => 1_700_000_000_000
    try {
      const seen = new Set<string>()
      for (let k = 0; k < 1000; k++) seen.add(defaultTempPath("/sandbox", 0, null))
      expect(seen.size).toBe(1000)
    } finally {
      Date.now = realNow
    }
  })
})
