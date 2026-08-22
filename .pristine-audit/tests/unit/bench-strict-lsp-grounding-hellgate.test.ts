import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  __acquirePyrightTestIsolationForTest,
  __resetLspAvailabilityCacheForTest,
  __resetSharedPyrightSessionsForTest,
  __setLspAvailabilityOverrideForTest,
  __setPyrightClientFactoryForTest,
  __setPyrightWarmupTimingForTest,
} from "@/agent/lsp-bridge"
import { runInstance } from "@/apps/bench/eval"
import type { Instance } from "@/apps/bench/types"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { type Location, LspClient, type LspClientOptions } from "@/lsp"
import { scopedEnv } from "../_support/scoped-env"

class SpyLLM implements LLMPort {
  invoked = false

  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    this.invoked = true
    yield { type: "text_delta", delta: "done" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

/** A fake pyright client so the LSP-01 READY proof (which drives a real warm
 *  backend) is deterministic and does NOT depend on a pyright binary being
 *  installed in the test env. `start`/`definition` are scriptable to model a
 *  warm-ready vs a never-resolving (cold) server. */
class FakePyrightClient extends LspClient {
  defImpl: () => Promise<Location[] | null> = async () => []
  constructor(options: LspClientOptions = {}) {
    super({ defaultCommand: ["unused"], languageIdFor: () => "python" }, options)
  }
  override async start(): Promise<void> {}
  override async stop(): Promise<void> {}
  override async prime(): Promise<void> {}
  override async definition(): Promise<Location[] | null> {
    return this.defImpl()
  }
}

let releasePyrightTestIsolation: (() => void) | undefined
beforeEach(async () => {
  releasePyrightTestIsolation = await __acquirePyrightTestIsolationForTest()
})
afterEach(async () => {
  try {
    await __resetSharedPyrightSessionsForTest()
    __setPyrightClientFactoryForTest(null)
    __setPyrightWarmupTimingForTest(null)
  } finally {
    releasePyrightTestIsolation?.()
    releasePyrightTestIsolation = undefined
  }
})

const env = scopedEnv(["QUANTA_BENCH_PRESET"])

describe("bench strict LSP grounding fail-closed", () => {
  test.serial(
    "agentless-v3-thin-strict degrades instead of running when pyright is unavailable",
    env.run(async () => {
      env.set({
        QUANTA_BENCH_PRESET: "agentless-v3-thin-strict",
      })
      __resetLspAvailabilityCacheForTest()
      __setLspAvailabilityOverrideForTest((bin) => bin !== "pyright-langserver")
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
        QUANTA_BENCH_PRESET: "agentless-v1",
      })
      __resetLspAvailabilityCacheForTest()
      __setLspAvailabilityOverrideForTest((bin) => bin !== "pyright-langserver")
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
      env.set({ QUANTA_BENCH_PRESET: "agentless-v3-thin-strict" })
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
      // LSP-01: the strict gate now also runs a READY proof on the task anchor.
      // Inject a warm-ready fake pyright so this case stays deterministic without
      // a real pyright binary (the launch override only fakes `--version`).
      __setPyrightClientFactoryForTest(() => new FakePyrightClient())
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

  test.serial(
    "LSP-01: strict preset fails CLOSED when pyright is launchable but the workspace never reaches ready",
    env.run(async () => {
      // The gap launchability-only admission could not see: the binary resolves
      // (`--version` ok) but the task workspace never reaches verified-ready in
      // budget. Strict admission must DEGRADE on ready_timeout, not run blind.
      env.set({ QUANTA_BENCH_PRESET: "agentless-v3-thin-strict" })
      __resetLspAvailabilityCacheForTest()
      __setLspAvailabilityOverrideForTest(() => true) // pyright "launchable"
      // A python file WITH an import gives the readiness probe a symbol to poll;
      // a fake server that never resolves it exhausts the (tiny) ready budget.
      const fake = new FakePyrightClient()
      fake.defImpl = async () => []
      __setPyrightClientFactoryForTest(() => fake)
      __setPyrightWarmupTimingForTest({ budgetMs: 120, retryMs: 40 })
      const dir = mkdtempSync(join(tmpdir(), "bench-strict-lsp-notready-"))
      try {
        writeFileSync(
          join(dir, "core.py"),
          "from pkg.dep import helper\n\n\ndef add(a, b):\n    return helper(a) - b\n",
        )
        const instance: Instance = {
          id: "strict-lsp-notready",
          repoPath: dir,
          problemStatement: "Fix add().",
          testCmd: "true",
          goldPatch:
            "--- a/core.py\n+++ b/core.py\n@@ -4,2 +4,2 @@\n-    return helper(a) - b\n+    return helper(a) + b\n",
        }
        const llm = new SpyLLM()
        const result = await runInstance(instance, { llm, maxTurns: 3, timeoutMs: 20_000 })
        expect(result.passed).toBe(false)
        expect(result.verdict).toBe("degraded")
        expect(result.turns).toBe(0)
        expect(result.error).toContain("verified-ready")
        expect(result.error).toContain("ready_timeout")
        // LSP-02: the degraded row carries the TYPED status, not just the error
        // string — and on the LIVE apps path (gate throws before `prepared`
        // exists), proving the receipt is threaded off the error.
        expect(result.lspGrounding?.ready).toBe("ready_timeout")
        expect(result.lspGrounding?.backend).toBe("pyright")
        // Red-on-injection: if the ready proof is reverted (launch-only), the task
        // would RUN and llm.invoked would flip true.
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
