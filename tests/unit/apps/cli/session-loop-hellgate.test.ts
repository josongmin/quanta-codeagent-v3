import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import type { AgentOutcome } from "../../../../src/agent"
import type { IdleMonitor } from "../../../../src/apps/cli/idle-monitor"
import type { LifecyclePills } from "../../../../src/apps/cli/lifecycle-pills"
import type { RejectCounter } from "../../../../src/apps/cli/reject-counter"
import { createMidTurnApprovalChannel } from "../../../../src/apps/cli/repl/mid-turn-approval-channel"
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
import { capabilitiesFor, makeSnapshotLite } from "../../../support/session-fixtures"

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
  pillArgs: Array<{ readonly externalQueued: number } | undefined>
} => {
  const events: string[] = []
  const errs: unknown[] = []
  const summaryArgs: Array<{ messages: readonly Message[] }> = []
  const pillArgs: Array<{ readonly externalQueued: number } | undefined> = []
  return {
    events,
    errs,
    summaryArgs,
    pillArgs,
    renderTurnDashboard: () => events.push("dashboard"),
    renderAndResetSummary: (o) => {
      events.push("summary")
      summaryArgs.push(o)
    },
    flushLifecyclePills: (live) => {
      events.push("pills")
      pillArgs.push(live)
    },
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
            snapshot: async () =>
              makeSnapshotLite({
                sessionId: "session-loop-sdk",
                revision: 0,
                seq: 0,
                state: { messageCount: bridgeState.messages.length },
                capabilities: {
                  approvals: "operator",
                  tools: true,
                  artifacts: true,
                  automation: automationEngine !== undefined,
                },
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
              cancel: async () => ({ revision: 0, seq: 0, events: [] }),
            },
            identity: { set: async () => ({ revision: 0, seq: 0, events: [] }) },
            permission: { set: async () => ({ revision: 0, seq: 0, events: [] }) },
            toolProfile: { set: async () => ({ revision: 0, seq: 0, events: [] }) },
            approval: { respond: async () => ({ revision: 0, seq: 0, events: [] }) },
            transcript: {
              replace: async (messages: readonly Message[]) => {
                bridgeState.messages = [...messages]
                return { revision: 3, seq: 3, events: [], transcript: { messages: [...messages] } }
              },
              messages: () => bridgeState.messages,
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
    permissionModeState: () => undefined,
    stickyModelStore: () => undefined,
    dreamTrigger: () => undefined,
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
    // #17 (Agent-B, additive) — required brief store fake (mirrors effortStore).
    briefStore: { get: () => false, set: () => undefined, snapshot: () => false },
    llm: llmStub,
    planMode: false,
    providerRateLimitRemainingPercent: undefined,
    metrics: undefined as never,
    state: undefined as never,
    mcpClients: [],
    mcpTools: [],
    mcpSurface: undefined,
    skillsConfig: undefined as never,
    memoryStore: undefined,
    memoryEmbedder: undefined,
    // Pre-existing contract drift (fixed alongside WS-H): these four keys are
    // REQUIRED on SessionSetupResult; the loop never reads them, so inert
    // stubs keep the fixture honest with the type.
    projectsKbStore: undefined,
    mcpResourceCapture: undefined,
    // WS-G widened fields (audit R1 — fakes must track SessionSetupResult).
    mcpHealth: undefined,
    liveModelSource: { source: () => "test-model" },
    contextUsageHolder: undefined as never,
    permissionStore: undefined,
    // RFC-def `/undo` — durable hunk-mutation journal store; absent by default
    // (gate off) in the fixture. Required on SessionSetupResult.
    hunkUndoStore: undefined,
    // L5 M-11 — per-session search-wire teardown. The fixture leaves it
    // `undefined` (no wire built) by default; the dispose hellgates below
    // inject their own via the `searchPipelineDispose` deps slot.
    searchPipelineDispose: undefined,
    lifecyclePills: stubPills(),
    lifecycleTaskRegistry: undefined,
    lifecycleActivityStore: undefined as never,
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
    // WS-H / UUX-3-01 — capture tee absent by default (gate off) in the fixture.
    backgroundStreamCapture: undefined,
    approvalPrompt: async () => "approve" as const,
    midTurnApprovalChannel: createMidTurnApprovalChannel(),
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
    stderrIsTTY: false,
    homeDir: "/tmp",
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
          capabilityManifest: capabilitiesFor({
            approvals: "operator",
            tools: true,
            artifacts: true,
            automation: options?.sessionDeps?.automationEngine !== undefined,
          }),
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
            permission: { set: async () => ({ revision: 0, seq: 0, events: [] }) },
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
  test("SessionLoopSinks shape is locked EXHAUSTIVELY (add/drop/rename ⇒ tsc error)", () => {
    // An exhaustive mapped-type lock: a DROPPED/renamed key leaves a missing
    // property (tsc error), an ADDED key is an excess property (tsc error).
    // Unlike a subset array + toHaveLength(n), this catches drift in BOTH
    // directions for the whole interface — not just a renamed listed key.
    const _exhaustive = {
      renderTurnDashboard: true,
      renderAndResetSummary: true,
      flushLifecyclePills: true,
      renderTurnError: true,
    } satisfies Record<keyof SessionLoopSinks, true>
    // Touch the binding so the lock is not dead-code-eliminated by tooling.
    expect(Object.keys(_exhaustive).sort()).toEqual(
      (Object.keys(_exhaustive) as Array<keyof SessionLoopSinks>).sort(),
    )
  })

  test("RunSessionLoopDeps shape is locked EXHAUSTIVELY (add/drop/rename ⇒ tsc error)", () => {
    // Every top-level dep is enumerated; a missing/extra/renamed key is a
    // compile error here. Replaces the old subset array + toHaveLength(7),
    // which silently ignored the other 16 fields.
    const _exhaustive = {
      setup: true,
      dispatchSlash: true,
      sinks: true,
      ux: true,
      imageQueue: true,
      textInbox: true,
      seedPrompts: true,
      registerExitTeardown: true,
      convCheckpointWire: true,
      registerReplaceMessages: true,
      registerSessionSwitch: true,
      registerSideConversationStart: true,
      registerPlanQueueSendNow: true,
      registerAutomationSlash: true,
      runtimeFacadeCompose: true,
      playbookSeam: true,
      playbookCliFlag: true,
      searchPipelineDispose: true,
      notify: true,
      notifyCwdBasename: true,
      contextWarning: true,
      planQueueStore: true,
      objectiveStore: true,
      inTurnStdin: true,
      conversationActions: true,
      inboundMode: true,
      backgroundPortal: true,
    } satisfies Record<keyof RunSessionLoopDeps, true>
    expect(_exhaustive.setup).toBe(true)
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
    // UUX-6-23 — the loop threads its LIVE externalPromptQueue count into the
    // flush so the follow-up pill can count mid-turn-queued prompts (nothing
    // queued in this scenario ⇒ 0, but the wire itself must be present).
    expect(sinks.pillArgs).toEqual([{ externalQueued: 0 }])
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
    // UUX-6-23 — the interactive flush carries the live external-queue count too.
    expect(sinks.pillArgs).toEqual([{ externalQueued: 0 }])
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

// === L5 M-11 — per-session search-wire dispose THREADING ======================

/**
 * T06 threading hellgate: the search-wire teardown is now wired PER-SESSION
 * onto the loop's close stack (it replaced the module-singleton
 * `disposeActiveSearchPipeline()`). These proofs assert the multi-session
 * correctness the singleton could NOT give:
 *
 *   - THREAD-1: session close calls THE session's own `searchPipelineDispose`
 *     exactly once (the disposer the host threaded in for THIS session).
 *   - THREAD-2: two sessions each running their OWN loop dispose their OWN
 *     wire — never each other's. The singleton kept ONE `activeWire`, so the
 *     second session's build silently disposed the first's interval; threading
 *     makes the two teardowns independent.
 *   - THREAD-3: absent slot ⇒ nothing to dispose (default-OFF byte-identical;
 *     no throw when no wire was built — kill-switch / lexical-only path).
 *   - THREAD-4: a throwing disposer is surfaced, NOT rethrown — one leaky
 *     teardown cannot abort the rest of the close stack (session/runtimeFacade
 *     still close).
 */
describe("session-loop — search-wire dispose threading (L5 M-11)", () => {
  test("THREAD-1: one-shot session close calls THIS session's searchPipelineDispose once", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup("seed")
    const sinks = buildSinks()
    let disposeCalls = 0
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
      searchPipelineDispose: () => {
        disposeCalls += 1
      },
    })
    // The close stack drains exactly once on one-shot completion ⇒ THIS
    // session's wire dispose fires exactly once (interval cleared).
    expect(disposeCalls).toBe(1)
    // And it is part of the SAME teardown that closes session + facade.
    expect(runtimeCalls.sessionClose).toBe(1)
    expect(runtimeCalls.runtimeClose).toBe(1)
  })

  test("THREAD-1b: interactive session close calls searchPipelineDispose once", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup(undefined)
    const sinks = buildSinks()
    promptQueue.push("ok", null)
    let disposeCalls = 0
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
      registerExitTeardown: () => undefined,
      searchPipelineDispose: () => {
        disposeCalls += 1
      },
    })
    expect(disposeCalls).toBe(1)
  })

  test("THREAD-2: two sessions dispose their OWN wire (not each other's)", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    // Two independent wires (e.g. two concurrent surfaces / a re-entered REPL).
    let wireADisposed = 0
    let wireBDisposed = 0

    const setupA = await buildSetup("session-A-seed")
    const sinksA = buildSinks()
    await runSessionLoop({
      setup: setupA,
      dispatchSlash: async () => false,
      sinks: sinksA,
      searchPipelineDispose: () => {
        wireADisposed += 1
      },
    })
    // After session A closes, ITS wire is disposed and B's is untouched.
    expect(wireADisposed).toBe(1)
    expect(wireBDisposed).toBe(0)

    const setupB = await buildSetup("session-B-seed")
    const sinksB = buildSinks()
    await runSessionLoop({
      setup: setupB,
      dispatchSlash: async () => false,
      sinks: sinksB,
      searchPipelineDispose: () => {
        wireBDisposed += 1
      },
    })
    // Session B's close disposed B's wire exactly once; A's stayed at 1 (B did
    // NOT redispose A, and A's build did NOT pre-dispose B — the singleton's
    // failure mode). Each session owns exactly one teardown of its own wire.
    expect(wireBDisposed).toBe(1)
    expect(wireADisposed).toBe(1)
  })

  test("THREAD-3: absent searchPipelineDispose ⇒ no throw, session still closes", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup("seed")
    const sinks = buildSinks()
    await expect(
      runSessionLoop({
        setup,
        dispatchSlash: async () => false,
        sinks,
        // searchPipelineDispose omitted (kill-switch / lexical-only path)
      }),
    ).resolves.toBeUndefined()
    expect(runtimeCalls.sessionClose).toBe(1)
  })

  test("THREAD-4: a throwing dispose is surfaced, not rethrown; facade still closes", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup("seed")
    const sinks = buildSinks()
    // The close stack surfaces (warns) disposer failures so one leaky teardown
    // cannot mask the others — the loop must NOT reject.
    await expect(
      runSessionLoop({
        setup,
        dispatchSlash: async () => false,
        sinks,
        searchPipelineDispose: () => {
          throw new Error("interval-clear-failed")
        },
      }),
    ).resolves.toBeUndefined()
    // Session + facade close ran despite the throwing search dispose.
    expect(runtimeCalls.sessionClose).toBe(1)
    expect(runtimeCalls.runtimeClose).toBe(1)
  })
})

