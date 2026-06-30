import { describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BudgetMeter } from "@/agent"
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

class EditOnceLLM implements LLMPort {
  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const text = input.messages
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
    const sandbox = text.match(/Work inside (\S+?)\./)?.[1] ?? ""
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
      expect(result.stopReason).toBe("completed")
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

  test("completed no-edit + budget cap preserves budget_exhausted authority and never invokes verifier/testCmd", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-agent-budget-empty-"))
    const marker = join(dir, "verifier-ran")
    const repo = join(dir, "repo")
    try {
      mkdirSync(repo, { recursive: true })
      writeFileSync(join(repo, "marker.txt"), "seed\n")
      const instance: Instance = {
        id: "budget-empty-terminal",
        repoPath: repo,
        problemStatement: "Do not edit anything.",
        testCmd: `sh -c 'printf verifier > ${marker}; exit 0'`,
      }
      const deps = {
        llm: new CompletedNoEditLLM(),
        maxTurns: 3,
        timeoutMs: 20_000,
        measurementStability: { maxAttempts: 3 },
        budgetMeterFactory: () => new BudgetMeter({ dials: { maxTurns: 0 } }),
      }

      const result = await runInstance(instance, deps)

      expect(result.passed).toBe(false)
      expect(result.patch).toBe("")
      expect(result.stopReason).toBe("budget_exhausted")
      expect(result.error).toContain("token budget")
      expect(existsSync(marker)).toBe(false)
      expect(classifyOutcome(result)).toEqual({
        kind: "real-fail",
        subkind: "budget_exhausted",
      })
      expect(result.budget?.attemptOutcomes).toEqual([
        { kind: "real-fail", subkind: "budget_exhausted" },
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test("repair path reuses ONE attempt-scoped budget meter across nested agent runs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-agent-repair-budget-"))
    const repo = join(dir, "repo")
    try {
      mkdirSync(repo, { recursive: true })
      writeFileSync(join(repo, "marker.txt"), "seed\n")
      execSync("git init -q", { cwd: repo })
      execSync("git config user.email b@b", { cwd: repo })
      execSync("git config user.name b", { cwd: repo })
      execSync("git add marker.txt", { cwd: repo })
      execSync("git commit -qm init", { cwd: repo })
      const baseCommit = execSync("git rev-parse HEAD", { cwd: repo }).toString().trim()

      const instance: Instance = {
        id: "repair-budget-shared-meter",
        repoPath: repo,
        problemStatement: "Do not edit anything.",
        testCmd: "true",
        swebench: { instanceId: "x__repair-budget-1", repo: "x/x", baseCommit },
      }

      let calls = 0
      const result = await runInstance(instance, {
        llm: new CompletedNoEditLLM(),
        maxTurns: 3,
        timeoutMs: 20_000,
        repair: {
          maxRounds: 2,
          validate: async () => ({ ok: false, failTail: "still red" }),
        },
        budgetMeterFactory: () => {
          calls += 1
          return new BudgetMeter()
        },
      })

      expect(result.passed).toBe(false)
      expect(calls).toBe(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  test("non-empty patch survives budget_exhausted and is still verified", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-agent-budget-patch-"))
    const repo = join(dir, "repo")
    try {
      mkdirSync(repo, { recursive: true })
      writeFileSync(
        join(repo, "math.js"),
        "function add(a,b){ return a - b }\nmodule.exports={add}\n",
      )
      const instance: Instance = {
        id: "budget-patch-terminal",
        repoPath: repo,
        problemStatement: "Fix add() in math.js.",
        testCmd: `node -e "const {add}=require('./math.js'); if(add(2,3)!==5) process.exit(1)"`,
      }

      const result = await runInstance(instance, {
        llm: new EditOnceLLM(),
        maxTurns: 3,
        timeoutMs: 20_000,
        budgetMeterFactory: () => new BudgetMeter({ dials: { maxTurns: 0 } }),
      })

      expect(result.passed).toBe(true)
      expect(result.stopReason).toBe("budget_exhausted")
      expect(result.error).toBeUndefined()
      expect(result.patch).toContain("return a + b")
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
      expect(result.stopReason).toBe("max_turns")
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
      expect(result.stopReason).toBe("aborted")
      expect(result.error).toContain("aborted")
      expect(existsSync(marker)).toBe(false)
      expect(classifyOutcome(result)).toEqual({ kind: "timeout" })
      expect(result.budget?.attemptOutcomes).toEqual([{ kind: "timeout" }])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
