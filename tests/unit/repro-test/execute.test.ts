/**
 * Repro-test execution — unit contract.
 *
 *   - classifyStdout: last-marker-wins; non-zero exit + no marker ⇒ exec_failed;
 *     zero exit + no marker ⇒ unknown; multiple markers ⇒ last position wins.
 *   - executeReproTests: writes each candidate to a unique path; invokes the
 *     exec port with argv form; returns one sample per input; survives
 *     individual write / exec failures.
 *   - empty source skips exec and records "unknown".
 *   - AbortSignal between samples stops dispatching.
 */
import { describe, expect, test } from "bun:test"
import {
  classifyStdout,
  type ExecuteReproTestsArgs,
  executeReproTests,
} from "../../../src/agent/repro-test/execute"

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

describe("classifyStdout", () => {
  test("'Issue reproduced' ⇒ reproduced", () => {
    expect(classifyStdout("Issue reproduced\n", 0)).toBe("reproduced")
  })

  test("'Issue resolved' ⇒ resolved", () => {
    expect(classifyStdout("Issue resolved\n", 0)).toBe("resolved")
  })

  test("'Other issues' ⇒ other", () => {
    expect(classifyStdout("Other issues\n", 0)).toBe("other")
  })

  test("multiple markers — last position wins", () => {
    expect(classifyStdout("Issue reproduced\nIssue resolved\n", 0)).toBe("resolved")
    expect(classifyStdout("Issue resolved\nIssue reproduced\n", 0)).toBe("reproduced")
    expect(classifyStdout("Other issues\nIssue reproduced\n", 0)).toBe("reproduced")
  })

  test("no marker + exit=0 ⇒ unknown", () => {
    expect(classifyStdout("just some output\n", 0)).toBe("unknown")
    expect(classifyStdout("", 0)).toBe("unknown")
  })

  test("no marker + exit≠0 ⇒ exec_failed", () => {
    expect(classifyStdout("traceback ...", 1)).toBe("exec_failed")
    expect(classifyStdout("", 137)).toBe("exec_failed")
    expect(classifyStdout("", -1)).toBe("exec_failed")
  })

  test("marker present + exit≠0 ⇒ outcome wins over exit code", () => {
    // Script printed the marker before crashing; the marker is authoritative.
    expect(classifyStdout("Issue reproduced\n", 1)).toBe("reproduced")
  })

  test("non-string stdout is treated as empty", () => {
    expect(classifyStdout(undefined as unknown as string, 0)).toBe("unknown")
    expect(classifyStdout(null as unknown as string, 0)).toBe("unknown")
  })

  test("marker substrings inside other text — last lastIndexOf wins", () => {
    // The classifier uses lastIndexOf; markers embedded in noise are still
    // picked up. The paper's print is line-exact but real stdout may include
    // logger noise — the classifier deliberately tolerates that.
    const noisy = "DEBUG: setup done\nIssue reproduced\nDEBUG: cleanup"
    expect(classifyStdout(noisy, 0)).toBe("reproduced")
  })
})

describe("executeReproTests", () => {
  test("writes each test to a unique path with argv-form python invocation", async () => {
    const calls: { path: string; content: string }[] = []
    const execCalls: { argv: readonly string[]; cwd: string }[] = []
    const out = await executeReproTests(
      mkArgs({
        tests: ['print("Issue reproduced")', 'print("Issue resolved")'],
        writeFile: async (path, content) => {
          calls.push({ path, content })
        },
        exec: async (argv, cwd) => {
          execCalls.push({ argv, cwd })
          const last = argv[argv.length - 1] ?? ""
          // Map test path → stdout by index in path.
          const idx = last.includes("__repro_0") ? 0 : 1
          return {
            code: 0,
            stdout: idx === 0 ? "Issue reproduced\n" : "Issue resolved\n",
            stderr: "",
          }
        },
      }),
    )
    expect(calls).toHaveLength(2)
    expect(calls[0]?.path).toBe("/sandbox/__repro_0.py")
    expect(calls[0]?.content).toBe('print("Issue reproduced")')
    expect(execCalls).toHaveLength(2)
    expect(execCalls[0]?.argv).toEqual(["python3", "/sandbox/__repro_0.py"])
    expect(execCalls[0]?.cwd).toBe("/sandbox")
    expect(out).toHaveLength(2)
    expect(out[0]?.outcome).toBe("reproduced")
    expect(out[1]?.outcome).toBe("resolved")
  })

  test("empty source ⇒ unknown, no write, no exec", async () => {
    let writeCount = 0
    let execCount = 0
    const out = await executeReproTests(
      mkArgs({
        tests: ["", 'print("Issue reproduced")'],
        writeFile: async () => {
          writeCount++
        },
        exec: async () => {
          execCount++
          return { code: 0, stdout: "Issue reproduced", stderr: "" }
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
        tests: ['print("Issue reproduced")', 'print("Issue resolved")'],
        writeFile: async (path) => {
          if (path.includes("__repro_0")) throw new Error("disk full")
        },
        exec: async () => ({ code: 0, stdout: "Issue resolved", stderr: "" }),
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
          return { code: 0, stdout: "Issue reproduced", stderr: "" }
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
          return { code: 0, stdout: "Issue reproduced", stderr: "" }
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
          return { code: 0, stdout: "Issue reproduced", stderr: "" }
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
