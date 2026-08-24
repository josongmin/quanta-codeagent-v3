import { describe, expect, test } from "bun:test"
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import { AGENT_MODES } from "@/agent/subagent-typed"
import {
  defaultResponsesContinuationStore,
  type LLMPort,
  type Message,
  type StreamEvent,
  type StreamInput,
} from "@/llm"
import type { SessionDeps } from "@/runner/assemble/config"
import { buildSharedExecutionPlaneSessionDeps } from "@/runner/session-execution-plane"
import { ToolRegistry } from "@/tool"
import { present } from "../../_helpers/expect-present"

const mkMsg = (text: string): Message => ({
  role: "user",
  content: [{ type: "text", text }],
})

const baseSessionDeps = (): SessionDeps => ({
  llm: {
    stream: (_input: StreamInput): AsyncIterable<StreamEvent> => ({
      async *[Symbol.asyncIterator]() {
        // empty
      },
    }),
  } satisfies LLMPort,
  registry: new ToolRegistry([]),
  stream: { emit: () => {} },
  permission: { mode: "acceptEdits" },
  system: "system",
  cwd: "/tmp/quanta-wire",
  maxTurns: 8,
  signal: new AbortController().signal,
  onConfirm: async () => true,
  store: undefined,
  sessionId: "sess-1",
  embedder: undefined,
  memoryConfig: undefined,
  planMode: false,
  metrics: undefined,
  run: undefined,
  subagentConfig: undefined,
  skillsConfig: undefined,
  compactionBreakerConfig: undefined,
  verifyGuardConfig: undefined,
  summarizerLlm: undefined,
  onShellEvent: undefined,
  workMetricsSink: undefined,
})

describe("session execution plane", () => {
  test("fork surfaces reuse the supplied conversation checkpoint store", async () => {
    const convStore = defaultConversationCheckpointStore()
    const deps = baseSessionDeps()
    const wired = await buildSharedExecutionPlaneSessionDeps({
      history: [mkMsg("seed")],
      sessionDeps: deps,
      cwd: deps.cwd,
      convStore,
      envSource: {},
    })

    expect(wired.conversationCheckpoint?.store).toBe(convStore)
    expect(wired.fork).toBeDefined()
    expect(wired.forkSession).toBeDefined()

    convStore.record("root", [mkMsg("root")])

    const baseFork = wired.fork?.forker.fork("root")
    expect(baseFork?.ok).toBe(true)

    const richFork = await wired.forkSession?.forker.fork({ fromCheckpointRef: "root" })
    expect(richFork?.ok).toBe(true)
  })

  test("subagent-enabled sessions gain delegation, background scheduler, and autoBackground", async () => {
    const deps = baseSessionDeps()
    deps.subagentConfig = {}
    const wired = await buildSharedExecutionPlaneSessionDeps({
      history: [mkMsg("seed")],
      sessionDeps: deps,
      cwd: deps.cwd,
      convStore: defaultConversationCheckpointStore(),
      envSource: {
        QUANTA_BG_MAX_CONCURRENT: "5",
        QUANTA_BG_MAX_RETAINED: "9",
        QUANTA_AUTO_BACKGROUND_THRESHOLD_MS: "2500",
      },
    })

    expect(wired.delegation?.modes).toEqual(AGENT_MODES)
    expect(wired.subagentBackground).toBeDefined()
    expect(wired.subagentBackground?.scheduler.list()).toEqual([])
    expect(wired.autoBackground?.detector).toBeDefined()
    expect(wired.autoBackground?.proposer).toBeDefined()
    expect(wired.autoBackground?.thresholdMs).toBe(2500)
  })

  test("execution plane wraps llm with the supplied Responses continuation store", async () => {
    const seen: StreamInput[] = []
    const responsesStore = defaultResponsesContinuationStore()
    const deps = baseSessionDeps()
    deps.llm = {
      surfaceId: "openai-responses",
      stream: (input: StreamInput): AsyncIterable<StreamEvent> => ({
        async *[Symbol.asyncIterator]() {
          seen.push(input)
          yield* []
        },
      }),
    }
    const wired = await buildSharedExecutionPlaneSessionDeps({
      history: [mkMsg("seed")],
      sessionDeps: deps,
      cwd: deps.cwd,
      convStore: defaultConversationCheckpointStore(),
      responsesStore,
      envSource: {},
    })

    expect(wired.responsesContinuation?.store).toBe(responsesStore)
    expect(wired.llm).toBeDefined()
    for await (const _ of present(wired.llm, "wired.llm").stream({
      messages: [mkMsg("hi")],
      tools: [],
    })) {
      // drain
    }

    expect(seen).toHaveLength(1)
    expect(seen[0]?.responsesContinuation?.store).toBe(responsesStore)
  })
})
