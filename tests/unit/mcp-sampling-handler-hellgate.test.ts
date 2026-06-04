/** ADR-0470 B1 follow-up hellgate — the `@/llm`-backed sampling handler.
 *
 *  Seals the host-layer handler + wiring decision in isolation (no transport):
 *   (1) request→completion field mapping (messages / system / role);
 *   (2) result→CreateMessageResult mapping (role / content / model / stopReason);
 *   (3) HITL consent: deny ⇒ user-denied + LLM NOT called; allow ⇒ LLM called;
 *   (4) no-throw on EVERY failure mode (throwing prompter, throwing stream,
 *       empty stream) — mapped to a typed decline, never a crash;
 *   (5) headless default prompter (declines) ⇒ user-denied by default;
 *   (6) advertise-iff-handler: buildSamplingWiring returns BOTH from one gate.
 */

import { describe, expect, it } from "bun:test"
import { buildSamplingWiring, createLlmSamplingHandler } from "@/host/runtime/mcp-sampling-handler"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { ElicitationPrompter, ElicitationResult } from "@/mcp"
import { headlessRejecter } from "@/mcp/elicitation/headless-rejecter"
import type { CreateMessageRequest } from "@/mcp/sampling"

/** A fake LLM that records the StreamInput it was given and yields a scripted
 *  event stream (default: a single text turn). */
const fakeLlm = (
  events: StreamEvent[] = [
    { type: "text_delta", delta: "4" },
    { type: "message_stop", stop_reason: "end_turn" },
  ],
  model = "fake-model",
): { llm: LLMPort; calls: () => number; lastInput: () => StreamInput | null } => {
  let n = 0
  let last: StreamInput | null = null
  return {
    calls: () => n,
    lastInput: () => last,
    llm: {
      model,
      stream(input: StreamInput): AsyncIterable<StreamEvent> {
        n += 1
        last = input
        return (async function* () {
          for (const ev of events) yield ev
        })()
      },
    },
  }
}

/** A throwing LLM — its stream rejects when iterated (no events first). */
const throwingLlm = (): LLMPort => ({
  model: "boom",
  stream(): AsyncIterable<StreamEvent> {
    async function* gen(): AsyncGenerator<StreamEvent> {
      // No events before the failure (a reachable `yield` keeps biome happy
      // while the empty source means nothing is actually yielded).
      for (const ev of [] as StreamEvent[]) yield ev
      throw new Error("provider down")
    }
    return gen()
  },
})

/** A consent prompter whose `promptBoolean` resolves to a scripted answer. */
const fakeConsent = (
  answer: ElicitationResult<boolean>,
): { prompter: ElicitationPrompter; promptCalls: () => number } => {
  let n = 0
  const reject = async (): Promise<never> => {
    throw new Error("only promptBoolean is exercised")
  }
  return {
    promptCalls: () => n,
    prompter: {
      promptBoolean: async () => {
        n += 1
        return answer
      },
      promptString: reject,
      promptNumber: reject,
      promptInteger: reject,
      promptEnum: reject,
      promptMultiEnum: reject,
      promptSingleEnum: reject,
    },
  }
}

const allow: ElicitationResult<boolean> = { ok: true, value: true }
const deny: ElicitationResult<boolean> = { ok: true, value: false }

const req: CreateMessageRequest = {
  messages: [
    { role: "user", content: { type: "text", text: "2+2?" } },
    { role: "assistant", content: "thinking…" },
  ],
  systemPrompt: "You are a calculator.",
  maxTokens: 16,
}

