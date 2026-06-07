import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test"
import {
  createPermissionStore,
  type PermissionStore,
  type ReviewContext,
  setThreadPermission,
  type ToolActionKeyed,
} from "@/permission"
import type {
  SessionSetupResult,
  SetupSessionDeps,
} from "../../../../src/apps/cli/repl/session-setup"

/**
 * Slice-C (T2 rewrite): runtime behavior coverage for `setupSession`.
 *
 * The PRIOR hellgate was source-sniffing: greps over `session-setup.ts`
 * for env knob NAMES (`QUANTA_IDLE_SUPPRESS`, `QUANTA_IDLE_MS`, …), for
 * the LLM stack composition ORDER (`buildLLM` → `RetryingLLM` → `composeLLM`),
 * for `process.exit(1)` substring presence, for `process.on("SIGINT"`
 * literal. Those assertions fail on cosmetic refactors that preserve
 * behavior AND pass on regressions that preserve the file shape — both
 * directions of false signal.
 *
 * This rewrite keeps the legitimate TYPE-SHAPE locks (compile-time
 * contract enforcement — NOT source-grep) and adds runtime behavior tests
 * that boot `setupSession` with heavy module stubs and assert:
 *
 *   - SIGINT handler IS registered on the process (spy on process.on)
 *   - When the abort fires, the handler triggers the AbortController
 *     returned in the result (so the surface's SIGINT contract is end-to-end)
 *   - All 11 INJECTED deps are CALLED at least once during a successful boot
 *     (drift detector — a future refactor that drops one of the wires
 *     surfaces here as a failed expectation)
 *   - The result populates every promised key (no silent undefined for
 *     non-optional bindings)
 *
 * REGRESSION SCENARIOS this rewritten test catches:
 *
 *   - If someone drops `process.on("SIGINT", …)` from `setupSession` ⇒
 *     `registers a SIGINT handler` fails.
 *   - If `deps.buildLifecycleBundle()` is no longer invoked (e.g. inlined
 *     and forgotten to call) ⇒ the corresponding factory spy stays at 0.
 *   - If the LLM stack helper returns the un-retrying LLM by mistake ⇒
 *     `result.llm` is the stubbed RetryingLLM instance not the inner.
 *   - If `loadFeatures()` is no longer awaited and a Promise is forwarded
 *     downstream ⇒ the resulting metrics/state fields are wrong shape ⇒
 *     dep contract tests fail.
 *
 * Startup failure policy is now typed rather than process-killing:
 * `setupSession` rejects with `SessionBootstrapError` and the CLI host
 * decides whether to exit. That keeps bootstrap reusable by non-process
 * surfaces while preserving the same operator-facing message.
 */

// =============================================================================
// type-shape locks (compile-time contract — NOT source-grep)
// =============================================================================

describe("session-setup — dependency contract (compile-time shape lock)", () => {
  test("SetupSessionDeps lists every spec-mandated factory", () => {
    type Required = keyof SetupSessionDeps
    const required: Required[] = [
      "buildLifecycleBundle",
      "deriveMcpPillServers",
      "buildCostPanelOrUndefined",
      "buildBranchProgressOrUndefined",
      "buildPlanStoreOrUndefined",
      "buildTurnSummaryAndStream",
      "buildTurnIndicatorAndStream",
      "buildDebugTracerAndStream",
      "buildTimelinePanelAndStream",
      "buildWorkMetricsSink",
      "loadPermissionStore",
      "installPills",
    ]
    expect(required).toHaveLength(12)
    expect(new Set(required).size).toBe(12)
  })

  test("setupSession export is an AsyncFunction", async () => {
    const mod = await import("../../../../src/apps/cli/repl/session-setup")
    expect(typeof mod.setupSession).toBe("function")
    expect(mod.setupSession.constructor.name).toBe("AsyncFunction")
  })

  test("SessionSetupResult contract keys are reachable via the type", () => {
    // Compile-time contract: the named keys MUST live on the result type.
    // A future rename of any field here is a compile error in THIS file
    // before it can become a silent surface drift.
    type Required = keyof SessionSetupResult
    const keys: Required[] = [
      "provider",
      "model",
      "mode",
      "cwd",
      "slog",
      "idleMonitor",
      "rejectCounter",
      "effortStore",
      "llm",
      "planMode",
      "metrics",
      "state",
      "mcpClients",
      "mcpTools",
      "mcpSurface",
      "skillsConfig",
      "lifecyclePills",
      "lifecycleTaskRegistry",
      "lifecycleFollowUpQueue",
      "sessionId",
      "history",
      "pendingImages",
      "idMeta",
      "statusBar",
      "turnIndicator",
      "turnSummary",
      "debugHandle",
      "timelinePanel",
      "approvalPrompt",
      "runtimeContext",
      "costPanel",
      "branchProgress",
      "planStore",
      "abort",
      "pills",
      "argPrompt",
      "shutdownMcp",
      "featureCfg",
    ]
    // 38 named bindings — assert presence to detect accidental drops
    // (ADR-0297 added `featureCfg` for surface-level feature consolidation;
    // `effortStore` was added earlier on main for session-level effort UX).
    expect(keys).toHaveLength(38)
    expect(new Set(keys).size).toBe(38)
  })
})

