import { describe, expect, test } from "bun:test"
import { foundryProviderAdapter } from "@/llm/providers/foundry-adapter"
import { replayLlmPort } from "@/llm/replay/replay-llm"
import type { ReplayStore } from "@/llm/replay/types"
import type { LLMPort } from "@/llm/ports"
import type { StreamEvent, StreamInput } from "@/llm/types"
import { LLMError } from "@/shared"

/**
 * T07 hellgate — replay passthrough abort symmetry (audit L6 M9) + foundry
 * abort error classification (audit L6 M10a).
 */

const missStore: ReplayStore = {
  match: async () => null,
}

const baseInput = (signal?: AbortSignal): StreamInput => ({
  messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
  tools: [],
  ...(signal ? { signal } : {}),
})

describe("T07 replay passthrough abort hellgate (M9)", () => {
  test("passthrough honours caller abort between yields (parity with replay-hit path)", async () => {
    const ctl = new AbortController()
    let yielded = 0
    // A fallback that yields forever; the passthrough wrapper must observe the
    // signal between yields and stop (pre-fix the bare for-await ignored it).
    const fallback: LLMPort = {
      async *stream(): AsyncIterable<StreamEvent> {
        for (;;) {
          yield { type: "text_delta", delta: "x" }
        }
      },
    }
    const port = replayLlmPort({ store: missStore, onMiss: "passthrough", fallback })

    let threw: unknown
    try {
      for await (const _ of port.stream(baseInput(ctl.signal))) {
        yielded += 1
        if (yielded === 2) ctl.abort()
        if (yielded > 100) break
      }
    } catch (e) {
      threw = e
    }
    expect(yielded).toBeLessThan(100)
    expect(threw).toBeInstanceOf(Error)
  })

  test("passthrough still drains a finite fallback to completion when not aborted", async () => {
    const fallback: LLMPort = {
      async *stream(): AsyncIterable<StreamEvent> {
        yield { type: "text_delta", delta: "a" }
        yield { type: "message_stop", stop_reason: "end_turn" }
      },
    }
    const port = replayLlmPort({ store: missStore, onMiss: "passthrough", fallback })
    const out: StreamEvent[] = []
    for await (const ev of port.stream(baseInput())) out.push(ev)
    expect(out.map((e) => e.type)).toEqual(["text_delta", "message_stop"])
  })
})

describe("T07 foundry abort classification hellgate (M10a)", () => {
  test("pre-aborted signal throws a typed LLMError{kind:'aborted'} (not provider-unsupported)", async () => {
    const adapter = foundryProviderAdapter({
      providerId: "foundry",
      model: "claude-sonnet-4-foundry",
      auth: { azureApiKey: "k-test" },
    })
    const ctl = new AbortController()
    ctl.abort()
    let threw: unknown
    try {
      for await (const _ of adapter.stream(baseInput(ctl.signal))) {
        throw new Error("should not yield")
      }
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(LLMError)
    expect((threw as LLMError).kind).toBe("aborted")
  })
})