// === #8 last-mile (jun-6) — CONCURRENT in-turn keystroke SOURCE wiring =========

/**
 * These hellgates seal the SOURCE half wired into the session loop: while a turn
 * is in flight, the loop runs a concurrent `in-turn-reader` over the INJECTED
 * stdin (default-OFF) and routes each completed line to
 * `captureLine(line, currentTurnIndex)` ⇒ the plan-queue + the turn-boundary
 * `externalPromptQueue` drain.
 *
 *   ON-1:  knob ON + a line typed during the turn ⇒ it lands on the plan-queue
 *          tagged with the in-flight turn index AND drains as the next prompt.
 *   ON-2:  multiple lines during one turn ⇒ all captured in order.
 *   OFF-1: knob OFF ⇒ the reader is NEVER started (no listener attached, no
 *          resume) ⇒ stdin stays detached, byte-identical to today.
 *   LIFE-1: the reader is DISPOSED after the turn (listener detached, prior
 *          paused state restored) — even when the turn THROWS.
 */

/** A fake stdin for the loop's `inTurnStdin` slot. It emits a queued line on
 *  `resume()` — which the in-turn reader calls right after attaching its `data`
 *  listener — so the line is delivered WHILE the reader is alive (i.e. during the
 *  turn). Tracks listener count + raw/pause calls so we can prove lifecycle. */
