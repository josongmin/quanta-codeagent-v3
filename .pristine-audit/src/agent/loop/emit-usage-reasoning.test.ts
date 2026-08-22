/**
 * TDD + WIRING GUARD — S3 (jul-03): the agent-level `emitUsage` seam must
 * FORWARD the reasoning-token split from the LLM `usage` StreamEvent onto the
 * `usage` AgentEvent it re-emits on `config.stream`.
 *
 * This is the seam the spec calls out ("forward through emit-helpers.ts"): the
 * wire produces `usage.reasoningTokens`, but if this re-emit drops it, every
 * downstream AgentEvent sink (surface gauge / recorder / debug tracer) is blind
 * to it — a classic wired-but-inert trap where the value is parsed upstream and
 * silently lost at the surface boundary.
 *
 * RED-ON-INJECTION: the last test asserts the field survives a value that would
 * be dropped by a truthiness guard (reasoningTokens: 0) AND that omission is
 * honoured (absent ⇒ absent, no synthetic 0), so a regression that stops
 * spreading the field, or that guards it with `if (x)`, turns this RED.
 */
import { describe, expect, test } from "bun:test"
import type { AgentEvent } from "@/stream"
import type { AgentConfig } from "../types"
import { emitUsage } from "./emit-helpers"

/** Minimal AgentConfig stub — `emitUsage` reads only `config.stream` (all other
 *  slots are optional and no-op when absent). Cast keeps the test a leaf. */
const stubConfig = (sink: AgentEvent[]): AgentConfig =>
  ({
    stream: {
      emit: (e: AgentEvent): void => {
        sink.push(e)
      },
    },
  }) as unknown as AgentConfig

const usageEventOf = (sink: AgentEvent[]): Extract<AgentEvent, { type: "usage" }> => {
  const u = sink.find((e): e is Extract<AgentEvent, { type: "usage" }> => e.type === "usage")
  if (u === undefined) throw new Error("no usage AgentEvent emitted")
  return u
}

describe("agent emitUsage — reasoningTokens forward", () => {
  test("forwards reasoningTokens from the StreamEvent onto the AgentEvent", () => {
    const sink: AgentEvent[] = []
    emitUsage(
      stubConfig(sink),
      { type: "usage", inputTokens: 100, outputTokens: 40, reasoningTokens: 30, model: "gpt-5" },
      undefined,
      undefined,
      undefined,
    )
    const usage = usageEventOf(sink)
    expect(usage.inputTokens).toBe(100)
    expect(usage.reasoningTokens).toBe(30)
  })

  test("omits reasoningTokens when the source event has none (Anthropic byte-identical)", () => {
    const sink: AgentEvent[] = []
    emitUsage(
      stubConfig(sink),
      { type: "usage", inputTokens: 10, outputTokens: 5, model: "claude-sonnet-4-5" },
      undefined,
      undefined,
      undefined,
    )
    const usage = usageEventOf(sink)
    expect("reasoningTokens" in usage).toBe(false)
  })

  test("forwards an explicit zero split verbatim (0 must not be dropped by a truthiness guard)", () => {
    const sink: AgentEvent[] = []
    emitUsage(
      stubConfig(sink),
      { type: "usage", inputTokens: 20, outputTokens: 20, reasoningTokens: 0, model: "gpt-5" },
      undefined,
      undefined,
      undefined,
    )
    const usage = usageEventOf(sink)
    expect(usage.reasoningTokens).toBe(0)
    expect("reasoningTokens" in usage).toBe(true)
  })
})
