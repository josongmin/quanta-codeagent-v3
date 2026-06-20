import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { runInstance } from "@/runner/batch/eval"
import { classifyOutcome } from "@/runner/batch/eval/retry-policy"
import type { Instance } from "@/runner/batch/types"
import { scopedEnv } from "../_support/scoped-env"
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

const DEPS = { maxTurns: 2, timeoutMs: 20_000 }
const verifySelectEnv = scopedEnv(
  [
    "QUANTA_BENCH_VERIFY_SELECT",
    "QUANTA_BENCH_VERIFY_SELECT_REGRESSION",
    "QUANTA_BENCH_VERIFY_SELECT_REPRO",
  ],
  {
    QUANTA_BENCH_VERIFY_SELECT: "2",
    QUANTA_BENCH_VERIFY_SELECT_REGRESSION: "off",
    QUANTA_BENCH_VERIFY_SELECT_REPRO: "positive",
  },
)

describe("runner verify-select telemetry survives early terminal no-patch", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "runner-verify-select-telemetry-"))
    verifySelectEnv.beforeEach()
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    verifySelectEnv.afterEach()
  })

  test.serial(
    "selectionTelemetry + reproOracleCalibration stay attached when verify-select has no submittable winner",
    async () => {
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
      expect(result.error).toContain("verify-select produced no submittable candidate")
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
      expect(classifyOutcome(result)).toEqual({
        kind: "real-fail",
        subkind: "completed_unresolved",
      })
    },
  )

  test.serial("all verify-select candidate generation failures stay generation-fail, not empty-patch", async () => {
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

  test.serial(
    "verify-select no-winner preserves max_turns authority from the terminal candidate",
    async () => {
      const corpusRoot = join(dir, "corpus")
      await writeSyntheticCorpus(corpusRoot)
      const base = (await loadCorpus(corpusRoot)).find((i) => i.id === "inst-add") as Instance
      const swebenchLike: Instance = {
        ...base,
        swebench: {
          instanceId: "demo__runner-3",
          repo: "demo/demo",
          baseCommit: "0".repeat(40),
        },
      }

      const result = await runInstance(swebenchLike, {
        ...DEPS,
        llm: new ReadLoopLLM(),
      })

      expect(result.passed).toBe(false)
      expect(result.patch).toBe("")
      expect(result.error).toContain("max turns")
      expect(result.selectionTelemetry?.winnerId).toBeNull()
      expect(classifyOutcome(result)).toEqual({
        kind: "real-fail",
        subkind: "max_turns_exhausted",
      })
    },
  )
})