const makeLoopFakeStdin = (opts: {
  isTTY?: boolean
  emitOnResume?: readonly string[]
}): import("../../../../src/apps/cli/repl/in-turn-reader").InTurnReaderStdin & {
  listenerCount(): number
  rawCalls: boolean[]
  resumeCalls: number
  pauseCalls: number
} => {
  const listeners: Array<(chunk: Buffer | string) => void> = []
  const rawCalls: boolean[] = []
  let isRaw = false
  let paused = true
  const queue = [...(opts.emitOnResume ?? [])]
  const fake = {
    isTTY: opts.isTTY ?? false,
    get isRaw() {
      return isRaw
    },
    isPaused: () => paused,
    rawCalls,
    resumeCalls: 0,
    pauseCalls: 0,
    setRawMode: (mode: boolean) => {
      isRaw = mode
      rawCalls.push(mode)
      return fake
    },
    on: (_event: "data", listener: (chunk: Buffer | string) => void) => {
      listeners.push(listener)
      return fake
    },
    removeListener: (_event: "data", listener: (chunk: Buffer | string) => void) => {
      const idx = listeners.indexOf(listener)
      if (idx >= 0) listeners.splice(idx, 1)
      return fake
    },
    resume: () => {
      paused = false
      fake.resumeCalls += 1
      // Deliver the queued lines NOW — the reader has just attached its listener.
      const pending = queue.splice(0, queue.length)
      for (const chunk of pending) for (const l of [...listeners]) l(chunk)
      return fake
    },
    pause: () => {
      paused = true
      fake.pauseCalls += 1
      return fake
    },
    listenerCount: () => listeners.length,
  }
  return fake
}

