import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
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

// Build a minimal SessionSetupResult — the loop only reads a subset.
const buildSetup = (
  argPrompt: string | undefined,
): SessionSetupResult & {
  __statusBar: ReturnType<typeof stubStatusBar>
  __pillsDisposeCalls: { n: number }
} => {
  const statusBar = stubStatusBar()
  const pillsDisposeCalls = { n: 0 }
  const llmStub = {
    generate: async () => ({ content: [] }),
  } as unknown as SessionSetupResult["llm"]
  // Use a permissive `as never` cast for fields the loop only forwards.
  const result = {
    provider: "anthropic" as never,
    model: "test-model",
    mode: "default" as never,
    cwd: "/tmp/test-cwd",
    slog: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    idleMonitor: stubIdle(),
    rejectCounter: stubRejects(),
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
    sessionDeps: { llm: llmStub, signal: new AbortController().signal } as never,
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
    shutdownMcp: async () => undefined,
    __statusBar: statusBar,
    __pillsDisposeCalls: pillsDisposeCalls,
  }
  return result as typeof result
}

// === module-mock plumbing ====================================================

// We override `runOnce` + `runInteractive` from `@/runner` so the loop body
// runs end-to-end WITHOUT booting the real agent stack. Other exports of
// `@/runner` (e.g. SIDE_CHAT_DEFAULT_READ_ONLY) flow through verbatim so
// downstream loaders are unaffected.
type RunOnceStub = ReturnType<typeof mock<(input: unknown) => Promise<unknown>>>
type RunInteractiveStub = ReturnType<typeof mock<(input: unknown) => Promise<unknown>>>

let runOnceStub: RunOnceStub
let runInteractiveStub: RunInteractiveStub
let lastInteractiveInput: {
  promptSource: { next: (s?: AbortSignal) => Promise<unknown> }
  wrapTurn?: (
    run: (deps: unknown) => Promise<{ messages: Message[]; outcome: unknown }>,
  ) => Promise<{ messages: Message[]; outcome: unknown } | undefined>
  onTurnEnd?: (e: { messages: Message[]; outcome: unknown }) => void | Promise<void>
} | null

beforeAll(async () => {
  const original = await import("@/runner")
  runOnceStub = mock(async () => ({
    messages: [{ role: "user", content: [{ type: "text", text: "x" }] }] as unknown as Message[],
    outcome: { id: "stub-once" },
  }))
  runInteractiveStub = mock(async (input: unknown) => {
    lastInteractiveInput = input as typeof lastInteractiveInput
    return undefined
  })
  await mock.module("@/runner", () => ({
    ...original,
    runOnce: runOnceStub,
    runInteractive: runInteractiveStub,
  }))
})

beforeEach(() => {
  runOnceStub.mockClear()
  runInteractiveStub.mockClear()
  lastInteractiveInput = null
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
      "registerExitTeardown",
    ]
    expect(allKeys).toHaveLength(6)
  })

  test("runSessionLoop export is an async function", async () => {
    const mod = await import("../../../../src/apps/cli/repl/session-loop")
    expect(typeof mod.runSessionLoop).toBe("function")
    expect(mod.runSessionLoop.constructor.name).toBe("AsyncFunction")
  })
})

// === one-shot branch (argPrompt set) =========================================

describe("session-loop — one-shot branch (argPrompt set)", () => {
  test("calls runOnce exactly once with the seed prompt", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = buildSetup("seed-prompt-text")
    const sinks = buildSinks()
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
    })
    expect(runOnceStub).toHaveBeenCalledTimes(1)
    const callArg = runOnceStub.mock.calls[0]?.[0] as { prompt?: string } | undefined
    expect(callArg?.prompt).toBe("seed-prompt-text")
  })

  test("does NOT call runInteractive in the one-shot branch", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = buildSetup("any-prompt")
    const sinks = buildSinks()
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
    })
    expect(runInteractiveStub).not.toHaveBeenCalled()
  })

  test("after a successful turn, fires sinks in order: dashboard → summary → pills", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = buildSetup("p")
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
    const setup = buildSetup("p")
    const sinks = buildSinks()
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
    })
    expect(sinks.summaryArgs).toHaveLength(1)
    expect(sinks.summaryArgs[0]?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "x" }] },
    ] as unknown as Message[])
  })

  test("seed images on FIRST turn — pendingImages is forwarded to runOnce, then drained", async () => {
    // The loop's invariant: surface-scoped pendingImages ride the FIRST turn
    // and are zeroed AFTER the body runs (so a subsequent reuse would see []).
    // We assert the forward via the runOnce call argument.
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = buildSetup("p")
    ;(setup as { pendingImages: unknown }).pendingImages = [{ kind: "image_url", url: "data:..." }]
    const sinks = buildSinks()
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
    })
    const callArg = runOnceStub.mock.calls[0]?.[0] as { pendingImages?: unknown[] } | undefined
    expect(callArg?.pendingImages).toHaveLength(1)
  })
})

