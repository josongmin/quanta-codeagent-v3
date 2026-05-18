import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { runInstance } from "../../src/apps/bench/runner"
import { loadCorpus, writeSyntheticCorpus } from "../../src/apps/bench/swebench"
import type { Instance } from "../../src/apps/bench/types"

/**
 * FakeLLM that fixes a planted bug with the REAL edit tool. It extracts the
 * sandbox dir from the prompt the runner injects ("Work inside <dir>.") so it
 * can issue an absolute edit path (storage resolves against process.cwd(),
 * which is not the sandbox). One scripted assistant turn: edit, then a final
 * text turn so the loop completes. Pattern copied from agent-loop.test.ts.
 */
class FixingLLM implements LLMPort {
  calls = 0
  constructor(
    private readonly file: string,
    private readonly oldStr: string,
    private readonly newStr: string,
  ) {}

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    const text = input.messages
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
    const m = text.match(/Work inside (\S+?)\./)
    const sandbox = m?.[1] ?? ""
    if (this.calls === 1) {
      const path = join(sandbox, this.file)
      yield { type: "tool_use_start", id: "e1", name: "edit" }
      yield {
        type: "tool_use_end",
        id: "e1",
        input: { path, old_string: this.oldStr, new_string: this.newStr },
      }
      yield { type: "message_stop", stop_reason: "tool_use" }
      return
    }
    yield { type: "text_delta", delta: "done" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

/** FakeLLM that does nothing: one text turn, no tool calls → no fix. */
class NoopLLM implements LLMPort {
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "I will not change anything" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

/** Flaky LLM: fails the first `failCount` attempts (noop), then fixes. Each
 *  runInstance call is an independent attempt → tracked via a shared counter. */
class FlakyLLM implements LLMPort {
  private attempt = 0
  private callsInAttempt = 0
  constructor(
    private readonly failCount: number,
    private readonly file: string,
    private readonly oldStr: string,
    private readonly newStr: string,
  ) {}

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    if (this.callsInAttempt === 0) this.attempt += 1
    this.callsInAttempt += 1
    const shouldFix = this.attempt > this.failCount
    const text = input.messages
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
    const sandbox = text.match(/Work inside (\S+?)\./)?.[1] ?? ""
    if (shouldFix && this.callsInAttempt === 1) {
      yield { type: "tool_use_start", id: "f1", name: "edit" }
      yield {
        type: "tool_use_end",
        id: "f1",
        input: {
          path: join(sandbox, this.file),
          old_string: this.oldStr,
          new_string: this.newStr,
        },
      }
      yield { type: "message_stop", stop_reason: "tool_use" }
      this.callsInAttempt = 0
      return
    }
    this.callsInAttempt = 0
    yield { type: "text_delta", delta: "noop" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const DEPS = { maxTurns: 5, timeoutMs: 30000 }

describe("bench integration", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bench-test-"))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test("writeSyntheticCorpus → loadCorpus returns 2 instances", async () => {
    await writeSyntheticCorpus(dir)
    const corpus = await loadCorpus(dir)
    expect(corpus).toHaveLength(2)
    const ids = corpus.map((i) => i.id).sort()
    expect(ids).toEqual(["inst-add", "inst-greet"])
    for (const inst of corpus) {
      expect(inst.problemStatement.length).toBeGreaterThan(0)
      expect(inst.testCmd.length).toBeGreaterThan(0)
    }
  })

  test("loadCorpus on missing/empty root returns [] (never throws)", async () => {
    expect(await loadCorpus(join(dir, "does-not-exist"))).toEqual([])
    expect(await loadCorpus("")).toEqual([])
    expect(await loadCorpus(dir)).toEqual([]) // empty dir
  })

  test("runInstance with a correct-edit FakeLLM → passed:true, non-empty patch", async () => {
    await writeSyntheticCorpus(dir)
    const corpus = await loadCorpus(dir)
    const add = corpus.find((i) => i.id === "inst-add") as Instance
    const llm = new FixingLLM("math.js", "return a - b", "return a + b")
    const result = await runInstance(add, { ...DEPS, llm })
    expect(result.passed).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.patch.length).toBeGreaterThan(0)
    expect(result.patch).toContain("return a + b")
  })

  test("runInstance with a do-nothing FakeLLM → passed:false", async () => {
    await writeSyntheticCorpus(dir)
    const corpus = await loadCorpus(dir)
    const greet = corpus.find((i) => i.id === "inst-greet") as Instance
    const result = await runInstance(greet, { ...DEPS, llm: new NoopLLM() })
    expect(result.passed).toBe(false)
  })

  test("Best-of-N n=3 over a flaky LLM (2 fail, 1 pass) → overall passed", async () => {
    await writeSyntheticCorpus(dir)
    const corpus = await loadCorpus(dir)
    const add = corpus.find((i) => i.id === "inst-add") as Instance
    const { sampleBestOfN } = await import("../../src/apps/bench/sampler")
    const llm = new FlakyLLM(2, "math.js", "return a - b", "return a + b")
    const out = await sampleBestOfN({
      n: 3,
      concurrency: 1, // serialize so the flaky counter is deterministic
      makeAttempt: () => runInstance(add, { ...DEPS, llm }),
      score: (r) => (r.passed ? 1 : 0),
    })
    expect(out.attempts).toHaveLength(3)
    expect(out.best.value?.passed).toBe(true)
    const passes = out.attempts.filter((a) => a.value?.passed).length
    expect(passes).toBe(1)
  })
})
