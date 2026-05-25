import * as readline from "node:readline/promises"
import type { AgentConfig } from "@/agent"
import { RetryingLLM } from "@/agent"
import { FollowUpQueue } from "@/agent/follow-up-queue"
import { createInMemoryPlanStore, type PlanStore } from "@/agent/plan/state"
import {
  createSubagentBackedGuardianReview,
  materializeReviewerAgent,
} from "@/agent/tier1/reviewer-subagent"
import { buildShellOtelObserver, summarizeWorkMetrics } from "@/observability"
import {
  createDecisionCounterSink,
  defaultMetricsRegistry,
  type MetricsRegistry,
} from "@/observability/metrics/index"
import { getDefaultPermissionStore, type PermissionStore } from "@/permission"
import type { StreamPort } from "@/stream"
import { TeeStream } from "@/stream"
import { TaskRegistry } from "@/subagent"
import { composeShellObservers, type ShellExecObserver } from "@/tool"
import { type BranchProgressTracker, createBranchProgressTracker } from "./branch-search-progress"
import { type CostPanel, createCostPanel } from "./cost-panel"
import type { DebugCmdState } from "./debug-cmd"
import { createDebugTracer } from "./debug-tracer"
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
import { createLifecyclePills, type LifecyclePills, type McpPillServer } from "./lifecycle-pills"
import { createRejectCounter } from "./reject-counter"
import type { CliFeatureConfig } from "./repl/cli-feature-config"
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
import { runSessionCommand } from "./session-commands"
import { switchToSessionCwd } from "./session-io"
import { buildShellStreamPainter } from "./shell-stream-painter"
import { runSlashCommand, slashCompleter } from "./slash-commands"
import type { StatusBar } from "./status-bar"
import { createTimelinePanel, type TimelinePanel } from "./timeline-panel"
import { createTurnIndicator, type TurnIndicator } from "./turn-indicator"
import { createTurnSummary, type TurnSummaryCollector } from "./turn-summary"

/**
 * CLI REPL + main-orchestration body.
 *
 * Extracted from `index.ts` (Phase-3 split, RFC may-22-unified-agent-runtime
 * §3) as a pure structural refactor with ZERO behavior change for existing
 * CLI users. Every line, every branch, every log statement is verbatim
 * relocation; `index.ts` keeps only argv-routing short-circuits and delegates
 * here for the actual agent assembly + interactive/one-shot dispatch.
 *
 * Module boundary: `repl.ts` may import `@/agent`, `@/llm`, `@/observability`,
 * `@/permission`, `@/shared` and CLI-local helpers (`./internal`,
 * `./session-io`, `./session-commands`, `./slash-commands`). No cross-app
 * imports (no `apps/bench`, no `apps/agent`).
 */

/** Shared REPL-side slash-context state. Threaded through `dispatchReplSlash`
 *  → `runSlashCommand`. Each field is independently optional:
 *
 *    - `skills` ⇒ `/skills`, `/reload-skills` see the live registry.
 *    - `idle` / `imageQueue` ⇒ surface-local mutables.
 *    - `rewindSession` ⇒ `/rewind` and `/fork` find an active session id
 *      (and, when `QUANTA_REWIND_GIT=1`, an injected real-git port for
 *      `--restore-files`). Absent ⇒ those commands print "no active session"
 *      and exit 1 — never silently no-op.
 *    - `mcp` ⇒ `/mcp` sees the live config/tool snapshot when MCP is wired.
 *    - `cost` / `planSnapshot` / `history` / `branchSearch` / `side` ⇒
 *      S3 port wire-up. Each adapter is OPTIONAL — when its env/dep gate is
 *      off the field is OMITTED from `ReplSlashCtx` so the slash command
 *      keeps its existing "not wired" output (byte-identical default-OFF). */
export { dispatchReplSlash, type ReplSlashCtx } from "./repl/slash-surface"

