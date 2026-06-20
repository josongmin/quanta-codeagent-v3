import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { runInstance } from "@/runner/batch/eval"
import { classifyOutcome } from "@/runner/batch/eval/retry-policy"
import type { Instance } from "@/runner/batch/types"
import { loadCorpus, writeSyntheticCorpus } from "../../src/apps/bench/corpus/loader"

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

describe("runner empty-patch max-turns authority", () => {
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
  })
})