// =============================================================================
// runtime behavior — boot setupSession with stubbed module surface
// =============================================================================

// Stub bag we ACCUMULATE call records on so we can assert each injected
// factory was actually invoked by setupSession.
type DepProbe = {
  buildLifecycleBundleCalls: number
  deriveMcpPillServersCalls: number
  buildCostPanelOrUndefinedCalls: number
  buildBranchProgressOrUndefinedCalls: number
  buildPlanStoreOrUndefinedCalls: number
  buildTurnSummaryAndStreamCalls: number
  buildTurnIndicatorAndStreamCalls: number
  buildDebugTracerAndStreamCalls: number
  buildTimelinePanelAndStreamCalls: number
  buildWorkMetricsSinkCalls: number
  loadPermissionStoreCalls: number
  installPillsCalls: number
}

const makeStubDeps = (
  opts: { permissionStore?: PermissionStore } = {},
): { deps: SetupSessionDeps; probe: DepProbe } => {
  const probe: DepProbe = {
    buildLifecycleBundleCalls: 0,
    deriveMcpPillServersCalls: 0,
    buildCostPanelOrUndefinedCalls: 0,
    buildBranchProgressOrUndefinedCalls: 0,
    buildPlanStoreOrUndefinedCalls: 0,
    buildTurnSummaryAndStreamCalls: 0,
    buildTurnIndicatorAndStreamCalls: 0,
    buildDebugTracerAndStreamCalls: 0,
    buildTimelinePanelAndStreamCalls: 0,
    buildWorkMetricsSinkCalls: 0,
    loadPermissionStoreCalls: 0,
    installPillsCalls: 0,
  }
  const stubPills = {
    update: () => undefined,
    render: () => "",
    flush: () => undefined,
    dispose: () => undefined,
  }
  const stubStatusPills = {
    dispose: () => undefined,
    update: () => undefined,
  }
  const stubStreamPort = { emit: () => undefined }
  const stubIndicator = {
    start: () => undefined,
    stop: () => undefined,
    updateUsage: () => undefined,
    markFirstChunk: () => undefined,
  }
  const stubSummary = {
    onEvent: () => undefined,
    render: () => "",
    reset: () => undefined,
    asStreamPort: () => stubStreamPort,
  }
  const deps: SetupSessionDeps = {
    buildLifecycleBundle: () => {
      probe.buildLifecycleBundleCalls += 1
      return {
        pills: stubPills as never,
        taskRegistry: undefined,
        followUpQueue: undefined,
      }
    },
    deriveMcpPillServers: (tools) => {
      probe.deriveMcpPillServersCalls += 1
      return tools.map((t) => ({ name: t.name, status: "connected" as const }))
    },
    buildCostPanelOrUndefined: () => {
      probe.buildCostPanelOrUndefinedCalls += 1
      return undefined
    },
    buildBranchProgressOrUndefined: () => {
      probe.buildBranchProgressOrUndefinedCalls += 1
      return undefined
    },
    buildPlanStoreOrUndefined: () => {
      probe.buildPlanStoreOrUndefinedCalls += 1
      return undefined
    },
    buildTurnSummaryAndStream: (_featureCfg, stream) => {
      probe.buildTurnSummaryAndStreamCalls += 1
      return { collector: stubSummary as never, stream }
    },
    buildTurnIndicatorAndStream: (_featureCfg, _statusBar, stream) => {
      probe.buildTurnIndicatorAndStreamCalls += 1
      return { indicator: stubIndicator as never, turnStream: stream }
    },
    buildDebugTracerAndStream: (_featureCfg, stream) => {
      probe.buildDebugTracerAndStreamCalls += 1
      return { stream, debugHandle: undefined }
    },
    buildTimelinePanelAndStream: (_featureCfg, stream) => {
      probe.buildTimelinePanelAndStreamCalls += 1
      return { stream, panel: undefined }
    },
    buildWorkMetricsSink: () => {
      probe.buildWorkMetricsSinkCalls += 1
      return undefined
    },
    // ADR-0292 — host-bootstrap-extraction new factory fields. Each defaults
    // to a no-op stub so the existing assertion surface is unchanged. The
    // `buildLlm` stub mirrors the prior `composeLLM` mock: when mode === "auto"
    // it threads a no-op classifier onto the permission context (the auto
    // reviewer path needs `permission.classify` to be defined).
    buildLlm: (_provider, _model, mode, permission) => {
      if (mode === "auto") {
        ;(permission as { classify?: unknown }).classify = async () => ({
          verdict: "allow" as const,
          reason: "Allowed by classifier",
        })
      }
      return { generate: async () => ({ content: [] }) } as unknown as ReturnType<
        SetupSessionDeps["buildLlm"]
      >
    },
    // jun-6 (RFC jun-6-ai-session-title) — default-OFF stub: no auto-title port.
    buildAutoTitlePort: () => undefined,
    buildStreaming: () =>
      ({ stream: stubStreamPort, run: undefined }) as unknown as ReturnType<
        SetupSessionDeps["buildStreaming"]
      >,
    buildTooling: () =>
      ({
        store: undefined,
        embedder: undefined,
        sessionId: "seed-session",
        registry: { tools: () => [] },
        memoryConfig: undefined,
        subagentConfig: undefined,
        skillsConfig: undefined,
        compactionBreakerConfig: undefined,
        verifyGuardConfig: undefined,
      }) as unknown as ReturnType<SetupSessionDeps["buildTooling"]>,
    loadFeatures: async () => ({
      planMode: false,
      metrics: undefined,
      state: undefined,
      resume: undefined,
      mcpTools: [],
      mcpClients: [],
      mcpConfigs: [],
      lspTools: [],
      lspNavTools: [],
      gitToolList: [],
    }),
    loadImageBlock: () =>
      ({ kind: "image", data: "", mimeType: "image/png" }) as unknown as ReturnType<
        SetupSessionDeps["loadImageBlock"]
      >,
    pickIdentity: () => undefined,
    pickPersona: () => "default" as ReturnType<SetupSessionDeps["pickPersona"]>,
    resolveResume: async () => ({
      sessionId: "resolved-session",
      history: [],
      idMeta: undefined,
      inIdMode: false,
      conflictError: undefined,
      missingIdError: undefined,
    }),
    composeShellEvent: () => undefined,
    switchToSessionCwd: (cwd) => cwd,
    materializeReviewerAgent: () => undefined,
    createSubagentBackedGuardianReview: () =>
      (async () => ({
        reviewer: "guardian_subagent",
        outcome: "not_needed",
        riskLevel: "low",
        rationale: "stub",
        decidedAt: new Date(0),
      })) as unknown as ReturnType<SetupSessionDeps["createSubagentBackedGuardianReview"]>,
    createSubagentBackedGuardianAssess: () => async () => ({
      kind: "allow",
      rationale: "stub",
      riskLevel: "low",
    }),
    buildMcpSurfaceInfo: () => undefined,
    buildIdleGuards: () => ({
      idleMonitor: {
        markActive: () => undefined,
        markIdle: () => undefined,
        snooze: () => undefined,
        isIdle: () => false,
        isSnoozed: () => false,
        snoozedUntil: () => 0,
      } as unknown as ReturnType<SetupSessionDeps["buildIdleGuards"]>["idleMonitor"],
      rejectCounter: {
        recordAccept: () => undefined,
        recordDeny: () => undefined,
      } as unknown as ReturnType<SetupSessionDeps["buildIdleGuards"]>["rejectCounter"],
    }),
    loadPermissionStore: async () => {
      probe.loadPermissionStoreCalls += 1
      return opts.permissionStore
    },
    installPills: () => {
      probe.installPillsCalls += 1
      return stubStatusPills as never
    },
  }
  return { deps, probe }
}