/** Claude A1 rewind/fork: bind `/rewind` and `/fork` to the live session id.
 *  `--restore-files` additionally needs a real-git port wired in; gated on
 *  `QUANTA_REWIND_GIT=1` (default OFF — destructive). The slash command
 *  STILL re-checks the env knob before invoking the port (belt-and-
 *  suspenders), so toggling the env without restart is safe: port present +
 *  env=0 ⇒ refused with a clear message. Absent session id ⇒ `undefined`
 *  ⇒ the commands print "no active session" and exit 1 (never silent). */
const buildRewindSlashState = (
  sessionId: string | undefined,
  cwd: string,
  featureCfg: CliFeatureConfig,
): RewindSlashState | undefined => {
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined
  const git = featureCfg.rewindGit.enabled ? createCliRewindGitPort({ cwd }) : undefined
  return { sessionId, ...(git !== undefined ? { git } : {}) }
}

/** MEDIUM-10: top-level usage block. Printed when the user passes `--help` or
 *  `-h` BEFORE any prompt forwarding logic so a typo doesn't become an LLM
 *  prompt. The session subcommand has its own help under
 *  `quanta session --help`. */
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

/** Build the per-REPL multi-modal image queue (ADR-0083 extension). Default-ON
 *  with cap 5; `QUANTA_IMAGE_QUEUE=0` returns `undefined` so the surface
 *  short-circuits (`/image …` falls through to the surface-agnostic dispatcher
 *  which prints "unknown command"). Extracted from `runRepl` so the host stays
 *  under biome's cognitive-complexity budget. */
const buildImageQueue = (featureCfg: CliFeatureConfig): ImageQueue | undefined => {
  if (!featureCfg.imageQueue.enabled) return undefined
  return createImageQueue({ maxSize: featureCfg.imageQueue.maxSize })
}

/** Lifecycle pills build-bundle for the CLI surface — pre-creates the
 *  TaskRegistry / FollowUpQueue handles the surface needs to thread through
 *  the loop AND keep references to for per-turn polling. Each handle is
 *  `undefined` when its pill is suppressed (env knob OR pills globally off);
 *  the receiver passes `undefined` through and downstream wiring stays
 *  byte-identical (`subagent`/`followUpQueue` fields omitted entirely).
 *
 *  Extracted out of `runRepl` so the host stays under biome's cognitive-
 *  complexity budget — the function is otherwise a straight-line composer of
 *  the optional handles + pills instance. */
interface LifecycleBundle {
  pills: LifecyclePills
  taskRegistry: TaskRegistry | undefined
  followUpQueue: FollowUpQueue | undefined
}

const buildLifecycleBundle = (featureCfg: CliFeatureConfig): LifecycleBundle => {
  const { pills: pillsCfg, subagentForPills } = featureCfg
  // The TaskRegistry is allocated ONLY when subagent + pills are both ON.
  // The loop receives the same instance through `buildTooling` so all four
  // subagent tools share it; the CLI holds the handle for `pendingIds()`.
  const taskRegistry: TaskRegistry | undefined = subagentForPills ? new TaskRegistry() : undefined
  // FollowUpQueue is allocated when pills + follow-up pill are both ON. The
  // queue is currently producer-less from the CLI; this seam is forward-
  // compatible with mid-turn user input injection (no behavior change yet).
  const followUpQueue: FollowUpQueue | undefined =
    pillsCfg.enabled && !pillsCfg.hideFollowUp ? new FollowUpQueue() : undefined
  const pills: LifecyclePills = createLifecyclePills({
    enabled: pillsCfg.enabled,
    hideTasks: pillsCfg.hideTasks,
    hideFollowUp: pillsCfg.hideFollowUp,
    hideMcp: pillsCfg.hideMcp,
  })
  return { pills, taskRegistry, followUpQueue }
}

