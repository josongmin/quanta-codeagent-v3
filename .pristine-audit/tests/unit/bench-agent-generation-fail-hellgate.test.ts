import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
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

class EditThenThrowLLM implements LLMPort {
  private calls = 0

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    const text = input.messages
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
    const sandbox = text.match(/Work inside (\S+?)\./)?.[1] ?? ""
    if (this.calls === 1) {
      yield { type: "tool_use_start", id: "e1", name: "edit" }
      yield {
        type: "tool_use_end",
        id: "e1",
        input: {
          path: join(sandbox, "math.js"),
          old_string: "return a - b",
          new_string: "return a + b",
        },
      }
      yield { type: "message_stop", stop_reason: "tool_use" }
      return
    }
    throw new Error("429 Too Many Requests")
  }
}

class EditThenRefuseLLM implements LLMPort {
  private calls = 0

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    const text = input.messages
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
    const sandbox = text.match(/Work inside (\S+?)\./)?.[1] ?? ""
    if (this.calls === 1) {
      yield { type: "tool_use_start", id: "e1", name: "edit" }
      yield {
        type: "tool_use_end",
        id: "e1",
        input: {
          path: join(sandbox, "math.js"),
          old_string: "return a - b",
          new_string: "return a + b",
        },
      }
      yield { type: "message_stop", stop_reason: "tool_use" }
      return
    }
    yield { type: "text_delta", delta: "I refuse to continue." }
    yield { type: "message_stop", stop_reason: "refusal" }
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
      expect(result.stopReason).toBe("error")
      expect(result.error).toContain("usage_limit_reached")
      expect(result.error).not.toContain("empty prediction")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test("ADVERSARIAL: post-edit provider error still verifies the retained patch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-error-patch-"))
    const repo = join(dir, "repo")
    try {
      mkdirSync(repo, { recursive: true })
      writeFileSync(
        join(repo, "math.js"),
        "function add(a,b){ return a - b }\nmodule.exports={add}\n",
      )
      const instance: Instance = {
        id: "bench-error-patch",
        repoPath: repo,
        problemStatement: "Fix add() in math.js.",
        testCmd: `node -e "const {add}=require('./math.js'); if(add(2,3)!==5) process.exit(1)"`,
      }

      const result = await runInstance(instance, {
        llm: new EditThenThrowLLM(),
        maxTurns: 3,
        timeoutMs: 20_000,
      })

      expect(result.passed).toBe(true)
      expect(result.stopReason).toBeUndefined()
      expect(result.patch).toContain("return a + b")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test("ADVERSARIAL: post-edit refusal still verifies the retained patch", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-refusal-patch-"))
    const repo = join(dir, "repo")
    try {
      mkdirSync(repo, { recursive: true })
      writeFileSync(
        join(repo, "math.js"),
        "function add(a,b){ return a - b }\nmodule.exports={add}\n",
      )
      const instance: Instance = {
        id: "bench-refusal-patch",
        repoPath: repo,
        problemStatement: "Fix add() in math.js.",
        testCmd: `node -e "const {add}=require('./math.js'); if(add(2,3)!==5) process.exit(1)"`,
      }

      const result = await runInstance(instance, {
        llm: new EditThenRefuseLLM(),
        maxTurns: 3,
        timeoutMs: 20_000,
      })

      expect(result.passed).toBe(true)
      expect(result.stopReason).toBeUndefined()
      expect(result.patch).toContain("return a + b")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
