import * as readline from "node:readline/promises"
import { RetryingLLM } from "@/agent"
import {
  createSubagentBackedGuardianReview,
  materializeReviewerAgent,
} from "@/agent/tier1/reviewer-subagent"
import { buildShellOtelObserver } from "@/observability"
import { getDefaultPermissionStore, type PermissionStore } from "@/permission"
import { runSessionCommand as runSessionCommandInner } from "@/runner/session-ops"
import { composeShellObservers, type ShellExecObserver } from "@/tool"
import { createIdleMonitor } from "./idle-monitor"
import { loadImageBlock } from "./image-loader"
import { createImageQueue, type ImageQueue } from "./image-queue"
import {
  buildLLM,
  buildSkillsConfig,
  buildStreaming,
  buildTooling,
  composeLLM,
  loadFeatures,
  pickIdentity,
  pickPersona,
  resolveResume,
} from "./internal"
import { createRejectCounter } from "./reject-counter"
import type { CliFeatureConfig } from "./repl/cli-feature-config"
import {
  buildBranchProgressOrUndefined,
  buildCostPanelOrUndefined,
  buildDebugTracerAndStream,
  buildLifecycleBundle,
  buildPlanStoreOrUndefined,
  buildTimelinePanelAndStream,
  buildTurnIndicatorAndStream,
  buildTurnSummaryAndStream,
  buildWorkMetricsSink,
  deriveMcpPillServers,
} from "./repl/factories"
import { buildMcpSurfaceInfo } from "./repl/mcp-surface-wire"
import { runSessionLoop } from "./repl/session-loop"
import { setupSession } from "./repl/session-setup"
import { buildSkillsCallback, installPills } from "./repl/skills-surface"
import {
  buildPromptUx,
  composeSurfaceSlashCtx,
  composeSurfaceWires,
  composeTurnSinks,
  createSurfaceState,
} from "./repl/surface-compose"
import type { RewindSlashState } from "./rewind-cmd"
import { createCliRewindGitPort } from "./rewind-git"
import { createCliImportHandler } from "./session-import-handler"
import { switchToSessionCwd } from "./session-io"
import { resolveCliSessionListEnv } from "./session-list-env"
import { buildShellStreamPainter } from "./shell-stream-painter"
import { runSlashCommand, slashCompleter } from "./slash-commands"

/**
 * CLI REPL + main-orchestration body. CLI-06 (ADR-0307) slimmed this host
 * file: the 10 default-OFF surface-adapter build helpers now live under
 * `src/apps/cli/repl/factories/` and are pulled in via the barrel. The host
 * owns ONLY entry routing + prompt UX + slash-ctx compose + turn-sink compose
 * + `runSessionLoop` call. Module boundary: no cross-app imports.
 */

/** Shared REPL-side slash-context re-export — `dispatchReplSlash` is the
 *  surface seam invoked from `runRepl` after the slash ctx is composed. */
export { dispatchReplSlash, type ReplSlashCtx } from "./repl/slash-surface"

/** Claude A1 rewind/fork: bind `/rewind` and `/fork` to the live session id.
 *  `--restore-files` needs the real-git port wired (`QUANTA_REWIND_GIT=1`,
 *  default OFF — destructive). Absent session id ⇒ `undefined` so commands
 *  print "no active session" and exit 1 (never silent). */
const buildRewindSlashState = (
  sessionId: string | undefined,
  cwd: string,
  featureCfg: CliFeatureConfig,
): RewindSlashState | undefined => {
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined
  const git = featureCfg.rewindGit.enabled ? createCliRewindGitPort({ cwd }) : undefined
  return { sessionId, ...(git !== undefined ? { git } : {}) }
}

/** Top-level usage block. Printed on `--help`/`-h` BEFORE prompt forwarding so
 *  a typo doesn't become an LLM prompt. Session subcommand has its own help. */
export const topLevelUsage = (): string =>
  [
    "quanta — coding agent CLI",
    "",
    "Usage:",
    "  quanta [PROMPT]                      Run a one-shot prompt",
    "  quanta                               Start interactive REPL",
    "  quanta --new-session [--title T]     Start a new id-mode session",
    "  quanta --resume <id|path>            Resume by id (id-mode) or path (path-mode)",
    "  quanta --state <path>                Save path-mode transcript",
    "  quanta session <subcommand> ...      Session management (see `quanta session --help`)",
    "  quanta remote <subcommand> ...       Remote execution plane (see `quanta remote --help`)",
    "",
    "Common flags:",
    "  --plan, --lsp, --lsp-tools, --git-tools, --observe-dir <d>, --metrics",
    "  -h, --help                           Show this help",
    "",
  ].join("\n")

/** Build the per-REPL multi-modal image queue (ADR-0083). Default-ON cap 5;
 *  `QUANTA_IMAGE_QUEUE=0` returns `undefined` so the surface short-circuits. */