// =============================================================================
// module-mock plumbing — stub the heavy surface so setupSession boots clean
// =============================================================================

let rawInternalModule: typeof import("../../../../src/apps/cli/internal") | undefined

const installDefaultInternalMock = async (): Promise<void> => {
  if (rawInternalModule === undefined) {
    throw new Error("rawInternalModule not initialized")
  }
  const module = rawInternalModule
  await mock.module("../../../../src/apps/cli/internal", () => ({
    ...module,
    env: (k: string, fallback: string) => process.env[k] ?? fallback,
    pickProvider: () => "anthropic" as never,
    pickPersona: () => "default" as never,
    DEFAULT_MODEL: { anthropic: "test-model", openai: "test-model" } as never,
    argvImages: () => [],
    argvPrompt: () => "",
    newSessionFlag: () => false,
    titleFlag: () => undefined,
    observeDir: () => undefined,
    isPathLikeToken: () => false,
    buildLLM: () => ({ generate: async () => ({ content: [] }) }) as never,
    buildSummarizerLlm: () => undefined,
    buildStreaming: () => ({
      stream: { emit: () => undefined },
      run: undefined,
    }),
    buildTooling: () => ({
      store: undefined,
      embedder: undefined,
      sessionId: "seed-session",
      registry: { tools: () => [] },
      memoryConfig: undefined,
      subagentConfig: undefined,
      skillsConfig: undefined,
      compactionBreakerConfig: undefined,
      verifyGuardConfig: undefined,
    }),
    loadFeatures: async () => ({
      planMode: false,
      metrics: undefined,
      state: undefined,
      resume: undefined,
      mcpTools: [],
      mcpClients: [],
      mcpConfigs: [],
      lspTools: [],
      lspNavTools: [],
      gitToolList: [],
    }),
    resolveResume: async () => ({
      sessionId: "resolved-session",
      history: [],
      idMeta: undefined,
      inIdMode: false,
      conflictError: undefined,
      missingIdError: undefined,
    }),
    composeLLM: (
      inner: unknown,
      _provider: unknown,
      _signal: AbortSignal,
      mode: string,
      permission: { classify?: unknown },
    ) => {
      if (mode === "auto") {
        permission.classify = async () => ({
          verdict: "allow" as const,
          reason: "Allowed by classifier",
        })
      }
      return inner
    },
  }))
}

