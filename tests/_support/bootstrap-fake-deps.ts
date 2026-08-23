/**
 * Shared bootstrap fixture — the typed `SessionBootstrapDeps` / runtime-shape
 * bundle that lets a test stand `bootstrapSession` up for real with no disk,
 * no network and no `mock.module`.
 *
 * Extracted from `tests/unit/host/bootstrap-host-extraction-hellgate.test.ts`
 * so a second suite can drive the SAME bootstrap the shipping CLI runs without
 * duplicating ~110 lines of fakes (a copy would drift the moment
 * `SessionBootstrapDeps` gains a field, and the two suites would then be
 * proving different things).
 *
 * Every field is a deliberate no-op: the point is to exercise the bootstrap's
 * OWN composition, so anything it merely passes through is stubbed.
 */

import type { SessionBootstrapDeps, SessionRuntimeConfigShape } from "@/host/bootstrap"
import type { LLMPort } from "@/llm"
import type { ResolveResumeInput } from "@/runner/orchestrate"

const fakeLLM: LLMPort = {
  stream: async function* () {
    yield* []
  },
}

export const makeFakeBootstrapDeps = (
  overrides: Partial<SessionBootstrapDeps> = {},
): SessionBootstrapDeps => {
  const base: SessionBootstrapDeps = {
    buildLifecycleBundle: () => ({
      pills: { update: () => undefined },
      taskRegistry: undefined,
      followUpQueue: undefined,
      activityStore: undefined as never,
    }),
    deriveMcpPillServers: () => [],
    buildCostPanelOrUndefined: () => undefined,
    buildBranchProgressOrUndefined: () => undefined,
    buildPlanStoreOrUndefined: () => undefined,
    buildWorkMetricsSink: () => undefined,
    buildLlm: () => fakeLLM,
    // jun-6 (RFC jun-6-ai-session-title) — default-OFF stub: no auto-title port.
    buildAutoTitlePort: () => undefined,
    buildStreaming: () => ({
      stream: { emit: () => undefined },
      run: undefined,
    }),
    buildTooling: () =>
      ({
        store: undefined,
        embedder: undefined,
        sessionId: "fake-session",
        registry: { tools: () => [] },
        memoryConfig: undefined,
        subagentConfig: undefined,
        skillsConfig: undefined,
        compactionBreakerConfig: undefined,
        verifyGuardConfig: undefined,
      }) as never,
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
      astGrepTools: [],
    }),
    loadImageBlock: () => ({ kind: "image", data: "", mimeType: "image/png" }) as never,
    pickIdentity: () => undefined,
    pickPersona: () => "default" as never,
    resolveResume: async (_input: ResolveResumeInput) => ({
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
    createSubagentBackedGuardianReview: () => (async () => ({})) as never,
    createSubagentBackedGuardianAssess: () => (async () => ({})) as never,
    buildMcpSurfaceInfo: () => undefined,
    buildIdleGuards: () => ({
      idleMonitor: { markActive: () => undefined } as never,
      rejectCounter: { recordAccept: () => undefined } as never,
    }),
  }
  return { ...base, ...overrides }
}

export const makeFakeBootstrapRuntime = (
  overrides: Partial<SessionRuntimeConfigShape> = {},
): SessionRuntimeConfigShape => ({
  provider: "openai" as never,
  model: "test-model",
  mode: "default" as never,
  maxTurns: 5,
  cwd: "/tmp/test",
  env: {},
  homeDir: "/tmp",
  stdinIsTTY: false,
  stdoutIsTTY: false,
  newSession: false,
  title: undefined,
  idleMs: 60_000,
  snoozeDefaultMs: 300_000,
  rejectLimit: 20,
  idleSuppressOn: false,
  observeDir: undefined,
  pendingImagePaths: [],
  mcpConfigPath: undefined,
  argPrompt: undefined,
  spinnerIntervalMs: "80",
  ...overrides,
})
