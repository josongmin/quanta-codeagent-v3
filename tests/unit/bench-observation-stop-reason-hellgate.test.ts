import { describe, expect, spyOn, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { runInstance } from "@/apps/bench/eval"
import { BenchObserver } from "@/apps/bench/eval/driver"
import type { Instance } from "@/apps/bench/types"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { loadCorpus, writeSyntheticCorpus } from "../../src/apps/bench/corpus/loader"
import { withBenchObserverTestIsolation } from "../_support/bench-observer-test-isolation"
import { scopedEnv } from "../_support/scoped-env"

class FixingLLM implements LLMPort {
  private calls = 0

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    this.calls += 1
    const text = input.messages
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
    // Stop at the prompt sentence terminator, not the first dot in the path.
    // The canonical isolated home contains `/.quanta/`, so `\S+?\.` silently
    // redirected edits outside the sandbox under the authoritative runner.
    const sandbox = text.match(/Work inside (.+?)\.(?:\n| When done)/)?.[1] ?? ""
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
    yield { type: "text_delta", delta: "done" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class NoopEndLLM implements LLMPort {
  async *stream(): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "noop" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const verifySelectEnv = scopedEnv(
  [
    "QUANTA_BENCH_VERIFY_SELECT",
    "QUANTA_BENCH_VERIFY_SELECT_ESCAPE",
    "QUANTA_BENCH_VERIFY_SELECT_EARLY_ACCEPT",
    "QUANTA_BENCH_VERIFY_SELECT_REGRESSION",
    "QUANTA_BENCH_VERIFY_SELECT_REPRO",
  ],
  {
    QUANTA_BENCH_VERIFY_SELECT: "2",
    QUANTA_BENCH_VERIFY_SELECT_ESCAPE: "1",
    QUANTA_BENCH_VERIFY_SELECT_EARLY_ACCEPT: undefined,
    QUANTA_BENCH_VERIFY_SELECT_REGRESSION: "off",
    QUANTA_BENCH_VERIFY_SELECT_REPRO: "positive",
  },
)

describe("bench observation stopReason authority", () => {
  test(
    "ADVERSARIAL: late strict observation degradation preserves completed authority",
    withBenchObserverTestIsolation(async () => {
      const dir = mkdtempSync(join(tmpdir(), "bench-observation-stop-reason-"))
      const repo = join(dir, "repo")
      const obs = join(dir, "obs")
      const patchGeneratedSpy = spyOn(BenchObserver.prototype, "patchGenerated").mockImplementation(
        () => {
          throw new Error("patch event sink failed")
        },
      )
      try {
        mkdirSync(repo, { recursive: true })
        writeFileSync(
          join(repo, "math.js"),
          "function add(a,b){ return a - b }\nmodule.exports={add}\n",
        )
        const instance: Instance = {
          id: "bench-observation-stop-reason",
          repoPath: repo,
          problemStatement: "Fix add() in math.js.",
          testCmd: `node -e "const {add}=require('./math.js'); if(add(2,3)!==5) process.exit(1)"`,
        }

        const result = await runInstance(instance, {
          llm: new FixingLLM(),
          maxTurns: 3,
          timeoutMs: 20_000,
          observe: { dir: obs, runId: "rd", now: () => 1 },
        })

        expect(result.passed).toBe(false)
        expect(result.verdict).toBe("degraded")
        expect(result.stopReason).toBe("completed")
        expect(result.patch).toContain("return a + b")
        expect(result.error).toContain("observation failed (strict)")
        expect(result.error).toContain("patch event sink failed")
      } finally {
        patchGeneratedSpy.mockRestore()
        rmSync(dir, { recursive: true, force: true })
      }
    }),
    60_000,
  )

  test.serial(
    "ADVERSARIAL: late strict observation degradation preserves verify-select telemetry",
    verifySelectEnv.run(
      withBenchObserverTestIsolation(async () => {
        const dir = mkdtempSync(join(tmpdir(), "bench-observation-selection-"))
        const obs = join(dir, "obs")
        const patchGeneratedSpy = spyOn(
          BenchObserver.prototype,
          "patchGenerated",
        ).mockImplementation(() => {
          throw new Error("patch event sink failed")
        })
        try {
          const corpusRoot = join(dir, "corpus")
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
            llm: new NoopEndLLM(),
            maxTurns: 2,
            timeoutMs: 20_000,
            observe: {
              dir: obs,
              runId: "run-vs-degraded",
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
          expect(result.reproOracleCalibration).toEqual({
            goldCalibrated: false,
            falseNegative: false,
            available: false,
            goldVotes: null,
            goldK: null,
            baseResolved: false,
            vacuous: false,
            baseVotes: null,
            baseK: null,
          })
          expect(result.error).toContain("observation failed (strict)")
        } finally {
          patchGeneratedSpy.mockRestore()
          rmSync(dir, { recursive: true, force: true })
        }
      }),
    ),
    60_000,
  )
})