const buildImageQueue = (featureCfg: CliFeatureConfig): ImageQueue | undefined => {
  if (!featureCfg.imageQueue.enabled) return undefined
  return createImageQueue({ maxSize: featureCfg.imageQueue.maxSize })
}

/** Route `quanta session …` to the session subcommand dispatcher. Returns
 *  the exit code; no agent/REPL wiring runs in this branch. */
export const runSessionMain = async (): Promise<number> => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    completer: slashCompleter,
  })
  // CLI-05 (ADR-0305): the prior shim `./session-commands.ts` is removed —
  // we now call the surface-agnostic runner slice directly and inject the
  // two CLI-specific adapters (import handler + list-env resolver) inline.
  // The runner accepts `listEnv: undefined` (treats it as omitted), so the
  // `exactOptionalPropertyTypes: true` spread is safe.
  const listEnv = resolveCliSessionListEnv()
  const code = await runSessionCommandInner(process.argv.slice(3), {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    confirm: async (prompt) => {
      const ans = await rl.question(prompt)
      return ans.trim().toLowerCase() === "y"
    },
    importHandler: createCliImportHandler(),
    ...(listEnv !== undefined ? { listEnv } : {}),
  })
  rl.close()
  return code
}

/** Run the matching built-in slash command and exit. Tier-2 absorption #2-1. */
export const runSlashMain = async (_tok: string): Promise<number> => {
  // Shell-entry gate (`quanta /skills`): build the skills callback ad-hoc from
  // env (no session). Mirrors what the REPL passes via slashCtx so `/skills`
  // behaves identically across both surfaces (shell one-shot vs in-REPL line).
  const skillsCfg = buildSkillsConfig()
  const skillsCb = buildSkillsCallback(skillsCfg)
  return runSlashCommand(process.argv.slice(2).join(" "), {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    cwd: process.cwd(),
    ...(skillsCb !== undefined ? { skills: skillsCb } : {}),
  })
}

/** ADR-0299 — compose the LLM stack at the CLI seam:
 *  `buildLLM` → `RetryingLLM` → `composeLLM`. */
const cliBuildLlm: Parameters<typeof setupSession>[0]["buildLlm"] = (
  provider,
  model,
  mode,
  permission,
  signal,
  slog,
) => {
  const llm = buildLLM(provider, model)
  const retryingLLM = new RetryingLLM({ inner: llm, signal })
  return composeLLM(retryingLLM, provider, signal, mode, permission, slog)
}

/** ADR-0299 — per-turn shell-event observer composer (CLI seam). */
const cliComposeShellEvent = (
  metrics: Parameters<Parameters<typeof setupSession>[0]["composeShellEvent"]>[0],
  stdoutIsTTY: boolean | undefined,
): ShellExecObserver | undefined => {
  const painterObs = stdoutIsTTY ? buildShellStreamPainter() : undefined
  const otelObs = metrics ? buildShellOtelObserver(metrics) : undefined
  return painterObs !== undefined || otelObs !== undefined
    ? composeShellObservers(painterObs, otelObs)
    : undefined
}

/** ADR-0299 — build the surface-side idle/reject guards (CLI seam). */
const cliBuildIdleGuards: Parameters<typeof setupSession>[0]["buildIdleGuards"] = (runtime) => {
  const idleMonitor = createIdleMonitor({
    idleThresholdMs:
      runtime.idleSuppressOn && Number.isFinite(runtime.idleMs)
        ? runtime.idleMs
        : Number.POSITIVE_INFINITY,
    defaultSnoozeMs:
      runtime.idleSuppressOn && Number.isFinite(runtime.snoozeDefaultMs)
        ? runtime.snoozeDefaultMs
        : 300_000,
  })
  const rejectCounter = createRejectCounter({
    threshold:
      runtime.idleSuppressOn && Number.isFinite(runtime.rejectLimit) && runtime.rejectLimit > 0
        ? runtime.rejectLimit
        : Number.POSITIVE_INFINITY,
  })
  return { idleMonitor, rejectCounter }
}

/** Bundle the {@link setupSession} factories the host wires. CLI-06
 *  (ADR-0307) — the 10 surface-adapter factories live under
 *  `./repl/factories/`; the wrappers here just narrow the host's `unknown`
 *  featureCfg arg back to `CliFeatureConfig`. */
