import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import {
  classifyGroundingInfraError,
  runGrounding,
  runGroundingPreflightCheck,
} from "@/../src/apps/eval/grounding"

class JsonLLM implements LLMPort {
  readonly provider = "openai"
  readonly model = "gpt-4.1"
  readonly surfaceId = "openai-responses"
  readonly transportId = "public"
  active = 0
  maxActive = 0
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.active += 1
    this.maxActive = Math.max(this.maxActive, this.active)
    await new Promise((resolve) => setTimeout(resolve, 5))
    yield {
      type: "text_delta",
      delta:
        '{"activeThreadId":"prompt_rules","referentId":"prompt_rules","intent":"status_check","scope":"current_workstream","shouldClarify":false,"confidence":"high"}',
    }
    yield { type: "message_stop", stop_reason: "end_turn" }
    this.active -= 1
  }
}

class AuthErrorLLM implements LLMPort {
  readonly provider = "chatgpt-oauth"
  readonly model = "gpt-4.1"
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    throw new Error("401 Unauthorized token_invalidated")
  }
}

describe("grounding diagnostics", () => {
  test("classifies common infra failures", () => {
    expect(classifyGroundingInfraError("401 Unauthorized token_invalidated")).toBe("auth")
    expect(classifyGroundingInfraError("credit balance is too low")).toBe("billing")
    expect(classifyGroundingInfraError("429 rate limit")).toBe("rate_limit")
    expect(
      classifyGroundingInfraError(
        "503 Service Unavailable — upstream connect error or disconnect/reset before headers",
      ),
    ).toBe("network")
  })

  test("preflight surfaces route metadata and auth errors", async () => {
    const ok = await runGroundingPreflightCheck(new JsonLLM())
    expect(ok.error).toBeUndefined()
    expect(ok.provider).toBe("openai")
    expect(ok.surfaceId).toBe("openai-responses")

    const bad = await runGroundingPreflightCheck(new AuthErrorLLM())
    expect(bad.errorKind).toBe("auth")
    expect(bad.error).toContain("llm stream failed")
  })

  test("runGrounding honors bounded concurrency and propagates route metadata", async () => {
    const llm = new JsonLLM()
    const dir = mkdtempSync(join(tmpdir(), "grounding-run-"))
    const summary = await runGrounding({
      llm,
      suite: "canary",
      limit: 4,
      concurrency: 2,
      storeDir: dir,
      now: () => 1_700_000_000_000,
    })
    expect(summary.total).toBe(4)
    expect(summary.concurrency).toBe(2)
    expect(summary.provider).toBe("openai")
    expect(summary.surfaceId).toBe("openai-responses")
    expect(summary.caseSetFingerprint).toHaveLength(16)
    expect(summary.routeFingerprint).toHaveLength(16)
    expect(summary.harnessFingerprint).toHaveLength(16)
    expect(llm.maxActive).toBeGreaterThan(1)
  })
})
