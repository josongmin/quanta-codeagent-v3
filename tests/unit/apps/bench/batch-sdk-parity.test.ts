import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { runInstance } from "../../../../src/apps/bench/eval/index"
import type { Instance } from "../../../../src/apps/bench/types"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")

class NoopLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

describe("T5 batch SDK parity", () => {
  test("batch driver consumes the sdk runtime and keeps direct bootstrap out", () => {
    const source = readFileSync(join(REPO_ROOT, "src/apps/bench/eval/driver.ts"), "utf8")

    expect(source).toContain('from "@/sdk/runtime"')
    expect(source).toContain("await createRuntime(")
    expect(source).toContain("await runtime.createSession(")
    expect(source).toContain("captureBenchSessionEvents(session)")
    expect(source).toContain("await session.input.append(")
    expect(source).toContain("await session.turn.run(")
    expect(source).not.toContain('from "@/host/bootstrap"')
    expect(source).not.toContain("bootstrapSession(")
    expect(source).not.toContain("createRuntimeFromBootstrap(")
  })

  test("runInstance preserves the per-instance public result shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "batch-sdk-parity-"))
    try {
      writeFileSync(join(dir, "marker"), "")
      const instance: Instance = {
        id: "batch-sdk-parity-1",
        repoPath: dir,
        problemStatement: "Do nothing.",
        testCmd: "false",
      }
      const result = await runInstance(instance, {
        llm: new NoopLLM(),
        maxTurns: 1,
        timeoutMs: 20_000,
      })

      expect(result.id).toBe(instance.id)
      expect(typeof result.passed).toBe("boolean")
      expect(typeof result.patch).toBe("string")
      expect(typeof result.turns).toBe("number")
      expect(result.passed).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
