import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMPort, StreamEvent } from "@/llm"
import { __resetRuntimeConfig } from "@/shared/runtime-config"
import { benchInstanceWorkSlug, benchWorkRoot } from "../../src/apps/bench/corpus/paths"
import { runInstance } from "../../src/apps/bench/eval"
import type { Instance } from "../../src/apps/bench/types"

class NoopEndLLM implements LLMPort {
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "noop" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

describe("bench sandbox cleanup exhaustive", () => {
  let dir: string
  let savedBenchHome: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bench-cleanup-nightly-"))
    savedBenchHome = process.env.QUANTA_BENCH_HOME
    process.env.QUANTA_BENCH_HOME = join(dir, "bench-home")
    __resetRuntimeConfig()
  })

  afterEach(() => {
    if (savedBenchHome === undefined) delete process.env.QUANTA_BENCH_HOME
    else process.env.QUANTA_BENCH_HOME = savedBenchHome
    __resetRuntimeConfig()
    rmSync(dir, { recursive: true, force: true })
  })

  test("two isolated 25-run lanes leave no owned sandbox parent", async () => {
    const repoPath = join(dir, "repo")
    mkdirSync(repoPath, { recursive: true })
    writeFileSync(join(repoPath, "math.js"), "module.exports = { value: 1 }\n")
    const runLane = async (lane: string): Promise<void> => {
      const id = `no-accum-${lane}`
      const instance: Instance = {
        id,
        repoPath,
        problemStatement: "No change required.",
        testCmd: 'node -e "process.exit(0)"',
      }
      const prefix = `bench-${benchInstanceWorkSlug(id)}-`
      const ownedParents = (): readonly string[] =>
        readdirSync(benchWorkRoot()).filter((name) => name.startsWith(prefix))
      expect(ownedParents()).toEqual([])
      const llm = new NoopEndLLM()
      for (let i = 0; i < 25; i++) {
        const result = await runInstance(instance, { maxTurns: 5, timeoutMs: 30_000, llm })
        expect(result.id).toBe(id)
        expect(ownedParents()).toEqual([])
      }
      expect(ownedParents()).toEqual([])
    }
    await Promise.all([runLane("a"), runLane("b")])
  }, 60_000)
})