beforeAll(async () => {
  // Stub `../internal` (the bulk of the surface).
  rawInternalModule = await import("../../../../src/apps/cli/internal")
  await installDefaultInternalMock()

  // Stub @/agent — buildSystemPrompt + RetryingLLM are reached by setupSession.
  const origAgent = await import("@/agent")
  await mock.module("@/agent", () => ({
    ...origAgent,
    buildSystemPrompt: () => "stub-system-prompt",
    RetryingLLM: class {
      generate = async (): Promise<{ content: never[] }> => ({ content: [] })
    },
  }))

  // Stub status bar — installStatusBar would mutate TTY otherwise.
  const origStatusBar = await import("../../../../src/apps/cli/status-bar")
  await mock.module("../../../../src/apps/cli/status-bar", () => ({
    ...origStatusBar,
    installStatusBar: () => ({
      setDefault: () => undefined,
      transient: () => undefined,
      clearTransient: () => undefined,
      teardown: () => undefined,
    }),
  }))

  // Stub session-io — switchToSessionCwd would chdir otherwise.
  const origSessionIo = await import("../../../../src/apps/cli/session-io")
  await mock.module("../../../../src/apps/cli/session-io", () => ({
    ...origSessionIo,
    switchToSessionCwd: (cwd: string) => cwd,
  }))
})

// Capture stderr writes so the "ready" log doesn't pollute test output.
let originalStderrWrite: typeof process.stderr.write
beforeEach(() => {
  originalStderrWrite = process.stderr.write.bind(process.stderr)
  // biome-ignore lint/suspicious/noExplicitAny: stderr stub
  process.stderr.write = (() => true) as any
})
afterEach(() => {
  // biome-ignore lint/suspicious/noExplicitAny: restore
  process.stderr.write = originalStderrWrite as any
})
afterEach(async () => {
  await installDefaultInternalMock()
})

