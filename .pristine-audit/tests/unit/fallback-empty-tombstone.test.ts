/**
 * R-Phase5 P1-G regression — when the FALLBACK provider yields zero events
 * (an accepted-but-empty response, edge case) AND a prior partial exists,
 * `streamProvider` MUST still emit `{type:"stream_reset"}` so the assembler
 * tombstones the dead partial. Pre-fix, the `for await` loop never ran on
 * an empty stream, `resetEmitted` stayed false, and the reset was dropped.
 *
 * Scenarios tested:
 *   1. Primary yields text + fails → fallback yields ZERO events → reset
 *      MUST appear (and the final assembled message is empty, not the
 *      primary's half-streamed text).
 *   2. Primary yields text + fails → fallback yields events → reset appears
 *      BEFORE the first fallback event (legacy behavior, regression guard).
 *   3. Primary succeeds (no fallback needed) → no reset event in the output
 *      (no-tombstone happy path).
 */
import { describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent } from "@/llm"
import { assembleFromEvents, FallbackLLM } from "@/llm"
import { LLMError } from "@/shared"

class ScriptedProvider implements LLMPort {
  readonly model = "scripted"
  constructor(private readonly script: { events: StreamEvent[]; throwAfter?: boolean }) {}
  async *stream(): AsyncIterable<StreamEvent> {
    for (const ev of this.script.events) yield ev
    if (this.script.throwAfter) {
      throw new LLMError("529 overloaded", { kind: "overloaded", statusCode: 529 })
    }
  }
}

const collect = async (it: AsyncIterable<StreamEvent>): Promise<StreamEvent[]> => {
  const out: StreamEvent[] = []
  for await (const ev of it) out.push(ev)
  return out
}

describe("R-Phase5 P1-G — FallbackLLM emits stream_reset even on empty fallback", () => {
  test("primary yields then fails + fallback yields ZERO events → stream_reset emitted", async () => {
    const primary = new ScriptedProvider({
      events: [{ type: "text_delta", delta: "dead-partial" }],
      throwAfter: true,
    })
    const fallback = new ScriptedProvider({ events: [] })
    const llm = new FallbackLLM({ providers: [primary, fallback] })

    const events = await collect(llm.stream({ messages: [], tools: [] }))

    // The stream_reset MUST appear so the assembler tombstones the dead
    // partial. Without this fix, events = [text_delta("dead-partial")] and
    // assembleFromEvents would keep the dead partial as the final message.
    const resetCount = events.filter((e) => e.type === "stream_reset").length
    expect(resetCount).toBe(1)

    // The assembled message MUST NOT contain the dead partial (post-tombstone).
    const { message } = assembleFromEvents(events)
    const textContent = message.content
      .filter((b) => b.type === "text")
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
    expect(textContent).not.toContain("dead-partial")
  })

  test("primary fails + fallback yields events → reset appears BEFORE first fallback event", async () => {
    const primary = new ScriptedProvider({
      events: [{ type: "text_delta", delta: "dead" }],
      throwAfter: true,
    })
    const fallback = new ScriptedProvider({
      events: [
        { type: "text_delta", delta: "recovered" },
        { type: "message_stop", stop_reason: "end_turn" },
      ],
    })
    const llm = new FallbackLLM({ providers: [primary, fallback] })

    const events = await collect(llm.stream({ messages: [], tools: [] }))

    const resetIdx = events.findIndex((e) => e.type === "stream_reset")
    const recoveredIdx = events.findIndex((e) => e.type === "text_delta" && e.delta === "recovered")
    expect(resetIdx).toBeGreaterThanOrEqual(0)
    expect(recoveredIdx).toBeGreaterThan(resetIdx) // reset comes BEFORE recovery
  })

  test("control: primary succeeds → no stream_reset event", async () => {
    const primary = new ScriptedProvider({
      events: [
        { type: "text_delta", delta: "ok" },
        { type: "message_stop", stop_reason: "end_turn" },
      ],
    })
    const fallback = new ScriptedProvider({ events: [] })
    const llm = new FallbackLLM({ providers: [primary, fallback] })

    const events = await collect(llm.stream({ messages: [], tools: [] }))
    expect(events.some((e) => e.type === "stream_reset")).toBe(false)
  })

  test("primary fails BEFORE any yield + fallback yields ZERO → no reset (no partial to tombstone)", async () => {
    // Edge case: if the primary throws before yielding ANY events, there's
    // no partial to tombstone. The fallback's empty stream should not emit
    // a spurious reset.
    const primary = new ScriptedProvider({ events: [], throwAfter: true })
    const fallback = new ScriptedProvider({ events: [] })
    const llm = new FallbackLLM({ providers: [primary, fallback] })

    const events = await collect(llm.stream({ messages: [], tools: [] }))
    expect(events.some((e) => e.type === "stream_reset")).toBe(false)
  })
})