/** Derive the per-server MCP pill state from the bridged tools list. The
 *  tool name prefix `mcp__<server>__<tool>` (mcp-bridge.ts) is the only
 *  surface-visible link between a tool and its server — clients are opaque
 *  (no public getter for the config name). Returns an empty servers list
 *  when no MCP tools are bridged ⇒ the pill is omitted by the renderer. */
const deriveMcpPillServers = (mcpTools: ReadonlyArray<{ name: string }>): McpPillServer[] => {
  const perServer = new Map<string, number>()
  for (const t of mcpTools) {
    const m = /^mcp__([^_]+(?:_[^_]+)*)__/.exec(t.name)
    const serverKey = m?.[1] ?? "unknown"
    perServer.set(serverKey, (perServer.get(serverKey) ?? 0) + 1)
  }
  return [...perServer.entries()].map(([name, toolCount]) => ({
    name,
    status: "connected" as const,
    toolCount,
  }))
}

/** ADR-0064 L4: the default per-turn work-metrics sink. The collector + emit are
 *  already wired in the loop (gated on `AgentConfig.workMetricsSink`), but no
 *  DEFAULT sink existed so the metrics were collected and dropped. This wires
 *  one human-readable `work: <summary>` line per turn to stderr — the SAME
 *  surface the cost/cache dashboard renders to. Gated on `enabled` (the same
 *  `QUANTA_METRICS` knob); OFF ⇒ `undefined` so the loop allocates no collector
 *  (byte-identical). Extracted from `runRepl` to keep it under the biome
 *  cognitive-complexity budget. */
const buildWorkMetricsSink = (enabled: boolean): AgentConfig["workMetricsSink"] | undefined =>
  enabled
    ? { emit: (m): void => void process.stderr.write(`work: ${summarizeWorkMetrics(m)}\n`) }
    : undefined

/** S3 cost-panel adapter — built ONCE at REPL setup. Returns `undefined` when
 *  the gate refuses (non-TTY / `QUANTA_COST_PANEL=0`) so the surface omits the
 *  `cost` field from {@link ReplSlashCtx} and `/cost` keeps printing "not wired".
 *  When built, the caller folds per-turn metric DELTAS via
 *  {@link foldCostPanelDelta} and exposes `panel.renderDetailed` to the slash
 *  command. The metrics counters are CUMULATIVE across the session — we track
 *  the previous snapshot and feed only the delta into `incrementTurn`. */
const buildCostPanelOrUndefined = (
  featureCfg: CliFeatureConfig,
  model: string,
): CostPanel | undefined => {
  if (!featureCfg.costPanel.enabled) return undefined
  return createCostPanel({ enabled: true, model })
}

/** S3 branch-search progress tracker — built ONCE per session. Returns
 *  `undefined` when the env/TTY gate refuses so the `/branches` slash command
 *  keeps its existing "not wired" output (byte-identical). The tracker itself
 *  is empty-state until a search ingests events; the `/branches` panel prints
 *  "(no branch search recorded yet)" until that happens. */
const buildBranchProgressOrUndefined = (
  featureCfg: CliFeatureConfig,
): BranchProgressTracker | undefined => {
  if (!featureCfg.branchProgress.enabled) return undefined
  return createBranchProgressTracker()
}

/** S3 plan-store wire — default-OFF. The `/plan` slash command prints
 *  "not wired" unless `QUANTA_PLAN_STORE=1` is set (opt-in). When opt-in,
 *  we mint an in-memory `PlanStore` and thread it through `SessionDeps` so
 *  the agent's plan tools mutate the SAME store the surface reads from. */
const buildPlanStoreOrUndefined = (featureCfg: CliFeatureConfig): PlanStore | undefined => {
  if (!featureCfg.planStore.enabled) return undefined
  return createInMemoryPlanStore({ now: Date.now })
}

