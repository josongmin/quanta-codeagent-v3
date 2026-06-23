/**
 * Repro-test slice — adversarial hellgate.
 *
 * 25+ adversarial cases covering every recovery path; the function MUST NOT
 * throw on any of them. Errors should surface as `null` selection /
 * `"unknown"` / `"exec_failed"` outcomes, never as uncaught exceptions.
 */
import { describe, expect, test } from "bun:test"
import { executeReproTests } from "../../src/agent/repro-test/execute"
import { generateReproTests, stripMarkdownFences } from "../../src/agent/repro-test/generate"
import {
  normaliseReproSource,
  selectReproTest,
  stripPythonComments,
} from "../../src/agent/repro-test/select"
import type { ReproTestSample } from "../../src/agent/repro-test/types"
import type { LLMPort, StreamEvent, StreamInput } from "../../src/llm"

const repro = (source: string): ReproTestSample => ({
  source,
  stdout: "",
  outcome: "reproduced",
})

// ─── ScriptedLLM helpers ──────────────────────────────────────────────────

class TextLLM implements LLMPort {
  constructor(private readonly t: string) {}
  async *stream(_i: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: this.t }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

// ─── generate / strip ─────────────────────────────────────────────────────

describe("generate hellgate", () => {
  test("response with multiple ``` fences (only outer stripped)", () => {
    const raw = "```python\nprint('``` inside string ```')\n```"
    expect(stripMarkdownFences(raw)).toBe("print('``` inside string ```')")
  })

  test("response without any text content ⇒ empty string", async () => {
    class NoTextLLM implements LLMPort {
      async *stream(_i: StreamInput): AsyncIterable<StreamEvent> {
        yield { type: "message_stop", stop_reason: "end_turn" }
      }
    }
    const out = await generateReproTests({
      issue: "x",
      llm: new NoTextLLM(),
      config: { samples: 2 },
    })
    expect(out).toEqual(["", ""])
  })

  test("response with only whitespace ⇒ empty after fence-strip", () => {
    expect(stripMarkdownFences("\n\n  \n")).toBe("")
  })

  test("response with leading garbage before fence — fence not stripped", () => {
    const raw = "garbage line\n```python\nprint('x')\n```"
    // First non-empty line is NOT a fence ⇒ verbatim return.
    expect(stripMarkdownFences(raw)).toBe(raw)
  })

  test("response with `python` after fence (`” ‘ ‘python`)", () => {
    const raw = "```python\nx = 1\n```"
    expect(stripMarkdownFences(raw)).toBe("x = 1")
  })

  test("LLM stream throws synchronously ⇒ empty source recorded", async () => {
    class SyncThrowLLM implements LLMPort {
      // biome-ignore lint/correctness/useYield: throws before any yield
      async *stream(_i: StreamInput): AsyncIterable<StreamEvent> {
        throw new Error("provider exploded")
      }
    }
    const out = await generateReproTests({
      issue: "x",
      llm: new SyncThrowLLM(),
      config: { samples: 3 },
    })
    expect(out).toEqual(["", "", ""])
  })

  test("very long issue body (10MB) — does not OOM or hang", async () => {
    const huge = "a".repeat(10_000_000)
    const out = await generateReproTests({
      issue: huge,
      llm: new TextLLM("print('x')"),
      config: { samples: 1 },
    })
    expect(out).toHaveLength(1)
  })

  test("issue with prototype-pollution-shaped keys does NOT execute them", async () => {
    const issue = '__proto__ = {"polluted": true}\nconstructor = "x"'
    const out = await generateReproTests({
      issue,
      llm: new TextLLM("print('Issue reproduced')"),
      config: { samples: 1 },
    })
    expect(out).toHaveLength(1)
    // No global pollution.
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  test("ANSI / unicode in response ⇒ preserved verbatim", () => {
    const raw = "```python\nprint('🦀')\n# 한글\n```"
    const stripped = stripMarkdownFences(raw)
    expect(stripped).toContain("🦀")
    expect(stripped).toContain("한글")
  })
})

// ─── classifyPytest / execute hellgate (P1: exit-code grounded) ────────────

describe("execute hellgate", () => {
  test("pytest precedence — 'failed' alongside 'passed' ⇒ reproduced", async () => {
    const out = await executeReproTests({
      tests: ["x"],
      repoRoot: "/s",
      writeFile: async () => {},
      tempPath: () => "/s/x.py",
      exec: async () => ({
        code: 1,
        stdout: ".F\n1 failed, 1 passed in 0.3s\n",
        stderr: "",
      }),
    })
    // A real assertion failed ⇒ the bug is present, even though one case passed.
    expect(out[0]?.outcome).toBe("reproduced")
  })

  test("binary-junk stdout — no pytest summary, exit 0 ⇒ unknown", async () => {
    const out = await executeReproTests({
      tests: ["x"],
      repoRoot: "/s",
      writeFile: async () => {},
      tempPath: () => "/s/x.py",
      exec: async () => ({ code: 0, stdout: "\x00\x01\x02BINARY", stderr: "" }),
    })
    expect(out[0]?.outcome).toBe("unknown")
  })

  test("ANSI/unicode noise around the pytest summary — still classified", async () => {
    const out = await executeReproTests({
      tests: ["x"],
      repoRoot: "/s",
      writeFile: async () => {},
      tempPath: () => "/s/x.py",
      exec: async () => ({
        code: 1,
        stdout: "\x1b[33mDEBUG\x1b[0m\n한글\n1 failed in 0.2s\n",
        stderr: "",
      }),
    })
    expect(out[0]?.outcome).toBe("reproduced")
  })

  test("import crash — exit 1 with NO summary ⇒ exec_failed (not a fake reproduced)", async () => {
    // The pytest footer never ran (the project import died first). Exit 1 with no
    // summary must be infra, NOT a reproduced bug — the import-vs-failure confound.
    const out = await executeReproTests({
      tests: ["x"],
      repoRoot: "/s",
      writeFile: async () => {},
      tempPath: () => "/s/x.py",
      exec: async () => ({
        code: 1,
        stdout: "",
        stderr: "ModuleNotFoundError: No module named 'projectlib'",
      }),
    })
    expect(out[0]?.outcome).toBe("exec_failed")
  })

  test("simulated exec timeout (code=137, no marker) ⇒ exec_failed", async () => {
    const out = await executeReproTests({
      tests: ["x"],
      repoRoot: "/s",
      writeFile: async () => {},
      tempPath: () => "/s/x.py",
      exec: async () => ({ code: 137, stdout: "", stderr: "killed" }),
    })
    expect(out[0]?.outcome).toBe("exec_failed")
  })

  test("0 tests ⇒ empty result, no exec calls", async () => {
    let calls = 0
    const out = await executeReproTests({
      tests: [],
      repoRoot: "/s",
      writeFile: async () => {},
      tempPath: () => "/s/x.py",
      exec: async () => {
        calls++
        return { code: 0, stdout: "", stderr: "" }
      },
    })
    expect(out).toEqual([])
    expect(calls).toBe(0)
  })

  test("tempPath collisions ⇒ each call still produces a sample", async () => {
    // Pathological tempPath returns the SAME path for every i; the
    // executor must still produce K samples (sequential overwrite is fine).
    const out = await executeReproTests({
      tests: ["a", "b", "c"],
      repoRoot: "/s",
      writeFile: async () => {},
      tempPath: () => "/s/shared.py",
      exec: async () => ({ code: 0, stdout: "Issue reproduced", stderr: "" }),
    })
    expect(out).toHaveLength(3)
  })

  test("writeFile throws asynchronously ⇒ exec_failed (not uncaught)", async () => {
    const out = await executeReproTests({
      tests: ["a"],
      repoRoot: "/s",
      writeFile: async () => {
        throw new Error("ENOSPC")
      },
      tempPath: () => "/s/x.py",
      exec: async () => ({ code: 0, stdout: "Issue reproduced", stderr: "" }),
    })
    expect(out[0]?.outcome).toBe("exec_failed")
  })

  test("AbortSignal pre-armed ⇒ no exec calls", async () => {
    const ac = new AbortController()
    ac.abort()
    let calls = 0
    const out = await executeReproTests({
      tests: ["a", "b"],
      repoRoot: "/s",
      writeFile: async () => {},
      tempPath: () => "/s/x.py",
      signal: ac.signal,
      exec: async () => {
        calls++
        return { code: 0, stdout: "Issue reproduced", stderr: "" }
      },
    })
    expect(calls).toBe(0)
    expect(out).toEqual([])
  })
})

// ─── select hellgate ─────────────────────────────────────────────────────

describe("select hellgate", () => {
  test("100 samples, all unique sources, all reproduced ⇒ first wins (1-vote tie)", () => {
    const samples: ReproTestSample[] = []
    for (let i = 0; i < 100; i++) samples.push(repro(`# ${i}\nimport x_${i}`))
    const sel = selectReproTest(samples)
    expect(sel.selected).toBe("# 0\nimport x_0")
    expect(sel.reproducedCount).toBe(100)
  })

  test("samples with __proto__ source — no global pollution", () => {
    const samples: ReproTestSample[] = [repro("__proto__"), repro("__proto__")]
    const sel = selectReproTest(samples)
    expect(sel.selected).toBe("__proto__")
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  test("samples with exactOptionalPropertyTypes-tricky shape", () => {
    // outcome is a closed string union; a sample with an explicit non-
    // "reproduced" outcome is filtered out of the vote even though the
    // source text is identical to a "reproduced" sample's.
    const samples: ReproTestSample[] = [
      { source: "a", stdout: "", outcome: "reproduced" },
      { source: "a", stdout: "", outcome: "other" },
    ]
    const sel = selectReproTest(samples)
    expect(sel.selected).toBe("a")
    expect(sel.reproducedCount).toBe(1)
  })

  test("multi-megabyte source ⇒ does not crash", () => {
    const big = `# ${"x".repeat(1_000_000)}\nprint('Issue reproduced')`
    const sel = selectReproTest([repro(big), repro(big)])
    expect(sel.selected).toBe(big)
    expect(sel.reproducedCount).toBe(2)
  })

  test("Unicode test name normalisation does NOT match non-ASCII (intended)", () => {
    // Our `\bdef\s+test_[A-Za-z0-9_]+` is intentionally ASCII; a Unicode
    // test name (`def test_한글():`) won't collapse — that's by design.
    const a = "def test_한글():\n    pass"
    const b = "def test_other():\n    pass"
    expect(normaliseReproSource(a)).not.toBe(normaliseReproSource(b))
  })

  test("source with `#` inside docstring ⇒ docstring strip wins, then no false comment", () => {
    const src = '"""\n# this is in a docstring, not a comment\n"""\nx = 1'
    // After docstring strip the # is gone too. No crash.
    const norm = normaliseReproSource(src)
    expect(norm).toBe("x = 1")
  })

  test("only `unknown` + `exec_failed` outcomes ⇒ null selection", () => {
    const samples: ReproTestSample[] = [
      { source: "a", stdout: "", outcome: "unknown" },
      { source: "b", stdout: "", outcome: "exec_failed" },
    ]
    const sel = selectReproTest(samples)
    expect(sel.selected).toBeNull()
  })

  test("stripPythonComments survives unterminated string (no infinite loop)", () => {
    const src = "x = 'unterminated"
    // Must terminate; the string state ends at EOF.
    const got = stripPythonComments(src)
    expect(typeof got).toBe("string")
  })

  test("stripPythonComments survives unterminated triple-quote", () => {
    const src = '"""unterminated docstring\nmore text'
    const got = stripPythonComments(src)
    expect(typeof got).toBe("string")
  })

  test("source with only comments ⇒ normalises to ''", () => {
    const a = "# a comment\n# another"
    const b = "# different\n# again"
    expect(normaliseReproSource(a)).toBe("")
    expect(normaliseReproSource(b)).toBe("")
  })

  test("3-way tie ⇒ first appearance wins (deterministic)", () => {
    const a = "# a\nimport a"
    const b = "# b\nimport b"
    const c = "# c\nimport c"
    const sel = selectReproTest([repro(a), repro(b), repro(c), repro(a), repro(b), repro(c)])
    expect(sel.selected).toBe(a)
  })
})
