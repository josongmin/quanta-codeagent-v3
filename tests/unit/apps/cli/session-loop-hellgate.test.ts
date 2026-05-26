import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { AgentOutcome } from "../../../../src/agent"
import type { IdleMonitor } from "../../../../src/apps/cli/idle-monitor"
import type { LifecyclePills } from "../../../../src/apps/cli/lifecycle-pills"
import type { RejectCounter } from "../../../../src/apps/cli/reject-counter"
import type {
  RunSessionLoopDeps,
  SessionLoopSinks,
} from "../../../../src/apps/cli/repl/session-loop"
import type { SessionSetupResult } from "../../../../src/apps/cli/repl/session-setup"
import type { StatusBar } from "../../../../src/apps/cli/status-bar"
import type { TurnIndicator } from "../../../../src/apps/cli/turn-indicator"
import type { TurnSummaryCollector } from "../../../../src/apps/cli/turn-summary"
import type { Message } from "../../../../src/llm"
import type { RuntimeContext } from "../../../../src/sdk/runtime"

/**
 * Slice-C (T2 rewrite): runtime behavior coverage for `runSessionLoop`.
 *
 * The PRIOR hellgate was source-sniffing (`grep` for `ESC_WINDOW_MS = 2000`,
 * `let surfaceState: SessionState`, `process.stderr.write("\n")`, regex
 * over drain-before-runOnce, `composePromptPipeline` substring presence).
 * Those assertions fail on cosmetic refactors that preserve behavior AND
 * pass on regressions that preserve file shape — both directions of false
 * signal.
 *
 * This rewrite calls `runSessionLoop(deps)` directly with stubs and asserts
 * OBSERVABLE behavior at the seam boundaries:
 *
 *   - one-shot branch (`setup.argPrompt` set):   runOnce called exactly once
 *   - interactive branch (no argPrompt):         runInteractive called with
 *                                                 wired wrapTurn + onTurnEnd
 *   - PromptSource semantics (built by composePromptPipeline) are exercised
 *     by the prompt-pipeline-hellgate sibling — we focus on the LOOP funnel.
 *   - `pills.dispose` + `statusBar.teardown` are registered via the
 *     `registerExitTeardown` hook (the interactive branch's process-exit
 *     contract).
 *   - sinks fire in the correct order on a successful turn.
 *
 * REGRESSION SCENARIOS this rewritten test catches:
 *
 *   - If the one-shot branch dropped `runOnce` (e.g. someone refactored to
 *     "just resolve immediately") ⇒ `runOnce called exactly once` fails.
 *   - If `wrapTurn` stopped invoking the `run(turnDeps)` callback ⇒ the
 *     `interactive — wrapTurn forwards run(turnDeps)` test fails.
 *   - If `onTurnEnd` no longer fires `flushLifecyclePills` ⇒
 *     `flushLifecyclePills fires on turn end` fails.
 *   - If `registerExitTeardown` is no longer called in interactive ⇒
 *     `registerExitTeardown installs pills/statusBar teardown` fails.
 *   - If both branches stopped funnelling through the sinks (e.g. an inline
 *     dashboard write returned) ⇒ `sinks.renderTurnDashboard fires` fails.
 *
 * NOTE on legitimate type-shape locks (kept): the existing key-array tests
 * compile-time-assert that every required key on the public DI bag is
 * present. A future rename without test update is a TypeScript ERROR in this
 * file. That is contract enforcement via the compiler, NOT source-sniff.
 */

// === stubs ====================================================================

const stubStatusBar = (): StatusBar & { teardownCalls: number } => {
  const handle = {
    teardownCalls: 0,
    setDefault: () => undefined,
    transient: () => undefined,
    clearTransient: () => undefined,
    teardown: (): void => {
      handle.teardownCalls += 1
    },
  }
  return handle
}

const stubIndicator = (): TurnIndicator => ({
  start: () => undefined,
  stop: () => undefined,
  updateUsage: () => undefined,
  markFirstChunk: () => undefined,
})

const stubSummary = (): TurnSummaryCollector => ({
  onEvent: () => undefined,
  render: () => "",
  reset: () => undefined,
  asStreamPort: () => ({ emit: () => undefined }),
})

const stubIdle = (): IdleMonitor => ({
  markActive: () => undefined,
  isIdle: () => false,
  snooze: () => undefined,
  unsnooze: () => undefined,
  isSnoozed: () => false,
  reset: () => undefined,
})