/** Bridge `AgentEvent`s into the live turn indicator. Implements `StreamPort`
 *  so it can be teed alongside the existing recorder/stdout port — the
 *  upstream emit path is unchanged (TeeStream forwards every event to every
 *  port in order) and the indicator just sips the ones it cares about.
 *
 *  Sliced taxonomy (only events that move the indicator state):
 *    - `assistant_text` / `tool_call` ⇒ `markFirstChunk` (TTFT seam — the
 *      first emit of either is the moment the model started producing
 *      something the user can see). Idempotent on the indicator side.
 *    - `usage` ⇒ `updateUsage` with the cumulative token counts. Cost stays
 *      OFF for now (no per-model price table is wired at this surface; a
 *      future round can hand a `costUsd` in).
 *  Every other event is ignored — the indicator is purely a UX surface, not
 *  a trajectory recorder. Errors in the indicator are swallowed in place so
 *  a faulty render can never poison the recorder path. */
const buildIndicatorPort = (ind: TurnIndicator): StreamPort => ({
  emit: (event): void => {
    try {
      if (event.type === "assistant_text" || event.type === "tool_call") {
        ind.markFirstChunk()
        return
      }
      if (event.type === "usage") {
        ind.updateUsage({
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
        })
      }
    } catch {
      // Intentional: an indicator failure must not surface as an emit error
      // (TeeStream would otherwise track it as a degraded record).
    }
  },
})

/** ADR-0270 — gated MetricsRegistry allocator for the decision-counter sink.
 *  Returns a fresh `defaultMetricsRegistry()` when the caller's typed
 *  feature flag is ON; otherwise `undefined` so the byte-identical no-tee
 *  path holds (no MetricsRegistry allocated, no sink port appended).
 *
 *  Default-OFF: `featureCfg.decisionMetricsEnabled` is `false` unless the
 *  operator opts in via `QUANTA_DECISION_METRICS` (parsed up-front in
 *  `cli-feature-config.ts`). */
const resolveDecisionMetricsRegistry = (enabled: boolean): MetricsRegistry | undefined =>
  enabled ? defaultMetricsRegistry() : undefined

/** ADR-0270 — append the decision → counter sink to a stream tee. Pure helper
 *  with NO env / NO global state — every input is explicit so tests can drive
 *  it directly and so the wiring inside `buildTurnSummaryAndStream` stays
 *  byte-identical when `metrics` is `undefined`.
 *
 *  When `metrics === undefined` the function returns the literal `stream`
 *  reference (no TeeStream allocated, no extra fan-out). When wired, it
 *  returns a new TeeStream that forwards every event to BOTH the upstream
 *  `stream` and the sink — exactly the same tee posture the turn-summary /
 *  debug / indicator consumers use. */
const appendDecisionCounterSink = (
  stream: StreamPort,
  metrics: MetricsRegistry | undefined,
): StreamPort => {
  if (metrics === undefined) return stream
  const sink = createDecisionCounterSink({ metrics })
  return new TeeStream([stream, sink])
}

/** Build the turn-summary collector + tee-wrap the upstream stream. Default-ON
 *  for TTY surfaces (auto-OFF on pipes/redirects) so the operator sees a
 *  per-turn signal box (tools / verify-guard / compaction / memory / recovery)
 *  WITHOUT opting in. Explicit `QUANTA_TURN_SUMMARY=0|false|off|no` reverts to
 *  the pre-summary code path (`{collector: disabled, stream}` ⇒ the renderer
 *  returns `""` and we write nothing).
 *
 *  Byte-identical: when the collector is disabled the returned `stream`
 *  reference is the literal input — no TeeStream allocated, no extra fan-out,
 *  so the existing recorder/stdout/indicator port path is identical to today's.
 *
 *  ADR-0270 wire seam — the decision-counter sink is folded into the SAME tee
 *  position as the turn-summary collector. When `QUANTA_DECISION_METRICS=1`
 *  AND the summary collector is enabled, the returned stream tees to BOTH
 *  consumers. When the env knob is off (default), no sink is appended and the
 *  returned stream is whatever the summary path produced — preserving the
 *  byte-identical no-tee path when both consumers are disabled. */