describe("session-loop — in-turn keystroke SOURCE wiring (#8)", () => {
  const KNOB = "QUANTA_MIDTURN_CAPTURE"
  let prevKnob: string | undefined
  let resetRuntimeConfig: () => void
  let defaultPlanQueueStore: typeof import("@/agent/plan-queue").defaultPlanQueueStore

  beforeAll(async () => {
    ;({ __resetRuntimeConfig: resetRuntimeConfig } = await import("@/shared/runtime-config"))
    ;({ defaultPlanQueueStore } = await import("@/agent/plan-queue"))
  })
  beforeEach(() => {
    prevKnob = process.env[KNOB]
  })
  afterEach(() => {
    if (prevKnob === undefined) delete process.env[KNOB]
    else process.env[KNOB] = prevKnob
    resetRuntimeConfig()
  })

  test("ON-1: a line typed during the turn lands on the plan-queue with the turn index + drains next turn", async () => {
    process.env[KNOB] = "1"
    resetRuntimeConfig()
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup(undefined)
    const sinks = buildSinks()
    const planQueue = defaultPlanQueueStore()
    const stdin = makeLoopFakeStdin({ emitOnResume: ["please also lint the repo\n"] })
    // One interactive turn, then end.
    promptQueue.push("do the work", null)
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
      registerExitTeardown: () => undefined,
      planQueueStore: planQueue,
      inTurnStdin: stdin,
    })
    // The captured line is on THIS thread's plan-queue partition, tagged with
    // the in-flight turn index (1 — the first turn).
    const snap = planQueue.peek(setup.sessionId as string)
    expect(snap).toHaveLength(1)
    expect(snap[0]?.text).toBe("please also lint the repo")
    expect(snap[0]?.arrivedDuringTurn).toBe(1)
    expect(snap[0]?.source).toBe("user_keystroke")
    // The reader resumed the stream (it was consumed during the turn).
    expect(stdin.resumeCalls).toBeGreaterThanOrEqual(1)
  })

  // MID-TURN FIX — when an approval is PENDING, the in-turn line is its answer:
  // it resolves the prompt and does NOT land on the plan-queue as a follow-up.
  test("APPROVAL: a line typed during the turn resolves a pending approval (not queued)", async () => {
    process.env[KNOB] = "1"
    resetRuntimeConfig()
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup(undefined)
    const sinks = buildSinks()
    const planQueue = defaultPlanQueueStore()
    const stdin = makeLoopFakeStdin({ emitOnResume: ["y\n"] })
    // Simulate a mid-turn approval waiting for input (as buildCliApprovalPrompt
    // does once `active`). It is registered before the line arrives.
    const answer = setup.midTurnApprovalChannel.awaitLine()
    promptQueue.push("do the work", null)
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
      registerExitTeardown: () => undefined,
      planQueueStore: planQueue,
      inTurnStdin: stdin,
    })
    // WS-A (jul-10) — the channel resolves a TYPED line result now.
    expect(await answer).toEqual({ kind: "line", line: "y" }) // routed to the approval
    expect(planQueue.peek(setup.sessionId as string)).toHaveLength(0) // NOT queued
  })

  test("ON-2: multiple lines during one turn ⇒ all captured in order", async () => {
    process.env[KNOB] = "1"
    resetRuntimeConfig()
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup(undefined)
    const sinks = buildSinks()
    const planQueue = defaultPlanQueueStore()
    const stdin = makeLoopFakeStdin({ emitOnResume: ["first\n", "second\nthird\n"] })
    promptQueue.push("go", null)
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
      registerExitTeardown: () => undefined,
      planQueueStore: planQueue,
      inTurnStdin: stdin,
    })
    const snap = planQueue.peek(setup.sessionId as string)
    expect(snap.map((e) => e.text)).toEqual(["first", "second", "third"])
  })

  test("OFF-1: knob OFF ⇒ reader NEVER starts (no listener, no resume) — byte-identical", async () => {
    delete process.env[KNOB]
    resetRuntimeConfig()
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup(undefined)
    const sinks = buildSinks()
    const planQueue = defaultPlanQueueStore()
    const stdin = makeLoopFakeStdin({ emitOnResume: ["should never be read\n"] })
    promptQueue.push("go", null)
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
      registerExitTeardown: () => undefined,
      planQueueStore: planQueue,
      inTurnStdin: stdin,
    })
    // No reader was ever attached ⇒ no listener, no resume, nothing captured.
    expect(stdin.listenerCount()).toBe(0)
    expect(stdin.resumeCalls).toBe(0)
    expect(planQueue.peek(setup.sessionId as string)).toEqual([])
  })

  test("OFF-2: knob ON but no stdin injected ⇒ no reader (the loop short-circuits)", async () => {
    process.env[KNOB] = "1"
    resetRuntimeConfig()
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup(undefined)
    const sinks = buildSinks()
    const planQueue = defaultPlanQueueStore()
    promptQueue.push("go", null)
    // inTurnStdin omitted ⇒ withInTurnCapture is a pure passthrough.
    await expect(
      runSessionLoop({
        setup,
        dispatchSlash: async () => false,
        sinks,
        registerExitTeardown: () => undefined,
        planQueueStore: planQueue,
      }),
    ).resolves.toBeUndefined()
    expect(planQueue.peek(setup.sessionId as string)).toEqual([])
  })

  test("LIFE-1: the in-turn reader is disposed after the turn — even when the turn THROWS", async () => {
    process.env[KNOB] = "1"
    resetRuntimeConfig()
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup(undefined)
    const sinks = buildSinks()
    const planQueue = defaultPlanQueueStore()
    const stdin = makeLoopFakeStdin({ emitOnResume: ["typed before the crash\n"] })
    promptQueue.push("explode", null)
    bridgeState.failWith = new Error("turn boom")
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
      registerExitTeardown: () => undefined,
      planQueueStore: planQueue,
      inTurnStdin: stdin,
    })
    // The turn threw (surfaced via renderTurnError) — but the reader's finally
    // still ran: listener detached (no leak) + prior paused state restored.
    expect(sinks.events).toContain("error")
    expect(stdin.listenerCount()).toBe(0)
    expect(stdin.pauseCalls).toBeGreaterThanOrEqual(1)
    // The line typed before the crash was still captured (reader was alive).
    expect(planQueue.peek(setup.sessionId as string).map((e) => e.text)).toEqual([
      "typed before the crash",
    ])
  })
})

