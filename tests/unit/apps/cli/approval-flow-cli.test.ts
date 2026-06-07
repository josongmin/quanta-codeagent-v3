import { describe, expect, test } from "bun:test"
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
      { role: "assistant", content: [{ type: "text", text: "approved and completed" }] },
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

const stubSetup = (approvalDecisions: readonly ("approve" | "deny")[]) => {
  const counters = {
    approvalPrompt: 0,
    approvalRespond: 0,
    inputAppend: 0,
    turnRun: 0,
    sessionClose: 0,
    runtimeClose: 0,
  }
  const queue = [...approvalDecisions]
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
            status: "idle" as const,
            draftInput: "",
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
          pendingApproval: null,
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
            if (counters.turnRun === 1) {
              return {
                revision: 2,
                seq: 2,
                events: [],
                turn: {
                  outcome,
                  messages: [],
                  approvalRequest: {
                    approvalId: "ap1",
                    reason: "terminal.needs_approval",
                    requestedAt: "2026-05-26T00:00:00.000Z",
                  },
                },
              }
            }
            return {
              revision: 4,
              seq: 4,
              events: [],
              turn: {
                outcome,
                messages: outcome.messages,
              },
            }
          },
        },
        identity: { set: async () => ({ revision: 0, seq: 0, events: [] }) },
        toolProfile: { set: async () => ({ revision: 0, seq: 0, events: [] }) },
        approval: {
          respond: async () => {
            counters.approvalRespond += 1
            return { revision: 3, seq: 3, events: [] }
          },
        },
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
    permissionMode: () => "default",
    permissionModeState: () => undefined,
    automationEngine: () => undefined,
    toolProfileState: () => undefined,
    identityModeState: () => undefined,
    focusChain: () => undefined,
    stickyModelStore: () => undefined,
    decisionEmitter: () => undefined,
    admissibility: () => undefined,
    planExitPort: () => undefined,
    userInputPort: () => undefined,
    dreamTrigger: () => undefined,
  }

  const setup: SessionSetupResult = {
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
    memoryStore: undefined,
    memoryEmbedder: undefined,
    searchPipelineDispose: undefined,
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
    approvalPrompt: async () => {
      counters.approvalPrompt += 1
      const next = queue.shift()
      if (next === undefined) throw new Error("approval decision queue exhausted")
      return next
    },
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
  }

  return { counters, setup }
}

describe("T5 approval flow cli", () => {
  test("CLI prompts, responds, and reruns the turn after approval", async () => {
    const { setup, counters } = stubSetup(["approve"])
    const sinks = buildSinks()

    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
    })

    expect(counters.inputAppend).toBe(1)
    expect(counters.turnRun).toBe(2)
    expect(counters.approvalPrompt).toBe(1)
    expect(counters.approvalRespond).toBe(1)
    expect(counters.sessionClose).toBe(1)
    expect(counters.runtimeClose).toBe(1)
    expect(sinks.events).toEqual(["dashboard", "summary", "pills"])
    expect(sinks.errs).toHaveLength(0)
  })

  test("CLI fails closed when the operator denies the pending approval", async () => {
    const { setup, counters } = stubSetup(["deny"])
    const sinks = buildSinks()

    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
    })

    expect(counters.inputAppend).toBe(1)
    expect(counters.turnRun).toBe(1)
    expect(counters.approvalPrompt).toBe(1)
    expect(counters.approvalRespond).toBe(1)
    expect(counters.sessionClose).toBe(1)
    expect(counters.runtimeClose).toBe(1)
    expect(sinks.events).toEqual(["error"])
    expect(sinks.errs).toHaveLength(1)
    expect(sinks.errs[0]).toBeInstanceOf(Error)
    expect((sinks.errs[0] as Error).message).toContain("runtime session approval denied")
  })

  test("CLI source routes approval requests through approval.respond and rerun", () => {
    const sessionLoop = read("src/apps/cli/repl/session-loop.ts")
    const sdkTypes = read("src/sdk/runtime/types.ts")
    // ADR-0303 — the approval-resolution loop was hoisted OUT of the surface
    // into the shared runner-owned driver. The CLI now ROUTES through it: each
    // turn funnels through `driveSessionTurn`, handing its operator resolver
    // (`setup.approvalPrompt`) in. The actual `approval.respond` + deny-throw
    // live in the driver — assert there, not in the surface.
    const driver = read("src/runner/orchestrate/session-turn-driver.ts")

    expect(sessionLoop).toContain("driveSessionTurn")
    expect(sessionLoop).toContain("setup.approvalPrompt")
    expect(driver).toContain("session.approval.respond")
    expect(driver).toContain('if (decision === "deny")')
    expect(sdkTypes).toContain("readonly approval:")
    expect(sdkTypes).toContain('decision: "approve" | "deny"')
  })
})