const buildTurnSummaryAndStream = (
  featureCfg: CliFeatureConfig,
  stream: StreamPort,
): { collector: TurnSummaryCollector; stream: StreamPort } => {
  const { enabled, verbose } = featureCfg.turnSummary
  const collector = createTurnSummary({ enabled, verbose })
  const decisionMetrics = resolveDecisionMetricsRegistry(featureCfg.decisionMetricsEnabled)
  if (!enabled) {
    // Summary collector OFF — the decision-counter sink can still be appended
    // if the operator opts in via the env knob. When both are OFF (the
    // default), the returned stream is the literal input (byte-identical
    // no-tee path).
    return { collector, stream: appendDecisionCounterSink(stream, decisionMetrics) }
  }
  const teed = new TeeStream([stream, collector.asStreamPort()])
  return { collector, stream: appendDecisionCounterSink(teed, decisionMetrics) }
}

/** Build the (indicator, turnStream) pair for the REPL surface — extracted
 *  from `runRepl` so the host stays under biome's cognitive-complexity
 *  budget. Default-OFF byte-identical: when the indicator is disabled
 *  (non-TTY or `QUANTA_SPINNER=0|false|off|no`) `turnStream === stream`
 *  verbatim (no tee, no extra fan-out) so the existing recorder + stdout
 *  port path is byte-identical to the pre-indicator code. `intervalMs`
 *  is clamped to a finite positive integer; a bad env value (`abc`, `-5`)
 *  falls back to the 80 ms default. */
const buildTurnIndicatorAndStream = (
  featureCfg: CliFeatureConfig,
  statusBar: StatusBar,
  stream: StreamPort,
): { indicator: TurnIndicator; turnStream: StreamPort } => {
  const { enabled, intervalMs } = featureCfg.turnIndicator
  const indicator = createTurnIndicator({ statusBar, enabled, intervalMs })
  if (!enabled) return { indicator, turnStream: stream }
  return { indicator, turnStream: new TeeStream([stream, buildIndicatorPort(indicator)]) }
}

/** Track D — build the debug-tracer + tee-wrap the stream + return the
 *  surface-mutable {@link DebugTracerHandle}. Default-OFF byte-identical:
 *  when `QUANTA_DEBUG` is unset (or parsed disabled) OR stderr is not a
 *  TTY, returns the literal `stream` reference + `debugHandle: undefined`
 *  ⇒ no tee allocated, no extra consumer, the `/debug` slash prints
 *  "not wired" + exits 0.
 *
 *  When the boot gate passes, allocates ONE mutable proxy port wrapping a
 *  live tracer ref. The `/debug` slash mutates `state` through
 *  `debugHandle.set(...)`; on every subsequent emit the proxy reads the
 *  CURRENT state and either invokes the tracer (when enabled) or no-ops
 *  (when disabled). Categories are honored by the tracer itself
 *  (Track C). The proxy is the ONLY thing teed in — re-allocating a
 *  tracer per state change keeps `startedAt` aligned with the LAST
 *  toggle so on-screen timestamps are intuitive ("ms since /debug on").
 *  A failure inside the tracer is swallowed in place (TeeStream would
 *  otherwise mark a degraded record). */
