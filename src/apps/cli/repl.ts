import * as readline from "node:readline/promises"
import { RetryingLLM } from "@/agent"
import { defaultConversationCheckpointStore } from "@/agent/conversation-checkpoint"
import {
  createSubagentBackedGuardianAssess,
  createSubagentBackedGuardianReview,
  materializeReviewerAgent,
} from "@/agent/tier1/reviewer-subagent"
import { defaultResponsesContinuationStore } from "@/llm"
import { buildShellOtelObserver } from "@/observability"
import { getDefaultPermissionStore, type PermissionStore } from "@/permission"
import { bootstrapCrashResumeOffers, selectCrashResumeReinject } from "@/runner/orchestrate"
import { redactSecrets } from "@/security"
import { clearSessionInterrupted, crashResumeEnabled, listSessions } from "@/session"
import { errMessage, gateOn, logger, runtimeConfig } from "@/shared"
import { composeShellObservers, type ShellExecObserver } from "@/tool"
import { emitConfigMigrationImport, emitConfigMigrationNotice } from "./config-migration-notice"
import { createIdleMonitor, DEFAULT_IDLE_MS } from "./idle-monitor"
import { loadImageBlock } from "./image-loader"
import { createImageQueue, type ImageQueue } from "./image-queue"
import {
  buildAutoTitlePort,
  buildLLMWithByok,
  buildSkillsConfig,
  buildStreaming,
  buildTooling,
  composeLLM,
  loadFeatures,
  pickIdentity,
  pickPersona,
  resolveResume,
} from "./internal"
import { computePresence } from "./notify"
import { createRejectCounter } from "./reject-counter"
import type { CliFeatureConfig } from "./repl/cli-feature-config"
import {
  buildBranchProgressOrUndefined,
  buildCostPanelOrUndefined,
  buildDebugTracerAndStream,
  buildLifecycleBundle,
  buildNotifyAndContextWarning,
  buildPlanStoreOrUndefined,
  buildTimelinePanelAndStream,
  buildTurnIndicatorAndStream,
  buildTurnSummaryAndStream,
  buildWorkMetricsSink,
  deriveMcpPillServers,
} from "./repl/factories"
import { buildMcpSurfaceInfo } from "./repl/mcp-surface-wire"
import { runSessionLoop } from "./repl/session-loop"
import { buildSessionLoopOptions } from "./repl/session-loop-options"
import { maybePickSession } from "./repl/session-picker"
import { setupSession } from "./repl/session-setup"
import { buildSkillsCallback, installPills } from "./repl/skills-surface"
import {
  composeSurfaceSlashCtx,
  composeSurfaceWires,
  createSurfaceState,
} from "./repl/surface-compose"
import type { RewindSlashState } from "./rewind-cmd"
import { createCliRewindGitPort } from "./rewind-git"
import { switchToSessionCwd } from "./session-io"
import { buildShellStreamPainter } from "./shell-stream-painter"
import { runSlashCommand } from "./slash-commands"
import { buildWelcomeInfo, renderWelcomeBanner } from "./welcome-banner"

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
export { runSessionMain } from "./session-main"
export { topLevelUsage } from "./top-level-usage"

/** Build the per-REPL multi-modal image queue (ADR-0083). Default-ON cap 5;
 *  `QUANTA_IMAGE_QUEUE=0` returns `undefined` so the surface short-circuits. */
