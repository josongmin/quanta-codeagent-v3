import { describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInstance } from "@/apps/bench/eval"
import type { Instance } from "@/apps/bench/types"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { classifyOutcome } from "@/runner/batch/eval/retry-policy"

class CompletedNoEditLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "No source change is needed." }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class ReadLoopLLM implements LLMPort {
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const text = input.messages
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
    const sandbox = text.match(/Work inside (\S+?)\./)?.[1] ?? ""
    yield { type: "tool_use_start", id: "r1", name: "read" }
    yield {
      type: "tool_use_end",
      id: "r1",
      input: { path: join(sandbox, "marker.txt") },
    }
    yield { type: "message_stop", stop_reason: "tool_use" }
  }
}

class SlowBashLLM implements LLMPort {
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "tool_use_start", id: "b1", name: "bash" }
    yield {
      type: "tool_use_end",
      id: "b1",
      input: { command: "sleep 5" },
    }
    yield { type: "message_stop", stop_reason: "tool_use" }
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

  test("read-only max-turns terminal preserves max_turns authority instead of flattening to completed_unresolved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-agent-max-turns-empty-"))
    const marker = join(dir, "verifier-ran")
    const repo = join(dir, "repo")
    try {
      mkdirSync(repo, { recursive: true })
      writeFileSync(join(repo, "marker.txt"), "seed\n")
      const instance: Instance = {
        id: "max-turns-empty-terminal",
        repoPath: repo,
        problemStatement: "Inspect the file but never edit it.",
        testCmd: `sh -c 'printf verifier > ${marker}; exit 0'`,
      }

      const result = await runInstance(instance, {
        llm: new ReadLoopLLM(),
        maxTurns: 3,
        timeoutMs: 20_000,
        measurementStability: { maxAttempts: 3 },
      })

      expect(result.passed).toBe(false)
      expect(result.patch).toBe("")
      expect(result.error).toContain("max turns")
      expect(existsSync(marker)).toBe(false)
      expect(classifyOutcome(result)).toEqual({
        kind: "real-fail",
        subkind: "max_turns_exhausted",
      })
      expect(result.budget?.attemptOutcomes).toEqual([
        { kind: "real-fail", subkind: "max_turns_exhausted" },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test("slow tool timeout preserves aborted authority instead of flattening to completed_unresolved", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-agent-aborted-empty-"))
    const marker = join(dir, "verifier-ran")
    const repo = join(dir, "repo")
    try {
      mkdirSync(repo, { recursive: true })
      writeFileSync(join(repo, "marker.txt"), "seed\n")
      const instance: Instance = {
        id: "aborted-empty-terminal",
        repoPath: repo,
        problemStatement: "Run one slow shell command and never edit source.",
        testCmd: `sh -c 'printf verifier > ${marker}; exit 0'`,
      }

      const result = await runInstance(instance, {
        llm: new SlowBashLLM(),
        maxTurns: 2,
        timeoutMs: 150,
        measurementStability: { maxAttempts: 3 },
      })

      expect(result.passed).toBe(false)
      expect(result.patch).toBe("")
      expect(result.error).toContain("aborted")
      expect(existsSync(marker)).toBe(false)
      expect(classifyOutcome(result)).toEqual({ kind: "timeout" })
      expect(result.budget?.attemptOutcomes).toEqual([{ kind: "timeout" }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