const buildDebugTracerAndStream = (
  featureCfg: CliFeatureConfig,
  stream: StreamPort,
): {
  stream: StreamPort
  debugHandle: import("./repl/session-setup").DebugTracerHandle | undefined
} => {
  // Non-TTY ⇒ forced disable (captured up-front in featureCfg.debugTracer.enabled
  // alongside the parsed QUANTA_DEBUG knob) to avoid polluting pipe/redirect output.
  if (!featureCfg.debugTracer.enabled) return { stream, debugHandle: undefined }
  // Live state ref + tracer ref. The tracer is rebuilt on each
  // `set(state)` so options (categories, startedAt) reflect the latest
  // toggle. Initial tracer is built once for the boot-enabled state.
  let state: DebugCmdState =
    featureCfg.debugTracer.categories !== undefined
      ? { enabled: true, categories: featureCfg.debugTracer.categories }
      : { enabled: true }
  const buildTracer = (s: DebugCmdState): ReturnType<typeof createDebugTracer> | null => {
    if (!s.enabled) return null
    return createDebugTracer({
      ...(s.categories !== undefined ? { categories: s.categories } : {}),
    })
  }
  let tracer = buildTracer(state)
  const proxy: StreamPort = {
    emit: (event): void => {
      if (tracer === null) return
      try {
        tracer(event)
      } catch {
        // Same posture as buildIndicatorPort: never poison the tee.
      }
    },
  }
  const debugHandle: import("./repl/session-setup").DebugTracerHandle = {
    get: () => state,
    set: (next) => {
      state = next
      tracer = buildTracer(next)
    },
  }
  return { stream: new TeeStream([stream, proxy]), debugHandle }
}

/** Track T — build the timeline ring-buffer panel + tee-wrap the stream.
 *  Default-OFF byte-identical: when `QUANTA_TIMELINE` is unset / 0 /
 *  non-finite OR stderr is not a TTY, returns the literal `stream` reference
 *  + `panel: undefined` ⇒ no tee allocated, no extra consumer, no DECSTBM
 *  write, no ring buffer.
 *
 *  When the boot gate passes, allocates ONE timeline panel + a proxy port
 *  that tees every `AgentEvent` into the panel's `emit`. Emit errors are
 *  swallowed in place (same posture as `buildIndicatorPort` /
 *  `buildDebugTracerAndStream`) so a faulty render can never poison the
 *  recorder tee. The host calls `panel.teardown()` in `runRepl`'s `finally`
 *  block so a follow-on shell prompt lands on a clean screen. */
const buildTimelinePanelAndStream = (
  featureCfg: CliFeatureConfig,
  stream: StreamPort,
): { stream: StreamPort; panel: TimelinePanel | undefined } => {
  if (!featureCfg.timelinePanel.enabled) return { stream, panel: undefined }
  const panel = createTimelinePanel({ height: featureCfg.timelinePanel.height })
  const proxy: StreamPort = {
    emit: (event): void => {
      try {
        panel.emit(event)
      } catch {
        // Same posture as buildIndicatorPort / buildDebugTracerAndStream:
        // never poison the tee from a UX-only consumer.
      }
    },
  }
  return { stream: new TeeStream([stream, proxy]), panel }
}

/** Route `quanta session …` to the session subcommand dispatcher. Returns the
 *  exit code so the caller can `process.exit(...)`. None of the agent/REPL
 *  wiring runs in this branch — that's how byte-identical default-OFF holds
 *  when no `session` subcommand is given. */
export const runSessionMain = async (): Promise<number> => {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
    completer: slashCompleter,
  })
  const code = await runSessionCommand(process.argv.slice(3), {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    confirm: async (prompt) => {
      const ans = await rl.question(prompt)
      return ans.trim().toLowerCase() === "y"
    },
  })
  rl.close()
  return code
}

/** Run the matching built-in slash command and exit. Extracted from `main()`
 *  to keep its cognitive complexity within the biome budget — the slash gate
 *  is one decision (`isSlashCommand`) plus one dispatch (`runSlashCommand`)
 *  and reads cleanly as its own helper. Tier-2 absorption #2-1. */
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

/**
 * Main REPL/one-shot entry: assembles the agent stack, resolves the resume
 * state machine, and delegates interactive vs argv-prompt dispatch to
 * {@link runSessionLoop}.
 *
 * This is a verbatim relocation of the post-routing body of `main()` from
 * `index.ts`. Caller (`index.ts::main`) is responsible for the argv-routing
 * short-circuits (`session` subcommand / `/<slash>` / `--help`) BEFORE
 * delegating here.
 */

