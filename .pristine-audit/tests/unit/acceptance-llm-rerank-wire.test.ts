/**
 * Driver-side wire: env-knob parse + LLMPort→ask→reranker. The parser is pure; the
 * port builder is exercised with a fake LLMPort that yields one text event.
 */

import { describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import {
  buildLlmRerankFromPort,
  resolveLlmSelectMode,
} from "../../src/runner/batch/eval/acceptance-llm-rerank-wire"
import type { AcceptanceScored } from "../../src/runner/batch/eval/acceptance-select"

describe("resolveLlmSelectMode", () => {
  test("exact modes only", () => {
    expect(resolveLlmSelectMode({ QUANTA_BENCH_LLM_SELECT: "chooser" })).toBe("chooser")
    expect(resolveLlmSelectMode({ QUANTA_BENCH_LLM_SELECT: "REVIEWER" })).toBe("reviewer")
    expect(resolveLlmSelectMode({ QUANTA_BENCH_LLM_SELECT: " chooser " })).toBe("chooser")
  })
  test("off when unset / unknown", () => {
    expect(resolveLlmSelectMode({})).toBeUndefined()
    expect(resolveLlmSelectMode({ QUANTA_BENCH_LLM_SELECT: "1" })).toBeUndefined()
    expect(resolveLlmSelectMode({ QUANTA_BENCH_LLM_SELECT: "on" })).toBeUndefined()
    expect(resolveLlmSelectMode({ QUANTA_BENCH_LLM_SELECT: "" })).toBeUndefined()
  })
})

const scored = (index: number, file: string): AcceptanceScored => ({
  index,
  patch: `diff --git a/${file} b/${file}\n+x`,
  patchKey: file,
  reproPass: false,
  regressionFailures: 0,
})

/** Fake LLM port: yields the given text as one `text_delta` event. */
const fakeLlm = (text: string): LLMPort => ({
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: text } as StreamEvent
  },
})

describe("buildLlmRerankFromPort", () => {
  test("chooser: streamed `BEST: <id>` maps to the scored index", async () => {
    const rerank = buildLlmRerankFromPort({
      llm: fakeLlm("BEST: 2"),
      problemStatement: "bug",
      mode: "chooser",
    })
    expect(await rerank([scored(0, "a.py"), scored(2, "c.py")])).toBe(2)
  })

  test("fail-open: a throwing stream ⇒ null (deterministic stands)", async () => {
    const llm: LLMPort = {
      // eslint-disable-next-line require-yield
      // biome-ignore lint/correctness/useYield: stream must be an async generator to satisfy LLMPort; this stub throws to exercise the fail-open path without yielding
      async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
        throw new Error("stream blew up")
      },
    }
    const rerank = buildLlmRerankFromPort({ llm, problemStatement: "bug", mode: "chooser" })
    expect(await rerank([scored(0, "a.py"), scored(1, "b.py")])).toBeNull()
  })
})
