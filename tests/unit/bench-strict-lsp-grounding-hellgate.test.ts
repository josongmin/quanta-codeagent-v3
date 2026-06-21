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

  test.serial(
    "task-relevant gating: a Python task (gold patch in .py) is NOT blocked by an incidental C-dominant repo when clangd is missing",
    env.run(async () => {
      // The astropy-7166 shape (measured jun-21): a Python instance whose repo
      // carries a C-extension subdir. pyright is up, clangd is not. The OLD
      // whole-repo probe picked the dominant language by raw file count — C here —
      // and hard-failed the Python task turns=0 demanding clangd. Task-relevant
      // gating keys off the gold-patch language (.py ⇒ pyright) and lets it run.
      env.set({ QUANTA_BENCH_PRESET: "agentless-v3-thin-strict" })
      __resetLspAvailabilityCacheForTest()
      __setLspAvailabilityOverrideForTest((bin) => bin !== "clangd")
      const dir = mkdtempSync(join(tmpdir(), "bench-strict-lsp-taskrel-"))
      try {
        // Make C the whole-repo dominant language (5 .c > 1 .py) so the old probe
        // would demand clangd; the fix must ignore it in favor of the gold language.
        mkdirSync(join(dir, "utils", "src"), { recursive: true })
        for (let i = 0; i < 5; i++) {
          writeFileSync(join(dir, "utils", "src", `compiler${i}.c`), "int main(){return 0;}\n")
        }
        writeFileSync(join(dir, "core.py"), "def add(a, b):\n    return a - b\n")
        const instance: Instance = {
          id: "strict-lsp-taskrel",
          repoPath: dir,
          problemStatement: "Fix add().",
          testCmd: "true",
          goldPatch:
            "--- a/core.py\n+++ b/core.py\n@@ -1,2 +1,2 @@\n-    return a - b\n+    return a + b\n",
        }
        const llm = new SpyLLM()
        const result = await runInstance(instance, { llm, maxTurns: 3, timeoutMs: 20_000 })
        // Red-on-injection: drop the task-relevant probe and the C-dominant repo
        // demands the missing clangd ⇒ degraded turns=0 ⇒ llm.invoked === false.
        expect(llm.invoked).toBe(true)
        expect(result.verdict).not.toBe("degraded")
        expect(result.error ?? "").not.toContain("clangd")
      } finally {
        rmSync(dir, { recursive: true, force: true })
        __setLspAvailabilityOverrideForTest(null)
        __resetLspAvailabilityCacheForTest()
      }
    }),
    60_000,
  )

  test.serial(
    "task-relevant gating honors pure-rename gold patches instead of falling back to the repo-dominant language",
    env.run(async () => {
      env.set({ QUANTA_BENCH_PRESET: "agentless-v3-thin-strict" })
      __resetLspAvailabilityCacheForTest()
      __setLspAvailabilityOverrideForTest((bin) => bin !== "typescript-language-server")
      const dir = mkdtempSync(join(tmpdir(), "bench-strict-lsp-rename-taskrel-"))
      try {
        mkdirSync(join(dir, "pkg"), { recursive: true })
        writeFileSync(join(dir, "bug.py"), "def add(a, b):\n    return a - b\n")
        writeFileSync(join(dir, "helper.py"), "def sub(a, b):\n    return a - b\n")
        writeFileSync(join(dir, "more.py"), "VALUE = 1\n")
        writeFileSync(join(dir, "pkg", "old.ts"), "export const answer = 0\n")
        const instance: Instance = {
          id: "strict-lsp-rename-taskrel",
          repoPath: dir,
          problemStatement: "Rename the TS module.",
          testCmd: "true",
          goldPatch: [
            "diff --git a/pkg/old.ts b/pkg/new.ts",
            "similarity index 100%",
            "rename from pkg/old.ts",
            "rename to pkg/new.ts",
          ].join("\n"),
        }
        const llm = new SpyLLM()
        const result = await runInstance(instance, { llm, maxTurns: 3, timeoutMs: 20_000 })
        expect(result.passed).toBe(false)
        expect(result.verdict).toBe("degraded")
        expect(result.turns).toBe(0)
        expect(result.error).toContain("requires live LSP grounding")
        expect(result.error).toContain("typescript-language-server")
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
