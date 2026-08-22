/**
 * `@/apps/terminal/brain-mode-session-scaffold` — the OFFLINE session-scaffold builders split out of
 * {@link module:@/apps/terminal/brain-mode} to keep that entry-point module under the god-MODULE cap.
 *
 * These are the leaf infrastructure builders the brain core assembles before it drives the real agent
 * loop: the fully-injected {@link SessionBootstrapDeps} bundle (a network-free / fs-free replica of the
 * headless fake-bootstrap shape — the terminal fence forbids importing `@/apps/headless`), the leanest
 * valid {@link SessionRuntimeConfigShape}, and the {@link JsonLineDuplex} over the brain's stdio.
 *
 * DOWNWARD-CLOSED: every function here calls ONLY module imports (`@/activity`, `@/tool`) + each other —
 * NEVER a `brain-mode` value — so this module has NO runtime dependency on `brain-mode`. It imports the
 * `RunTerminalBrainOpts` SHAPE type-only (no value edge), and `brain-mode` imports these builders back as
 * values; the one edge that exists is `brain-mode → session-scaffold`, so there is no cycle.
 *
 * SURFACE ISOLATION (biome fence `src/apps/terminal/**`): same as `brain-mode` — composes ONLY `@/tool`
 * ports + the shared agent-loop core shapes; it MUST NOT import a sibling app surface.
 */

import { createActivityStore } from "@/activity"
import type { SessionBootstrapDeps, SessionRuntimeConfigShape } from "@/host/bootstrap"
import type { ImageBlock, LLMPort, Message } from "@/llm"
import type { ResolveResumeInput, ResumeResolution } from "@/runner/orchestrate/resume-fsm"
import type { StreamPort } from "@/stream"
import { type Tool, ToolRegistry } from "@/tool"
import type { JsonLineDuplex } from "@/tool/container-exec"
import type { RunTerminalBrainOpts } from "./brain-mode"

const TERMINAL_BRAIN_SESSION_ID = "terminal-brain-session"

/** Build a complete, offline {@link SessionBootstrapDeps} bundle wired to the injected LLM, capture
 *  stream, and the terminal tool registry. REPLICATES the headless `buildFakeBootstrapDeps` shape
 *  (cannot import `@/apps/headless` across the terminal fence) — the deps the agent loop needs that
 *  the brain surface does not own (memory store / subagents / reviewer / MCP / images) are leanest
 *  valid stubs. */
export const buildTerminalBootstrapDeps = (
  llm: LLMPort,
  stream: StreamPort,
  tools: readonly Tool[],
): SessionBootstrapDeps => {
  const registry = new ToolRegistry([...tools])
  return {
    buildLifecycleBundle: () => ({
      pills: { update: () => undefined },
      taskRegistry: undefined,
      followUpQueue: undefined,
      activityStore: createActivityStore(),
    }),
    deriveMcpPillServers: () => [],
    buildCostPanelOrUndefined: () => undefined,
    buildBranchProgressOrUndefined: () => undefined,
    buildPlanStoreOrUndefined: () => undefined,
    buildWorkMetricsSink: () => undefined,
    buildLlm: () => llm,
    buildAutoTitlePort: () => undefined,
    buildStreaming: () => ({ stream, run: undefined }),
    buildTooling: () => ({
      store: undefined,
      embedder: undefined,
      sessionId: TERMINAL_BRAIN_SESSION_ID,
      registry,
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
      astGrepTools: [],
    }),
    loadImageBlock: (): ImageBlock => ({ type: "image", data: "", mediaType: "image/png" }),
    pickIdentity: () => undefined,
    pickPersona: () => "default",
    resolveResume: async (_: ResolveResumeInput): Promise<ResumeResolution> => ({
      sessionId: TERMINAL_BRAIN_SESSION_ID,
      history: [] as Message[],
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
      idleMonitor: { markActive: () => undefined },
      rejectCounter: { recordAccept: () => undefined, recordDeny: () => 0, shouldAutoExit: () => false },
    }),
  }
}

/** Build the leanest valid {@link SessionRuntimeConfigShape} for an offline brain run. No
 *  `process.*` reads — the surface entry threads argv-derived values in. */
export const buildTerminalRuntime = (opts: RunTerminalBrainOpts): SessionRuntimeConfigShape => ({
  // Config-label only — the ACTUAL provider is whatever the injected `llm` adapter is. The runtime
  // shape constrains this to the `LLMProvider` enum, so we carry the headless precedent's `"openai"`
  // placeholder; the brain never dispatches on it (the surface tools + injected LLM own behavior).
  provider: "openai",
  model: opts.model ?? "terminal-brain",
  mode: "acceptEdits",
  maxTurns: opts.maxTurns ?? 30,
  cwd: opts.cwd ?? "/",
  env: {},
  homeDir: "/tmp",
  stdinIsTTY: false,
  stdoutIsTTY: false,
  newSession: false,
  title: undefined,
  // INERT here: `idleMs` is only ever consulted by the interactive REPL path (repl.ts, gated on
  // `idleSuppressOn`), which the brain NEVER runs — so this value has no effect. Kept as a required
  // shape field with an explicit 0 (was a misleading `60_000` const whose comment claimed a live
  // "no inbound frame" bound that nothing enforces — P0-B). The real per-command bound is the
  // opt-in `timeoutMs` on the exec path; the task-level bound is harbor's AgentTimeout.
  idleMs: 0,
  snoozeDefaultMs: 300_000,
  rejectLimit: 20,
  idleSuppressOn: false,
  observeDir: undefined,
  pendingImagePaths: [],
  mcpConfigPath: undefined,
  argPrompt: undefined,
  spinnerIntervalMs: "80",
})

/** A `JsonLineDuplex` over the brain's stdio: read inbound frames from `stdin`, write outbound
 *  frames to `stdout` (appending the line terminator). */
export const duplexOverStdio = (
  stdin: AsyncIterable<string>,
  stdout: { write(line: string): void },
): JsonLineDuplex => ({
  write: (line) => stdout.write(`${line}\n`),
  lines: stdin,
})