const buildImageQueue = (featureCfg: CliFeatureConfig): ImageQueue | undefined => {
  if (!featureCfg.imageQueue.enabled) return undefined
  return createImageQueue({ maxSize: featureCfg.imageQueue.maxSize })
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

/** ADR-0299 + jun-6 H7-BYOK — compose the LLM stack at the CLI seam:
 *  `buildLLMWithByok` → `RetryingLLM` → `composeLLM`. ASYNC: the inner build may
 *  `await` an `apiKeyHelper` mint on the legacy vendor path under
 *  `QUANTA_API_KEY_HELPER_LEGACY_VENDOR=1`; off / cloud-transport ⇒ it delegates
 *  to the sync `buildLLM` (resolves immediately, byte-identical). `bootstrapSession`
 *  already `await`s the returned promise. */
const cliBuildLlm: Parameters<typeof setupSession>[0]["buildLlm"] = async (
  provider,
  model,
  mode,
  permission,
  signal,
  slog,
  routeEventSink,
) => {
  const llm = await buildLLMWithByok(provider, model)
  const retryingLLM = new RetryingLLM({ inner: llm, signal })
  // RFC02-3 (A8) — forward the host's PRODUCTION route sink (present ONLY under
  // QUANTA_MODEL_REROUTE_EVENT) into the composed stack so a real FallbackLLM swap
  // emits `model_route_changed` on the live stream. Absent ⇒ byte-identical.
  return composeLLM(retryingLLM, provider, signal, mode, permission, slog, routeEventSink)
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

/**
 * Fail-soft durable permission-store load (G-F8). Fallback stays `undefined`.
 * Warning fires once; a throwing sink does not become a boot crash.
 */
export const loadPermissionStoreFailSoft = async (
  open: () => Promise<PermissionStore>,
  warn: (message: string) => void,
): Promise<PermissionStore | undefined> => {
  try {
    return await open()
  } catch (e) {
    try {
      warn(
        `cli.loadPermissionStore: ${redactSecrets(errMessage(e), { origin: "envelope_jsonl" }).text}`,
      )
    } catch {
      // Diagnostic failure must not convert fail-soft into throw.
    }
    return undefined
  }
}

/** Bundle the {@link setupSession} factories the host wires. CLI-06
 *  (ADR-0307) — the 10 surface-adapter factories live under
 *  `./repl/factories/`; the wrappers here just narrow the host's `unknown`
 *  featureCfg arg back to `CliFeatureConfig`. */
const sessionSetupDeps: Parameters<typeof setupSession>[0] = {
  // The host slice declares the featureCfg parameter as `unknown` so it
  // stays slice-clean (no import of `apps/cli/repl/cli-feature-config`).
  // The CLI surface narrows it back to `CliFeatureConfig` at each call site.
  buildLifecycleBundle: (cfg, env) => buildLifecycleBundle(cfg as CliFeatureConfig, env),
  deriveMcpPillServers,
  buildCostPanelOrUndefined: (cfg, model, accounting) =>
    buildCostPanelOrUndefined(cfg as CliFeatureConfig, model, accounting),
  buildBranchProgressOrUndefined: (cfg) => buildBranchProgressOrUndefined(cfg as CliFeatureConfig),
  buildPlanStoreOrUndefined: (cfg) => buildPlanStoreOrUndefined(cfg as CliFeatureConfig),
  buildTurnSummaryAndStream,
  buildTurnIndicatorAndStream,
  buildDebugTracerAndStream,
  buildTimelinePanelAndStream,
  buildWorkMetricsSink,
  // ADR-0299 — env-bound factories the host consumes as deps.
  buildLlm: cliBuildLlm,
  // jun-6 (ai-session-title) — default-OFF ⇒ undefined ⇒ byte-identical.
  buildAutoTitlePort: (provider, signal) => buildAutoTitlePort(provider, signal),
  buildStreaming,
  buildTooling,
  // B1 (jun-04) — adapt the host's `(slog, llm?)` factory shape to the CLI
  // surface's `(slog, opts)` loader: the threaded LLM becomes the `llm` opt so
  // an inbound MCP `sampling/createMessage` can be fulfilled. Omitted ⇒ `{}` ⇒
  // byte-identical (no sampling wiring).
  // H3 (jun-10 session-scoped egress) — the bootstrap opens the session proxy and
  // hands its `proxyEnv` down so each MCP stdio child's own sockets are gated.
  // Absent / proxy OFF ⇒ `{}` slot omitted ⇒ byte-identical load.
  loadFeatures: (slog, llm, proxyEnv) =>
    loadFeatures(slog, {
      ...(llm !== undefined ? { llm } : {}),
      ...(proxyEnv !== undefined ? { proxyEnv } : {}),
    }),
  loadImageBlock,
  pickIdentity,
  pickPersona,
  resolveResume,
  composeShellEvent: cliComposeShellEvent,
  switchToSessionCwd,
  materializeReviewerAgent,
  createSubagentBackedGuardianReview,
  createSubagentBackedGuardianAssess,
  buildMcpSurfaceInfo,
  buildIdleGuards: cliBuildIdleGuards,
  loadPermissionStore: () =>
    loadPermissionStoreFailSoft(
      async () => {
        const store = getDefaultPermissionStore()
        await store.load()
        return store
      },
      (message) => logger.warn(message),
    ),
  installPills,
}

/** Thin orchestrator over the 6 helpers under `src/apps/cli/repl/`:
 *  `setupSession` → `composePromptPipeline` → `runOneTurn` → `installTurnCancel`
 *  → `SessionState` → `runSessionLoop`. The host owns slashCtx composition +
 *  per-turn render sinks; byte-identical default behavior. */
/**
 * jun-10 — the welcome banner: the interactive surface's FIRST paint (the
 * Claude-Code-style entry box). Interactive + TTY only: one-shot (`argPrompt`),
 * piped and eval launches never see it (byte-identical). Writes to stderr like
 * every other surface chrome — stdout stays the agent stream.
 *
 * Extracted from `runRepl` (aug-27) so that function stays under the god-FN cap:
 * the banner is now the only place that resolves three host-owned facts (the two
 * affordance gates, the strict envelope posture, and the effective model), and
 * that cluster reads better named than inlined.
 *
 * UUX-2-23/5-18 — the banner itself is a PURE renderer; the gate states are
 * computed HERE (the same env truthiness the composers use), except the security
 * posture, which must come from the frozen strict runtime-config authority
 * (`gateOn` accepts "true"/"on", which would make the banner claim envelope
 * protection while the dispatch seam stayed disabled).
 */
export const paintWelcomeBanner = (setup: Awaited<ReturnType<typeof setupSession>>): void => {
  if (setup.argPrompt !== undefined || setup.stderrIsTTY !== true) return
  process.stderr.write(
    `${renderWelcomeBanner(
      buildWelcomeInfo(
        setup,
        setup.homeDir.length > 0 ? setup.homeDir : undefined,
        {
          modeCycle: gateOn(process.env, "QUANTA_MODE_CYCLE"),
          atMention: gateOn(process.env, "QUANTA_AT_AUTOCOMPLETE"),
          untrustedEnvelope: runtimeConfig().untrustedEnvelope,
        },
        // aug-28 — announce the EFFECTIVE model (a `/model` pick persists to
        // `~/.quanta/sticky-model.json` and the loop applies it from turn 1, so a
        // banner pinned to the boot model is a false claim on every resumed
        // session). Resolved ONCE in `setupSession` and shared with the status-bar
        // preamble and the repointable status-line source. The banner used to
        // resolve it here itself, which is how it became the ONLY first-paint
        // surface telling the truth: measured over a real pty, the banner named the
        // persisted pick while the status bar named the boot model IN THE SAME
        // FRAME — and the status bar paints once at boot, so it never corrected.
        setup.effectiveBootModel,
      ),
    )}\n`,
  )
}

export const runRepl = async (): Promise<void> => {
  await maybePickSession()
  const convStore = defaultConversationCheckpointStore()
  const responsesStore = defaultResponsesContinuationStore()
  const setup = await setupSession(sessionSetupDeps, { convStore, responsesStore })
  const featureCfg = setup.featureCfg
  const surfaceState = createSurfaceState({
    imageQueue: setup.argPrompt ? undefined : buildImageQueue(featureCfg),
    rewindState: buildRewindSlashState(setup.sessionId, setup.cwd, featureCfg),
    history: setup.history,
  })
  try {
    paintWelcomeBanner(setup)
    // H13 — gated external-config migration notice (default-OFF behind
    // QUANTA_MIGRATE_CONFIG). Detects competitor (Claude Code / Cursor) config
    // under ~ + cwd, converts it to the quanta shape, throttles a re-offer, and
    // surfaces a one-line stderr notice. Knob off ⇒ no detect / no disk touch /
    // byte-identical. Awaited (cheap: a handful of stat probes) but no-throw.
    await emitConfigMigrationNotice(setup.cwd)
    // H13 PERSIST — the CONFIRMED, opt-in import step. Gated by BOTH
    // QUANTA_MIGRATE_CONFIG=1 (feature) AND QUANTA_MIGRATE_CONFIG_IMPORT=1
    // (the user opting in to actually WRITE). The notice above only records
    // `offered`; this writes the converted config into quanta's live locations
    // (settings.json permissions/hooks, .mcp.json, .quanta/agents, AGENTS.md,
    // .quanta/rules), records `imported` (so re-runs are no-ops), and surfaces a
    // one-line stderr summary. Either knob unset ⇒ no detect / no persist /
    // byte-identical. No-throw. RFC03-def — capture the review/approve surface
    // for any staged imported skill so `/skills review` can consume it (bound to
    // the SAME approval machine + artifact port + staging store the import staged
    // into). `undefined` when nothing staged ⇒ the slot is omitted (default-OFF).
    const skillReview = await emitConfigMigrationImport(setup.cwd)
    // ADR-0299 — surface composition wire. Builds the slash ctx PLUS the
    // wire bundle (conv-checkpoint, playbook-trigger seam, composer +
    // textInbox handles). Each upstream knob (env / CLI flag) gates the
    // ctx slot independently so the projection is byte-identical to
    // legacy when no opt-in is present (RFC §1.2). The bundled
    // `dispatchSlash` closure routes through the FULL augmented
    // SlashContext (legacy + ADR-0291 + ADR-0292 + ADR-0294 slots).
    const wires = composeSurfaceWires(setup, surfaceState, process.env, {
      convStore,
      ...(skillReview === undefined ? {} : { skillReview }),
    })
    // RFC-09 (A+B) / ADR-0444+0445 — notify port + pre-compaction warning
    // (factory owns env/TTY reads; all fields undefined ⇒ default-OFF).
    const rfc09 = buildNotifyAndContextWarning({
      cwd: setup.cwd,
      contextUsageView: wires.contextUsageView,
      // B5 (jul-03→jul-04) — SSOT presence probe. Reuses the existing
      // IdleMonitor's idle window (`QUANTA_IDLE_MS`), no parallel focus tracker.
      // Now routed through the SHARED `computePresence` decision (the same rule
      // the web reuses): the CLI has no tab ⇒ `tabVisible: true`, so this reduces
      // to the legacy activity-only `!isIdle()` while pinning ONE presence rule
      // across surfaces. Activity age comes from the monitor's own clock
      // (`msSinceActive`) so there is no second clock; `now - lastActivityAt`
      // therefore equals `msSinceActive()`. The factory attaches this ONLY when
      // QUANTA_NOTIFY_PRESENCE opts in (default-OFF).
      isUserPresent: () =>
        computePresence({
          tabVisible: true,
          now: setup.idleMonitor.msSinceActive?.() ?? 0,
          lastActivityAt: 0,
          thresholdMs: setup.idleMonitor.thresholdMs ?? DEFAULT_IDLE_MS,
        }),
    })
    // ADR-0528 L2 — crash-resume on restart. Gate FIRST so a gate-off / one-shot
    // / non-TTY launch never even lists sessions (byte-identical). The CURRENT
    // session's OWN mid-turn crash ⇒ prompt to AUTO re-inject its task as turn-1
    // (e.g. `quanta --resume X` where X crashed); OTHER interrupted sessions ⇒
    // surface-only (resume via `--resume <id>`). A stranger's task is NEVER
    // injected into the current session (selectCrashResumeReinject fence).
    let crashResumeSeeds: readonly string[] | undefined
    if (
      setup.argPrompt === undefined &&
      setup.stderrIsTTY === true &&
      crashResumeEnabled(process.env)
    ) {
      const offers = await bootstrapCrashResumeOffers(
        await listSessions({ includeArchived: false }),
        { env: process.env },
      )
      const { own, others } = selectCrashResumeReinject(offers, setup.sessionId)
      if (own !== undefined) {
        process.stderr.write(`\x1b[2m⏮ ${own.summary}\x1b[0m\n`)
        const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
        const ans = (await rl.question("Resume this interrupted task? (y/N) ")).trim().toLowerCase()
        rl.close()
        if (ans === "y" || ans === "yes") {
          crashResumeSeeds = [own.resumeMessage]
          await clearSessionInterrupted(own.sessionId, { env: process.env })
        }
      }
      const otherTop = others[0]
      if (otherTop !== undefined) {
        process.stderr.write(
          `\x1b[2m⏮ ${otherTop.summary} — \`quanta --resume ${otherTop.sessionId}\`\x1b[0m\n`,
        )
      }
    }
    // CLI-06 (ADR-0307) — the per-turn loop wiring is assembled in
    // `repl/session-loop-options.ts` (same host-slimming pattern as
    // `repl/factories/`); the host owns only entry routing + compose.
    try {
      await runSessionLoop(
        await buildSessionLoopOptions({
          setup,
          surfaceState,
          wires,
          rfc09,
          featureCfg,
          env: process.env,
          // #8 (jun-6) — host binds stdin for the in-turn reader (only consumed
          // when QUANTA_MIDTURN_CAPTURE=1; the loop/reader slice never poke stdin).
          inTurnStdin: process.stdin,
          // ADR-0528 L2 — accepted crash-resume task seeded as the first turn.
          ...(crashResumeSeeds !== undefined ? { seedPrompts: crashResumeSeeds } : {}),
        }),
      )
    } finally {
      wires.disposePerToolRecord?.()
    }
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