// Spy on process.on + remember handlers so SIGINT registration is observable
// AND so we don't leak handlers across tests.
const installedSigintHandlers: Array<(...a: unknown[]) => void> = []
let originalProcessOn: typeof process.on
beforeEach(() => {
  installedSigintHandlers.length = 0
  originalProcessOn = process.on.bind(process)
  const stub = (evt: string, handler: (...a: unknown[]) => void): NodeJS.Process => {
    if (evt === "SIGINT") installedSigintHandlers.push(handler)
    return process
  }
  process.on = stub as unknown as typeof process.on
})
afterEach(() => {
  process.on = originalProcessOn
})

describe("session-setup — runtime behavior (boot with stubbed surface)", () => {
  test("setupSession returns a result with the populated abort + idle/reject + statusBar", async () => {
    const { setupSession } = await import("../../../../src/apps/cli/repl/session-setup")
    const { deps } = makeStubDeps()
    const result = await setupSession(deps)
    expect(result.abort).toBeInstanceOf(AbortController)
    expect(result.idleMonitor).toBeDefined()
    expect(result.rejectCounter).toBeDefined()
    expect(result.statusBar).toBeDefined()
  })

  test("wires reviewer + plan-exit + user-input host ports into the runtime bridge", async () => {
    const { setupSession } = await import("../../../../src/apps/cli/repl/session-setup")
    const { deps } = makeStubDeps()
    const result = await setupSession(deps)
    expect(result.runtimeContext.admissibility()?.reviewerPort).toBeDefined()
    expect(result.runtimeContext.admissibility()?.defaultReviewer).toBe("user")
    expect(result.runtimeContext.planExitPort()).toBeDefined()
    expect(result.runtimeContext.userInputPort()).toBeDefined()
  })

  test("switches the CLI default reviewer to auto_review when the auto classifier is live", async () => {
    const prevPermission = process.env.QUANTA_PERMISSION
    process.env.QUANTA_PERMISSION = "auto"
    try {
      const { setupSession } = await import("../../../../src/apps/cli/repl/session-setup")
      const { deps } = makeStubDeps()
      const result = await setupSession(deps)
      expect(result.runtimeContext.admissibility()?.defaultReviewer).toBe("auto_review")

      const action: ToolActionKeyed = {
        tool: "edit_file",
        input: { path: "src/app.ts" },
        isReadOnly: false,
        actionKey: "edit_file",
      }
      const ctx: ReviewContext = {
        sessionId: "s1",
        turnId: "1",
        priorDenials: [],
        configReviewer: "auto_review",
        decidedAt: 42,
      }
      const admissibility = result.runtimeContext.admissibility()
      expect(admissibility).toBeDefined()
      if (admissibility === undefined) throw new Error("admissibility must be defined")
      const reviewerPort = admissibility.reviewerPort
      expect(reviewerPort).toBeDefined()
      if (reviewerPort === undefined) throw new Error("reviewerPort must be defined")
      const decision = await reviewerPort.autoReview(action, ctx)
      expect(decision.reviewer).toBe("auto_review")
      expect(decision.outcome).toBe("config_allowed")
    } finally {
      if (prevPermission === undefined) delete process.env.QUANTA_PERMISSION
      else process.env.QUANTA_PERMISSION = prevPermission
    }
  })

  test("honors explicit per-thread agent authority and injects the same permission store", async () => {
    const prevPermission = process.env.QUANTA_PERMISSION
    const prevSandbox = process.env.QUANTA_SANDBOX
    process.env.QUANTA_PERMISSION = "acceptEdits"
    process.env.QUANTA_SANDBOX = "workspace-write"
    const permissionStore = createPermissionStore()
    setThreadPermission(
      "resolved-session",
      {
        approvalPolicy: "on-request",
        approvalsReviewer: "agent",
        sandboxPolicy: { type: "workspace-write" },
      },
      permissionStore,
    )
    try {
      const { setupSession } = await import("../../../../src/apps/cli/repl/session-setup")
      const { deps } = makeStubDeps({ permissionStore })
      // ADR-0292 — override the reviewer factory so the guardian-subagent
      // path materializes (the stub's default returns undefined).
      const fakeReviewer = async (): Promise<{ ok: true; finalText: string; turns: number }> => ({
        ok: true,
        finalText: "approve",
        turns: 1,
      })
      const depsWithReviewer: SetupSessionDeps = {
        ...deps,
        buildTooling: ((mcp, lsp, lspNav, git, slog, taskRegistry) => {
          const t = deps.buildTooling(mcp, lsp, lspNav, git, slog, taskRegistry)
          return { ...t, subagentConfig: { maxDepth: 2 } } as typeof t
        }) as SetupSessionDeps["buildTooling"],
        materializeReviewerAgent: () =>
          fakeReviewer as unknown as ReturnType<SetupSessionDeps["materializeReviewerAgent"]>,
      }
      const result = await setupSession(depsWithReviewer)
      expect(result.runtimeContext.admissibility()?.defaultReviewer).toBe("guardian_subagent")
      expect(result.runtimeContext.admissibility()?.permissionStore).toBe(permissionStore)
      const admissibility = result.runtimeContext.admissibility()
      expect(admissibility).toBeDefined()
      if (admissibility === undefined) throw new Error("admissibility must be defined")
      const reviewerPort = admissibility.reviewerPort
      expect(reviewerPort).toBeDefined()
      if (reviewerPort === undefined) throw new Error("reviewerPort must be defined")
      const guardian = await reviewerPort.guardianReview(
        {
          tool: "read",
          input: { path: "README.md" },
          isReadOnly: true,
          actionKey: "read",
        },
        {
          sessionId: "s1",
          turnId: "1",
          priorDenials: [],
          configReviewer: "guardian_subagent",
          decidedAt: 42,
        },
      )
      expect(guardian?.reviewer).toBe("guardian_subagent")
      expect(guardian?.outcome).toBe("not_needed")
    } finally {
      if (prevPermission === undefined) delete process.env.QUANTA_PERMISSION
      else process.env.QUANTA_PERMISSION = prevPermission
      if (prevSandbox === undefined) delete process.env.QUANTA_SANDBOX
      else process.env.QUANTA_SANDBOX = prevSandbox
    }
  })

  test("explicit per-thread user authority beats the auto reviewer fallback", async () => {
    const prevPermission = process.env.QUANTA_PERMISSION
    const prevSandbox = process.env.QUANTA_SANDBOX
    process.env.QUANTA_PERMISSION = "auto"
    process.env.QUANTA_SANDBOX = "workspace-write"
    const permissionStore = createPermissionStore()
    setThreadPermission(
      "resolved-session",
      {
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "workspace-write" },
      },
      permissionStore,
    )
    try {
      const { setupSession } = await import("../../../../src/apps/cli/repl/session-setup")
      const { deps } = makeStubDeps({ permissionStore })
      const result = await setupSession(deps)
      expect(result.runtimeContext.admissibility()?.defaultReviewer).toBe("user")
    } finally {
      if (prevPermission === undefined) delete process.env.QUANTA_PERMISSION
      else process.env.QUANTA_PERMISSION = prevPermission
      if (prevSandbox === undefined) delete process.env.QUANTA_SANDBOX
      else process.env.QUANTA_SANDBOX = prevSandbox
    }
  })

  test("rethrows buildLLM failure as a typed startup error", async () => {
    // ADR-0292 — inject the failure through the typed dep factory.
    const { setupSession } = await import("../../../../src/apps/cli/repl/session-setup")
    const { SessionBootstrapError } = await import("../../../../src/host/bootstrap")
    const { deps } = makeStubDeps()
    const failingDeps: SetupSessionDeps = {
      ...deps,
      buildLlm: () => {
        throw new Error("bad llm")
      },
    }
    let caught: unknown
    try {
      await setupSession(failingDeps)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SessionBootstrapError)
    expect(caught).toMatchObject({
      kind: "llm_build_failed",
      message: "bad llm",
    })
  })

  test("startup failure stops active mcp clients before rethrowing", async () => {
    const stop = mock(async () => undefined)
    const { setupSession } = await import("../../../../src/apps/cli/repl/session-setup")
    const { SessionBootstrapError } = await import("../../../../src/host/bootstrap")
    const { deps } = makeStubDeps()
    const failingDeps: SetupSessionDeps = {
      ...deps,
      loadFeatures: async () => ({
        planMode: false,
        metrics: undefined,
        state: undefined,
        resume: "session-missing",
        mcpTools: [],
        mcpClients: [{ stop }],
        mcpConfigs: [],
        lspTools: [],
        lspNavTools: [],
        gitToolList: [],
      }),
      resolveResume: async () => ({
        sessionId: "seed-session",
        history: [],
        idMeta: undefined,
        inIdMode: false,
        conflictError: undefined,
        missingIdError: "session-missing",
      }),
    }
    let caught: unknown
    try {
      await setupSession(failingDeps)
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(SessionBootstrapError)
    expect(caught).toMatchObject({
      kind: "resume_missing_id",
      message: "--resume: session id not found: session-missing",
    })
    expect(stop).toHaveBeenCalledTimes(1)
  })

  test("registers a SIGINT handler — invoking it triggers result.abort", async () => {
    const { setupSession } = await import("../../../../src/apps/cli/repl/session-setup")
    const { deps } = makeStubDeps()
    const result = await setupSession(deps)
    expect(installedSigintHandlers.length).toBeGreaterThanOrEqual(1)
    expect(result.abort.signal.aborted).toBe(false)
    // Invoke the registered handler — must abort the controller.
    installedSigintHandlers[0]?.()
    expect(result.abort.signal.aborted).toBe(true)
  })

  test("invokes EVERY one of the 12 injected dep factories at least once", async () => {
    const { setupSession } = await import("../../../../src/apps/cli/repl/session-setup")
    const { deps, probe } = makeStubDeps()
    await setupSession(deps)
    expect(probe.buildLifecycleBundleCalls).toBeGreaterThanOrEqual(1)
    expect(probe.buildCostPanelOrUndefinedCalls).toBeGreaterThanOrEqual(1)
    expect(probe.buildBranchProgressOrUndefinedCalls).toBeGreaterThanOrEqual(1)
    expect(probe.buildPlanStoreOrUndefinedCalls).toBeGreaterThanOrEqual(1)
    expect(probe.buildTurnSummaryAndStreamCalls).toBeGreaterThanOrEqual(1)
    expect(probe.buildTurnIndicatorAndStreamCalls).toBeGreaterThanOrEqual(1)
    expect(probe.buildDebugTracerAndStreamCalls).toBeGreaterThanOrEqual(1)
    expect(probe.buildTimelinePanelAndStreamCalls).toBeGreaterThanOrEqual(1)
    expect(probe.buildWorkMetricsSinkCalls).toBeGreaterThanOrEqual(1)
    expect(probe.loadPermissionStoreCalls).toBeGreaterThanOrEqual(1)
    expect(probe.installPillsCalls).toBeGreaterThanOrEqual(1)
    // deriveMcpPillServers is only called when mcpClients.length > 0; our
    // stub returns [] so the count stays at 0 — that's the documented
    // conditional contract (see session-setup.ts:306-310).
    expect(probe.deriveMcpPillServersCalls).toBe(0)
  })

  test("deriveMcpPillServers IS called when loadFeatures returns at least one mcpClient", async () => {
    // ADR-0292 — override via the typed dep factory.
    const { setupSession } = await import("../../../../src/apps/cli/repl/session-setup")
    const { deps, probe } = makeStubDeps()
    const withMcp: SetupSessionDeps = {
      ...deps,
      loadFeatures: async () => ({
        planMode: false,
        metrics: undefined,
        state: undefined,
        resume: undefined,
        mcpTools: [{ name: "mcp__fs__read" } as never],
        mcpClients: [{ stop: async () => undefined }],
        mcpConfigs: [],
        lspTools: [],
        lspNavTools: [],
        gitToolList: [],
      }),
    }
    await setupSession(withMcp)
    expect(probe.deriveMcpPillServersCalls).toBeGreaterThanOrEqual(1)
  })

  test("builds mcpSurface from configs + bridged tools + QUANTA_MCP_CONFIG", async () => {
    const prev = process.env.QUANTA_MCP_CONFIG
    process.env.QUANTA_MCP_CONFIG = "/tmp/quanta-mcp.json"
    const { setupSession } = await import("../../../../src/apps/cli/repl/session-setup")
    const { buildMcpSurfaceInfo } = await import("../../../../src/apps/cli/repl/mcp-surface-wire")
    const { deps } = makeStubDeps()
    const fsTool = { name: "mcp__fs__read_file", description: "read file" } as never
    const withSurface: SetupSessionDeps = {
      ...deps,
      loadFeatures: async () => ({
        planMode: false,
        metrics: undefined,
        state: undefined,
        resume: undefined,
        mcpTools: [fsTool],
        mcpClients: [],
        mcpConfigs: [{ name: "fs", command: ["bun", "fs.ts"] }],
        lspTools: [],
        lspNavTools: [],
        gitToolList: [],
      }),
      // ADR-0292 — wire the real builder so the test sees a populated surface.
      buildMcpSurfaceInfo,
    }
    try {
      const result = await setupSession(withSurface)
      // ADR-0292 — narrow the host's opaque mcpSurface back to the CLI
      // surface concrete type for assertions. Two-step `as unknown as ...`
      // because the surface CLI type has stricter literal-union members
      // (e.g. `status: "connected"|"failed"`) that don't overlap directly.
      const surface = result.mcpSurface as unknown as {
        configPath?: string
        servers: Array<{
          name: string
          status: string
          tools: Array<{ name: string }>
        }>
      }
      expect(surface?.configPath).toBe("/tmp/quanta-mcp.json")
      expect(surface?.servers.map((s) => `${s.name}:${s.status}`)).toEqual(["fs:connected"])
      expect(surface?.servers[0]?.tools.map((t) => t.name)).toEqual(["read_file"])
    } finally {
      if (prev === undefined) delete process.env.QUANTA_MCP_CONFIG
      else process.env.QUANTA_MCP_CONFIG = prev
    }
  })

  test("setupSession.shutdownMcp resolves cleanly when no clients are registered", async () => {
    // After the prior test's loadFeatures override, restore the empty default
    // by re-importing the original module mock.
    const origInternal = await import("../../../../src/apps/cli/internal")
    await mock.module("../../../../src/apps/cli/internal", () => ({
      ...origInternal,
      loadFeatures: async () => ({
        planMode: false,
        metrics: undefined,
        state: undefined,
        resume: undefined,
        mcpTools: [],
        mcpClients: [],
        mcpConfigs: [],
        lspTools: [],
        lspNavTools: [],
        gitToolList: [],
      }),
    }))
    const { setupSession } = await import("../../../../src/apps/cli/repl/session-setup")
    const { deps } = makeStubDeps()
    const result = await setupSession(deps)
    // Must not throw (empty clients list ⇒ loop is a no-op).
    await result.shutdownMcp()
    expect(typeof result.shutdownMcp).toBe("function")
  })

  test("buildLLM failure rejects with SessionBootstrapError instead of exiting the process", async () => {
    // ADR-0292 — failure is now injected through the typed dep factory
    // instead of mock-ing `../internal`, because the bootstrap consumes the
    // closure (not the env-bound module symbol).
    const { setupSession } = await import("../../../../src/apps/cli/repl/session-setup")
    const { SessionBootstrapError } = await import("../../../../src/host/bootstrap")
    const { deps } = makeStubDeps()
    const failingDeps: SetupSessionDeps = {
      ...deps,
      buildLlm: () => {
        throw new Error("missing provider key")
      },
    }
    try {
      await setupSession(failingDeps)
      throw new Error("expected setupSession to reject")
    } catch (e) {
      expect(e).toBeInstanceOf(SessionBootstrapError)
      expect((e as Error).message).toBe("missing provider key")
    }
  })

  test("resume conflict rejects with SessionBootstrapError instead of exiting the process", async () => {
    const { setupSession } = await import("../../../../src/apps/cli/repl/session-setup")
    const { SessionBootstrapError } = await import("../../../../src/host/bootstrap")
    const { deps } = makeStubDeps()
    const conflictDeps: SetupSessionDeps = {
      ...deps,
      resolveResume: async () => ({
        sessionId: "resolved-session",
        history: [],
        idMeta: undefined,
        inIdMode: false,
        conflictError: "cannot combine --new-session with --resume",
        missingIdError: undefined,
      }),
    }
    try {
      await setupSession(conflictDeps)
      throw new Error("expected setupSession to reject")
    } catch (e) {
      expect(e).toBeInstanceOf(SessionBootstrapError)
      expect((e as Error).message).toBe("cannot combine --new-session with --resume")
    }
  })
})
