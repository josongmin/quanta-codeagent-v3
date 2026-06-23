/**
 * Repro-test generation — unit contract (P1: pytest tests, exit-code verdict).
 *
 *   - K=5 default; 1 greedy + 4 sample (we issue K independent LLM calls).
 *   - prompt body embeds the issue verbatim + the PYTEST contract (assert the
 *     EXPECTED behavior; NO sentinel prints; the self-driving footer).
 *   - markdown fences stripped from the raw response.
 *   - the self-driving pytest footer is GUARANTEED on every non-empty source.
 *   - empty issue / malformed response handled gracefully.
 *   - per-call exception ⇒ "" source for that index (not a throw).
 *   - AbortSignal between samples stops dispatching.
 */
import { describe, expect, test } from "bun:test"
import {
  buildReproTestPrompt,
  DEFAULT_SAMPLES,
  ensurePytestFooter,
  generateReproTests,
  MAX_SAMPLES,
  stripMarkdownFences,
} from "../../../src/agent/repro-test/generate"
import type { LLMPort, StreamEvent, StreamInput } from "../../../src/llm"

class ScriptedLLM implements LLMPort {
  calls = 0
  lastInput: StreamInput | undefined
  constructor(private readonly text: string) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    this.lastInput = input
    yield { type: "text_delta", delta: this.text }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class VaryingLLM implements LLMPort {
  calls = 0
  constructor(private readonly texts: string[]) {}
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    const idx = this.calls
    this.calls += 1
    const text = this.texts[idx] ?? this.texts[this.texts.length - 1] ?? ""
    yield { type: "text_delta", delta: text }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class EventScriptedLLM implements LLMPort {
  calls = 0
  constructor(private readonly events: readonly StreamEvent[]) {}
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    for (const ev of this.events) yield ev
  }
}

class ThrowingLLM implements LLMPort {
  calls = 0
  // biome-ignore lint/correctness/useYield: stream throws before any yield
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    throw new Error("provider down")
  }
}

class YieldThenThrowLLM implements LLMPort {
  calls = 0
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    yield { type: "text_delta", delta: 'print("partial")' }
    throw new Error("provider down after partial")
  }
}

describe("buildReproTestPrompt", () => {
  test("embeds issue verbatim + pytest contract + example", () => {
    const prompt = buildReproTestPrompt("UnicodeError on http://.example.com")
    expect(prompt).toContain("UnicodeError on http://.example.com")
    // P1: pytest contract, not sentinel strings.
    expect(prompt).toContain("pytest")
    expect(prompt).toContain("def test_")
    expect(prompt.toLowerCase()).toContain("assert")
    expect(prompt).toContain("Output only the Python source code")
  })

  test("RED-ON-INJECTION: prompt no longer asks for ANY sentinel print", () => {
    // The exact fakeability we removed: the model must NOT be told to print a
    // verdict string. If any of these strings reappear in the prompt, the
    // self-judged sentinel oracle has crept back in.
    const prompt = buildReproTestPrompt("some bug")
    expect(prompt).not.toContain("Issue reproduced")
    expect(prompt).not.toContain("Issue resolved")
    expect(prompt).not.toContain("Other issues")
    expect(prompt).not.toContain("Print EXACTLY ONE")
  })

  test("the verdict is pytest's exit code — prompt says so explicitly", () => {
    const prompt = buildReproTestPrompt("some bug")
    expect(prompt.toLowerCase()).toContain("exit code")
    expect(prompt.toLowerCase()).toContain("expected")
  })

  test("prompt demands the self-driving footer (python <path> → pytest bridge)", () => {
    const prompt = buildReproTestPrompt("some bug")
    expect(prompt).toContain('if __name__ == "__main__"')
    expect(prompt).toContain("pytest.main")
    expect(prompt).toContain("no:cacheprovider")
  })
})

