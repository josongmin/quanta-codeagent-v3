/**
 * Repro-test slice end-to-end — generate → execute → select.
 *
 * Mocks the LLM port + exec port; demonstrates the paper's algorithm on a
 * synthetic 5-sample run shaped after the requests-5414 issue (IDNAError on
 * invalid URL).
 */
import { describe, expect, test } from "bun:test"
import {
  type ExecuteReproTestsArgs,
  executeReproTests,
} from "../../../src/agent/repro-test/execute"
import { generateReproTests } from "../../../src/agent/repro-test/generate"
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

const TEST_A_NAMED = [
  "import requests",
  "",
  "def test_unicode_a():",
  "    try:",
  '        requests.get("http://.example.com")',
  '        print("Issue resolved")',
  "    except UnicodeError:",
  '        print("Issue reproduced")',
  "    except Exception:",
  '        print("Other issues")',
  "",
  "test_unicode_a()",
].join("\n")

const TEST_A_DIFFERENT_NAME = [
  "import requests",
  "",
  "def test_invalid_url_42():  # different fn name, same logic",
  "    try:",
  '        requests.get("http://.example.com")',
  '        print("Issue resolved")',
  "    except UnicodeError:",
  '        print("Issue reproduced")',
  "    except Exception:",
  '        print("Other issues")',
  "",
  "test_invalid_url_42()",
].join("\n")

const TEST_A_WITH_COMMENT = [
  "import requests",
  "",
  "# slightly different — extra comment shouldn't matter",
  "def test_unicode_b():",
  "    try:",
  '        requests.get("http://.example.com")',
  '        print("Issue resolved")',
  "    except UnicodeError:",
  '        print("Issue reproduced")',
  "    except Exception:",
  '        print("Other issues")',
  "",
  "test_unicode_b()",
].join("\n")

const TEST_B_DIFFERENT = [
  "import requests",
  "",
  "# completely different shape",
  "try:",
  '    r = requests.get("http://[bad]")',
  '    print("Issue resolved")',
  "except Exception as e:",
  '    if "UnicodeError" in repr(e):',
  '        print("Issue reproduced")',
  "    else:",
  '        print("Other issues")',
].join("\n")

const TEST_OTHER = [
  "import requests",
  "",
  "try:",
  '    requests.get("http://ok.example.com")',
  '    print("Other issues")',
  "except Exception:",
  '    print("Other issues")',
].join("\n")

describe("repro-test end-to-end — requests-5414 shape", () => {
  test("5-sample run picks the majority test, returning original source", async () => {
    // 3 variants of test A (collapse to same normalised key under fn-name +
    // comment rules) + 1 different test B + 1 "other" sample.
    const llm = new ScriptedSampleLLM([
      TEST_A_NAMED,
      TEST_A_DIFFERENT_NAME,
      TEST_A_WITH_COMMENT,
      TEST_B_DIFFERENT,
      TEST_OTHER,
    ])

    // Generate
    const tests = await generateReproTests({
      issue: "UnicodeError raised when scheme is missing and host has leading dot",
      llm,
      config: { samples: 5 },
    })
    expect(tests).toHaveLength(5)
    expect(llm.calls).toBe(5)

    // Execute — synthetic exec port: scripts whose source contains
    // "UnicodeError" print "Issue reproduced"; the TEST_OTHER variant
    // prints "Other issues"; everything else "Issue reproduced".
    const args: ExecuteReproTestsArgs = {
      tests,
      repoRoot: "/sandbox",
      writeFile: async () => {},
      tempPath: (i: number) => `/sandbox/__repro_${i}.py`,
      exec: async (argv: readonly string[]) => {
        const path = argv[argv.length - 1] ?? ""
        const idx = Number.parseInt(/_(\d+)\.py$/.exec(path)?.[1] ?? "0", 10)
        const src = tests[idx] ?? ""
        if (src.includes('print("Other issues")') && !src.includes("UnicodeError")) {
          return { code: 0, stdout: "Other issues\n", stderr: "" }
        }
        return { code: 0, stdout: "Issue reproduced\n", stderr: "" }
      },
    }
    const samples = await executeReproTests(args)
    expect(samples).toHaveLength(5)
    // 4 of the 5 should be "reproduced" (TEST_OTHER ends up "other").
    const reproduced = samples.filter((s) => s.outcome === "reproduced")
    expect(reproduced).toHaveLength(4)

    // Select
    const sel = selectReproTest(samples)
    expect(sel.reproducedCount).toBe(4)
    // The 3 variants of TEST_A collapse to one normalised key (test_ fn
    // names normalise, comments strip); they form the majority group.
    // Winner = first appearance, which is TEST_A_NAMED.
    expect(sel.selected).toBe(TEST_A_NAMED)
  })

  test("all samples fail to reproduce ⇒ null selection", async () => {
    const llm = new ScriptedSampleLLM([TEST_OTHER, TEST_OTHER, TEST_OTHER])
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
      exec: async () => ({ code: 0, stdout: "Other issues\n", stderr: "" }),
    })
    const sel = selectReproTest(samples)
    expect(sel.selected).toBeNull()
    expect(sel.reproducedCount).toBe(0)
  })

  test("LLM returns markdown-fenced source — strip + select still works", async () => {
    const fenced = `\`\`\`python\n${TEST_A_NAMED}\n\`\`\``
    const llm = new ScriptedSampleLLM([fenced, fenced, fenced])
    const tests = await generateReproTests({
      issue: "the bug",
      llm,
      config: { samples: 3 },
    })
    // All three should be unfenced.
    for (const t of tests) {
      expect(t).not.toContain("```")
      expect(t).toBe(TEST_A_NAMED)
    }
    const samples = await executeReproTests({
      tests,
      repoRoot: "/sandbox",
      writeFile: async () => {},
      tempPath: (i: number) => `/sandbox/__repro_${i}.py`,
      exec: async () => ({ code: 0, stdout: "Issue reproduced\n", stderr: "" }),
    })
    const sel = selectReproTest(samples)
    expect(sel.selected).toBe(TEST_A_NAMED)
  })
})