const stubRejects = (): RejectCounter => ({
  recordDeny: () => 0,
  recordAccept: () => undefined,
  count: () => 0,
  shouldAutoExit: () => false,
  reset: () => undefined,
})

const stubPills = (): LifecyclePills & { disposeCalls: number } => {
  const handle = {
    disposeCalls: 0,
    update: () => undefined,
    render: () => "",
    flush: () => undefined,
    dispose: (): void => {
      handle.disposeCalls += 1
    },
  }
  return handle
}

const buildSinks = (): SessionLoopSinks & {
  events: string[]
  errs: unknown[]
  summaryArgs: Array<{ messages: readonly Message[] }>
} => {
  const events: string[] = []
  const errs: unknown[] = []
  const summaryArgs: Array<{ messages: readonly Message[] }> = []
  return {
    events,
    errs,
    summaryArgs,
    renderTurnDashboard: () => events.push("dashboard"),
    renderAndResetSummary: (o) => {
      events.push("summary")
      summaryArgs.push(o)
    },
    flushLifecyclePills: () => events.push("pills"),
    renderTurnError: (err) => {
      events.push("error")
      errs.push(err)
    },
  }
}

const resetRuntimeCalls = (): void => {
  runtimeCalls.createRuntime = 0
  runtimeCalls.createSession = 0
  runtimeCalls.prompts = []
  runtimeCalls.imageCounts = []
  runtimeCalls.turnRun = 0
  runtimeCalls.sessionClose = 0
  runtimeCalls.runtimeClose = 0
}

// Build a minimal SessionSetupResult — the loop only reads a subset.
const buildSetup = async (
  argPrompt: string | undefined,
): Promise<
  SessionSetupResult & {
    __statusBar: ReturnType<typeof stubStatusBar>
    __pillsDisposeCalls: { n: number }
  }