describe("buildReproTestPrompt — MWE grounding (jun-18 repro-install lever)", () => {
  const baseIssue = "UnicodeError on http://.example.com"

  test("no mwe ⇒ byte-identical to the pre-feature prompt", () => {
    // The grounding lever MUST be invisible when no MWE is extracted. Both the
    // implicit (omitted arg) and explicit-undefined/empty forms must equal the
    // single-arg prompt exactly.
    const baseline = buildReproTestPrompt(baseIssue)
    expect(buildReproTestPrompt(baseIssue, undefined)).toBe(baseline)
    expect(buildReproTestPrompt(baseIssue, "")).toBe(baseline)
    expect(buildReproTestPrompt(baseIssue, "   \n  ")).toBe(baseline)
  })

  test("non-empty mwe ⇒ grounding block spliced AFTER the issue, BEFORE the example", () => {
    const mwe = "from sympy import lambdify\nlambdify([], tuple([1]))"
    const prompt = buildReproTestPrompt(baseIssue, mwe)
    // The MWE code is present verbatim.
    expect(prompt).toContain("from sympy import lambdify")
    expect(prompt).toContain("lambdify([], tuple([1]))")
    // The grounding instruction is present and tells the model to ADAPT the MWE.
    expect(prompt).toContain("Known reproduction")
    expect(prompt).toContain("adapt THIS one")
    // Placement: after the issue body, before the illustrative example.
    const iIssue = prompt.indexOf(baseIssue)
    const iMwe = prompt.indexOf("from sympy import lambdify")
    const iExample = prompt.indexOf("# Example output")
    expect(iIssue).toBeGreaterThanOrEqual(0)
    expect(iMwe).toBeGreaterThan(iIssue)
    expect(iExample).toBeGreaterThan(iMwe)
  })

  test("pytest contract survives MWE injection (assert/footer still demanded)", () => {
    // Even with grounding, the pytest contract MUST remain — a grounded MWE that
    // displaced the contract would produce scripts that never assert / never
    // self-drive pytest.
    const prompt = buildReproTestPrompt(baseIssue, "import os\nos.getcwd()")
    expect(prompt).toContain("def test_")
    expect(prompt.toLowerCase()).toContain("assert")
    expect(prompt).toContain("pytest.main")
    // The removed sentinel contract must NOT have leaked back in.
    expect(prompt).not.toContain("Print EXACTLY ONE")
  })

  test("MWE containing a markdown fence cannot break out of the grounding block", () => {
    // Adversarial: an MWE that itself contains ``` must not let the model think
    // the prompt's code block ended early. We still embed it; the pytest
    // contract precedes the block so the contract is never displaced.
    const nasty = "import x\n```\nassert False\n```"
    const prompt = buildReproTestPrompt(baseIssue, nasty)
    expect(prompt).toContain("def test_")
    expect(prompt).toContain("# Example output")
  })
})

describe("generateReproTests — MWE forwarding (wiring proof)", () => {
  test("mwe reaches the LLM user message (red-on-injection)", async () => {
    const llm = new ScriptedLLM('print("Issue reproduced")')
    const mwe = "from pkg import boom\nboom()"
    await generateReproTests({ issue: "the bug", llm, config: { samples: 1 }, mwe })
    const userText =
      llm.lastInput?.messages?.[0]?.content?.[0] &&
      "text" in (llm.lastInput.messages[0].content[0] as { text?: string })
        ? (llm.lastInput.messages[0].content[0] as { text: string }).text
        : ""
    expect(userText).toContain("from pkg import boom")
    expect(userText).toContain("Known reproduction")
  })

  test("no mwe ⇒ user message byte-identical to single-issue prompt", async () => {
    const llm = new ScriptedLLM('print("Issue reproduced")')
    await generateReproTests({ issue: "the bug", llm, config: { samples: 1 } })
    const userText = (llm.lastInput?.messages?.[0]?.content?.[0] as { text: string }).text
    expect(userText).toBe(buildReproTestPrompt("the bug"))
  })

  test("a crashing MWE value cannot break generation (mwe is data, not code)", async () => {
    // The MWE is spliced as plain text — even a pathological value must not throw.
    const llm = new ScriptedLLM('print("Issue reproduced")')
    const out = await generateReproTests({
      issue: "x",
      llm,
      config: { samples: 1 },
      mwe: "```\n".repeat(50),
    })
    expect(out).toHaveLength(1)
  })
})