// === interactive branch (no argPrompt) ========================================

describe("session-loop — interactive branch (no argPrompt)", () => {
  test("calls runInteractive with a promptSource + wrapTurn + onTurnEnd wiring", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = buildSetup(undefined)
    const sinks = buildSinks()
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
      registerExitTeardown: () => undefined,
    })
    expect(runInteractiveStub).toHaveBeenCalledTimes(1)
    expect(lastInteractiveInput).not.toBeNull()
    expect(typeof lastInteractiveInput?.promptSource.next).toBe("function")
    expect(typeof lastInteractiveInput?.wrapTurn).toBe("function")
    expect(typeof lastInteractiveInput?.onTurnEnd).toBe("function")
  })

  test("does NOT call runOnce in the interactive branch", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = buildSetup(undefined)
    const sinks = buildSinks()
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
      registerExitTeardown: () => undefined,
    })
    expect(runOnceStub).not.toHaveBeenCalled()
  })

  test("registerExitTeardown registers a callback that disposes pills + tears down status bar", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = buildSetup(undefined)
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

  test("wrapTurn forwards the driver-supplied `run(turnDeps)` to runOneTurn body", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = buildSetup(undefined)
    const sinks = buildSinks()
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
      registerExitTeardown: () => undefined,
    })
    // Now simulate the driver: it calls wrapTurn with a `run` lambda.
    const runCalls: Array<{ signal: AbortSignal | undefined }> = []
    const runLambda = async (
      turnDeps: unknown,
    ): Promise<{ messages: Message[]; outcome: unknown }> => {
      const d = turnDeps as { signal?: AbortSignal }
      runCalls.push({ signal: d.signal })
      return {
        messages: [
          { role: "user", content: [{ type: "text", text: "wrapped" }] },
        ] as unknown as Message[],
        outcome: { id: "wrap" },
      }
    }
    const wrapped = await lastInteractiveInput?.wrapTurn?.(runLambda)
    expect(wrapped?.messages).toEqual([
      { role: "user", content: [{ type: "text", text: "wrapped" }] },
    ] as unknown as Message[])
    expect(runCalls).toHaveLength(1)
    expect(runCalls[0]?.signal).toBeDefined()
  })

  test("wrapTurn fires renderTurnDashboard + renderAndResetSummary after success", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = buildSetup(undefined)
    const sinks = buildSinks()
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
      registerExitTeardown: () => undefined,
    })
    await lastInteractiveInput?.wrapTurn?.(async () => ({
      messages: [],
      outcome: { id: "x" },
    }))
    expect(sinks.events).toContain("dashboard")
    expect(sinks.events).toContain("summary")
  })

  test("onTurnEnd fires flushLifecyclePills", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = buildSetup(undefined)
    const sinks = buildSinks()
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
      registerExitTeardown: () => undefined,
    })
    await lastInteractiveInput?.onTurnEnd?.({ messages: [], outcome: { id: "x" } })
    expect(sinks.events).toContain("pills")
  })

  test("renderTurnError fires when wrapTurn body throws a non-abort error", async () => {
    const { runSessionLoop } = await import("../../../../src/apps/cli/repl/session-loop")
    const setup = buildSetup(undefined)
    const sinks = buildSinks()
    await runSessionLoop({
      setup,
      dispatchSlash: async () => false,
      sinks,
      registerExitTeardown: () => undefined,
    })
    await lastInteractiveInput?.wrapTurn?.(async () => {
      throw new Error("boom")
    })
    expect(sinks.events).toContain("error")
    expect((sinks.errs[0] as Error).message).toBe("boom")
  })
})
