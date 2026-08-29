/**
 * ★ HELLGATE (MR-06) — MCP `sampling/createMessage` runs on the session's LIVE
 * model.
 *
 * POLICY, decided rather than inferred: a server asking the host to "complete this
 * on my behalf" is asking the AGENT, so an operator who switched models expects the
 * switch to hold here too. Before this the handler captured one `LLMPort` at
 * composition time, so after a `/model` switch every sampling request kept running
 * — and REPORTING (`result.model`) — the model the session booted with.
 *
 * The dep now accepts a thunk, resolved PER REQUEST. A fixed port is still valid
 * (headless hosts and tests pass one) and behaves exactly as before.
 *
 * RED-on-injection: capture the port once (`const llm = deps.llm` outside the
 * request path) ⇒ case 2 reds.
 */

import { describe, expect, test } from "bun:test"
import { createLlmSamplingHandler } from "@/host/runtime"
import type { LLMPort, StreamEvent } from "@/llm"

const port = (model: string): LLMPort =>
  ({
    model,
    stream: async function* (): AsyncIterable<StreamEvent> {
      yield { type: "text_delta", delta: `from ${model}` }
      yield { type: "message_stop", stop_reason: "end_turn" }
    },
  }) as unknown as LLMPort

/** Consent that always allows — the HITL gate is a different hellgate's subject.
 *  Shaped as the real `ElicitationPrompter` returns (`{ok, value}`), not a bare
 *  boolean: a wrong-shaped double here would deny and every case would pass for
 *  the wrong reason. */
const allow = { promptBoolean: async () => ({ ok: true, value: true }) } as never

/** The handler reads `req.messages` directly (see `toStreamInput`), not a
 *  JSON-RPC `params` envelope — the shape the MCP slice hands it. */
const request = {
  messages: [{ role: "user", content: { type: "text", text: "hi" } }],
} as never

describe("MR-06 · MCP sampling follows the live model", () => {
  test("1. a FIXED port still works, and names itself (byte-identical legacy)", async () => {
    const handler = createLlmSamplingHandler({ llm: port("boot-model"), consent: allow })
    const out = await handler.createMessage(request)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.model).toBe("boot-model")
    expect(out.result.content.text).toContain("from boot-model")
  })

  test("2. a THUNK is resolved PER REQUEST — a mid-session switch is honoured", async () => {
    let current = port("boot-model")
    const handler = createLlmSamplingHandler({ llm: () => current, consent: allow })

    const before = await handler.createMessage(request)
    expect(before.ok && before.result.model).toBe("boot-model")

    // …the operator switches models.
    current = port("gpt-4o")

    const after = await handler.createMessage(request)
    expect(after.ok).toBe(true)
    if (!after.ok) return
    // The port that STREAMED and the model REPORTED are the new one — capturing at
    // mint would have kept both on `boot-model`.
    expect(after.result.model).toBe("gpt-4o")
    expect(after.result.content.text).toContain("from gpt-4o")
  })
})