describe("stripMarkdownFences", () => {
  test("strips ```python ... ``` fences", () => {
    const raw = ["```python", 'print("hi")', "```"].join("\n")
    expect(stripMarkdownFences(raw)).toBe('print("hi")')
  })

  test("strips bare ``` fences", () => {
    const raw = ["```", 'print("hi")', "```"].join("\n")
    expect(stripMarkdownFences(raw)).toBe('print("hi")')
  })

  test("strips trailing fence with whitespace after", () => {
    const raw = ["```py", 'print("hi")', "```", "  ", ""].join("\n")
    expect(stripMarkdownFences(raw)).toBe('print("hi")')
  })

  test("returns input verbatim when no fence", () => {
    const raw = 'print("hi")\nprint("bye")'
    expect(stripMarkdownFences(raw)).toBe(raw)
  })

  test("returns '' on empty / non-string", () => {
    expect(stripMarkdownFences("")).toBe("")
    expect(stripMarkdownFences(undefined as unknown as string)).toBe("")
  })

  test("tolerates leading blank lines", () => {
    const raw = ["", "", "```python", 'print("hi")', "```"].join("\n")
    expect(stripMarkdownFences(raw)).toBe('print("hi")')
  })

  test("tolerates CR/CRLF", () => {
    const raw = "```python\r\nprint('x')\r\n```\r\n"
    expect(stripMarkdownFences(raw)).toBe("print('x')")
  })
})

describe("generateReproTests", () => {
  test("K=5 default, each call hits the LLM exactly once", async () => {
    const src = "def test_x():\n    assert thing() == 1"
    const llm = new ScriptedLLM(src)
    const out = await generateReproTests({ issue: "the bug", llm })
    expect(llm.calls).toBe(DEFAULT_SAMPLES)
    expect(out).toHaveLength(DEFAULT_SAMPLES)
    // Each source is returned with the self-driving pytest footer guaranteed.
    for (const s of out) expect(s).toBe(ensurePytestFooter(src))
  })

  test("respects config.samples (K=3)", async () => {
    const llm = new ScriptedLLM('print("Issue reproduced")')
    const out = await generateReproTests({ issue: "the bug", llm, config: { samples: 3 } })
    expect(llm.calls).toBe(3)
    expect(out).toHaveLength(3)
  })

  test("K=0 / negative ⇒ clamped to 1; NaN ⇒ DEFAULT_SAMPLES (defensive)", async () => {
    // K<1 clamps to 1 (the lower bound). K=NaN falls through to the default
    // (NaN is not finite ⇒ resolver returns DEFAULT_SAMPLES).
    const llm1 = new ScriptedLLM('print("Issue reproduced")')
    await generateReproTests({ issue: "x", llm: llm1, config: { samples: 0 } })
    expect(llm1.calls).toBe(1)

    const llmNeg = new ScriptedLLM('print("x")')
    await generateReproTests({ issue: "x", llm: llmNeg, config: { samples: -3 } })
    expect(llmNeg.calls).toBe(1)

    const llm2 = new ScriptedLLM('print("x")')
    await generateReproTests({ issue: "x", llm: llm2, config: { samples: NaN } })
    expect(llm2.calls).toBe(DEFAULT_SAMPLES)
  })

  test("K > MAX_SAMPLES clamps to MAX_SAMPLES", async () => {
    const llm = new ScriptedLLM('print("Issue reproduced")')
    await generateReproTests({ issue: "x", llm, config: { samples: 9999 } })
    expect(llm.calls).toBe(MAX_SAMPLES)
  })

  test("empty issue → []", async () => {
    const llm = new ScriptedLLM('print("Issue reproduced")')
    const out = await generateReproTests({ issue: "", llm })
    expect(out).toEqual([])
    expect(llm.calls).toBe(0)
  })

  test("strips markdown fences from each response (footer appended after strip)", async () => {
    const body = "def test_x():\n    assert f() == 1"
    const fenced = `\`\`\`python\n${body}\n\`\`\``
    const llm = new ScriptedLLM(fenced)
    const out = await generateReproTests({ issue: "x", llm, config: { samples: 2 } })
    expect(out).toEqual([ensurePytestFooter(body), ensurePytestFooter(body)])
  })

  test("stream_reset tombstones dead partial within a sample", async () => {
    const body = "def test_x():\n    assert f() == 1"
    const llm = new EventScriptedLLM([
      { type: "text_delta", delta: "def test_dead():\n    assert False\n" },
      { type: "stream_reset" },
      { type: "text_delta", delta: "```python\n" },
      { type: "text_delta", delta: `${body}\n` },
      { type: "text_delta", delta: "```" },
      { type: "message_stop", stop_reason: "end_turn" },
    ])
    const out = await generateReproTests({ issue: "x", llm, config: { samples: 1 } })
    expect(out).toEqual([ensurePytestFooter(body)])
  })

  test("per-call LLM exception ⇒ '' for that slot (not a throw)", async () => {
    const llm = new ThrowingLLM()
    const out = await generateReproTests({ issue: "x", llm, config: { samples: 3 } })
    expect(llm.calls).toBe(3)
    expect(out).toEqual(["", "", ""])
  })

  test("mid-stream failure after partial still yields empty string", async () => {
    const llm = new YieldThenThrowLLM()
    const out = await generateReproTests({ issue: "x", llm, config: { samples: 1 } })
    expect(out).toEqual([""])
  })

  test("varying responses preserved in order (5 distinct samples)", async () => {
    const llm = new VaryingLLM([
      'print("Issue reproduced")  # a',
      'print("Issue reproduced")  # b',
      'print("Issue reproduced")  # c',
      'print("Issue reproduced")  # d',
      'print("Issue reproduced")  # e',
    ])
    const out = await generateReproTests({ issue: "x", llm, config: { samples: 5 } })
    expect(out).toHaveLength(5)
    expect(out[0]).toContain("# a")
    expect(out[4]).toContain("# e")
  })

  test("AbortSignal triggers before any call ⇒ empty result", async () => {
    const ac = new AbortController()
    ac.abort()
    const llm = new ScriptedLLM('print("x")')
    const out = await generateReproTests({
      issue: "x",
      llm,
      config: { samples: 5 },
      signal: ac.signal,
    })
    expect(llm.calls).toBe(0)
    expect(out).toEqual([])
  })

  test("system message embeds the pytest contract", async () => {
    const llm = new ScriptedLLM("def test_x(): assert True")
    await generateReproTests({ issue: "x", llm, config: { samples: 1 } })
    const sys = llm.lastInput?.system
    const s = typeof sys === "string" ? sys : ""
    expect(s).toContain("pytest")
    expect(s.toLowerCase()).toContain("exit code")
  })
})

