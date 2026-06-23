/**
 * Repro-test execution — unit contract (P1: pytest-exit-grounded verdict).
 *
 *   - classifyPytest: verdict from pytest exit code + parsed summary line, NOT a
 *     model-printed sentinel. "N failed" ⇒ reproduced; "N error" ⇒ exec_failed;
 *     "N passed" ⇒ resolved; "no tests ran" / exit 5 ⇒ unknown; non-zero exit
 *     with no summary (import crash) ⇒ exec_failed; exit 3/4 ⇒ other.
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
} from "../../../src/agent/repro-test/execute"

/** Real pytest summary lines (terse `-q` mode) — captured from pytest 6.x so
 *  the classifier tests exercise the EXACT strings pytest emits, not a guess. */
const SUM_FAILED = "FAILED t.py::test_x - assert 1 == 2\n1 failed in 0.24s"
const SUM_PASSED = ".                                            [100%]\n1 passed in 0.21s"
const SUM_ERROR = "ERROR t.py::test_x - RuntimeError: setup boom\n1 error in 0.26s"
const SUM_NO_TESTS = "no tests ran in 0.20s"

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
  tempPath: (i: number) => `/sandbox/__repro_${i}.py`,
  ...overrides,
})

describe("classifyPytest — pytest exit/summary → outcome", () => {
  test("'N failed' summary ⇒ reproduced (assertion failed = bug present)", () => {
    expect(classifyPytest(SUM_FAILED, "", 1)).toBe("reproduced")
  })

  test("'N passed' summary ⇒ resolved (green)", () => {
    expect(classifyPytest(SUM_PASSED, "", 0)).toBe("resolved")
  })

  test("'N error' summary (collection/setup) ⇒ exec_failed (NOT a verdict)", () => {
    // pytest exits 1 for a setup/collection error JUST LIKE a real failure — the
    // summary "error" (not "failed") is the ONLY thing that disambiguates them.
    expect(classifyPytest(SUM_ERROR, "", 1)).toBe("exec_failed")
  })

  test("'no tests ran' ⇒ unknown; exit 5 (no tests collected) ⇒ unknown", () => {
    expect(classifyPytest(SUM_NO_TESTS, "", 5)).toBe("unknown")
    expect(classifyPytest("", "", 5)).toBe("unknown")
  })

  test("failed WINS over passed/error in the same run (a failure is a failure)", () => {
    // "1 failed, 1 passed" ⇒ the bug still reproduces ⇒ reproduced.
    expect(classifyPytest("1 failed, 1 passed in 0.3s", "", 1)).toBe("reproduced")
    // "1 failed, 1 error" ⇒ still reproduced.
    expect(classifyPytest("1 failed, 1 error in 0.3s", "", 1)).toBe("reproduced")
  })

  test("import crash: exit≠0 + NO pytest summary ⇒ exec_failed (project not importable)", () => {
    // The script died at `import projectlib` BEFORE the footer drove pytest, so
    // there is no summary line at all. This is infra (project not importable),
    // NOT a reproduced bug — the exact import-crash-vs-failure confound.
    expect(classifyPytest("", "ModuleNotFoundError: No module named 'foo'", 1)).toBe("exec_failed")
    expect(classifyPytest("", "", 1)).toBe("exec_failed")
  })

  test("timeout-kill (code 137, no summary) ⇒ exec_failed", () => {
    expect(classifyPytest("", "killed", 137)).toBe("exec_failed")
    expect(classifyPytest("", "", -1)).toBe("exec_failed")
  })

  test("pytest internal/usage error (exit 3/4, no summary) ⇒ other", () => {
    expect(classifyPytest("INTERNALERROR> ...", "", 3)).toBe("other")
    expect(classifyPytest("ERROR: usage", "", 4)).toBe("other")
  })

  test("exit 0 with no summary at all ⇒ unknown (ran clean, no signal)", () => {
    expect(classifyPytest("just some output\n", "", 0)).toBe("unknown")
    expect(classifyPytest("", "", 0)).toBe("unknown")
  })

  test("summary may land on stderr — classifier reads BOTH streams", () => {
    expect(classifyPytest("", "1 failed in 0.2s", 1)).toBe("reproduced")
    expect(classifyPytest("", "1 passed in 0.2s", 0)).toBe("resolved")
  })

  test("non-string stdout/stderr treated as empty (no runtime crash)", () => {
    expect(classifyPytest(undefined as unknown as string, "", 0)).toBe("unknown")
    expect(classifyPytest(null as unknown as string, null as unknown as string, 0)).toBe("unknown")
  })

  test("word-boundary: a test NAME containing 'failed' does NOT spoof the summary", () => {
    // Only "<N> failed" (digits + space + failed) counts as a summary token; a
    // passing test whose name mentions 'failed' must NOT classify reproduced.
    const out = "test_failed_path PASSED\n1 passed in 0.1s"
    expect(classifyPytest(out, "", 0)).toBe("resolved")
  })

  test("MUTATION: a script that PRINTS 'Issue resolved' but whose pytest FAILS ⇒ reproduced", () => {
    // This is the EXACT fakeability we removed. The legacy sentinel scan would
    // have read "Issue resolved" and returned `resolved` (a fake green). The
    // pytest-grounded classifier ignores the printed string entirely and trusts
    // the "1 failed" summary ⇒ reproduced. If this ever returns "resolved" the
    // sentinel scan has crept back in.
    const fakeGreen = "Issue resolved\nIssue resolved\nFAILED t.py::test_x\n1 failed in 0.2s"
    expect(classifyPytest(fakeGreen, "", 1)).toBe("reproduced")
  })
})

