import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BudgetMeter } from "@/agent"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { runInstance } from "@/runner/batch/eval"
import { classifyOutcome } from "@/runner/batch/eval/retry-policy"
import type { Instance } from "@/runner/batch/types"
import { loadCorpus, writeSyntheticCorpus } from "../../src/apps/bench/corpus/loader"

class NoopEndLLM implements LLMPort {
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "noop" }
    yield { type: "message_stop", stop_reason: "end_turn" }
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
      input: { path: join(sandbox, "math.js") },
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

describe("runner empty-patch terminal authority", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "runner-max-turns-empty-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("read-only max-turns terminal classifies as max_turns_exhausted", async () => {
    const corpusRoot = join(dir, "corpus")
    await writeSyntheticCorpus(corpusRoot)
    const instance = (await loadCorpus(corpusRoot)).find((i) => i.id === "inst-add") as Instance

    const result = await runInstance(instance, {
      llm: new ReadLoopLLM(),
      maxTurns: 3,
      timeoutMs: 20_000,
    })

    expect(result.passed).toBe(false)
    expect(result.patch).toBe("")
    expect(result.error).toContain("max turns")
    expect(classifyOutcome(result)).toEqual({
      kind: "real-fail",
      subkind: "max_turns_exhausted",
    })
  }, 60_000)

  test("completed no-edit + budget cap classifies as budget_exhausted", async () => {
    const corpusRoot = join(dir, "corpus")
    await writeSyntheticCorpus(corpusRoot)
    const instance = (await loadCorpus(corpusRoot)).find((i) => i.id === "inst-add") as Instance
    const deps = {
      llm: new NoopEndLLM(),
      maxTurns: 3,
      timeoutMs: 20_000,
      budgetMeterFactory: () => new BudgetMeter({ dials: { maxTurns: 0 } }),
    }

    const result = await runInstance(instance, deps)

    expect(result.passed).toBe(false)
    expect(result.patch).toBe("")
    expect(result.error).toContain("token budget")
    expect(classifyOutcome(result)).toEqual({
      kind: "real-fail",
      subkind: "budget_exhausted",
    })
  }, 60_000)

  test("non-empty patch survives budget_exhausted and is still verified", async () => {
    const repo = join(dir, "repo-budget-patch")
    mkdirSync(repo, { recursive: true })
    writeFileSync(
      join(repo, "math.js"),
      "function add(a,b){ return a - b }\nmodule.exports={add}\n",
    )
    const instance: Instance = {
      id: "runner-budget-patch",
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
    expect(result.error).toBeUndefined()
    expect(result.patch).toContain("return a + b")
  }, 60_000)

  test("slow tool timeout classifies as timeout", async () => {
    const corpusRoot = join(dir, "corpus")
    await writeSyntheticCorpus(corpusRoot)
    const instance = (await loadCorpus(corpusRoot)).find((i) => i.id === "inst-add") as Instance

    const result = await runInstance(instance, {
      llm: new SlowBashLLM(),
      maxTurns: 2,
      timeoutMs: 150,
    })

    expect(result.passed).toBe(false)
    expect(result.patch).toBe("")
    expect(result.error).toContain("aborted")
    expect(classifyOutcome(result)).toEqual({
      kind: "timeout",
    })
  }, 60_000)

  test("ADVERSARIAL: post-edit provider error still verifies the retained patch", async () => {
    const repo = join(dir, "repo-error-patch")
    mkdirSync(repo, { recursive: true })
    writeFileSync(
      join(repo, "math.js"),
      "function add(a,b){ return a - b }\nmodule.exports={add}\n",
    )
    const instance: Instance = {
      id: "runner-error-patch",
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
  }, 60_000)

  test("ADVERSARIAL: post-edit refusal still verifies the retained patch", async () => {
    const repo = join(dir, "repo-refusal-patch")
    mkdirSync(repo, { recursive: true })
    writeFileSync(
      join(repo, "math.js"),
      "function add(a,b){ return a - b }\nmodule.exports={add}\n",
    )
    const instance: Instance = {
      id: "runner-refusal-patch",
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
  }, 60_000)
})
