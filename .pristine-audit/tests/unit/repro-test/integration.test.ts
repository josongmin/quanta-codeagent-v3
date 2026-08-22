/**
 * Repro-test slice end-to-end — generate → execute → select (P1: pytest verdict).
 *
 * Mocks the LLM port + exec port; demonstrates the algorithm on a synthetic
 * 5-sample run shaped after the requests-5414 issue (IDNAError on invalid URL).
 * The generated candidates are PYTEST tests; the exec port writes structured
 * pytest sidecar reports. The outcome is grounded in that report, NOT stdout or
 * a model-printed sentinel.
 */
import { describe, expect, test } from "bun:test"
import {
  type ExecuteReproTestsArgs,
  executeReproTests,
  pytestReportPathFor,
} from "../../../src/agent/repro-test/execute"
import { ensurePytestFooter, generateReproTests } from "../../../src/agent/repro-test/generate"
import { selectReproTest } from "../../../src/agent/repro-test/select"
import type { LLMPort, StreamEvent, StreamInput } from "../../../src/llm"

class ScriptedSampleLLM implements LLMPort {
  calls = 0
  constructor(private readonly samples: string[]) {}
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    const idx = this.calls
    this.calls += 1
    yield {
      type: "text_delta",
      delta: this.samples[idx] ?? this.samples[this.samples.length - 1] ?? "",
    }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

// Three variants of test A: same logic, differing fn name + a comment, so they
// collapse to ONE normalised key under select.ts's fn-name + comment rules.
const TEST_A_NAMED = [
  "import requests",
  "",
  "def test_unicode_a():",
  "    with pytest.raises(UnicodeError):",
  '        requests.get("http://.example.com")',
].join("\n")

const TEST_A_DIFFERENT_NAME = [
  "import requests",
  "",
  "def test_invalid_url_42():  # different fn name, same logic",
  "    with pytest.raises(UnicodeError):",
  '        requests.get("http://.example.com")',
].join("\n")

const TEST_A_WITH_COMMENT = [
  "import requests",
  "",
  "# slightly different — extra comment shouldn't matter",
  "def test_unicode_b():",
  "    with pytest.raises(UnicodeError):",
  '        requests.get("http://.example.com")',
].join("\n")

const TEST_B_DIFFERENT = [
  "import requests",
  "",
  "# completely different shape",
  "def test_bad_host():",
  "    with pytest.raises(Exception):",
  '        requests.get("http://[bad]")',
].join("\n")

// A candidate that collects NO tests (no def test_*) ⇒ pytest "no tests ran".
const TEST_NO_TESTS = ["import requests", "", "x = 1  # no test function here"].join("\n")

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
const REPORT_NO_TESTS = report({ collected: 0, exitstatus: 5 })

describe("repro-test end-to-end — requests-5414 shape", () => {
  test("5-sample run picks the majority test, returning original source", async () => {
    // 3 variants of test A (collapse to same normalised key) + 1 different test
    // B + 1 "no tests" sample.
    const llm = new ScriptedSampleLLM([
      TEST_A_NAMED,
      TEST_A_DIFFERENT_NAME,
      TEST_A_WITH_COMMENT,
      TEST_B_DIFFERENT,
      TEST_NO_TESTS,
    ])

    // Generate — the self-driving pytest footer is appended to each.
    const tests = await generateReproTests({
      issue: "UnicodeError raised when scheme is missing and host has leading dot",
      llm,
      config: { samples: 5 },
    })
    expect(tests).toHaveLength(5)
    expect(llm.calls).toBe(5)

    // Execute — synthetic exec port writes the same sidecar shape the footer
    // writes: assertion failure ⇒ reproduced; no tests ⇒ unknown.
    const reports = new Map<string, string>()
    const args: ExecuteReproTestsArgs = {
      tests,
      repoRoot: "/sandbox",
      writeFile: async () => {},
      tempPath: (i: number) => `/sandbox/__repro_${i}.py`,
      exec: async (argv: readonly string[]) => {
        const path = argv[argv.length - 1] ?? ""
        const idx = Number.parseInt(/_(\d+)\.py$/.exec(path)?.[1] ?? "0", 10)
        const src = tests[idx] ?? ""
        if (!src.includes("def test_")) {
          reports.set(pytestReportPathFor(path), REPORT_NO_TESTS)
          return { code: 5, stdout: "no tests ran in 0.1s", stderr: "" }
        }
        reports.set(pytestReportPathFor(path), REPORT_FAILED)
        return { code: 1, stdout: "1 failed in 0.1s", stderr: "" }
      },
      readFile: async (path) => reports.get(path) ?? "",
    }
    const samples = await executeReproTests(args)
    expect(samples).toHaveLength(5)
    // 4 of the 5 should be "reproduced" (TEST_NO_TESTS ⇒ unknown).
    const reproduced = samples.filter((s) => s.outcome === "reproduced")
    expect(reproduced).toHaveLength(4)

    // Select — the 3 variants of TEST_A collapse to one normalised key; they
    // form the majority group. Winner = first appearance (TEST_A_NAMED, with
    // the footer the generator guaranteed).
    const sel = selectReproTest(samples)
    expect(sel.reproducedCount).toBe(4)
    expect(sel.selected).toBe(ensurePytestFooter(TEST_A_NAMED))
  })

  test("all samples fail to reproduce ⇒ null selection", async () => {
    const llm = new ScriptedSampleLLM([TEST_NO_TESTS, TEST_NO_TESTS, TEST_NO_TESTS])
    const tests = await generateReproTests({
      issue: "the bug",
      llm,
      config: { samples: 3 },
    })
    const samples = await executeReproTests({
      tests,
      repoRoot: "/sandbox",
      writeFile: async () => {},
      tempPath: (i: number) => `/sandbox/__repro_${i}.py`,
      exec: async () => ({ code: 5, stdout: "no tests ran in 0.1s", stderr: "" }),
      readFile: async () => REPORT_NO_TESTS,
    })
    const sel = selectReproTest(samples)
    expect(sel.selected).toBeNull()
    expect(sel.reproducedCount).toBe(0)
  })

  test("LLM returns markdown-fenced source — strip + footer + select still works", async () => {
    const fenced = `\`\`\`python\n${TEST_A_NAMED}\n\`\`\``
    const llm = new ScriptedSampleLLM([fenced, fenced, fenced])
    const tests = await generateReproTests({
      issue: "the bug",
      llm,
      config: { samples: 3 },
    })
    // All three should be unfenced, with the self-driving footer guaranteed.
    for (const t of tests) {
      expect(t).not.toContain("```")
      expect(t).toBe(ensurePytestFooter(TEST_A_NAMED))
    }
    const samples = await executeReproTests({
      tests,
      repoRoot: "/sandbox",
      writeFile: async () => {},
      tempPath: (i: number) => `/sandbox/__repro_${i}.py`,
      exec: async () => ({ code: 1, stdout: "1 failed in 0.1s", stderr: "" }),
      readFile: async () => REPORT_FAILED,
    })
    const sel = selectReproTest(samples)
    expect(sel.selected).toBe(ensurePytestFooter(TEST_A_NAMED))
  })
})
