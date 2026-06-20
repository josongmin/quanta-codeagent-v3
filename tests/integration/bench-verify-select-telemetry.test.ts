import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { BudgetMeter } from "@/agent"
import { BenchObserver } from "@/apps/bench/eval/driver"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { classifyOutcome } from "@/runner/batch/eval/retry-policy"
import { loadCorpus, writeSyntheticCorpus } from "../../src/apps/bench/corpus/loader"
import { runInstance } from "../../src/apps/bench/eval"
import type { Instance } from "../../src/apps/bench/types"
import { scopedEnv } from "../_support/scoped-env"

class NoopEndLLM implements LLMPort {
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "noop" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class ThrowLLM implements LLMPort {
  stream(): AsyncIterable<StreamEvent> {
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

class SequentialEditLLM implements LLMPort {
  private calls = 0
  private readonly targets = [
    { oldString: "return a - b", newString: "return a + b + 0" },
    { oldString: "return a - b", newString: "return a + b" },
  ] as const

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    const text = input.messages
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
    const sandbox = text.match(/Work inside (\S+?)\./)?.[1] ?? ""
    if (this.calls % 2 === 1) {
      const target =
        this.targets[Math.floor((this.calls - 1) / 2)] ?? this.targets[this.targets.length - 1]
      yield { type: "tool_use_start", id: `edit-${this.calls}`, name: "edit" }
      yield {
        type: "tool_use_end",
        id: `edit-${this.calls}`,
        input: {
          path: join(sandbox, "math.js"),
          old_string: target.oldString,
          new_string: target.newString,
        },
      }
      yield { type: "message_stop", stop_reason: "tool_use" }
      return
    }
    yield { type: "text_delta", delta: "done" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class EditThenThrowThenNoopLLM implements LLMPort {
  private calls = 0

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    const text = input.messages
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
    const sandbox = text.match(/Work inside (\S+?)\./)?.[1] ?? ""
    if (this.calls === 1) {
      yield { type: "tool_use_start", id: "edit-1", name: "edit" }
      yield {
        type: "tool_use_end",
        id: "edit-1",
        input: {
          path: join(sandbox, "math.js"),
          old_string: "return a - b",
          new_string: "return a + b",
        },
      }
      yield { type: "message_stop", stop_reason: "tool_use" }
      return
    }
    if (this.calls === 2) {
      throw new Error("429 Too Many Requests")
    }
    yield { type: "text_delta", delta: "noop" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class EditThenRefuseThenNoopLLM implements LLMPort {
  private calls = 0

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    const text = input.messages
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
    const sandbox = text.match(/Work inside (\S+?)\./)?.[1] ?? ""
    if (this.calls === 1) {
      yield { type: "tool_use_start", id: "edit-1", name: "edit" }
      yield {
        type: "tool_use_end",
        id: "edit-1",
        input: {
          path: join(sandbox, "math.js"),
          old_string: "return a - b",
          new_string: "return a + b",
        },
      }
      yield { type: "message_stop", stop_reason: "tool_use" }
      return
    }
    if (this.calls === 2) {
      yield { type: "text_delta", delta: "I refuse to continue." }
      yield { type: "message_stop", stop_reason: "refusal" }
      return
    }
    yield { type: "text_delta", delta: "noop" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const DEPS = { maxTurns: 2, timeoutMs: 20_000 }
const verifySelectEnv = scopedEnv(
  [
    "QUANTA_BENCH_VERIFY_SELECT",
    "QUANTA_BENCH_VERIFY_SELECT_EARLY_ACCEPT",
    "QUANTA_BENCH_VERIFY_SELECT_REGRESSION",
    "QUANTA_BENCH_VERIFY_SELECT_REPRO",
  ],
  {
    QUANTA_BENCH_VERIFY_SELECT: "2",
    QUANTA_BENCH_VERIFY_SELECT_EARLY_ACCEPT: undefined,
    QUANTA_BENCH_VERIFY_SELECT_REGRESSION: "off",
    QUANTA_BENCH_VERIFY_SELECT_REPRO: "positive",
  },
)

const verifySelectDiagnosticEnv = scopedEnv(
  [
    "QUANTA_BENCH_VERIFY_SELECT",
    "QUANTA_BENCH_VERIFY_SELECT_EARLY_ACCEPT",
    "QUANTA_BENCH_VERIFY_SELECT_REGRESSION",
    "QUANTA_BENCH_VERIFY_SELECT_REPRO",
    "QUANTA_BENCH_PATCH_BUDGET",
    "QUANTA_BENCH_PATCH_HYGIENE",
  ],
  {
    QUANTA_BENCH_VERIFY_SELECT: "2",
    QUANTA_BENCH_VERIFY_SELECT_EARLY_ACCEPT: undefined,
    QUANTA_BENCH_VERIFY_SELECT_REGRESSION: "off",
    QUANTA_BENCH_VERIFY_SELECT_REPRO: "positive",
    QUANTA_BENCH_PATCH_BUDGET: "1",
    QUANTA_BENCH_PATCH_HYGIENE: "1",
  },
)

describe("verify-select telemetry survives early terminal no-patch", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bench-verify-select-telemetry-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test.serial(
    "selectionTelemetry + reproOracleCalibration stay attached when verify-select has no submittable winner",
    verifySelectEnv.run(async () => {
      const corpusRoot = join(dir, "corpus")
      const obs = join(dir, "obs")
      await writeSyntheticCorpus(corpusRoot)
      const base = (await loadCorpus(corpusRoot)).find((i) => i.id === "inst-add") as Instance
      const swebenchLike: Instance = {
        ...base,
        swebench: {
          instanceId: "demo__demo-1",
          repo: "demo/demo",
          baseCommit: "0".repeat(40),
        },
      }

      const result = await runInstance(swebenchLike, {
        ...DEPS,
        llm: new NoopEndLLM(),
        observe: {
          dir: obs,
          runId: "run-vs",
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
    }),
  )

  test.serial(
    "ADVERSARIAL: late strict observation degradation preserves verify-select telemetry",
    verifySelectDiagnosticEnv.run(async () => {
      const corpusRoot = join(dir, "corpus")
      const obs = join(dir, "obs-degraded")
      const patchGeneratedSpy = spyOn(BenchObserver.prototype, "patchGenerated").mockImplementation(
        () => {
          throw new Error("patch event sink failed")
        },
      )
      try {
        await writeSyntheticCorpus(corpusRoot)
        const base = (await loadCorpus(corpusRoot)).find((i) => i.id === "inst-add") as Instance
        const swebenchLike: Instance = {
          ...base,
          swebench: {
            instanceId: "demo__bench-observation-selection",
            repo: "demo/demo",
            baseCommit: "0".repeat(40),
          },
        }

        const result = await runInstance(swebenchLike, {
          ...DEPS,
          llm: new NoopEndLLM(),
          observe: {
            dir: obs,
            runId: "run-vs-bench-degraded",
            now: (() => {
              let ts = 1
              return () => ts++
            })(),
          },
        })

        expect(result.passed).toBe(false)
        expect(result.verdict).toBe("degraded")
        expect(result.stopReason).toBe("completed")
        expect(result.selectionTelemetry?.attempted).toBe(2)
        expect(result.selectionTelemetry?.successfulGenerations).toBe(2)
        expect(result.selectionTelemetry?.generationFailures).toBe(0)
        expect(result.selectionTelemetry?.winnerId).toBeNull()
        expect(result.patchBudget?.withinBudget).toBe(true)
        expect(result.patchHygiene).toEqual({
          patchFileCount: 0,
          addedFiles: [],
          filesOutsideOwner: [],
          strayAddedFiles: [],
          violation: false,
        })
        expect(result.outOfScopeFiles).toBe(false)
        expect(result.reproOracleCalibration).toEqual({
          goldCalibrated: false,
          falseNegative: false,
          available: false,
          goldVotes: null,
          goldK: null,
        })
        expect(result.error).toContain("observation failed (strict)")
      } finally {
        patchGeneratedSpy.mockRestore()
      }
    }),
  )

  test.serial(
    "all verify-select candidate generation failures stay generation-fail, not empty-patch",
    verifySelectEnv.run(async () => {
      const corpusRoot = join(dir, "corpus")
      const obs = join(dir, "obs-all-fail")
      await writeSyntheticCorpus(corpusRoot)
      const base = (await loadCorpus(corpusRoot)).find((i) => i.id === "inst-add") as Instance
      const swebenchLike: Instance = {
        ...base,
        swebench: {
          instanceId: "demo__demo-2",
          repo: "demo/demo",
          baseCommit: "0".repeat(40),
        },
      }

      const result = await runInstance(swebenchLike, {
        ...DEPS,
        llm: new ThrowLLM(),
        observe: {
          dir: obs,
          runId: "run-vs-all-fail",
          now: (() => {
            let ts = 1
            return () => ts++
          })(),
        },
      })

      expect(result.passed).toBe(false)
      expect(result.patch).toBe("")
      expect(result.error).toContain(
        "verify-select candidate generation failed for all 2 candidates",
      )
      expect(result.selectionTelemetry?.attempted).toBe(2)
      expect(result.selectionTelemetry?.successfulGenerations).toBe(0)
      expect(result.selectionTelemetry?.generationFailures).toBe(2)
      expect(result.selectionTelemetry?.generated).toBe(0)
      expect(result.selectionTelemetry?.winnerId).toBeNull()
      expect(classifyOutcome(result)).toEqual({
        kind: "generation-fail",
        reason: result.error as string,
      })
    }),
  )

  test.serial(
    "ADVERSARIAL: edited candidate survives post-edit provider error and remains selectable",
    verifySelectEnv.run(async () => {
      const corpusRoot = join(dir, "corpus")
      await writeSyntheticCorpus(corpusRoot)
      const base = (await loadCorpus(corpusRoot)).find((i) => i.id === "inst-add") as Instance
      const swebenchLike: Instance = {
        ...base,
        swebench: {
          instanceId: "demo__bench-error-patch",
          repo: "demo/demo",
          baseCommit: "0".repeat(40),
        },
      }

      const result = await runInstance(swebenchLike, {
        ...DEPS,
        llm: new EditThenThrowThenNoopLLM(),
      })

      expect(result.passed).toBe(true)
      expect(result.stopReason).toBeUndefined()
      expect(result.patch).toContain("return a + b")
      expect(result.selectionTelemetry?.attempted).toBe(2)
      expect(result.selectionTelemetry?.successfulGenerations).toBe(2)
      expect(result.selectionTelemetry?.generationFailures).toBe(0)
      expect(result.selectionTelemetry?.winnerId).toBe("cand-0")
    }),
  )

  test.serial(
    "ADVERSARIAL: edited candidate survives post-edit refusal and remains selectable",
    verifySelectEnv.run(async () => {
      const corpusRoot = join(dir, "corpus")
      await writeSyntheticCorpus(corpusRoot)
      const base = (await loadCorpus(corpusRoot)).find((i) => i.id === "inst-add") as Instance
      const swebenchLike: Instance = {
        ...base,
        swebench: {
          instanceId: "demo__bench-refusal-patch",
          repo: "demo/demo",
          baseCommit: "0".repeat(40),
        },
      }

      const result = await runInstance(swebenchLike, {
        ...DEPS,
        llm: new EditThenRefuseThenNoopLLM(),
      })

      expect(result.passed).toBe(true)
      expect(result.stopReason).toBeUndefined()
      expect(result.patch).toContain("return a + b")
      expect(result.selectionTelemetry?.attempted).toBe(2)
      expect(result.selectionTelemetry?.successfulGenerations).toBe(2)
      expect(result.selectionTelemetry?.generationFailures).toBe(0)
      expect(result.selectionTelemetry?.winnerId).toBe("cand-0")
    }),
  )

  test.serial(
    "verify-select no-winner preserves max_turns authority from the terminal candidate",
    verifySelectEnv.run(async () => {
      const corpusRoot = join(dir, "corpus")
      await writeSyntheticCorpus(corpusRoot)
      const base = (await loadCorpus(corpusRoot)).find((i) => i.id === "inst-add") as Instance
      const swebenchLike: Instance = {
        ...base,
        swebench: {
          instanceId: "demo__demo-3",
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
    }),
  )

  test.serial(
    "verify-select no-winner preserves budget_exhausted authority from the terminal candidate",
    verifySelectEnv.run(async () => {
      const corpusRoot = join(dir, "corpus")
      await writeSyntheticCorpus(corpusRoot)
      const base = (await loadCorpus(corpusRoot)).find((i) => i.id === "inst-add") as Instance
      const swebenchLike: Instance = {
        ...base,
        swebench: {
          instanceId: "demo__demo-budget",
          repo: "demo/demo",
          baseCommit: "0".repeat(40),
        },
      }
      const deps = {
        ...DEPS,
        llm: new NoopEndLLM(),
        budgetMeterFactory: () => new BudgetMeter({ dials: { maxTurns: 0 } }),
      }

      const result = await runInstance(swebenchLike, deps)

      expect(result.passed).toBe(false)
      expect(result.patch).toBe("")
      expect(result.error).toContain("token budget")
      expect(result.selectionTelemetry?.winnerId).toBeNull()
      expect(classifyOutcome(result)).toEqual({
        kind: "real-fail",
        subkind: "budget_exhausted",
      })
    }),
  )

  test.serial(
    "verify-select no-winner preserves aborted authority from the terminal candidate",
    verifySelectEnv.run(async () => {
      const corpusRoot = join(dir, "corpus")
      await writeSyntheticCorpus(corpusRoot)
      const base = (await loadCorpus(corpusRoot)).find((i) => i.id === "inst-add") as Instance
      const swebenchLike: Instance = {
        ...base,
        swebench: {
          instanceId: "demo__demo-4",
          repo: "demo/demo",
          baseCommit: "0".repeat(40),
        },
      }

      const result = await runInstance(swebenchLike, {
        llm: new SlowBashLLM(),
        maxTurns: 2,
        timeoutMs: 150,
      })

      expect(result.passed).toBe(false)
      expect(result.patch).toBe("")
      expect(result.error).toContain("aborted")
      expect(result.selectionTelemetry?.winnerId).toBeNull()
      expect(classifyOutcome(result)).toEqual({
        kind: "timeout",
      })
    }),
  )

  test.serial(
    "early-accept stays off without a hard positive signal, so verify-select still spends the full candidate budget",
    verifySelectEnv.run(async () => {
      verifySelectEnv.set({
        QUANTA_BENCH_VERIFY_SELECT: "2",
        QUANTA_BENCH_VERIFY_SELECT_EARLY_ACCEPT: "1",
        QUANTA_BENCH_VERIFY_SELECT_REGRESSION: "off",
        QUANTA_BENCH_VERIFY_SELECT_REPRO: "off",
      })

      const corpusRoot = join(dir, "corpus")
      await writeSyntheticCorpus(corpusRoot)
      const base = (await loadCorpus(corpusRoot)).find((i) => i.id === "inst-add") as Instance
      const swebenchLike: Instance = {
        ...base,
        swebench: {
          instanceId: "demo__demo-4",
          repo: "demo/demo",
          baseCommit: "0".repeat(40),
        },
      }

      const result = await runInstance(swebenchLike, {
        ...DEPS,
        llm: new SequentialEditLLM(),
      })

      expect(result.selectionTelemetry?.attempted).toBe(2)
      expect(result.selectionTelemetry?.successfulGenerations).toBe(2)
      expect(result.selectionTelemetry?.generationFailures).toBe(0)
      expect(result.selectionTelemetry?.generated).toBe(2)
      expect(result.selectionTelemetry?.earlyAccepted).toBe(false)
      expect(result.selectionTelemetry?.candidates).toHaveLength(2)
    }),
  )
})
