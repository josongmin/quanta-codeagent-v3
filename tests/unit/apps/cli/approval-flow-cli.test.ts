import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentOutcome } from "@/agent"
import { runSessionLoop, type SessionLoopSinks } from "@/apps/cli/repl/session-loop"
import type { SessionSetupResult } from "@/apps/cli/repl/session-setup"
import type { Message } from "@/llm"
import type { RuntimeContext } from "@/sdk/runtime"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..")
const read = (path: string): string => readFileSync(join(REPO_ROOT, path), "utf8")

const makeOutcome = (): AgentOutcome =>
  ({
    reason: "completed",
    turns: 1,
    messages: [
      { role: "user", content: [{ type: "text", text: "needs approval" }] },
      { role: "assistant", content: [{ type: "text", text: "awaiting approval" }] },
    ],
  }) as AgentOutcome

const buildSinks = (): SessionLoopSinks & {
  readonly events: string[]
  readonly errs: unknown[]
} => {
  const events: string[] = []
  const errs: unknown[] = []
  return {
    events,
    errs,
    renderTurnDashboard: () => events.push("dashboard"),
    renderAndResetSummary: () => events.push("summary"),
    flushLifecyclePills: () => events.push("pills"),
    renderTurnError: (err) => {
      events.push("error")
      errs.push(err)
    },
  }
}

const stubSetup = (): {
  readonly setup: SessionSetupResult
  readonly counters: {
    inputAppend: number
    turnRun: number
    sessionClose: number
    runtimeClose: number
  }
} => {
  const counters = {
    inputAppend: 0,
    turnRun: 0,
    sessionClose: 0,
    runtimeClose: 0,
  }
  const outcome = makeOutcome()
  const runtimeContext: RuntimeContext = {
    createRuntimeFacade: async () => ({
      createSession: async () => ({
        sessionId: "approval-flow-cli",
        dispatch: async () => ({ revision: 0, seq: 0, events: [] }),
        subscribe: () => () => undefined,
        snapshot: async () => ({
          sessionId: "approval-flow-cli",
          revision: 0,
          seq: 0,
          state: {
            status: "awaiting_approval" as const,
            draftInput: "needs approval",
            permissionMode: "default",
            messageCount: outcome.messages.length,
          },
          capabilities: {
            approvals: "operator" as const,
            tools: true,
            memory: false,
            artifacts: false,
            subagents: false,
            automation: false,
            shellSnapshot: false,
            transport: "inproc" as const,
          },
          pendingApproval: {
            approvalId: "ap1",
            reason: "terminal.needs_approval",
            requestedAt: "2026-05-26T00:00:00.000Z",
          },
          openArtifacts: [],
        }),
        attachSessionTransport: async () => ({ close: async () => undefined }),
        close: async () => {
          counters.sessionClose += 1
        },
        input: {
          append: async () => {
            counters.inputAppend += 1
            return { revision: 1, seq: 1, events: [] }
          },
        },
        turn: {
          run: async () => {
            counters.turnRun += 1
            return {
              revision: 2,
              seq: 2,
              events: [],
              turn: {
                outcome,
                messages: outcome.messages,
                approvalRequest: {
                  approvalId: "ap1",
                  reason: "terminal.needs_approval",
                  requestedAt: "2026-05-26T00:00:00.000Z",
                },
              },
            }
          },
        },
        identity: { set: async () => ({ revision: 0, seq: 0, events: [] }) },
        toolProfile: { set: async () => ({ revision: 0, seq: 0, events: [] }) },
        approval: { respond: async () => ({ revision: 0, seq: 0, events: [] }) },
        transcript: {
          replace: async (messages: readonly Message[]) => ({
            revision: 0,
            seq: 0,
            events: [],
            transcript: { messages: [...messages] },
          }),
        },
        side: {
          start: async () => ({
            outcome,
            answerText: "",
            inputTokens: 0,
            outputTokens: 0,
            toolsAvailable: 0,
          }),
        },
      }),
      close: async () => {
        counters.runtimeClose += 1
      },
    }),
    materializeReviewerAgent: () => undefined,
    registry: () => ({ has: () => false, all: () => [] }) as never,
    wrapRegistry: () => undefined,
    permissionMode: () => "default",
    automationEngine: () => undefined,
    ensureAutomationEngine: (slot) => slot,
    setGranularRegistry: () => undefined,
    toolProfileState: () => undefined,
    identityModeState: () => undefined,
    focusChain: () => undefined,
    decisionEmitter: () => undefined,
    admissibility: () => undefined,
    withAdmissibility: () => undefined,
    planExitPort: () => undefined,
    userInputPort: () => undefined,
  }

  return {
    counters,
    setup: {
      provider: "openai" as never,
      model: "test-model",
      mode: "default" as never,
      cwd: "/tmp/test-cwd",
      slog: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
      idleMonitor: { markActive: () => undefined } as never,
      rejectCounter: { recordAccept: () => undefined, recordDeny: () => 0 } as never,
      effortStore: {
        get: () => "default" as const,
        set: () => undefined,
        snapshot: () => "default" as const,
      },
      llm: { generate: async () => ({ content: [] }) } as never,
      planMode: false,
      metrics: undefined as never,
      state: undefined as never,
      mcpClients: [],
      mcpTools: [],
      mcpSurface: undefined,
      skillsConfig: undefined as never,
      lifecyclePills: {
        update: () => undefined,
        render: () => "",
        flush: () => undefined,
      } as never,
      lifecycleTaskRegistry: undefined,
      lifecycleFollowUpQueue: undefined,
      sessionId: "approval-flow-cli",
      history: [],
      pendingImages: [],
      idMeta: undefined,
      statusBar: {
        setDefault: () => undefined,
        transient: () => undefined,
        clearTransient: () => undefined,
        teardown: () => undefined,
      } as never,
      turnIndicator: {
        start: () => undefined,
        stop: () => undefined,
        updateUsage: () => undefined,
        markFirstChunk: () => undefined,
      } as never,
      turnSummary: {
        onEvent: () => undefined,
        render: () => "",
        reset: () => undefined,
        asStreamPort: () => ({ emit: () => undefined }),
      } as never,
      debugHandle: undefined,
      timelinePanel: undefined,
      runtimeContext,
      costPanel: undefined,
      branchProgress: undefined,
      planStore: undefined,
      abort: new AbortController(),
      pills: { dispose: () => undefined, update: () => undefined } as never,
      argPrompt: "needs approval",
      systemSource: { get: () => "SYS", set: () => undefined },
      refreshSystemPrompt: () => undefined,
      shutdownMcp: async () => undefined,
      playbookCliFlag: undefined,
      featureCfg: {
        pills: { enabled: false, hideTasks: false, hideFollowUp: false, hideMcp: false },
        subagentForPills: false,
        costPanel: { enabled: false },
        branchProgress: { enabled: false },
        planStore: { enabled: false },
        workMetricsSinkEnabled: false,
        turnSummary: { enabled: false, verbose: false },
        turnIndicator: { enabled: false, intervalMs: 80 },
        debugTracer: { enabled: false, categories: undefined, stderrIsTTY: false },
        imageQueue: { enabled: true, maxSize: 5 },
        history: { enabled: true, maxLines: 1000, filePath: undefined },
        multiline: { enabled: true },
        rewindGit: { enabled: false },
      } as never,
    },
  }
}

