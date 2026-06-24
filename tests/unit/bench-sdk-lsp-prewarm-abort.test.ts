import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
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
import { runInstance as runRunnerInstance } from "@/runner/batch/eval"
import { scopedEnv } from "../_support/scoped-env"

class SpyLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "done" }
    await new Promise((resolve) => setTimeout(resolve, 40))
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

class FakePyrightClient extends LspClient {
  readonly seenSignals: AbortSignal[] = []
  constructor(options: LspClientOptions = {}) {
    super({ defaultCommand: ["unused"], languageIdFor: () => "python" }, options)
  }
  override async start(): Promise<void> {}
  override async stop(): Promise<void> {}
  override async prime(): Promise<void> {}
  override async definition(
    _filePath: string,
    _pos: { line: number; character: number },
    signal?: AbortSignal,
  ): Promise<Location[] | null> {
    if (signal !== undefined) this.seenSignals.push(signal)
    return []
  }
}

const clients: FakePyrightClient[] = []
const env = scopedEnv(["QUANTA_BENCH_PRESET"])

const collectSeenSignals = async (
  runBenchInstance: (
    instance: Instance,
    args: { llm: LLMPort; maxTurns: number; timeoutMs: number },
  ) => Promise<unknown>,
): Promise<readonly AbortSignal[]> => {
  const dir = mkdtempSync(join(tmpdir(), "bench-prewarm-abort-"))
  try {
    writeFileSync(join(dir, "dep.py"), "VALUE = 1\n")
    writeFileSync(
      join(dir, "bug.py"),
      "from dep import VALUE\n\n\ndef add(a, b):\n    return a - b\n",
    )
    const instance: Instance = {
      id: "sdk-prewarm-abort",
      repoPath: dir,
      problemStatement: "Fix add().",
      testCmd: "true",
    }

    await runBenchInstance(instance, {
      llm: new SpyLLM(),
      maxTurns: 3,
      timeoutMs: 20_000,
    })
    await new Promise((resolve) => setTimeout(resolve, 40))
    return clients.flatMap((client) => client.seenSignals)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

afterEach(async () => {
  clients.length = 0
  await __resetSharedPyrightSessionsForTest()
  __setPyrightClientFactoryForTest(null)
  __setPyrightWarmupTimingForTest(null)
  __setLspAvailabilityOverrideForTest(null)
  __resetLspAvailabilityCacheForTest()
})

describe("apps bench SDK session-end prewarm abort", () => {
  test.serial(
    "SDK path aborts the background LSP prewarm signal on normal turn completion",
    env.run(async () => {
      env.set({ QUANTA_BENCH_PRESET: "agentless-v3-thin-strict" })
      __resetLspAvailabilityCacheForTest()
      __setLspAvailabilityOverrideForTest(() => true)
      __setPyrightWarmupTimingForTest({ budgetMs: 25, retryMs: 1 })
      __setPyrightClientFactoryForTest(() => {
        const client = new FakePyrightClient()
        clients.push(client)
        return client
      })
      const seen = await collectSeenSignals(runInstance)
      expect(seen.length).toBeGreaterThan(0)
      // Red-on-injection: if the SDK path threads only the outer timeout signal,
      // normal turn completion leaves the prewarm signal live (`aborted=false`)
      // and the fire-and-forget warm can keep polling past session end.
      expect(seen.every((signal) => signal.aborted)).toBe(true)
    }),
    60_000,
  )

  test.serial(
    "runner path aborts the background LSP prewarm signal on normal turn completion",
    env.run(async () => {
      env.set({ QUANTA_BENCH_PRESET: "agentless-v3-thin-strict" })
      __resetLspAvailabilityCacheForTest()
      __setLspAvailabilityOverrideForTest(() => true)
      __setPyrightWarmupTimingForTest({ budgetMs: 25, retryMs: 1 })
      __setPyrightClientFactoryForTest(() => {
        const client = new FakePyrightClient()
        clients.push(client)
        return client
      })
      const seen = await collectSeenSignals(runRunnerInstance)
      expect(seen.length).toBeGreaterThan(0)
      expect(seen.every((signal) => signal.aborted)).toBe(true)
    }),
    60_000,
  )
})