describe("ensurePytestFooter — python <path> → pytest bridge guarantee", () => {
  test("appends the self-driving footer when the model omitted it", () => {
    const src = "def test_x():\n    assert f() == 1"
    const out = ensurePytestFooter(src)
    expect(out).toContain(src)
    expect(out).toContain('if __name__ == "__main__"')
    expect(out).toContain('PYTEST_DISABLE_PLUGIN_AUTOLOAD')
    expect(out).toContain("pytest.main([__file__")
    expect(out).toContain("sys.exit")
  })

  test("LEAVES a compliant source byte-identical (no double-append)", () => {
    const compliant = [
      "def test_x():",
      "    assert f() == 1",
      "",
      "",
      'if __name__ == "__main__":',
      "    import os",
      '    os.environ.setdefault("PYTEST_DISABLE_PLUGIN_AUTOLOAD", "1")',
      "    import sys, pytest",
      '    sys.exit(pytest.main([__file__, "-q"]))',
    ].join("\n")
    expect(ensurePytestFooter(compliant)).toBe(compliant)
    // Exactly one footer (one __main__ guard).
    const guards = ensurePytestFooter(compliant).match(/if __name__ == "__main__"/g) ?? []
    expect(guards).toHaveLength(1)
  })

  test("empty / whitespace / non-string source is returned unchanged (never executed)", () => {
    expect(ensurePytestFooter("")).toBe("")
    expect(ensurePytestFooter("   \n  ")).toBe("   \n  ")
    expect(ensurePytestFooter(undefined as unknown as string)).toBe("")
  })

  test("recognises a footer that uses single quotes / different args (no double-append)", () => {
    const single =
      "def test_x():\n    assert True\nif __name__ == '__main__':\n    import pytest, sys; sys.exit(pytest.main([__file__]))"
    expect(ensurePytestFooter(single)).toBe(single)
  })
})
