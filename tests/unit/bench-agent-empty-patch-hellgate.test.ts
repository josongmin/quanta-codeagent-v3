import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInstance } from "@/apps/bench/eval"
import type { Instance } from "@/apps/bench/types"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"

class CompletedNoEditLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "No source change is needed." }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

describe("bench agent empty patch boundary", () => {
  test("completed no-edit agent is terminal and never invokes verifier/testCmd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-agent-empty-patch-"))
    const marker = join(dir, "verifier-ran")
    const repo = join(dir, "repo")
    try {
      mkdirSync(repo, { recursive: true })
      writeFileSync(join(repo, "marker.txt"), "seed\n")
      const instance: Instance = {
        id: "empty-patch-terminal",
        repoPath: repo,
        problemStatement: "Do not edit anything.",
        testCmd: `sh -c 'printf verifier > ${marker}; exit 0'`,
      }

      const result = await runInstance(instance, {
        llm: new CompletedNoEditLLM(),
        maxTurns: 3,
        timeoutMs: 20_000,
        measurementStability: { maxAttempts: 3 },
      })

      expect(result.passed).toBe(false)
      expect(result.patch).toBe("")
      expect(result.error).toBeUndefined()
      expect(result.turns).toBeGreaterThan(0)
      expect(existsSync(marker)).toBe(false)
      expect(result.budget?.attempts).toBe(1)
      expect(result.budget?.attemptOutcomes).toEqual([
        { kind: "real-fail", subkind: "completed_unresolved" },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
