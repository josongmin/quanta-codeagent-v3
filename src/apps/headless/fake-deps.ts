/**
 * `@/apps/headless/fake-deps` — minimal `SessionBootstrapDeps` factory for
 * a fully-offline headless run (ADR-0308 / ARCH-07). Every factory returns
 * the leanest valid value; the dep BUNDLE is COMPLETE. NO `@/apps/cli` /
 * `@/apps/bench` / `@/apps/agent` imports (enforced by biome + hellgate).
 */

import type { SessionBootstrapDeps, SessionRuntimeConfigShape } from "@/host/bootstrap"
import type { ImageBlock, LLMPort, Message } from "@/llm"
import { StructuredLogger } from "@/observability"
import type { AgentConfig } from "@/agent"
import type { Tooling } from "@/runner/assemble"
import type { ResolveResumeInput, ResumeResolution } from "@/runner/orchestrate"
import type { AgentEvent, StreamPort } from "@/stream"
import { type Tool, ToolRegistry } from "@/tool"

/** Capture surface so the headless smoke + the hellgate test can assert on
 *  every `AgentEvent` the runner emitted during the turn. */
export class RecordingStream implements StreamPort {
  readonly events: AgentEvent[] = []
  emit(event: AgentEvent): void {
    this.events.push(event)
  }
}

/** Build a complete {@link SessionBootstrapDeps} for an offline headless run.
 *
 *  @param llm     The fake LLM port (see `./fake-llm`).
 *  @param stream  Recording stream so the caller can introspect the events.
 *  @param tools   Optional registered tools (default: empty registry — the
 *                 model can still call zero tools and complete with text). */
export const buildFakeBootstrapDeps = (
  llm: LLMPort,
  stream: StreamPort,
  tools: readonly Tool[] = [],
  overrides: { readonly subagentConfig?: AgentConfig["subagent"] } = {},
): SessionBootstrapDeps => {
  const registry = new ToolRegistry([...tools])
  const sessionId = "headless-session"
  const tooling: Tooling = {
    store: undefined,
    embedder: undefined,
    sessionId,
    registry,
    memoryConfig: undefined,
    subagentConfig: overrides.subagentConfig,
    skillsConfig: undefined,
    compactionBreakerConfig: undefined,
    verifyGuardConfig: undefined,
  }
  return {
    buildLifecycleBundle: () => ({
      pills: { update: () => undefined },
      taskRegistry: undefined,
      followUpQueue: undefined,
    }),
    deriveMcpPillServers: () => [],
    buildCostPanelOrUndefined: () => undefined,
    buildBranchProgressOrUndefined: () => undefined,
    buildPlanStoreOrUndefined: () => undefined,
    buildWorkMetricsSink: () => undefined,
    buildLlm: () => llm,
    buildStreaming: () => ({ stream, run: undefined }),
    buildTooling: () => tooling,
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
    // Typed stub — bootstrap only calls it when `runtime.pendingImagePaths`
    // is non-empty (default `[]` ⇒ never). Headless never reads disk.
    loadImageBlock: (): ImageBlock => ({ type: "image", data: "", mediaType: "image/png" }),
    pickIdentity: () => undefined,
    pickPersona: () => "default",
    resolveResume: async (_: ResolveResumeInput): Promise<ResumeResolution> => ({
      sessionId,
      history: [] as Message[],
      idMeta: undefined,
      inIdMode: false,
      conflictError: undefined,
      missingIdError: undefined,
    }),
    composeShellEvent: () => undefined,
    switchToSessionCwd: (cwd) => cwd,
    // Reviewer pair is default-OFF: the headless path never wires
    // admissibility, so the host re-exposes both closures but never invokes
    // them. The `never`-cast guardian no-op matches CLI-01's fake-deps
    // verbatim — keeps this slice free of `@/permission#ReviewerPort`.
    materializeReviewerAgent: () => undefined,
    createSubagentBackedGuardianReview: () => (async () => ({})) as never,
    buildMcpSurfaceInfo: () => undefined,
    buildIdleGuards: () => ({
      idleMonitor: { markActive: () => undefined },
      rejectCounter: { recordAccept: () => undefined, recordDeny: () => undefined },
    }),
  }
}

/** Build a minimal {@link SessionRuntimeConfigShape} for the headless run.
 *  Every field is plain data: NO `process.*` reads inside the headless slice
 *  itself (the caller may pass `env` through `HeadlessRunInput`, but the
 *  slice does not touch the global env). */
export const buildFakeRuntime = (
  overrides: Partial<SessionRuntimeConfigShape> = {},
): SessionRuntimeConfigShape => ({
  provider: "openai",
  model: "headless-fake",
  mode: "acceptEdits",
  maxTurns: 5,
  cwd: "/tmp/headless",
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

/** Build a headless `StructuredLogger`. Re-exported so the headless slice
 *  has a single allocation point and tests can swap if needed in the future. */
export const buildFakeLogger = (): StructuredLogger => new StructuredLogger()
