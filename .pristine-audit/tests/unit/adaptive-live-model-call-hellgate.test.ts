import { describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { ADAPTIVE_DECISION_JSON_SCHEMA } from "@/runner/batch/eval/adaptive-escalation/decision-schema"
import { makeAdaptiveToolModelCall } from "@/runner/batch/eval/adaptive-escalation/live-model-call"

class ScriptedLLM implements LLMPort {
  private readonly scripts: readonly StreamEvent[][]
  calls = 0

  constructor(...scripts: readonly StreamEvent[][]) {
    this.scripts = scripts
  }

  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    const script = this.scripts[Math.min(this.calls, this.scripts.length - 1)] ?? []
    this.calls += 1
    for (const event of script) yield event
  }
}

const TOOL_NAME = "route_adaptive_phase"

describe("adaptive live model call", () => {
  test("uses the forced schema tool when the provider returns tool_use", async () => {
    const llm = new ScriptedLLM([
      { type: "tool_use_start", id: "r1", name: TOOL_NAME },
      {
        type: "tool_use_end",
        id: "r1",
        input: {
          action: "accept_thin",
          evidenceGaps: [],
          citedEvidenceIds: [],
          why: "thin is sufficient",
        },
      },
      { type: "message_stop", stop_reason: "tool_use" },
    ])
    const call = makeAdaptiveToolModelCall({ llm })
    const out = await call({
      prompt: "route",
      schema: ADAPTIVE_DECISION_JSON_SCHEMA,
      model: "unused-in-port",
      maxTokens: 128,
    })
    expect(out).toEqual({
      action: "accept_thin",
      evidenceGaps: [],
      citedEvidenceIds: [],
      why: "thin is sufficient",
    })
  })

  test("accepts validated text JSON only as a fallback", async () => {
    const llm = new ScriptedLLM([
      {
        type: "text_delta",
        delta:
          '{"action":"run_proof_clean","evidenceGaps":["candidate_no_positive_proof"],"citedEvidenceIds":["proof"],"why":"need proof"}',
      },
      { type: "message_stop", stop_reason: "end_turn" },
    ])
    const call = makeAdaptiveToolModelCall({ llm })
    const out = await call({
      prompt: "route",
      schema: ADAPTIVE_DECISION_JSON_SCHEMA,
      model: "unused-in-port",
      maxTokens: 128,
    })
    expect(out).toEqual({
      action: "run_proof_clean",
      evidenceGaps: ["candidate_no_positive_proof"],
      citedEvidenceIds: ["proof"],
      why: "need proof",
    })
  })

  test("invalid text falls through as raw output so the controller rejects it fail-closed", async () => {
    const llm = new ScriptedLLM([
      { type: "text_delta", delta: "not json" },
      { type: "message_stop", stop_reason: "end_turn" },
    ])
    const call = makeAdaptiveToolModelCall({ llm })
    const out = await call({
      prompt: "route",
      schema: ADAPTIVE_DECISION_JSON_SCHEMA,
      model: "unused-in-port",
      maxTokens: 128,
    })
    expect(out).toBe("not json")
  })
})
