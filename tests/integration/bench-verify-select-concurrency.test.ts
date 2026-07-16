import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { scopedEnv } from "../_support/scoped-env"
import { runInstance } from "../../src/apps/bench/eval"
import type { Instance } from "../../src/apps/bench/types"

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

class ParallelEditLLM implements LLMPort {
  inFlight = 0
  maxInFlight = 0
  private nextTarget = 0
  private phaseBySandbox = new Map<string, number>()
  private targetBySandbox = new Map<string, { file: string; before: string; after: string }>()

  async *stream(input: StreamInput): AsyncIterable<StreamEvent> {
    const text = input.messages
      .flatMap((m) => m.content)
      .map((b) => (b.type === "text" ? b.text : ""))
      .join(" ")
    const sandbox = text.match(/Work inside (\S+?)\./)?.[1] ?? ""
    const phase = this.phaseBySandbox.get(sandbox) ?? 0
    this.inFlight += 1
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight)
    try {
      if (phase === 0) {
        this.phaseBySandbox.set(sandbox, 1)
        await sleep(75)
        let target = this.targetBySandbox.get(sandbox)
        if (target === undefined) {
          target =
            this.nextTarget++ % 2 === 0
              ? { file: "a.js", before: "BUG_A", after: "FIX_A" }
              : { file: "b.js", before: "BUG_B", after: "FIX_B" }
          this.targetBySandbox.set(sandbox, target)
        }
        yield { type: "tool_use_start", id: `edit-${sandbox}`, name: "edit" }
        yield {
          type: "tool_use_end",
          id: `edit-${sandbox}`,
          input: {
            path: join(sandbox, target.file),
            old_string: target.before,
            new_string: target.after,
          },
        }
        yield { type: "message_stop", stop_reason: "tool_use" }
        return
      }
      yield { type: "text_delta", delta: "done" }
      yield { type: "message_stop", stop_reason: "end_turn" }
    } finally {
      this.inFlight -= 1
    }
  }
}

const DEPS = { maxTurns: 4, timeoutMs: 20_000 }
// B1 FAIL-CLOSED (ea787de4a, 2026-07-03): the verify-select SELECTION plane is a
// retired footgun; `verifySelectN` resolves ONLY behind the explicit operator
// ESCAPE hatch `QUANTA_BENCH_VERIFY_SELECT_ESCAPE`. Without it the plane stays
// inert (verifySelectN ⇒ undefined ⇒ single-pass path ⇒ no selectionTelemetry).
// These tests exercise the verify-select plane, so they must set the escape —
// same shipped gating the telemetry sibling already threads.
const verifySelectEnv = scopedEnv(
  [
    "QUANTA_BENCH_VERIFY_SELECT",
    "QUANTA_BENCH_VERIFY_SELECT_ESCAPE",
    "QUANTA_BENCH_VERIFY_SELECT_CONCURRENCY",
    "QUANTA_BENCH_VERIFY_SELECT_REGRESSION",
    "QUANTA_BENCH_VERIFY_SELECT_REPRO",
    "QUANTA_BENCH_ISSUE_HINT",
    "QUANTA_BENCH_REPRO_TEST",
  ],
  {
    QUANTA_BENCH_VERIFY_SELECT: "2",
    QUANTA_BENCH_VERIFY_SELECT_ESCAPE: "1",
    QUANTA_BENCH_VERIFY_SELECT_CONCURRENCY: "2",
    QUANTA_BENCH_VERIFY_SELECT_REGRESSION: "off",
    QUANTA_BENCH_VERIFY_SELECT_REPRO: "off",
    QUANTA_BENCH_ISSUE_HINT: undefined,
    QUANTA_BENCH_REPRO_TEST: undefined,
  },
)

const makeRepo = (root: string): string => {
  const repo = join(root, "repo")
  mkdirSync(repo, { recursive: true })
  writeFileSync(join(repo, "a.js"), "module.exports = 'BUG_A'\n")
  writeFileSync(join(repo, "b.js"), "module.exports = 'BUG_B'\n")
  return repo
}

describe("verify-select concurrency wiring", () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "bench-verify-select-concurrency-"))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test.serial(
    "driver threads verify-select-concurrency into parallel isolated candidate generation",
    verifySelectEnv.run(async () => {
      const repo = makeRepo(dir)
      const obs = join(dir, "obs")
      const llm = new ParallelEditLLM()
      const instance: Instance = {
        id: "demo__verify-select-concurrency",
        repoPath: repo,
        problemStatement: "Change BUG_A and BUG_B markers to fixed values.",
        testCmd: "true",
        swebench: {
          instanceId: "demo__verify-select-concurrency",
          repo: "demo/demo",
          baseCommit: "0".repeat(40),
        },
      }

      const result = await runInstance(instance, {
        ...DEPS,
        llm,
        observe: {
          dir: obs,
          runId: "run-vsc",
          now: (() => {
            let ts = 1
            return () => ts++
          })(),
        },
      })

      expect(result.selectionTelemetry?.generated).toBe(2)
      expect(result.selectionTelemetry?.attempted).toBe(2)
      expect(result.selectionTelemetry?.successfulGenerations).toBe(2)
      expect(result.selectionTelemetry?.generationFailures).toBe(0)
      expect(result.selectionTelemetry?.candidates).toHaveLength(2)
      expect(llm.maxInFlight).toBe(2)
      expect(result.patch === "" || result.patch.includes("FIX_")).toBe(true)
    }),
  )

  test.serial(
    "discovered regression mode does not hard-reject a candidate when repro authority is absent",
    verifySelectEnv.run(async () => {
      verifySelectEnv.set({
        QUANTA_BENCH_VERIFY_SELECT: "1",
        QUANTA_BENCH_VERIFY_SELECT_CONCURRENCY: undefined,
        QUANTA_BENCH_VERIFY_SELECT_REGRESSION: "discovered",
        QUANTA_BENCH_VERIFY_SELECT_REPRO: "off",
      })

      const repo = makeRepo(dir)
      const obs = join(dir, "obs-discovered")
      const llm = new ParallelEditLLM()
      const instance: Instance = {
        id: "demo__verify-select-discovered",
        repoPath: repo,
        problemStatement: "Change BUG_A to FIX_A.",
        testCmd: "true",
        swebench: {
          instanceId: "demo__verify-select-discovered",
          repo: "demo/demo",
          baseCommit: "0".repeat(40),
        },
      }

      const result = await runInstance(instance, {
        ...DEPS,
        llm,
        observe: {
          dir: obs,
          runId: "run-vsd",
          now: (() => {
            let ts = 1
            return () => ts++
          })(),
        },
      })

      expect(result.selectionTelemetry?.attempted).toBe(1)
      expect(result.selectionTelemetry?.successfulGenerations).toBe(1)
      expect(result.selectionTelemetry?.generationFailures).toBe(0)
      expect(result.selectionTelemetry?.candidates).toHaveLength(1)
      expect(result.selectionTelemetry?.candidates[0]?.admissible).toBe(true)
      expect(result.selectionTelemetry?.candidates[0]?.reasons).not.toContain(
        "hard:baseValidatedRed=false (no validated repro authority)",
      )
      expect(result.patch).toContain("FIX_")
    }),
  )
})
