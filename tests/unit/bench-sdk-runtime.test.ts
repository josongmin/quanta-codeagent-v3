import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Instance } from "@/apps/bench/types"
import type { LLMPort, StreamEvent, StreamInput } from "@/llm"
import { __resetRuntimeConfig } from "@/shared/runtime-config"

class NoopLLM implements LLMPort {
  async *stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    yield { type: "text_delta", delta: "done" }
    yield { type: "message_stop", stop_reason: "end_turn" }
  }
}

const sdkCalls = {
  createRuntime: 0,
  createSession: 0,
  subscribe: 0,
  unsubscribe: 0,
  prompts: [] as string[],
  turnRun: 0,
  sessionClose: 0,
  runtimeClose: 0,
}

const originalBenchHome = process.env.QUANTA_BENCH_HOME
const testBenchHome = mkdtempSync(join(tmpdir(), "bench-sdk-home-"))
process.env.QUANTA_BENCH_HOME = testBenchHome
__resetRuntimeConfig()

const loadRunInstanceWithSdkMock = async () => {
  const originalSdkModule = await import("@/sdk/runtime")
  await mock.module("@/sdk/runtime", () => ({
    ...originalSdkModule,
    createRuntime: async ({
      host,
    }: {
      host: {
        createSessionHost(config: Record<string, unknown>): Promise<{
          describe(): { sessionId: string }
          runTurn(args: {
            history: readonly unknown[]
            prompt: string
            signal?: AbortSignal
          }): Promise<unknown>
          close(): Promise<void>
        }>
      }
    }) => {
      sdkCalls.createRuntime += 1
      return {
        createSession: async (config: Record<string, unknown>) => {
          sdkCalls.createSession += 1
          const hostSession = await host.createSessionHost(config)
          let prompt = ""
          const listeners = new Set<(event: Record<string, unknown>) => void>()
          return {
            sessionId: hostSession.describe().sessionId,
            dispatch: async () => ({ revision: 0, seq: 0, events: [] }),
            subscribe: (listener: (event: Record<string, unknown>) => void) => {
              sdkCalls.subscribe += 1
              listeners.add(listener)
              return () => {
                sdkCalls.unsubscribe += 1
                listeners.delete(listener)
              }
            },
            snapshot: async () => ({ sessionId: hostSession.describe().sessionId }),
            close: async () => {
              sdkCalls.sessionClose += 1
              await hostSession.close()
            },
            input: {
              append: async (text: string) => {
                prompt = text
                sdkCalls.prompts.push(text)
                return { revision: 1, seq: 1, events: [] }
              },
            },
            turn: {
              run: async (_meta?: unknown, options?: { signal?: AbortSignal }) => {
                sdkCalls.turnRun += 1
                for (const listener of [...listeners]) {
                  listener({
                    eventId: "turn-started",
                    seq: 2,
                    revision: 2,
                    emittedAt: "2026-05-26T00:00:00.000Z",
                    type: "turn.started",
                    prompt,
                  })
                }
                const result = await hostSession.runTurn({
                  history: [],
                  prompt,
                  ...(options?.signal !== undefined ? { signal: options.signal } : {}),
                })
                for (const listener of [...listeners]) {
                  listener({
                    eventId: "turn-completed",
                    seq: 3,
                    revision: 3,
                    emittedAt: "2026-05-26T00:00:01.000Z",
                    type: "turn.completed",
                    outcomeReason: "completed",
                  })
                }
                return { revision: 2, seq: 2, events: [], turn: result }
              },
            },
            identity: { set: async () => ({ revision: 0, seq: 0, events: [] }) },
            toolProfile: { set: async () => ({ revision: 0, seq: 0, events: [] }) },
            approval: { respond: async () => ({ revision: 0, seq: 0, events: [] }) },
            transcript: {
              replace: async () => ({
                revision: 0,
                seq: 0,
                events: [],
                transcript: { messages: [] },
              }),
            },
          }
        },
        close: async () => {
          sdkCalls.runtimeClose += 1
        },
      }
    },
  }))

  const benchEvalModuleUrl = new URL("../../src/apps/bench/eval/index.ts", import.meta.url)
  benchEvalModuleUrl.searchParams.set("sdkCutover", `${Date.now()}-${Math.random()}`)
  const { runInstance } = await import(benchEvalModuleUrl.href)

  return {
    runInstance,
    restore: async () => {
      await mock.module("@/sdk/runtime", () => originalSdkModule)
      mock.restore()
    },
  }
}

afterAll(async () => {
  if (originalBenchHome === undefined) delete process.env.QUANTA_BENCH_HOME
  else process.env.QUANTA_BENCH_HOME = originalBenchHome
  __resetRuntimeConfig()
  rmSync(testBenchHome, { recursive: true, force: true })
})

beforeEach(() => {
  sdkCalls.createRuntime = 0
  sdkCalls.createSession = 0
  sdkCalls.subscribe = 0
  sdkCalls.unsubscribe = 0
  sdkCalls.prompts = []
  sdkCalls.turnRun = 0
  sdkCalls.sessionClose = 0
  sdkCalls.runtimeClose = 0
})

describe("apps/bench/eval SDK cutover", () => {
  test.serial(
    "runInstance drives the per-instance attempt through createRuntime/session dispatch",
    async () => {
      const { runInstance, restore } = await loadRunInstanceWithSdkMock()
      const dir = mkdtempSync(join(tmpdir(), "bench-sdk-runtime-"))
      try {
        writeFileSync(join(dir, "note.txt"), "ok\n")
        const instance: Instance = {
          id: "sdk-cutover-1",
          repoPath: dir,
          problemStatement: "Inspect the repo and stop.",
          testCmd: "true",
        }
        const result = await runInstance(instance, {
          llm: new NoopLLM(),
          maxTurns: 2,
          timeoutMs: 20_000,
        })
        expect(result.id).toBe(instance.id)
        expect(result.passed).toBe(false)
        expect(result.error).toContain("empty prediction")
        expect(sdkCalls.createRuntime).toBe(1)
        expect(sdkCalls.createSession).toBe(1)
        expect(sdkCalls.subscribe).toBe(1)
        expect(sdkCalls.unsubscribe).toBe(1)
        expect(sdkCalls.turnRun).toBe(1)
        expect(sdkCalls.sessionClose).toBe(1)
        expect(sdkCalls.runtimeClose).toBe(1)
        expect(sdkCalls.prompts).toHaveLength(1)
        expect(sdkCalls.prompts[0]).toContain("Inspect the repo and stop.")
        expect(sdkCalls.prompts[0]).toContain("Work inside")
      } finally {
        await restore()
        rmSync(dir, { recursive: true, force: true })
      }
    },
  )
})
