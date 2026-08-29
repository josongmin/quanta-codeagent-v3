/**
 * ★ HELLGATE (MR-04) — every report names the model that ACTUALLY RAN.
 *
 * `config.llm` is the BOOT port. Once a sticky pick, a `/model` switch or a skill
 * `model:` override could swap the port per turn, `llm_request` kept announcing
 * the boot model for the rest of the session — and it is not a debug field:
 *
 *   - the CLI prints it (`— llm request (<model>) —`, `stream/adapters/stdout.ts`);
 *   - the debug tracer renders it (`debug-tracer.ts`);
 *   - the session JSONL records it (`jsonl-recorder-event-data.ts`);
 *   - the headless `stream-json` surface publishes it as `turn.llm.request.model`.
 *
 * MEASURED through the real `runAgent` before MR-04:
 *     PORTS STREAMED: ["gpt-4o"]      llm_request.model: "boot-model"
 *
 * The contract MR-00 fixed is that SELECTED and EXECUTED are different facts. This
 * pins the executed side end to end: the port that streams and the model the event
 * names are the same object's identity, for a sticky pick AND for a skill override,
 * with a paired control that an unswitched turn is byte-identical.
 *
 * RED-on-injection: `emitLlmRequest(config, config.llm, …)` ⇒ both switch cases red.
 */

import { describe, expect, test } from "bun:test"
import { type AgentConfig, runAgent } from "@/agent"
import { inMemoryStickyModelStore } from "@/agent/sticky-model"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import type { AgentEvent } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

class CountingLLM implements LLMPort {
  calls = 0
  readonly provider = "openai"
  constructor(readonly model: string) {}
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    yield { type: "text_delta", delta: "ok" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const runOnce = async (over: Partial<AgentConfig>) => {
  const events: AgentEvent[] = []
  const boot = new CountingLLM("boot-model")
  const picked = new CountingLLM("gpt-4o")
  await runAgent({
    llm: boot,
    cwd: "/tmp",
    registry: new ToolRegistry(defaultTools),
    stream: { emit: (e: AgentEvent) => events.push(e) },
    permission: { mode: "acceptEdits" },
    messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    system: "t",
    maxTurns: 2,
    signal: new AbortController().signal,
    modelCandidates: [{ id: "gpt-4o", port: picked }],
    ...over,
  } as unknown as AgentConfig)
  const req = events.find((e) => e.type === "llm_request") as
    | { readonly model?: string; readonly provider?: string }
    | undefined
  return { req, boot, picked }
}

describe("MR-04 — llm_request names the EXECUTED model", () => {
  test("a STICKY pick: the picked port streams and the event names it", async () => {
    const { req, boot, picked } = await runOnce({
      stickyModelStore: {
        store: inMemoryStickyModelStore({ "openai:default": "gpt-4o" }),
        provider: "openai",
      },
    } as Partial<AgentConfig>)
    expect([boot.calls, picked.calls]).toEqual([0, 1])
    expect(req?.model).toBe("gpt-4o")
  })

  test("paired control — NO switch ⇒ the boot model streams and is named", async () => {
    const { req, boot, picked } = await runOnce({})
    expect([boot.calls, picked.calls]).toEqual([1, 0])
    expect(req?.model).toBe("boot-model")
  })

  test("the event's PROVIDER also comes from the streaming port, not the boot one", async () => {
    // A swapped port can legitimately carry a different provider identity (a
    // fallback stack, a differently-configured endpoint). Reading these fields off
    // `config.llm` while the OTHER port streams mislabels the whole request.
    const { req } = await runOnce({
      stickyModelStore: {
        store: inMemoryStickyModelStore({ "openai:default": "gpt-4o" }),
        provider: "openai",
      },
    } as Partial<AgentConfig>)
    expect(req?.provider).toBe("openai")
  })
})