/** ADR-0299 — compose the LLM stack at the CLI seam. Same byte-identical
 *  sequence the prior `buildLlmStack` inside `bootstrapSession` ran:
 *  `buildLLM` → `RetryingLLM` → `composeLLM`. Passed as a single closure into
 *  the host so the host slice does not import `@/llm` adapters directly. */
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

/** ADR-0299 — compose the per-turn shell-event observer from the surface.
 *  Replaces the inline `composeShellEvent` previously in `session-bootstrap.ts`. */
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

/** ADR-0299 — build the surface-side idle/reject guards. Concrete ports
 *  touch node:fs/node:os so they stay in the CLI; the host receives them as
 *  opaque values through the bootstrap result. */
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

/** Slice-C: bundle the {@link setupSession} factories the host wires.
 *  Lifted out of `runRepl` so the orchestrator stays inside the spec's
 *  ≤ 50 LOC budget — each factory still resolves to the SAME closure the
 *  prior inline code allocated (byte-identical). */
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

/** Slice-C SOLID split — thin orchestrator over the 6 helpers under
 *  `src/apps/cli/repl/`:
 *
 *   1. {@link setupSession}            — first-block prelude (session-setup.ts)
 *   2. {@link composePromptPipeline}   — raw-line ➜ slash ➜ idle (prompt-pipeline.ts)
 *   3. {@link runOneTurn}              — per-turn wrapper DRY win (turn-runner.ts)
 *   4. {@link installTurnCancel}       — Esc-Esc / Ctrl+C FSM (turn-cancel-install.ts)
 *   5. {@link SessionState}            — replaces 5 god-state lets (session-state.ts)
 *   6. {@link runSessionLoop}          — argv-prompt vs interactive (session-loop.ts)
 *
 *  The host (this file) still owns the slashCtx composition + the per-turn
 *  render sinks (cost dashboard / summary panel / pills flush) so all
 *  S3-adapter wiring (costPanel / branchProgress / planStore / rewindState)
 *  stays at the surface. Byte-identical default behavior — every helper is
 *  a pure relocation of the prior inline code. */
export const runRepl = async (): Promise<void> => {
  const setup = await setupSession(sessionSetupDeps)
  const featureCfg = setup.featureCfg
  const surfaceState = createSurfaceState({
    imageQueue: setup.argPrompt ? undefined : buildImageQueue(featureCfg),
    rewindState: buildRewindSlashState(setup.sessionId, setup.cwd, featureCfg),
    history: setup.history,
  })
  try {
    // ADR-0299 — surface composition wire. Builds the slash ctx PLUS the
    // wire bundle (conv-checkpoint, playbook-trigger seam, composer +
    // textInbox handles). Each upstream knob (env / CLI flag) gates the
    // ctx slot independently so the projection is byte-identical to
    // legacy when no opt-in is present (RFC §1.2). The bundled
    // `dispatchSlash` closure routes through the FULL augmented
    // SlashContext (legacy + ADR-0291 + ADR-0292 + ADR-0294 slots).
    const wires = composeSurfaceWires(setup, surfaceState, process.env)
    await runSessionLoop({
      setup,
      dispatchSlash: wires.dispatchSlash,
      sinks: composeTurnSinks(setup, surfaceState),
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
      ...(setup.playbookCliFlag !== undefined ? { playbookCliFlag: setup.playbookCliFlag } : {}),
    })
  } finally {
    // Track T — tear down the ring-buffer panel BEFORE other surface
    // teardowns so any DECSTBM reset writes land before subsequent
    // chrome dispose. Idempotent + no-op when the panel wasn't allocated
    // (default-OFF byte-identical: this entire block becomes a function
    // call returning undefined).
    setup.timelinePanel?.teardown()
    setup.lifecyclePills.dispose()
    await setup.shutdownMcp()
  }
}
// Silence the unused-import lint for the legacy alias kept for back-compat.
void composeSurfaceSlashCtx
