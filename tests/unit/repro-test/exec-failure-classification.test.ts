/**
 * F3D — split `exec_failed` into `infra_unavailable` vs `test_errored` (jun-25).
 *
 * PRINCIPLE: an infrastructure failure (the test harness could not RUN —
 * exit127/ENOENT/python-missing/timeout-kill/sidecar-missing-because-infra) is
 * NOT a verdict and must fail-OPEN. It must be DISTINGUISHABLE from a
 * `test_errored` (pytest RAN and the test/collection/setup errored — a real
 * signal). Neither rejects a candidate here (both stay outcome `exec_failed`,
 * which every consumer already treats as inconclusive), but the SUB-KIND must be
 * recorded so the conflation is auditable and a launch-failure is never read as
 * a test-correctness signal.
 *
 * INVARIANT (paired control): a clean non-zero pytest exit with a COLLECTED
 * call-phase failure must NOT be `exec_failed` at all — it is a real
 * `reproduced` red. F3D must not fold a real verdict into infra.
 */
import { describe, expect, test } from "bun:test"
import {
  classifyExecFailureKind,
  type ExecuteReproTestsArgs,
  executeReproTests,
  pytestReportPathFor,
} from "@/agent/repro-test/execute"

const mkArgs = (over: Partial<ExecuteReproTestsArgs>): ExecuteReproTestsArgs => ({
  tests: [],
  repoRoot: "/sandbox",
  exec: async () => ({ code: 0, stdout: "", stderr: "" }),
  writeFile: async () => {},
  readFile: async () => "",
  tempPath: (i) => `/sandbox/__repro_${i}.py`,
  ...over,
})

// A pytest run that COLLECTED a test (collected:1) but the test's SETUP errored
// (a non-call `when` failure) ⇒ classifyPytest → exec_failed, and the report is
// parseable ⇒ pytest RAN ⇒ test_errored. (A pure collection error reports
// collected:0 / exit 5 which the classifier maps to `unknown`, not exec_failed.)
const REPORT_COLLECTION_ERROR = JSON.stringify({
  schema: 1,
  collected: 1,
  exitstatus: 1,
  reports: [{ nodeid: "t.py::test_x", when: "setup", outcome: "failed", exc_type: "ImportError" }],
})

const REPORT_CALL_FAILURE = JSON.stringify({
  schema: 1,
  collected: 1,
  exitstatus: 1,
  reports: [
    { nodeid: "t.py::test_x", when: "call", outcome: "failed", exc_type: "AssertionError" },
  ],
})

describe("F3D: classifyExecFailureKind (pure)", () => {
  // ── infra_unavailable: the harness could not RUN ─────────────────────────
  test("no report text at all ⇒ infra_unavailable (process produced no sidecar)", () => {
    expect(classifyExecFailureKind({ reportText: undefined })).toBe("infra_unavailable")
  })

  test("exec port threw (ENOENT/python-missing) ⇒ infra_unavailable", () => {
    expect(classifyExecFailureKind({ reportText: undefined, execThrew: true })).toBe(
      "infra_unavailable",
    )
  })

  test("unparseable / non-JSON sidecar ⇒ infra_unavailable (no real pytest report)", () => {
    expect(classifyExecFailureKind({ reportText: "not json" })).toBe("infra_unavailable")
    expect(classifyExecFailureKind({ reportText: "" })).toBe("infra_unavailable")
  })

  // ── test_errored: pytest RAN and the test/collection/setup errored ───────
  test("a parseable pytest report with a collection/setup error ⇒ test_errored", () => {
    expect(classifyExecFailureKind({ reportText: REPORT_COLLECTION_ERROR })).toBe("test_errored")
  })
})

describe("F3D: executeReproTests threads execFailure sub-kind", () => {
  test("exec port THREW (python missing) ⇒ exec_failed + execFailure=infra_unavailable", async () => {
    const out = await executeReproTests(
      mkArgs({
        tests: ["a"],
        exec: async () => {
          throw new Error("spawn python3 ENOENT")
        },
      }),
    )
    expect(out[0]?.outcome).toBe("exec_failed")
    expect(out[0]?.execFailure).toBe("infra_unavailable")
  })

  test("writeFile THREW (disk/infra) ⇒ exec_failed + execFailure=infra_unavailable", async () => {
    const out = await executeReproTests(
      mkArgs({
        tests: ["a"],
        writeFile: async () => {
          throw new Error("disk full")
        },
      }),
    )
    expect(out[0]?.outcome).toBe("exec_failed")
    expect(out[0]?.execFailure).toBe("infra_unavailable")
  })

  test("pytest RAN but collection errored (real report) ⇒ exec_failed + execFailure=test_errored", async () => {
    const reports = new Map<string, string>()
    const out = await executeReproTests(
      mkArgs({
        tests: ["a"],
        exec: async (argv) => {
          reports.set(pytestReportPathFor(argv[argv.length - 1] ?? ""), REPORT_COLLECTION_ERROR)
          return { code: 2, stdout: "", stderr: "collection error" }
        },
        readFile: async (path) => reports.get(path) ?? "",
      }),
    )
    expect(out[0]?.outcome).toBe("exec_failed")
    expect(out[0]?.execFailure).toBe("test_errored")
  })

  test("missing sidecar (process produced no report) ⇒ exec_failed + execFailure=infra_unavailable", async () => {
    const out = await executeReproTests(
      mkArgs({
        tests: ["a"],
        exec: async () => ({ code: 1, stdout: "", stderr: "" }),
        readFile: async () => {
          throw new Error("ENOENT report")
        },
      }),
    )
    expect(out[0]?.outcome).toBe("exec_failed")
    expect(out[0]?.execFailure).toBe("infra_unavailable")
  })

  // ── PAIRED CONTROL: a REAL verdict is NOT exec_failed and carries no kind ─
  test("a clean non-zero pytest with a collected call-failure stays `reproduced` (NOT exec_failed)", async () => {
    const reports = new Map<string, string>()
    const out = await executeReproTests(
      mkArgs({
        tests: ["a"],
        exec: async (argv) => {
          reports.set(pytestReportPathFor(argv[argv.length - 1] ?? ""), REPORT_CALL_FAILURE)
          return { code: 1, stdout: "1 failed", stderr: "" }
        },
        readFile: async (path) => reports.get(path) ?? "",
      }),
    )
    expect(out[0]?.outcome).toBe("reproduced")
    // A real red is not an exec failure ⇒ no sub-kind is attached.
    expect(out[0]?.execFailure).toBeUndefined()
  })
})