describe("ADR-0470 handler — request→completion mapping", () => {
  it("(1) maps messages + system into the StreamInput, flattening text blocks", async () => {
    const { llm, lastInput } = fakeLlm()
    const { prompter } = fakeConsent(allow)
    const handler = createLlmSamplingHandler({ llm, consent: prompter })

    await handler.createMessage(req)
    const input = lastInput()
    expect(input).not.toBeNull()
    // role passes through; both the {type:"text"} block AND a bare-string
    // content flatten to a single text block.
    expect(input?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "2+2?" }] },
      { role: "assistant", content: [{ type: "text", text: "thinking…" }] },
    ])
    expect(input?.system).toBe("You are a calculator.")
    // A plain sampling completion offers no tools.
    expect(input?.tools).toEqual([])
  })

  it("(1b) absent systemPrompt ⇒ system omitted from StreamInput", async () => {
    const { llm, lastInput } = fakeLlm()
    const { prompter } = fakeConsent(allow)
    const handler = createLlmSamplingHandler({ llm, consent: prompter })
    await handler.createMessage({ messages: [{ role: "user", content: "hi" }] })
    expect(lastInput()?.system).toBeUndefined()
  })

  it("(1c) non-text/unknown content modality flattens to empty text, never throws", async () => {
    const { llm, lastInput } = fakeLlm()
    const { prompter } = fakeConsent(allow)
    const handler = createLlmSamplingHandler({ llm, consent: prompter })
    const outcome = await handler.createMessage({
      messages: [{ role: "user", content: { type: "image", data: "…" } }],
    })
    expect(outcome.ok).toBe(true)
    expect(lastInput()?.messages).toEqual([{ role: "user", content: [{ type: "text", text: "" }] }])
  })
})

describe("ADR-0470 handler — result→CreateMessageResult mapping", () => {
  it("(2) assembles assistant text, model, stopReason from the stream", async () => {
    const { llm } = fakeLlm(
      [
        { type: "text_delta", delta: "the " },
        { type: "text_delta", delta: "answer is 4" },
        { type: "message_stop", stop_reason: "max_tokens" },
      ],
      "claude-x",
    )
    const { prompter } = fakeConsent(allow)
    const handler = createLlmSamplingHandler({ llm, consent: prompter })

    const outcome = await handler.createMessage(req)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error("unreachable")
    expect(outcome.result.role).toBe("assistant")
    expect(outcome.result.content).toEqual({ type: "text", text: "the answer is 4" })
    expect(outcome.result.model).toBe("claude-x")
    expect(outcome.result.stopReason).toBe("max_tokens")
  })

  it("(2b) LLM with no model id ⇒ result.model defaults to 'unknown'", async () => {
    const llm: LLMPort = {
      stream: () =>
        (async function* () {
          yield { type: "text_delta", delta: "x" } as StreamEvent
        })(),
    }
    const { prompter } = fakeConsent(allow)
    const handler = createLlmSamplingHandler({ llm, consent: prompter })
    const outcome = await handler.createMessage(req)
    if (!outcome.ok) throw new Error("unreachable")
    expect(outcome.result.model).toBe("unknown")
  })
})

describe("ADR-0470 handler — HITL consent gate", () => {
  it("(3) consent=allow ⇒ LLM IS called, fulfilled outcome", async () => {
    const { llm, calls } = fakeLlm()
    const { prompter, promptCalls } = fakeConsent(allow)
    const handler = createLlmSamplingHandler({ llm, consent: prompter })
    const outcome = await handler.createMessage(req)
    expect(promptCalls()).toBe(1)
    expect(calls()).toBe(1)
    expect(outcome.ok).toBe(true)
  })

  it("(3b) consent=deny ⇒ user-denied AND the LLM is NEVER called", async () => {
    const { llm, calls } = fakeLlm()
    const { prompter } = fakeConsent(deny)
    const handler = createLlmSamplingHandler({ llm, consent: prompter })
    const outcome = await handler.createMessage(req)
    expect(outcome).toEqual({ ok: false, reason: "user-denied" })
    expect(calls()).toBe(0)
  })

  it("(3c) consent prompter returns ok:false (e.g. cancelled) ⇒ user-denied, LLM not called", async () => {
    const { llm, calls } = fakeLlm()
    const { prompter } = fakeConsent({ ok: false, reason: "cancelled" })
    const handler = createLlmSamplingHandler({ llm, consent: prompter })
    const outcome = await handler.createMessage(req)
    expect(outcome).toEqual({ ok: false, reason: "user-denied" })
    expect(calls()).toBe(0)
  })

  it("(5) the headless default prompter (declines) ⇒ user-denied by default, LLM not called", async () => {
    const { llm, calls } = fakeLlm()
    // headlessRejecter is the SAME default an unwired McpClient uses — it
    // declines every prompt, so an unattended run never spends inference.
    const handler = createLlmSamplingHandler({ llm, consent: headlessRejecter })
    const outcome = await handler.createMessage(req)
    expect(outcome).toEqual({ ok: false, reason: "user-denied" })
    expect(calls()).toBe(0)
  })
})