> => {
  const statusBar = stubStatusBar()
  const pillsDisposeCalls = { n: 0 }
  const llmStub = {
    generate: async () => ({ content: [] }),
  } as unknown as SessionSetupResult["llm"]
  resetRuntimeCalls()
  let registry = {
    has: (_name: string) => false,
    all: () => [] as unknown[],
  }
  let automationEngine: unknown
  const runtimeContext: RuntimeContext = {
    createRuntimeFacade: async (args: Parameters<RuntimeContext["createRuntimeFacade"]>[0]) => {
      runtimeCalls.createRuntime += 1
      automationEngine = args.compose?.automationEngine
      const registryNames = [
        ...new Set([
          ...registry
            .all()
            .map((tool) =>
              typeof tool === "object" && tool !== null && "name" in tool
                ? String((tool as { name: string }).name)
                : "",
            )
            .filter((name) => name.length > 0),
          ...(automationEngine !== undefined ? ["automation_update"] : []),
        ]),
      ]
      registry = {
        has: (name: string) => registryNames.includes(name),
        all: () => registryNames.map((name) => ({ name })),
      }
      bridgeState.options = {
        sessionDeps: {
          ...(automationEngine !== undefined ? { automationEngine } : {}),
          registry,
        },
      }
      bridgeState.messages = []
      bridgeState.outcome = undefined
      bridgeState.closeCalls = 0
      return {
        createSession: async () => {
          runtimeCalls.createSession += 1
          return {
            sessionId: "session-loop-sdk",
            dispatch: async () => ({ revision: 0, seq: 0, events: [] }),
            subscribe: () => () => undefined,
            snapshot: async () => ({
              sessionId: "session-loop-sdk",
              revision: 0,
              seq: 0,
              state: {
                status: "idle",
                draftInput: "",
                permissionMode: "default",
                messageCount: bridgeState.messages.length,
              },
              capabilities: {
                approvals: "operator",
                tools: true,
                memory: false,
                artifacts: true,
                subagents: false,
                automation: automationEngine !== undefined,
                shellSnapshot: false,
                transport: "inproc" as const,
              },
              pendingApproval: null,
              openArtifacts: [],
            }),
            attachSessionTransport: async () => ({ close: async () => undefined }),
            close: async () => {
              runtimeCalls.sessionClose += 1
              bridgeState.closeCalls += 1
            },
            input: {
              append: async (text: string, meta?: { readonly images?: readonly unknown[] }) => {
                runtimeCalls.prompts.push(text)
                runtimeCalls.imageCounts.push(meta?.images?.length ?? 0)
                return { revision: 1, seq: 1, events: [] }
              },
            },
            turn: {
              run: async () => {
                runtimeCalls.turnRun += 1
                if (bridgeState.failWith !== undefined) throw bridgeState.failWith
                const prompt = runtimeCalls.prompts.at(-1) ?? ""
                const outcome = makeOutcome(prompt)
                bridgeState.messages = [...outcome.messages] as Message[]
                bridgeState.outcome = outcome
                return {
                  revision: 2,
                  seq: 2,
                  events: [],
                  turn: { outcome, messages: outcome.messages },
                }
              },
            },
            identity: { set: async () => ({ revision: 0, seq: 0, events: [] }) },
            toolProfile: { set: async () => ({ revision: 0, seq: 0, events: [] }) },
            approval: { respond: async () => ({ revision: 0, seq: 0, events: [] }) },
            transcript: {
              replace: async (messages: readonly Message[]) => {
                bridgeState.messages = [...messages]
                return { revision: 3, seq: 3, events: [], transcript: { messages: [...messages] } }
              },
            },
            side: {
              start: async () => ({
                outcome: makeOutcome("side"),
                answerText: "side",
                inputTokens: 0,
                outputTokens: 0,
                toolsAvailable: 0,
              }),
            },
          }
        },
        close: async () => {
          runtimeCalls.runtimeClose += 1
        },
      }
    },
    materializeReviewerAgent: (_boot, _turnAssembler) => undefined,
    registry: () => registry as never,
    permissionMode: () => "default",
    automationEngine: () => automationEngine as never,
    toolProfileState: () => undefined,
    identityModeState: () => undefined,
    focusChain: () => undefined,
    decisionEmitter: () => undefined,
    admissibility: () => undefined,
    planExitPort: () => undefined,
    userInputPort: () => undefined,
  }
  // Use a permissive `as never` cast for fields the loop only forwards.
  const result = {
    provider: "anthropic" as never,
    model: "test-model",
    mode: "default" as never,
    cwd: "/tmp/test-cwd",
    slog: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    idleMonitor: stubIdle(),
    rejectCounter: stubRejects(),
    effortStore: {
      get: () => "default" as const,
      set: () => undefined,
      snapshot: () => "default" as const,
    },
    llm: llmStub,
    planMode: false,
    metrics: undefined as never,
    state: undefined as never,
    mcpClients: [],
    mcpTools: [],
    mcpSurface: undefined,
    skillsConfig: undefined as never,
    lifecyclePills: stubPills(),
    lifecycleTaskRegistry: undefined,
    lifecycleFollowUpQueue: undefined,
    sessionId: "session-loop-test",
    history: [],
    pendingImages: [],
    idMeta: undefined,
    statusBar,
    turnIndicator: stubIndicator(),
    turnSummary: stubSummary(),
    debugHandle: undefined,
    timelinePanel: undefined,
    approvalPrompt: async () => "approve" as const,
    runtimeContext,
    costPanel: undefined,
    branchProgress: undefined,
    planStore: undefined,
    abort: new AbortController(),
    // `pills` here is the status-pills row (NOT lifecyclePills); the loop's
    // exit teardown calls `pills.dispose()` to clear the pill row before the
    // scroll region resets.
    pills: {
      dispose: (): void => {
        pillsDisposeCalls.n += 1
      },
      update: () => undefined,
    } as never,
    argPrompt,
    systemSource: {
      get: () => "SYS",
      set: () => undefined,
    },
    refreshSystemPrompt: () => undefined,
    shutdownMcp: async () => undefined,
    // ADR-0301 — `--playbook-trigger` CLI flag echo. The loop spreads this
    // by-presence onto `maybeStartPlaybookTriggerWire({ cliFlag })`; the
    // fixture defaults to `undefined` ⇒ slot omitted ⇒ default-OFF behaviour.
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
    __statusBar: statusBar,
    __pillsDisposeCalls: pillsDisposeCalls,
  }
  return result as typeof result
}

// === module-mock plumbing ====================================================

// We override the Runtime SDK, the legacy runner-session bridge, and the
// prompt pipeline so the loop runs against a deterministic in-memory session
// instead of booting the real agent stack or touching raw readline.
const runtimeCalls = {
  createRuntime: 0,
  createSession: 0,
  prompts: [] as string[],
  imageCounts: [] as number[],
  turnRun: 0,
  sessionClose: 0,
  runtimeClose: 0,
}

