import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __resetLspAvailabilityCacheForTest,
  __setLspAvailabilityOverrideForTest,
} from "@/agent/lsp-bridge"
import { runInstance } from "@/apps/bench/eval"
import type { Instance } from "@/apps/bench/types"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { scopedEnv } from "../_support/scoped-env"

class SpyLLM implements LLMPort {
  invoked = false

  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.invoked = true
    yield { type: "text_delta", delta: "done" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const env = scopedEnv(["QUANTA_BENCH_PRESET"])

describe("bench strict LSP grounding fail-closed", () => {
  test.serial(
    "agentless-v3-thin-strict degrades instead of running when pyright is unavailable",
    env.run(async () => {
      env.set({
        QUANTA_BENCH_PRESET: "agentless-v3-thin-strict",
      })
      __resetLspAvailabilityCacheForTest()
      __setLspAvailabilityOverrideForTest((bin) => (bin === "pyright-langserver" ? false : true))
      const dir = mkdtempSync(join(tmpdir(), "bench-strict-lsp-missing-"))
      try {
        writeFileSync(join(dir, "bug.py"), "def add(a, b):\n    return a - b\n")
        const instance: Instance = {
          id: "strict-lsp-missing",
          repoPath: dir,
          problemStatement: "Fix add().",
          testCmd: "true",
        }
        const llm = new SpyLLM()
        const result = await runInstance(instance, {
          llm,
          maxTurns: 3,
          timeoutMs: 20_000,
        })
        expect(result.passed).toBe(false)
        expect(result.verdict).toBe("degraded")
        expect(result.turns).toBe(0)
        expect(result.error).toContain("requires live LSP grounding")
        expect(result.error).toContain("pyright-langserver")
        expect(llm.invoked).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
        __setLspAvailabilityOverrideForTest(null)
        __resetLspAvailabilityCacheForTest()
      }
    }),
    60_000,
  )

  test.serial(
    "non-strict presets keep the historical degrade-open behavior when pyright is unavailable",
    env.run(async () => {
      env.set({
        QUANTA_BENCH_PRESET: "agentless-v3-thin",
      })
      __resetLspAvailabilityCacheForTest()
      __setLspAvailabilityOverrideForTest((bin) => (bin === "pyright-langserver" ? false : true))
      const dir = mkdtempSync(join(tmpdir(), "bench-thin-lsp-open-"))
      try {
        writeFileSync(join(dir, "bug.py"), "def add(a, b):\n    return a - b\n")
        const instance: Instance = {
          id: "thin-lsp-open",
          repoPath: dir,
          problemStatement: "Fix add().",
          testCmd: "true",
        }
        const llm = new SpyLLM()
        const result = await runInstance(instance, {
          llm,
          maxTurns: 3,
          timeoutMs: 20_000,
        })
        expect(llm.invoked).toBe(true)
        expect(result.verdict).not.toBe("degraded")
        expect(result.error ?? "").not.toContain("requires live LSP grounding")
      } finally {
        rmSync(dir, { recursive: true, force: true })
        __setLspAvailabilityOverrideForTest(null)
        __resetLspAvailabilityCacheForTest()
      }
    }),
    60_000,
  )

  test.serial(
    "strict family also degrades when the repo has no source file mapped to a configured LSP server",
    env.run(async () => {
      env.set({ QUANTA_BENCH_PRESET: "agentless-v3-thin-strict-select" })
      __resetLspAvailabilityCacheForTest()
      __setLspAvailabilityOverrideForTest(null)
      const dir = mkdtempSync(join(tmpdir(), "bench-strict-lsp-unsupported-"))
      try {
        mkdirSync(join(dir, "src"), { recursive: true })
        writeFileSync(join(dir, "src", "Main.java"), "class Main {}\n")
        const instance: Instance = {
          id: "strict-lsp-unsupported",
          repoPath: dir,
          problemStatement: "Do nothing.",
          testCmd: "true",
        }
        const llm = new SpyLLM()
        const result = await runInstance(instance, {
          llm,
          maxTurns: 3,
          timeoutMs: 20_000,
        })
        expect(result.passed).toBe(false)
        expect(result.verdict).toBe("degraded")
        expect(result.error).toContain("requires live LSP grounding")
        expect(result.error).toContain("no source file mapped")
        expect(llm.invoked).toBe(false)
      } finally {
        rmSync(dir, { recursive: true, force: true })
        __setLspAvailabilityOverrideForTest(null)
        __resetLspAvailabilityCacheForTest()
      }
    }),
    60_000,
  )
})