describe("executeReproTests", () => {
  test("writes each test to a unique path with argv-form python invocation", async () => {
    const calls: { path: string; content: string }[] = []
    const execCalls: { argv: readonly string[]; cwd: string }[] = []
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
          return idx === 0
            ? { code: 1, stdout: "1 failed in 0.1s", stderr: "" }
            : { code: 0, stdout: "1 passed in 0.1s", stderr: "" }
        },
      }),
    )
    expect(calls).toHaveLength(2)
    expect(calls[0]?.path).toBe("/sandbox/__repro_0.py")
    expect(calls[0]?.content).toBe("def test_a(): assert False")
    expect(execCalls).toHaveLength(2)
    expect(execCalls[0]?.argv).toEqual(["python3", "/sandbox/__repro_0.py"])
    expect(execCalls[0]?.cwd).toBe("/sandbox")
    expect(out).toHaveLength(2)
    // pytest "1 failed" ⇒ reproduced; "1 passed" ⇒ resolved.
    expect(out[0]?.outcome).toBe("reproduced")
    expect(out[1]?.outcome).toBe("resolved")
  })

  test("empty source ⇒ unknown, no write, no exec", async () => {
    let writeCount = 0
    let execCount = 0
    const out = await executeReproTests(
      mkArgs({
        tests: ["", "def test_x(): assert False"],
        writeFile: async () => {
          writeCount++
        },
        exec: async () => {
          execCount++
          return { code: 1, stdout: "1 failed in 0.1s", stderr: "" }
        },
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
    const out = await executeReproTests(
      mkArgs({
        tests: ["a", "b"],
        exec: async () => {
          if (firstCall) {
            firstCall = false
            throw new Error("python missing")
          }
          return { code: 1, stdout: "1 failed in 0.1s", stderr: "" }
        },
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

  test("exec returns malformed result ⇒ classifyStdout handles it", async () => {
    const out = await executeReproTests(
      mkArgs({
        tests: ["a"],
        exec: async () => ({
          code: undefined as unknown as number,
          stdout: undefined as unknown as string,
          stderr: "",
        }),
      }),
    )
    // No stdout / no code ⇒ exec_failed (code defaults to -1).
    expect(out[0]?.outcome).toBe("exec_failed")
  })

  test("returns empty array for empty input", async () => {
    const out = await executeReproTests(mkArgs({ tests: [] }))
    expect(out).toEqual([])
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