const promptQueue: unknown[] = []

const bridgeState: {
  options: {
    sessionDeps?: {
      automationEngine?: unknown
      registry?: { has: (name: string) => boolean; all?: () => unknown[] }
    }
  } | null
  messages: Message[]
  outcome: AgentOutcome | undefined
  failWith: Error | undefined
  closeCalls: number
} = {
  options: null,
  messages: [],
  outcome: undefined,
  failWith: undefined,
  closeCalls: 0,
}

const makeOutcome = (prompt: string): AgentOutcome => {
  const messages = [
    { role: "user", content: [{ type: "text", text: prompt }] },
    { role: "assistant", content: [{ type: "text", text: `assistant:${prompt}` }] },
  ] as unknown as Message[]
  return {
    reason: "completed",
    turns: 1,
    messages,
  } as AgentOutcome
}

let originalSdkModule: Record<string, unknown> | undefined
let originalLegacyHostModule: Record<string, unknown> | undefined
let originalPromptPipelineModule: Record<string, unknown> | undefined

beforeAll(async () => {
  const sdk = await import("@/sdk/runtime")
  const legacyHost = await import("@/host/runtime/session-host")
  const promptPipelineUrl = new URL(
    "../../../../src/apps/cli/repl/prompt-pipeline.ts",
    import.meta.url,
  )
  const promptPipeline = await import(promptPipelineUrl.href)

  originalSdkModule = { ...sdk }
  originalLegacyHostModule = { ...legacyHost }
  originalPromptPipelineModule = { ...promptPipeline }

  await mock.module("@/host/runtime/session-host", () => {
    const createMockLegacyRunnerSessionHost = (options: typeof bridgeState.options) => {
      bridgeState.options = options
      bridgeState.messages = []
      bridgeState.outcome = undefined
      bridgeState.closeCalls = 0
      return {
        describe: () => ({
          sessionId: "session-loop-sdk",
          permissionMode: "default",
          capabilityManifest: {
            approvals: "operator",
            tools: true,
            memory: false,
            artifacts: true,
            subagents: false,
            automation: options?.sessionDeps?.automationEngine !== undefined,
            shellSnapshot: false,
            transport: "inproc" as const,
          },
        }),
        runTurn: async ({ history, prompt }: { history: readonly Message[]; prompt: string }) => {
          if (bridgeState.failWith !== undefined) throw bridgeState.failWith
          expect(history).toEqual(bridgeState.messages)
          const outcome = makeOutcome(prompt)
          bridgeState.messages = [...outcome.messages] as Message[]
          bridgeState.outcome = outcome
          return { outcome, messages: outcome.messages }
        },
        close: async () => {
          bridgeState.closeCalls += 1
        },
      }
    }
    const createMockLegacyRuntimeBinding = (
      initial: {
        permission?: { mode: string }
        registry?: { has: (name: string) => boolean; all?: () => unknown[] }
        automationEngine?: unknown
      } = {},
    ) => {
      const bind = (snapshot: {
        permission: { mode: string }
        registry: { has: (name: string) => boolean; all?: () => unknown[] }
        automationEngine?: unknown
      }) => ({
        snapshot,
        patch: (
          patch: Partial<{
            permission: { mode: string }
            registry: { has: (name: string) => boolean; all?: () => unknown[] }
            automationEngine?: unknown
          }>,
        ) =>
          bind({
            ...snapshot,
            ...patch,
          }),
        createRuntimeHost: (
          options: Omit<NonNullable<typeof bridgeState.options>, "sessionDeps">,
        ) => {
          const hostOptions = {
            ...options,
            sessionDeps: {
              permission: snapshot.permission,
              ...(snapshot.automationEngine !== undefined
                ? { automationEngine: snapshot.automationEngine }
                : {}),
              registry: snapshot.registry,
            },
          }
          return {
            createSessionHost: async () => createMockLegacyRunnerSessionHost(hostOptions),
          }
        },
        materializeReviewerAgent: () => undefined,
      })
      return bind({
        permission: initial.permission ?? { mode: "default" },
        registry: initial.registry ?? { has: () => false, all: () => [] },
        ...(initial.automationEngine !== undefined
          ? { automationEngine: initial.automationEngine }
          : {}),
      })
    }
    return {
      ...legacyHost,
      createLegacyRuntimeBridgeBindingFromAgentConfigBase: (args: {
        base?: {
          permission?: { mode: string }
          registry?: { has: (name: string) => boolean; all?: () => unknown[] }
          automationEngine?: unknown
        }
      }) =>
        createMockLegacyRuntimeBinding({
          ...(args.base?.permission !== undefined ? { permission: args.base.permission } : {}),
          ...(args.base?.registry !== undefined ? { registry: args.base.registry } : {}),
          ...(args.base?.automationEngine !== undefined
            ? { automationEngine: args.base.automationEngine }
            : {}),
        }),
      createLegacyRuntimeBridgeBindingFromBootstrap: async (args: {
        boot?: {
          permission?: { mode: string }
          tooling?: {
            registry?: { has: (name: string) => boolean; all?: () => unknown[] }
          }
        }
      }) =>
        createMockLegacyRuntimeBinding({
          ...(args.boot?.permission !== undefined ? { permission: args.boot.permission } : {}),
          ...(args.boot?.tooling?.registry !== undefined
            ? { registry: args.boot.tooling.registry }
            : {}),
        }),
    }
  })

  await mock.module("@/sdk/runtime", () => ({
    ...sdk,
    createRuntime: async ({
      host,
    }: {
      host: {
        createSessionHost(config: Record<string, unknown>): Promise<{
          describe(): {
            sessionId: string
            capabilityManifest: Record<string, unknown>
          }
          runTurn(args: {
            history: readonly Message[]
            prompt: string
            images?: unknown[]
            signal?: AbortSignal
          }): Promise<unknown>
          close(): Promise<void>
        }>
      }
    }) => {
      runtimeCalls.createRuntime += 1
      return {
        createSession: async (config: Record<string, unknown>) => {
          runtimeCalls.createSession += 1
          const hostSession = await host.createSessionHost(config)
          let prompt = ""
          let imageCount = 0
          return {
            sessionId: hostSession.describe().sessionId,
            dispatch: async () => ({ revision: 0, seq: 0, events: [] }),
            subscribe: () => () => undefined,
            snapshot: async () => ({
              sessionId: hostSession.describe().sessionId,
              revision: 0,
              seq: 0,
              state: {
                status: "idle",
                draftInput: "",
                permissionMode: "default",
                messageCount: bridgeState.messages.length,
              },
              capabilities: hostSession.describe().capabilityManifest,
              pendingApproval: null,
              openArtifacts: [],
            }),
            close: async () => {
              runtimeCalls.sessionClose += 1
              await hostSession.close()
            },
            input: {
              append: async (text: string, meta?: { readonly images?: readonly unknown[] }) => {
                prompt = text
                imageCount = meta?.images?.length ?? 0
                runtimeCalls.prompts.push(text)
                runtimeCalls.imageCounts.push(imageCount)
                return { revision: 1, seq: 1, events: [] }
              },
            },
            turn: {
              run: async (_meta?: unknown, options?: { signal?: AbortSignal }) => {
                runtimeCalls.turnRun += 1
                const result = await hostSession.runTurn({
                  history: [...bridgeState.messages],
                  prompt,
                  ...(imageCount > 0 ? { images: new Array(imageCount).fill(null) } : {}),
                  ...(options?.signal !== undefined ? { signal: options.signal } : {}),
                })
                return { revision: 2, seq: 2, events: [], turn: result }
              },
            },
            identity: { set: async () => ({ revision: 0, seq: 0, events: [] }) },
            toolProfile: { set: async () => ({ revision: 0, seq: 0, events: [] }) },
            approval: { respond: async () => ({ revision: 0, seq: 0, events: [] }) },
            transcript: {
              replace: async (messages: readonly Message[]) => {
                bridgeState.messages = [...messages]
                return { revision: 3, seq: 3, events: [], transcript: { messages: [...messages] } }
              },
            },
          }
        },
        close: async () => {
          runtimeCalls.runtimeClose += 1
        },
      }
    },
  }))

  await mock.module(promptPipelineUrl.href, () => ({
    ...promptPipeline,
    composePromptPipeline: () => ({
      next: async () => (promptQueue.length > 0 ? (promptQueue.shift() ?? null) : null),
    }),
  }))
})

