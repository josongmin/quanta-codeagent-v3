/**
 * Hellgate — reflect LLM-backed port wiring (GAP 11, ADR-0504).
 *
 * The tool + quota are proven in reflect-tool-hellgate; this proves the LLM-backed
 * port (`reflectConsultFromLLM`): a one-shot critique turn, no tools offered,
 * NO-THROW failure mapping.
 */
import { describe, expect, test } from "bun:test"
import { reflectConsultFromLLM } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"

const textLLM = (text: string): LLMPort => ({
  model: "m",
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: text }
  },
})
const throwingLLM = (): LLMPort => ({
  model: "m",
  // biome-ignore lint/correctness/useYield: intentional throw before any yield
  async *stream(): AsyncIterable<StreamEvent> {
    throw new Error("provider down")
  },
})
const req = { situation: "the same edit keeps failing", nextSteps: "try a different anchor" }

describe("reflectConsultFromLLM — one-shot critique", () => {
  test("assembles the critique text ⇒ ok:true", async () => {
    const r = await reflectConsultFromLLM({
      llm: textLLM("Your anchor is ambiguous; widen it."),
    }).reflect(req)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.analysis).toContain("ambiguous")
  })

  test("offers NO tools to the critic turn (read-only consult)", async () => {
    let sawTools: unknown
    const spy: LLMPort = {
      model: "m",
      async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
        sawTools = input.tools
        yield { type: "text_delta", delta: "ok" }
      },
    }
    await reflectConsultFromLLM({ llm: spy }).reflect(req)
    expect(sawTools).toEqual([])
  })

  test("empty model output ⇒ ok:false empty-analysis", async () => {
    const r = await reflectConsultFromLLM({ llm: textLLM("   ") }).reflect(req)
    expect(r).toEqual({ ok: false, reason: "empty-analysis" })
  })

  test("a thrown provider ⇒ ok:false reflect-error (no throw)", async () => {
    const r = await reflectConsultFromLLM({ llm: throwingLLM() }).reflect(req)
    expect(r).toEqual({ ok: false, reason: "reflect-error" })
  })

  test("a pre-aborted signal ⇒ ok:false cancelled (never calls the LLM)", async () => {
    let called = false
    const llm: LLMPort = {
      model: "m",
      async *stream(): AsyncIterable<StreamEvent> {
        called = true
        yield { type: "text_delta", delta: "x" }
      },
    }
    const ac = new AbortController()
    ac.abort()
    const r = await reflectConsultFromLLM({ llm }).reflect(req, ac.signal)
    expect(r).toEqual({ ok: false, reason: "cancelled" })
    expect(called).toBe(false)
  })
})
