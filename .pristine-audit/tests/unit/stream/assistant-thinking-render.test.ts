import { describe, expect, test } from "bun:test"
import { StdoutStream } from "../../../src/stream/adapters/stdout"
import type { AgentEvent } from "../../../src/stream/types"

/**
 * jun-11 (#11) — the stdout adapter renders `assistant_thinking` deltas DIM,
 * distinct from the assistant's answer (`assistant_text`). Before this, the
 * LLM's `thinking_delta` was dropped (counted only for TTFT/tokens), so turning
 * QUANTA_REASONING_SUMMARY on paid tokens with NOTHING shown. This locks the
 * render + the run-boundary bookkeeping (symmetric to the `inText` flush).
 *
 * RED before the `assistant_thinking` switch case existed (the event produced
 * zero bytes); GREEN after.
 */
const DIM = "\x1b[2m"
const RESET = "\x1b[0m"

const think = (delta: string): AgentEvent => ({ type: "assistant_thinking", delta })

describe("StdoutStream — assistant_thinking renders DIM", () => {
  test("a thinking delta is written wrapped in DIM…RESET", () => {
    const out: string[] = []
    new StdoutStream({ write: (c) => out.push(c) }).emit(think("weighing options"))
    const s = out.join("")
    expect(s).toContain("weighing options")
    expect(s).toContain(DIM)
    expect(s).toContain(RESET)
  })

  test("an open reasoning run is newline-terminated before the answer text", () => {
    const out: string[] = []
    const s = new StdoutStream({ write: (c) => out.push(c) })
    s.emit(think("hmm"))
    s.emit({ type: "assistant_text", delta: "Here is the answer" })
    const joined = out.join("")
    // The reasoning block closes with a newline BEFORE the answer begins.
    expect(joined).toContain("hmm")
    expect(joined).toContain("Here is the answer")
    expect(joined.indexOf("hmm") < joined.indexOf("\n")).toBe(true)
    expect(joined.indexOf("\n") < joined.indexOf("Here is the answer")).toBe(true)
  })

  test("a live-counter event between thinking deltas does not break the run", () => {
    const out: string[] = []
    const s = new StdoutStream({ write: (c) => out.push(c) })
    s.emit(think("step one "))
    s.emit({ type: "output_progress", outputTokens: 5, exact: false })
    s.emit(think("step two"))
    const joined = out.join("")
    // No spurious newline was inserted between the two reasoning deltas by the
    // interleaved no-op event.
    expect(joined).toContain("step one ")
    expect(joined).toContain("step two")
    expect(joined).not.toContain("step one \n")
  })
})