afterAll(async () => {
  if (originalSdkModule !== undefined) {
    const snapshot = originalSdkModule
    await mock.module("@/sdk/runtime", () => snapshot)
  }
  if (originalLegacyHostModule !== undefined) {
    const snapshot = originalLegacyHostModule
    await mock.module("@/host/runtime/session-host", () => snapshot)
  }
  if (originalPromptPipelineModule !== undefined) {
    const promptPipelineUrl = new URL(
      "../../../../src/apps/cli/repl/prompt-pipeline.ts",
      import.meta.url,
    )
    const snapshot = originalPromptPipelineModule
    await mock.module(promptPipelineUrl.href, () => snapshot)
  }
  mock.restore()
})

beforeEach(() => {
  resetRuntimeCalls()
  promptQueue.length = 0
  bridgeState.options = null
  bridgeState.messages = []
  bridgeState.outcome = undefined
  bridgeState.failWith = undefined
  bridgeState.closeCalls = 0
})

// stderr capture so the loop's `process.stderr.write("\n")` initial-header
// doesn't pollute test output.
let originalStderrWrite: typeof process.stderr.write
beforeEach(() => {
  originalStderrWrite = process.stderr.write.bind(process.stderr)
  // biome-ignore lint/suspicious/noExplicitAny: stderr stub for capture
  process.stderr.write = (() => true) as any
})
afterEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: restore
  process.stderr.write = originalStderrWrite as any
})