// ALBB-18 (1) — the abort branch (`session-loop.ts`) must route through the
// SSOT classifier so an aborted turn records `lastTurnOutcome === "partial"`
// (NOT the hardcoded `"fail"` it used before). `lastTurnOutcome` is a private
// loop var; we observe it through its ONLY consumer seam — the closure
// `() => lastTurnOutcome` handed to `buildAutorunEligibility`. Mocking that
// factory captures the live getter; forcing `runOneTurn` to report an aborted
// turn drives the branch. Reverting the fix to `"fail"` turns this red.
describe("session-loop — ALBB-18 abort branch routes through SSOT (partial, not fail)", () => {
  let originalTurnRunner: Record<string, unknown> | undefined
  let originalPermission: Record<string, unknown> | undefined
  // Set by the captured `buildAutorunEligibility` getter argument.
  let capturedOutcomeGetter: (() => string | undefined) | undefined

  const turnRunnerUrl = new URL("../../../../src/apps/cli/repl/turn-runner.ts", import.meta.url)

  beforeAll(async () => {
    const turnRunner = await import(turnRunnerUrl.href)
    const permission = await import("@/permission")
    originalTurnRunner = { ...turnRunner }
    originalPermission = { ...permission }

    await mock.module(turnRunnerUrl.href, () => ({
      ...turnRunner,
      // Force a single ABORTED turn: `turnAborted: true`, `result: undefined`.
      // Fire `onAfterResult`? No — an aborted turn has no result, matching the
      // real branch precondition (`out.result === undefined` too).
      runOneTurn: async () => ({ result: undefined, turnAborted: true }),
    }))
    await mock.module("@/permission", () => ({
      ...permission,
      buildAutorunEligibility: (_env: unknown, getOutcome: () => string | undefined) => {
        capturedOutcomeGetter = getOutcome
        // Return undefined ⇒ "no opinion" ⇒ byte-identical to no resolver.
        return undefined
      },
    }))
  })

  afterAll(async () => {
    if (originalTurnRunner !== undefined) {
      const snapshot = originalTurnRunner
      await mock.module(turnRunnerUrl.href, () => snapshot)
    }
    if (originalPermission !== undefined) {
      const snapshot = originalPermission
      await mock.module("@/permission", () => snapshot)
    }
  })

  beforeEach(() => {
    capturedOutcomeGetter = undefined
  })

  test("aborted turn ⇒ lastTurnOutcome === 'partial' (SSOT), not 'fail'", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = await buildSetup(undefined)
    const sinks = buildSinks()
    // One interactive turn, then the prompt source ends.
    promptQueue.push("do the work", null)
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
      registerExitTeardown: () => undefined,
    })
    // The eligibility getter was captured at loop start and closes over the
    // mutable `lastTurnOutcome`; reading it post-loop reflects the aborted turn.
    expect(capturedOutcomeGetter).toBeDefined()
    expect(capturedOutcomeGetter?.()).toBe("partial")
    // Guard against the pre-fix regression explicitly.
    expect(capturedOutcomeGetter?.()).not.toBe("fail")
  })
})
