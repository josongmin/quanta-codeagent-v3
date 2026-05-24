/**
 * Repro-test generation — unit contract.
 *
 *   - K=5 default; 1 greedy + 4 sample (we issue K independent LLM calls).
 *   - prompt body embeds the issue verbatim + the three-marker contract.
 *   - markdown fences stripped from the raw response.
 *   - empty issue / malformed response handled gracefully.
 *   - per-call exception ⇒ "" source for that index (not a throw).
 *   - AbortSignal between samples stops dispatching.
 */
import { describe, expect, test } from "bun:test"
import {
  buildReproTestPrompt,
  DEFAULT_SAMPLES,
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

class ThrowingLLM implements LLMPort {
  calls = 0
  // biome-ignore lint/correctness/useYield: stream throws before any yield
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    throw new Error("provider down")
  }
}

describe("buildReproTestPrompt", () => {
  test("embeds issue verbatim + marker contract + example", () => {
    const prompt = buildReproTestPrompt("UnicodeError on http://.example.com")
    expect(prompt).toContain("UnicodeError on http://.example.com")
    expect(prompt).toContain('"Issue reproduced"')
    expect(prompt).toContain('"Issue resolved"')
    expect(prompt).toContain('"Other issues"')
    expect(prompt).toContain("Output only the Python source code")
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
    const llm = new ScriptedLLM('print("Issue reproduced")')
    const out = await generateReproTests({ issue: "the bug", llm })
    expect(llm.calls).toBe(DEFAULT_SAMPLES)
    expect(out).toHaveLength(DEFAULT_SAMPLES)
    for (const s of out) expect(s).toBe('print("Issue reproduced")')
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

  test("strips markdown fences from each response", async () => {
    const fenced = '```python\nprint("Issue reproduced")\n```'
    const llm = new ScriptedLLM(fenced)
    const out = await generateReproTests({ issue: "x", llm, config: { samples: 2 } })
    expect(out).toEqual(['print("Issue reproduced")', 'print("Issue reproduced")'])
  })

  test("per-call LLM exception ⇒ '' for that slot (not a throw)", async () => {
    const llm = new ThrowingLLM()
    const out = await generateReproTests({ issue: "x", llm, config: { samples: 3 } })
    expect(llm.calls).toBe(3)
    expect(out).toEqual(["", "", ""])
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

  test("system message embeds the print-contract", async () => {
    const llm = new ScriptedLLM('print("Issue reproduced")')
    await generateReproTests({ issue: "x", llm, config: { samples: 1 } })
    const sys = llm.lastInput?.system
    expect(typeof sys === "string" ? sys : "").toContain("Python")
  })
})