const sessionSetupDeps: Parameters<typeof setupSession>[0] = {
  // The host slice declares the featureCfg parameter as `unknown` so it
  // stays slice-clean (no import of `apps/cli/repl/cli-feature-config`).
  // The CLI surface narrows it back to `CliFeatureConfig` at each call site.
  buildLifecycleBundle: (cfg) => buildLifecycleBundle(cfg as CliFeatureConfig),
  deriveMcpPillServers,
  buildCostPanelOrUndefined: (cfg, model) =>
    buildCostPanelOrUndefined(cfg as CliFeatureConfig, model),
  buildBranchProgressOrUndefined: (cfg) => buildBranchProgressOrUndefined(cfg as CliFeatureConfig),
  buildPlanStoreOrUndefined: (cfg) => buildPlanStoreOrUndefined(cfg as CliFeatureConfig),
  buildTurnSummaryAndStream,
  buildTurnIndicatorAndStream,
  buildDebugTracerAndStream,
  buildTimelinePanelAndStream,
  buildWorkMetricsSink,
  // ADR-0299 — env-bound factories the host consumes as deps.
  buildLlm: cliBuildLlm,
  buildStreaming,
  buildTooling,
  loadFeatures,
  loadImageBlock,
  pickIdentity,
  pickPersona,
  resolveResume,
  composeShellEvent: cliComposeShellEvent,
  switchToSessionCwd,
  materializeReviewerAgent,
  createSubagentBackedGuardianReview,
  buildMcpSurfaceInfo,
  buildIdleGuards: cliBuildIdleGuards,
  loadPermissionStore: async (): Promise<PermissionStore | undefined> => {
    try {
      const store = getDefaultPermissionStore()
      await store.load()
      return store
    } catch {
      return undefined
    }
  },
  installPills,
}

/** Thin orchestrator over the 6 helpers under `src/apps/cli/repl/`:
 *  `setupSession` → `composePromptPipeline` → `runOneTurn` → `installTurnCancel`
 *  → `SessionState` → `runSessionLoop`. The host owns slashCtx composition +
 *  per-turn render sinks; byte-identical default behavior. */
export const runRepl = async (): Promise<void> => {
  const setup = await setupSession(sessionSetupDeps)
  const featureCfg = setup.featureCfg
  const surfaceState = createSurfaceState({
    imageQueue: setup.argPrompt ? undefined : buildImageQueue(featureCfg),
    rewindState: buildRewindSlashState(setup.sessionId, setup.cwd, featureCfg),
    history: setup.history,
  })
  try {
    const convStore = defaultConversationCheckpointStore()
    const executionPlaneDeps = await buildExecutionPlaneSessionDeps({
      setup,
      convStore,
      envSource: process.env,
    })
    const setupWithExecution: typeof setup = {
      ...setup,
      sessionDeps: {
        ...setup.sessionDeps,
        ...executionPlaneDeps,
      },
    }
    // ADR-0299 — surface composition wire. Builds the slash ctx PLUS the
    // wire bundle (conv-checkpoint, playbook-trigger seam, composer +
    // textInbox handles). Each upstream knob (env / CLI flag) gates the
    // ctx slot independently so the projection is byte-identical to
    // legacy when no opt-in is present (RFC §1.2). The bundled
    // `dispatchSlash` closure routes through the FULL augmented
    // SlashContext (legacy + ADR-0291 + ADR-0292 + ADR-0294 slots).
    const wires = composeSurfaceWires(setupWithExecution, surfaceState, process.env, { convStore })
    await runSessionLoop({
      setup: setupWithExecution,
      dispatchSlash: wires.dispatchSlash,
      sinks: composeTurnSinks(setupWithExecution, surfaceState),
      ...(surfaceState.imageQueue !== undefined ? { imageQueue: surfaceState.imageQueue } : {}),
      textInbox: wires.textInbox,
      ux: buildPromptUx(featureCfg),
      registerExitTeardown: (cb) => {
        process.once("exit", cb)
      },
      // ADR-0292 — turn-end record + restore swap. The wire may be null
      // (default-OFF byte-identical when QUANTA_CHECKPOINT_CONV !== "on")
      // — the loop short-circuits on null.
      convCheckpointWire: wires.convCheckpointWire,
      registerReplaceMessages: wires.setReplaceMessages,
      // ADR-0293 — seam attached by the loop once externalPromptQueue is
      // born (the queue is the sink the trigger dispatches into).
      playbookSeam: wires.playbookSeam,
      // ADR-0301 — `--playbook-trigger` CLI flag echo. Spread conditionally
      // so `exactOptionalPropertyTypes` doesn't see a literal `undefined`.
      ...(setupWithExecution.playbookCliFlag !== undefined
        ? { playbookCliFlag: setupWithExecution.playbookCliFlag }
        : {}),
    })
  } finally {
    // Track T — tear down ring-buffer panel BEFORE other chrome dispose so
    // any DECSTBM reset lands first. Idempotent + no-op when not allocated.
    setup.timelinePanel?.teardown()
    setup.lifecyclePills.dispose()
    await setup.shutdownMcp()
  }
}
// Silence the unused-import lint for the legacy alias kept for back-compat.
void composeSurfaceSlashCtx
