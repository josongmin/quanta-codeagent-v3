/**
 * ADR-0049 side-conversation seam — e2e wiring tests.
 *
 * Covers (2 tests):
 *   1. dispatchSideConversation() resolves a question through the router
 *      WITHOUT touching the parent agent loop (parallel invocation, parent
 *      completes its own turn unmodified).
 *   2. parent abort cancels the side-conversation (cancellation propagation).
 */

import { describe, expect, it } from "bun:test"
import {
  dispatchSideConversation,
  runAgent,
  SideConversationAbortedError,
  type SideConversationResolver,
} from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import { baseConfig, FakeLLM, text } from "./_harness"

/** A side-conv LLM that always answers `text` plus a usage block. */
class SideLlm implements LLMPort {
  readonly model = "fake-side"
  calls = 0
  constructor(private readonly answer: string) {}
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    yield { type: "text_delta", delta: this.answer }
    yield {
      type: "usage",
      inputTokens: 10,
      outputTokens: 5,
      model: this.model,
    }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

/** A blocking side-conv LLM that yields nothing until the abort fires. */
class BlockingLlm implements LLMPort {
  readonly model = "blocking-side"
  readonly inputs: StreamInput[] = []
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    yield { type: "text_delta", delta: "" }
    await new Promise<never>((_, reject) => {
      if (input.signal === undefined) {
        reject(new Error("missing signal"))
        return
      }
      if (input.signal.aborted) {
        reject(new Error("signal already aborted"))
        return
      }
      input.signal.addEventListener("abort", () => reject(new Error("provider aborted")), {
        once: true,
      })
    })
    yield { type: "text_delta", delta: "should-be-discarded" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

describe("side-conversation e2e", () => {
  it("1. dispatches a question in parallel with the parent loop without disturbing it", async () => {
    const sideLlm = new SideLlm("42")
    const resolver: SideConversationResolver = {
      resolveLlm: () => sideLlm,
    }

    // Parent agent runs a one-turn script; we await it AFTER kicking off the
    // side-conv to assert ordering, but the agent's own LLM is independent
    // of the side-conv LLM (different instance), so the side-conv cannot
    // contaminate the parent's message buffer.
    const parentLlm = new FakeLLM([text("parent-done")])
    const cfg = baseConfig({ llm: parentLlm, maxTurns: 2 })

    // Fire side-conv concurrently.
    const sidePromise = dispatchSideConversation(
      { parentSessionId: "parent-session", question: "What is the answer?" },
      resolver,
    )

    const [outcome, sideResp] = await Promise.all([runAgent(cfg), sidePromise])

    expect(outcome.reason).toBe("completed")
    expect(sideResp.answer).toBe("42")
    expect(sideResp.tokens).toEqual({ input: 10, output: 5 })

    // Parent received NO trace of the side-conv (its message history is
    // its own seed + one assistant turn).
    const parentAssistantMessages: Message[] = outcome.messages.filter(
      (m) => m.role === "assistant",
    )
    expect(parentAssistantMessages.length).toBe(1)
    const parentText = parentAssistantMessages[0]?.content
      .filter((b) => b.type === "text")
      .map((b) => (b as { type: "text"; text: string }).text)
      .join("")
    expect(parentText).toBe("parent-done")
    expect(parentText).not.toContain("42")
  })

  it("2. parent abort cancels the side-conversation in flight", async () => {
    const ac = new AbortController()
    const blockingLlm = new BlockingLlm()
    const resolver: SideConversationResolver = {
      resolveLlm: () => blockingLlm,
      signal: ac.signal,
    }

    const promise = dispatchSideConversation({ parentSessionId: "p", question: "long" }, resolver)
    await Promise.resolve()

    expect(blockingLlm.inputs[0]?.signal).toBe(ac.signal)

    ac.abort()

    await expect(promise).rejects.toBeInstanceOf(SideConversationAbortedError)
  })
})
