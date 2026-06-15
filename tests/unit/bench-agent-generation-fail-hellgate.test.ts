import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInstance } from "@/apps/bench/eval"
import type { Instance } from "@/apps/bench/types"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"

class QuotaFailLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "" }
    throw new Error(
      "LLM stream failed after retries: chatgpt-oauth responses request failed: 429 Too Many Requests — usage_limit_reached",
    )
  }
}

describe("bench agent generation failure", () => {
  test("agent LLM failure is reported before verifier empty-patch grading", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-generation-fail-"))
    try {
      writeFileSync(join(dir, "marker.txt"), "seed\n")
      const instance: Instance = {
        id: "generation-fail",
        repoPath: dir,
        problemStatement: "Do nothing.",
        testCmd: "true",
      }

      const result = await runInstance(instance, {
        llm: new QuotaFailLLM(),
        maxTurns: 3,
        timeoutMs: 20_000,
      })

      expect(result.passed).toBe(false)
      expect(result.patch).toBe("")
      expect(result.turns).toBe(0)
      expect(result.error).toContain("usage_limit_reached")
      expect(result.error).not.toContain("empty prediction")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