describe("ADR-0470 handler — total (no-throw) contract", () => {
  it("(4a) a throwing consent prompter ⇒ user-denied, never throws", async () => {
    const { llm, calls } = fakeLlm()
    const prompter: ElicitationPrompter = {
      promptBoolean: async () => {
        throw new Error("prompter exploded")
      },
      promptString: async () => ({ ok: false, reason: "cancelled" }),
      promptNumber: async () => ({ ok: false, reason: "cancelled" }),
      promptInteger: async () => ({ ok: false, reason: "cancelled" }),
      promptEnum: async () => ({ ok: false, reason: "cancelled" }),
      promptMultiEnum: async () => ({ ok: false, reason: "cancelled" }),
      promptSingleEnum: async () => ({ ok: false, reason: "cancelled" }),
    }
    const handler = createLlmSamplingHandler({ llm, consent: prompter })
    const outcome = await handler.createMessage(req)
    expect(outcome).toEqual({ ok: false, reason: "user-denied" })
    expect(calls()).toBe(0)
  })

  it("(4b) a throwing LLM stream (after consent) ⇒ error, never throws", async () => {
    const { prompter } = fakeConsent(allow)
    const handler = createLlmSamplingHandler({ llm: throwingLlm(), consent: prompter })
    const outcome = await handler.createMessage(req)
    expect(outcome).toEqual({ ok: false, reason: "error" })
  })

  it("(4c) an empty stream ⇒ fulfilled with empty text (no crash)", async () => {
    const { llm } = fakeLlm([])
    const { prompter } = fakeConsent(allow)
    const handler = createLlmSamplingHandler({ llm, consent: prompter })
    const outcome = await handler.createMessage(req)
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) throw new Error("unreachable")
    expect(outcome.result.content).toEqual({ type: "text", text: "" })
    // No message_stop ⇒ stopReason omitted (not fabricated).
    expect(outcome.result.stopReason).toBeUndefined()
  })
})

describe("ADR-0470 — advertise-iff-handler (buildSamplingWiring)", () => {
  it("(6a) knob ON + deps present ⇒ advertise:true AND a handler (move together)", () => {
    const { llm } = fakeLlm()
    const { prompter } = fakeConsent(allow)
    const wiring = buildSamplingWiring(true, { llm, consent: prompter })
    expect(wiring.advertise).toBe(true)
    expect(wiring.handler).toBeDefined()
  })

  it("(6b) knob OFF ⇒ advertise:false AND NO handler (byte-identical default)", () => {
    const { llm } = fakeLlm()
    const { prompter } = fakeConsent(allow)
    const wiring = buildSamplingWiring(false, { llm, consent: prompter })
    expect(wiring.advertise).toBe(false)
    expect(wiring.handler).toBeUndefined()
  })

  it("(6c) knob ON but deps absent ⇒ advertise:false AND NO handler (cannot advertise without a handler)", () => {
    const wiring = buildSamplingWiring(true, undefined)
    expect(wiring.advertise).toBe(false)
    expect(wiring.handler).toBeUndefined()
  })
})
