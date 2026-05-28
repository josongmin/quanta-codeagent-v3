import { describe, expect, test } from "bun:test"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import {
  buildGroundingHarnessManifest,
  groundingHarnessFingerprint,
  runGroundingProbe,
  type GroundingCase,
} from "@/../src/apps/eval/grounding"

class CaptureLLM implements LLMPort {
  readonly provider = "openai"
  readonly model = "gpt-4.1"
  captured?: StreamInput

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.captured = input
    yield {
      type: "text_delta",
      delta:
        '{"activeThreadId":"prompt_rules","referentId":"prompt_rules","intent":"status_check","scope":"current_workstream","shouldClarify":false,"confidence":"high"}',
    }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class FlakyFirstChunkTimeoutLLM implements LLMPort {
  readonly provider = "openai"
  readonly model = "gpt-4.1"
  calls = 0

  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    if (this.calls === 1) {
      throw new Error("LLM stream first-chunk timeout after 60000ms (provider sent no data; timed out)")
    }
    yield {
      type: "text_delta",
      delta:
        '{"activeThreadId":"prompt_rules","referentId":"prompt_rules","intent":"status_check","scope":"current_workstream","shouldClarify":false,"confidence":"high"}',
    }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class FlakyTransportLLM implements LLMPort {
  readonly provider = "chatgpt-oauth"
  readonly model = "gpt-5"
  calls = 0

  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    if (this.calls === 1) {
      throw new Error(
        "chatgpt-oauth responses request failed: 503 Service Unavailable — upstream connect error or disconnect/reset before headers",
      )
    }
    yield {
      type: "text_delta",
      delta:
        '{"activeThreadId":"prompt_rules","referentId":"prompt_rules","intent":"status_check","scope":"current_workstream","shouldClarify":false,"confidence":"high"}',
    }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const flattenText = (input: StreamInput | undefined): string =>
  (input?.messages ?? [])
    .flatMap((message) => message.content)
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n")

describe("grounding probe rendering", () => {
  test("renders structured history metadata into the probe transcript", async () => {
    const llm = new CaptureLLM()
    const groundingCase: GroundingCase = {
      schema: 2,
      id: "pair-summary",
      usecase: "persistent-context.conversation-state.thread-grounding",
      history: [
        {
          role: "assistant",
          kind: "summary",
          text: "Conversation summary: prompt_rules is active.",
          threadId: "prompt_rules",
          mentionedFileIds: ["src/agent/prompt.ts"],
          mentionedReferentIds: ["prompt_rules_step_2"],
          mentionedThreadIds: ["oauth_abort_flow"],
          policyMarkers: ["closeout"],
        },
      ],
      targetUtterance: "야 이제 다 해결됐냐?",
      gold: {
        activeThreadId: "prompt_rules",
        referentId: "prompt_rules",
        intent: "status_check",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "high",
      },
      bucket: "summary_equivalence",
      severity: "critical",
      pairId: "pair-prompt-rules-status",
      pairRole: "summary",
      stateContract: {
        activeThreadId: "prompt_rules",
        visibleThreadIds: ["oauth_abort_flow", "prompt_rules"],
        pausedThreadIds: ["oauth_abort_flow"],
        policyMarkers: ["closeout"],
      },
    }

    const result = await runGroundingProbe(groundingCase, { llm, now: () => 0 })
    expect(result.error).toBeUndefined()
    const rendered = flattenText(llm.captured)
    expect(rendered).toContain("<grounding-meta>")
    expect(rendered).toContain('"kind":"summary"')
    expect(rendered).toContain('"threadId":"prompt_rules"')
    expect(rendered).toContain('"mentionedFileIds":["src/agent/prompt.ts"]')
    expect(rendered).toContain('"mentionedReferentIds":["prompt_rules_step_2"]')
    expect(rendered).toContain('"mentionedThreadIds":["oauth_abort_flow"]')
    expect(rendered).toContain('"policyMarkers":["closeout"]')
  })

  test("harness manifest is source-derived and fingerprinted", () => {
    const manifest = buildGroundingHarnessManifest()
    expect(manifest.contract.schemaVersion).toBe(2)
    expect(manifest.sourceFiles.map((entry) => entry.file)).toEqual([
      "compare.ts",
      "config.ts",
      "execution-contract.ts",
      "file-context.ts",
      "harness.ts",
      "loader.ts",
      "normalizer.ts",
      "normalization/heuristic.ts",
      "normalization/structural.ts",
      "parser.ts",
      "probe.ts",
      "replay-scaffold.ts",
      "referent-context.ts",
      "report.ts",
      "route-matrix.ts",
      "schema.ts",
      "scorer.ts",
      "stable-json.ts",
    ])
    expect(groundingHarnessFingerprint()).toHaveLength(16)
  })

  test("runtime-parity probe omits evaluator decision rules", async () => {
    const llm = new CaptureLLM()
    const groundingCase: GroundingCase = {
      schema: 2,
      id: "runtime-parity",
      usecase: "persistent-context.conversation-state.thread-grounding",
      history: [{ role: "assistant", text: "Active thread prompt_rules." }],
      targetUtterance: "야 이제 다 해결됐냐?",
      gold: {
        activeThreadId: "prompt_rules",
        referentId: "prompt_rules",
        intent: "status_check",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "high",
      },
      bucket: "ellipsis",
      severity: "critical",
      stateContract: {
        activeThreadId: "prompt_rules",
      },
    }
    await runGroundingProbe(groundingCase, {
      llm,
      probeProfile: "runtime_parity",
      now: () => 0,
    })
    const rendered = flattenText(llm.captured)
    expect(rendered).not.toContain("Decision rules:")
    expect(rendered).toContain("Use only the provided conversation context")
    expect(rendered).toContain("Field semantics:")
    expect(rendered).toContain("intent = the user's underlying goal")
  })

  test("minimal probe still describes tuple semantics without evaluator rules", async () => {
    const llm = new CaptureLLM()
    const groundingCase: GroundingCase = {
      schema: 2,
      id: "minimal",
      usecase: "persistent-context.conversation-state.thread-grounding",
      history: [{ role: "assistant", text: "Active thread prompt_rules." }],
      targetUtterance: "야 이제 다 해결됐냐?",
      gold: {
        activeThreadId: "prompt_rules",
        referentId: "prompt_rules",
        intent: "status_check",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "high",
      },
      bucket: "ellipsis",
      severity: "critical",
      stateContract: {
        activeThreadId: "prompt_rules",
      },
      candidateThreadIds: ["prompt_rules"],
    }
    await runGroundingProbe(groundingCase, {
      llm,
      probeProfile: "minimal",
      now: () => 0,
    })
    const rendered = flattenText(llm.captured)
    expect(rendered).not.toContain("Decision rules:")
    expect(rendered).toContain("Field semantics:")
    expect(rendered).toContain("Authoritative candidate constraints:")
    expect(rendered).toContain('"candidateThreadIds":["prompt_rules"]')
    expect(rendered).toContain("For current_workstream use the thread id")
  })

  test("retries a first-chunk timeout once before surfacing an error", async () => {
    const llm = new FlakyFirstChunkTimeoutLLM()
    const groundingCase: GroundingCase = {
      schema: 2,
      id: "retry",
      usecase: "persistent-context.conversation-state.thread-grounding",
      history: [{ role: "assistant", text: "Active thread prompt_rules." }],
      targetUtterance: "야 이제 다 해결됐냐?",
      gold: {
        activeThreadId: "prompt_rules",
        referentId: "prompt_rules",
        intent: "status_check",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "high",
      },
      bucket: "ellipsis",
      severity: "critical",
    }
    const result = await runGroundingProbe(groundingCase, { llm, now: () => 0 })
    expect(result.error).toBeUndefined()
    expect(result.decision?.activeThreadId).toBe("prompt_rules")
    expect(llm.calls).toBe(2)
  })

  test("retries a transient empty-body transport failure once before surfacing an error", async () => {
    const llm = new FlakyTransportLLM()
    const groundingCase: GroundingCase = {
      schema: 2,
      id: "retry-transport",
      usecase: "persistent-context.conversation-state.thread-grounding",
      history: [{ role: "assistant", text: "Active thread prompt_rules." }],
      targetUtterance: "야 이제 다 해결됐냐?",
      gold: {
        activeThreadId: "prompt_rules",
        referentId: "prompt_rules",
        intent: "status_check",
        scope: "current_workstream",
        shouldClarify: false,
        confidence: "high",
      },
      bucket: "ellipsis",
      severity: "critical",
    }
    const result = await runGroundingProbe(groundingCase, { llm, now: () => 0 })
    expect(result.error).toBeUndefined()
    expect(result.decision?.activeThreadId).toBe("prompt_rules")
    expect(llm.calls).toBe(2)
  })
})