let originalStdin: NodeJS.ReadStream

beforeEach(() => {
  originalStdin = process.stdin
  Object.defineProperty(process, "stdin", {
    value: { isTTY: false } as Partial<NodeJS.ReadStream>,
    configurable: true,
  })
})

afterEach(() => {
  Object.defineProperty(process, "stdin", { value: originalStdin, configurable: true })
})

describe("T5 approval flow cli", () => {
  test("CLI fails closed when a runtime session returns an approval request", async () => {
    const { setup, counters } = stubSetup()
    const sinks = buildSinks()

    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
    })

    expect(counters.inputAppend).toBe(1)
    expect(counters.turnRun).toBe(1)
    expect(counters.sessionClose).toBe(1)
    expect(counters.runtimeClose).toBe(1)
    expect(sinks.events).toEqual(["error"])
    expect(sinks.errs).toHaveLength(1)
    expect(sinks.errs[0]).toBeInstanceOf(Error)
    expect((sinks.errs[0] as Error).message).toContain(
      "runtime session approval flow is not yet wired in CLI surface",
    )
  })

  test("CLI source carries an explicit approval-request guard while the sdk surface exposes approval.respond", () => {
    const sessionLoop = read("src/apps/cli/repl/session-loop.ts")
    const sdkTypes = read("src/sdk/runtime/types.ts")

    expect(sessionLoop).toContain("result.turn.approvalRequest")
    expect(sessionLoop).toContain("runtime session approval flow is not yet wired in CLI surface")
    expect(sdkTypes).toContain("readonly approval:")
    expect(sdkTypes).toContain('decision: "approve" | "deny"')
  })
})