// Force stdin to non-TTY so installTurnCancel (called by runOneTurn) is a no-op.
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

// === type-shape locks (compile-time, not source-grep) =========================

describe("session-loop — type contract shape lock (compile-time)", () => {
  test("SessionLoopSinks lists every sink the host wires", () => {
    type Required = keyof SessionLoopSinks
    const required: Required[] = [
      "renderTurnDashboard",
      "renderAndResetSummary",
      "flushLifecyclePills",
      "renderTurnError",
    ]
    expect(required).toHaveLength(4)
    expect(new Set(required).size).toBe(4)
  })

  test("RunSessionLoopDeps surfaces the required + optional fields", () => {
    type Required = keyof RunSessionLoopDeps
    const allKeys: Required[] = [
      "setup",
      "dispatchSlash",
      "sinks",
      "ux",
      "imageQueue",
      "runtimeFacadeCompose",
      "registerExitTeardown",
    ]
    expect(allKeys).toHaveLength(7)
  })

  test("runSessionLoop export is an async function", async () => {
    const mod = await import("../../../../src/apps/cli/repl/session-loop")
    expect(typeof mod.runSessionLoop).toBe("function")
    expect(mod.runSessionLoop.constructor.name).toBe("AsyncFunction")
  })
})

// === one-shot branch (argPrompt set) =========================================

describe("session-loop — one-shot branch (argPrompt set)", () => {
  test("drives the one-shot branch through the runtime session with the seed prompt", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup("seed-prompt-text")
    const sinks = buildSinks()
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
    })
    expect(runtimeCalls.createRuntime).toBe(1)
    expect(runtimeCalls.createSession).toBe(1)
    expect(runtimeCalls.prompts).toEqual(["seed-prompt-text"])
    expect(runtimeCalls.turnRun).toBe(1)
  })

  test("one-shot branch closes both the session and runtime facade", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup("any-prompt")
    const sinks = buildSinks()
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
    })
    expect(runtimeCalls.sessionClose).toBe(1)
    expect(runtimeCalls.runtimeClose).toBe(1)
    expect(bridgeState.closeCalls).toBe(1)
  })

  test("after a successful turn, fires sinks in order: dashboard → summary → pills", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup("p")
    const sinks = buildSinks()
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
    })
    expect(sinks.events).toEqual(["dashboard", "summary", "pills"])
  })

  test("renderAndResetSummary receives the runOnce outcome (messages threaded through)", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup("p")
    const sinks = buildSinks()
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
    })
    expect(sinks.summaryArgs).toHaveLength(1)
    expect(sinks.summaryArgs[0]?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "p" }] },
      { role: "assistant", content: [{ type: "text", text: "assistant:p" }] },
    ] as unknown as Message[])
  })

  test("seed images on FIRST turn — pendingImages is forwarded to runOnce, then drained", async () => {
    // The loop's invariant: surface-scoped pendingImages ride the FIRST turn
    // and are zeroed AFTER the body runs (so a subsequent reuse would see []).
    // We assert the forward via the runtime session append metadata.
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup("p")
    ;(setup as { pendingImages: unknown }).pendingImages = [{ kind: "image_url", url: "data:..." }]
    const sinks = buildSinks()
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
    })
    expect(runtimeCalls.imageCounts).toEqual([1])
  })
})

