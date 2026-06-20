import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMPort, StreamEvent } from "@/llm"
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

class ThrowLLM implements LLMPort {
  async *stream(): AsyncIterable<StreamEvent> {
    throw new Error("429 Too Many Requests")
  }
}

const DEPS = { maxTurns: 2, timeoutMs: 20_000 }

describe("runner verify-select telemetry survives early terminal no-patch", () => {
  let dir: string
  let savedVerifySelect: string | undefined
  let savedVerifySelectRegression: string | undefined
  let savedVerifySelectRepro: string | undefined

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "runner-verify-select-telemetry-"))
    savedVerifySelect = process.env.QUANTA_BENCH_VERIFY_SELECT
    savedVerifySelectRegression = process.env.QUANTA_BENCH_VERIFY_SELECT_REGRESSION
    savedVerifySelectRepro = process.env.QUANTA_BENCH_VERIFY_SELECT_REPRO
    process.env.QUANTA_BENCH_VERIFY_SELECT = "2"
    process.env.QUANTA_BENCH_VERIFY_SELECT_REGRESSION = "off"
    process.env.QUANTA_BENCH_VERIFY_SELECT_REPRO = "positive"
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    if (savedVerifySelect === undefined) delete process.env.QUANTA_BENCH_VERIFY_SELECT
    else process.env.QUANTA_BENCH_VERIFY_SELECT = savedVerifySelect
    if (savedVerifySelectRegression === undefined) {
      delete process.env.QUANTA_BENCH_VERIFY_SELECT_REGRESSION
    } else {
      process.env.QUANTA_BENCH_VERIFY_SELECT_REGRESSION = savedVerifySelectRegression
    }
    if (savedVerifySelectRepro === undefined) delete process.env.QUANTA_BENCH_VERIFY_SELECT_REPRO
    else process.env.QUANTA_BENCH_VERIFY_SELECT_REPRO = savedVerifySelectRepro
  })

  test("selectionTelemetry + reproOracleCalibration stay attached when verify-select has no submittable winner", async () => {
    const corpusRoot = join(dir, "corpus")
    const obs = join(dir, "obs")
    await writeSyntheticCorpus(corpusRoot)
    const base = (await loadCorpus(corpusRoot)).find((i) => i.id === "inst-add") as Instance
    const swebenchLike: Instance = {
      ...base,
      swebench: {
        instanceId: "demo__runner-1",
        repo: "demo/demo",
        baseCommit: "0".repeat(40),
      },
    }

    const result = await runInstance(swebenchLike, {
      ...DEPS,
      llm: new NoopEndLLM(),
      observe: {
        dir: obs,
        runId: "run-vs-runner",
        now: (() => {
          let ts = 1
          return () => ts++
        })(),
      },
    })

    expect(result.passed).toBe(false)
    expect(result.patch).toBe("")
    expect(result.selectionTelemetry?.attempted).toBe(2)
    expect(result.selectionTelemetry?.successfulGenerations).toBe(2)
    expect(result.selectionTelemetry?.generationFailures).toBe(0)
    expect(result.selectionTelemetry?.generated).toBe(1)
    expect(result.selectionTelemetry?.admissibleCount).toBe(0)
    expect(result.selectionTelemetry?.winnerId).toBeNull()
    expect(result.selectionTelemetry?.candidates).toHaveLength(1)
    expect(result.selectionTelemetry?.candidates[0]?.id).toBe("cand-0")
    expect(result.selectionTelemetry?.candidates[0]?.admissible).toBe(false)
    expect(result.selectionTelemetry?.candidates[0]?.score).toBe(0)
    expect(result.selectionTelemetry?.candidates[0]?.reasons).toContain(
      "hard:patchProduced=false (empty patch)",
    )
    expect(result.reproOracleCalibration).toEqual({
      goldCalibrated: false,
      falseNegative: false,
      available: false,
      goldVotes: null,
      goldK: null,
    })
  })

  test("all verify-select candidate generation failures stay generation-fail, not empty-patch", async () => {
    const corpusRoot = join(dir, "corpus")
    const obs = join(dir, "obs-all-fail")
    await writeSyntheticCorpus(corpusRoot)
    const base = (await loadCorpus(corpusRoot)).find((i) => i.id === "inst-add") as Instance
    const swebenchLike: Instance = {
      ...base,
      swebench: {
        instanceId: "demo__runner-2",
        repo: "demo/demo",
        baseCommit: "0".repeat(40),
      },
    }

    const result = await runInstance(swebenchLike, {
      ...DEPS,
      llm: new ThrowLLM(),
      observe: {
        dir: obs,
        runId: "run-vs-runner-all-fail",
        now: (() => {
          let ts = 1
          return () => ts++
        })(),
      },
    })

    expect(result.passed).toBe(false)
    expect(result.patch).toBe("")
    expect(result.error).toContain("verify-select candidate generation failed for all 2 candidates")
    expect(result.selectionTelemetry?.attempted).toBe(2)
    expect(result.selectionTelemetry?.successfulGenerations).toBe(0)
    expect(result.selectionTelemetry?.generationFailures).toBe(2)
    expect(result.selectionTelemetry?.generated).toBe(0)
    expect(result.selectionTelemetry?.winnerId).toBeNull()
    expect(classifyOutcome(result)).toEqual({
      kind: "generation-fail",
      reason: result.error as string,
    })
  })
})
