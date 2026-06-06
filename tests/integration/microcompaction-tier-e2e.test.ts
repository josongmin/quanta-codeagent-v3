/**
 * E2E — tier-1 microcompaction in the REAL loop (RFC jun-6-microcompaction §6.3).
 *
 * Drives `runAgent` with `QUANTA_MICROCOMPACT=1` and asserts:
 *   1. A transcript bloated with OLD tool dumps ⇒ tier-1 fires (clears the old
 *      tool_result bodies via `wm.replace`), with ZERO summarizer LLM calls and
 *      the assistant reasoning text preserved verbatim. tier-2 no-ops.
 *   2. default-OFF (knob unset) ⇒ NO eviction, NO `recovery:compact` event —
 *      byte-identical to the pre-feature flow.
 *
 * Harness mirrors compaction-archive-loop.test.ts (no cross-test imports).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { runAgent } from "@/agent"
import type { LLMPort, Message, StreamEvent, StreamInput } from "@/llm"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { AgentEvent, StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

class ScriptedLLM implements LLMPort {
  readonly inputs: StreamInput[] = []
  calls = 0
  readonly model = "scripted"
  constructor(private readonly scripts: StreamEvent[][]) {}
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.inputs.push(input)
    this.calls += 1
    const next = this.scripts.shift() ?? [
      { type: "text_delta", delta: "final" },
      { type: "message_stop", stop_reason: "end_turn" },
    ]
    for (const ev of next) yield ev
  }
}

class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

const userText = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] })
const textScript = (text: string): StreamEvent[] => [
  { type: "text_delta", delta: text },
  { type: "message_stop", stop_reason: "end_turn" },
]

/** Old tool dumps + verbatim assistant reasoning, UNDER a high summarization
 *  threshold. The 4 oldest tool_results are big stale dumps; the assistant text
 *  in between is the reasoning we must keep verbatim. */
const bloatedHistory = (): Message[] => {
  const out: Message[] = [userText("start the task")]
  for (let i = 0; i < 5; i++) {
    out.push({
      role: "assistant",
      content: [
        { type: "text", text: `DECISION ${i}: keep this reasoning verbatim` },
        { type: "tool_use", id: `u${i}`, name: "Read", input: { path: `f${i}` } },
      ],
    })
    out.push({
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `u${i}`, content: `dump${i}:${"x".repeat(60_000)}` },
      ],
    })
  }
  out.push(userText("now answer"))
  return out
}

const cfg = (over: Partial<AgentConfig> & Pick<AgentConfig, "llm">): AgentConfig => ({
  registry: new ToolRegistry(defaultTools),
  stream: new RecordingStream(),
  permission: { mode: "acceptEdits" } as PermissionContext,
  messages: [userText("go")],
  system: "test-system",
  cwd: "/tmp",
  maxTurns: 5,
  signal: new AbortController().signal,
  onConfirm: async () => false,
  ...over,
})

const origKnob = process.env.QUANTA_MICROCOMPACT
const origFloor = process.env.QUANTA_MICROCOMPACT_FLOOR_TOKENS
const origInterval = process.env.QUANTA_MICROCOMPACT_INTERVAL_MS

afterEach(() => {
  if (origKnob === undefined) delete process.env.QUANTA_MICROCOMPACT
  else process.env.QUANTA_MICROCOMPACT = origKnob
  if (origFloor === undefined) delete process.env.QUANTA_MICROCOMPACT_FLOOR_TOKENS
  else process.env.QUANTA_MICROCOMPACT_FLOOR_TOKENS = origFloor
  if (origInterval === undefined) delete process.env.QUANTA_MICROCOMPACT_INTERVAL_MS
  else process.env.QUANTA_MICROCOMPACT_INTERVAL_MS = origInterval
  __resetRuntimeConfig()
})

describe("tier-1 microcompaction e2e", () => {
  beforeEach(() => {
    __resetRuntimeConfig()
  })

  test("knob ON ⇒ old tool dumps cleared (no summarizer call), reasoning preserved", async () => {
    process.env.QUANTA_MICROCOMPACT = "1"
    process.env.QUANTA_MICROCOMPACT_FLOOR_TOKENS = "100"
    process.env.QUANTA_MICROCOMPACT_INTERVAL_MS = "1"
    __resetRuntimeConfig()

    const main = new ScriptedLLM([textScript("final answer")])
    const stream = new RecordingStream()
    const out = await runAgent(
      cfg({
        llm: main,
        stream,
        messages: bloatedHistory(),
        // Threshold high enough that tier-2 summarization never crosses — only
        // tier-1 eviction can shrink this transcript.
        compaction: { thresholdTokens: 10_000_000, keepRecentTurns: 2 },
      }),
    )
    expect(out.reason).toBe("completed")
    // Exactly ONE LLM call — the answer turn. NO summarizer round-trip.
    expect(main.calls).toBe(1)

    // The answer turn's input transcript: the OLD tool dumps were cleared, the
    // most-recent kept, and every assistant DECISION text is verbatim.
    const sent = main.inputs[0]?.messages ?? []
    const clearedCount = sent
      .flatMap((m) => m.content)
      .filter(
        (b) =>
          b.type === "tool_result" && b.content.startsWith("[Old tool result content cleared]"),
      ).length
    expect(clearedCount).toBeGreaterThan(0)
    // Reasoning text survives byte-for-byte.
    const allText = sent
      .flatMap((m) => m.content)
      .filter((b): b is Extract<typeof b, { type: "text" }> => b.type === "text")
      .map((b) => b.text)
      .join("\n")
    expect(allText).toContain("DECISION 0: keep this reasoning verbatim")
    expect(allText).toContain("DECISION 4: keep this reasoning verbatim")
    // A tier-1 recovery event fired with the microcompact detail.
    expect(
      stream.events.some(
        (e) => e.type === "recovery" && e.reason === "compact" && e.detail === "microcompact",
      ),
    ).toBe(true)
    // NO synthetic <conversation summary> (tier-2 never ran).
    expect(allText).not.toContain("<conversation summary>")
  })

  test("default-OFF (knob unset) ⇒ NO eviction, byte-identical (no recovery:compact)", async () => {
    delete process.env.QUANTA_MICROCOMPACT
    __resetRuntimeConfig()

    const main = new ScriptedLLM([textScript("final answer")])
    const stream = new RecordingStream()
    const out = await runAgent(
      cfg({
        llm: main,
        stream,
        messages: bloatedHistory(),
        compaction: { thresholdTokens: 10_000_000, keepRecentTurns: 2 },
      }),
    )
    expect(out.reason).toBe("completed")
    expect(main.calls).toBe(1)
    const sent = main.inputs[0]?.messages ?? []
    // NOTHING cleared — the original big dumps are intact.
    const cleared = sent
      .flatMap((m) => m.content)
      .filter(
        (b) =>
          b.type === "tool_result" && b.content.startsWith("[Old tool result content cleared]"),
      )
    expect(cleared.length).toBe(0)
    // No tier-1 (or tier-2) recovery:compact event.
    expect(stream.events.some((e) => e.type === "recovery" && e.reason === "compact")).toBe(false)
  })
})
