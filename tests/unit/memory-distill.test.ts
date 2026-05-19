import { describe, expect, test } from "bun:test"
import { distillSession, finalAssistantText } from "@/agent/memory-distill"
import type { LLMPort, Message, StreamEvent } from "@/llm"

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const assistant = (text: string): Message => ({
  role: "assistant",
  content: [{ type: "text", text }],
})

/** Build an async-iterable stream from a precomputed event list (or throw). */
const stream = (out: string | { throw: true }): AsyncIterable<StreamEvent> => {
  const events: StreamEvent[] =
    typeof out === "string"
      ? [
          { type: "text_delta", delta: out },
          { type: "message_stop", stop_reason: "end_turn" },
        ]
      : []
  return {
    async *[Symbol.asyncIterator]() {
      if (typeof out !== "string") throw new Error("llm down")
      yield* events
    },
  }
}

/** FakeLLM: emits `out` as one text_delta then message_stop, or throws. */
const fakeLLM = (out: string | { throw: true }): LLMPort => ({
  stream: () => stream(out),
})

const transcript: Message[] = [user("set up the db"), assistant("Done. Using Postgres 16.")]

describe("finalAssistantText", () => {
  test("last non-empty assistant text, trimmed", () => {
    expect(
      finalAssistantText([assistant("first"), user("q"), assistant("  last  "), assistant("")]),
    ).toBe("last")
    expect(finalAssistantText([user("only user")])).toBe("")
  })
})

describe("distillSession happy paths", () => {
  test("plain JSON array parsed, clamped, capped", async () => {
    const json = JSON.stringify([
      { kind: "fact", tier: "semantic", text: "uses pg16", tags: ["db"], importance: 2 },
      { kind: "decision", tier: "episodic", text: "chose pg", tags: [], importance: -1 },
      { kind: "fact", tier: "semantic", text: "x", tags: [], importance: 0.5 },
    ])
    const out = await distillSession(fakeLLM(json), transcript, { max: 2 })
    expect(out.length).toBe(2)
    expect(out[0]).toEqual({
      kind: "fact",
      tier: "semantic",
      text: "uses pg16",
      tags: ["db"],
      importance: 1,
    })
    expect(out[1]?.importance).toBe(0)
  })

  test("fenced JSON with prose tolerated", async () => {
    const md =
      'Here you go:\n```json\n[{"kind":"x","tier":"y","text":"hi","tags":["t"],"importance":0.7}]\n```\nDone.'
    const out = await distillSession(fakeLLM(md), transcript)
    expect(out.length).toBe(1)
    expect(out[0]?.kind).toBe("observation") // invalid kind coerced
    expect(out[0]?.tier).toBe("semantic") // invalid tier coerced
    expect(out[0]?.text).toBe("hi")
  })

  test("entries with empty text dropped", async () => {
    const json = JSON.stringify([
      { kind: "fact", tier: "semantic", text: "  ", tags: [], importance: 0.5 },
      { kind: "fact", tier: "semantic", text: "real", tags: [], importance: 0.5 },
    ])
    const out = await distillSession(fakeLLM(json), transcript)
    expect(out).toEqual([
      { kind: "fact", tier: "semantic", text: "real", tags: [], importance: 0.5 },
    ])
  })
})

describe("distillSession fallback branches", () => {
  const expectSummary = (out: Awaited<ReturnType<typeof distillSession>>) => {
    expect(out).toEqual([
      {
        kind: "decision",
        tier: "episodic",
        text: "Done. Using Postgres 16.",
        tags: ["session-summary"],
        importance: 0.4,
      },
    ])
  }

  test("llm throws → summary fallback", async () => {
    expectSummary(await distillSession(fakeLLM({ throw: true }), transcript))
  })

  test("no JSON array → summary fallback", async () => {
    expectSummary(await distillSession(fakeLLM("no json here"), transcript))
  })

  test("unparseable JSON → summary fallback", async () => {
    expectSummary(await distillSession(fakeLLM("[ { bad json "), transcript))
  })

  test("empty array → summary fallback", async () => {
    expectSummary(await distillSession(fakeLLM("[]"), transcript))
  })

  test("no assistant text anywhere → []", async () => {
    expect(await distillSession(fakeLLM({ throw: true }), [user("hi")])).toEqual([])
  })

  test("pre-aborted signal → fallback, no llm call", async () => {
    const ctrl = new AbortController()
    ctrl.abort()
    let called = false
    const spy: LLMPort = {
      stream() {
        called = true
        return stream("[]")
      },
    }
    expectSummary(await distillSession(spy, transcript, { signal: ctrl.signal }))
    expect(called).toBe(false)
  })
})