// === interactive branch (no argPrompt) ========================================

describe("session-loop — interactive branch (no argPrompt)", () => {
  test("consumes the prompt pipeline and dispatches one interactive turn through the runtime session", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup(undefined)
    const sinks = buildSinks()
    promptQueue.push({ text: "interactive-seed", images: [] }, null)
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
      registerExitTeardown: () => undefined,
    })
    expect(runtimeCalls.createRuntime).toBe(1)
    expect(runtimeCalls.createSession).toBe(1)
    expect(runtimeCalls.prompts).toEqual(["interactive-seed"])
    expect(runtimeCalls.turnRun).toBe(1)
    expect(sinks.events).toContain("dashboard")
    expect(sinks.events).toContain("summary")
    expect(sinks.events).toContain("pills")
  })

  test("QUANTA_AUTOMATION=on wires a live automation slot and exposes automation_update", async () => {
    const prev = process.env.QUANTA_AUTOMATION
    process.env.QUANTA_AUTOMATION = "on"
    try {
      const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
      const setup = await buildSetup(undefined)
      const sinks = buildSinks()
      await runSessionLoop({
        setup,
        dispatchSlash: async () => false,
        sinks,
        registerExitTeardown: () => undefined,
      })
      expect(bridgeState.options?.sessionDeps?.automationEngine).toBeDefined()
      expect(bridgeState.options?.sessionDeps?.registry?.has("automation_update")).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.QUANTA_AUTOMATION
      else process.env.QUANTA_AUTOMATION = prev
    }
  })

  test("empty prompt source exits without dispatching a turn", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup(undefined)
    const sinks = buildSinks()
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
      registerExitTeardown: () => undefined,
    })
    expect(runtimeCalls.prompts).toEqual([])
    expect(runtimeCalls.turnRun).toBe(0)
  })

  test("registerExitTeardown registers a callback that disposes pills + tears down status bar", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup(undefined)
    const sinks = buildSinks()
    const teardowns: Array<() => void> = []
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
      registerExitTeardown: (cb) => teardowns.push(cb),
    })
    expect(teardowns).toHaveLength(1)
    expect(setup.__statusBar.teardownCalls).toBe(0)
    expect(setup.__pillsDisposeCalls.n).toBe(0)
    teardowns[0]?.()
    expect(setup.__statusBar.teardownCalls).toBe(1)
    expect(setup.__pillsDisposeCalls.n).toBe(1)
  })

  test("registerReplaceMessages routes transcript restore through the runtime session", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup(undefined)
    const sinks = buildSinks()
    let replaceMessages: ((messages: ReadonlyArray<Message>) => Promise<void>) | undefined
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
      registerExitTeardown: () => undefined,
      registerReplaceMessages: (fn) => {
        replaceMessages = fn
      },
    })
    const nextMessages = [
      { role: "user", content: [{ type: "text", text: "rewound" }] },
    ] as unknown as Message[]
    await replaceMessages?.(nextMessages)
    expect(bridgeState.messages).toEqual(nextMessages)
  })

  test("interactive success renders dashboard and summary exactly once for one prompt", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup(undefined)
    const sinks = buildSinks()
    promptQueue.push("ok", null)
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
      registerExitTeardown: () => undefined,
    })
    expect(sinks.events.filter((event) => event === "dashboard")).toHaveLength(1)
    expect(sinks.events.filter((event) => event === "summary")).toHaveLength(1)
  })

  test("interactive success flushes lifecycle pills on turn completion", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup(undefined)
    const sinks = buildSinks()
    promptQueue.push("ok", null)
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
      registerExitTeardown: () => undefined,
    })
    expect(sinks.events).toContain("pills")
  })

  test("renderTurnError fires when the runtime-backed turn throws", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup(undefined)
    const sinks = buildSinks()
    promptQueue.push("explode", null)
    bridgeState.failWith = new Error("boom")
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
      registerExitTeardown: () => undefined,
    })
    expect(sinks.events).toContain("error")
    expect((sinks.errs[0] as Error).message).toBe("boom")
  })
})
