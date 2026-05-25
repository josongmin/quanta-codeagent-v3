import * as readline from "node:readline/promises"
import { type AgentConfig, type EffortLevel, parseEffort, resolveAgentMode } from "@/agent"
import { FollowUpQueue } from "@/agent/follow-up-queue"
import { createInMemoryPlanStore, type PlanStore } from "@/agent/plan/state"
import type { Message } from "@/llm"
import {
  buildCostDashboard,
  GEN_AI_ATTRS,
  renderDashboardText,
  summarizeWorkMetrics,
} from "@/observability"
import { discoverSkills, discoverSystemSkills } from "@/skill"
import type { StreamPort } from "@/stream"
import { TeeStream } from "@/stream"
import { TaskRegistry } from "@/subagent"
import {
  type BranchProgressTracker,
  createBranchProgressTracker,
  isBranchProgressEnabled,
} from "./branch-search-progress"
import { type CostPanel, createCostPanel, isCostPanelEnabled } from "./cost-panel"
import type { DebugCmdState } from "./debug-cmd"
import { createDebugTracer, parseDebugEnv } from "./debug-tracer"
import type { HistorySessionState } from "./history-cmd"
import type { IdleMonitor } from "./idle-monitor"
import { runImageCmd } from "./image-cmd"
import { createImageQueue, type ImageQueue } from "./image-queue"
import { assembleConfig, buildSkillsConfig, env, type SessionDeps } from "./internal"
import {
  createLifecyclePills,
  isLifecyclePillsEnabled,
  type LifecyclePills,
  type McpPillServer,
  readPillEnvFlags,
} from "./lifecycle-pills"
import { createPromptHistory, type PromptHistory } from "./prompt-history"
import { runSessionLoop } from "./repl/session-loop"
import { setupSession } from "./repl/session-setup"
import type { RewindSlashState } from "./rewind-cmd"
import { createCliRewindGitPort, isCliRewindGitEnabled } from "./rewind-git"
import { buildRuleInventory, isRulePillEnabled } from "./rule-indicator"
import { runSessionCommand } from "./session-commands"
import type { SideChatSessionState } from "./side-cmd"
import { isSlashCommand, runSlashCommand, type SkillRow, slashCompleter } from "./slash-commands"
import type { StatusBar } from "./status-bar"
import { createStatusPills, type SandboxMode } from "./status-pills"
import { createTurnIndicator, isIndicatorEnabled, type TurnIndicator } from "./turn-indicator"
import {
  createTurnSummary,
  isTurnSummaryEnabled,
  isTurnSummaryVerbose,
  type TurnSummaryCollector,
} from "./turn-summary"

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
export type ReplSlashCtx = Partial<{
  skills: () => Promise<SkillRow[]>
  idle: IdleMonitor
  imageQueue: ImageQueue
  rewindSession: RewindSlashState
  mcp: import("./mcp-cmd").McpSurfaceInfo
  cost: () => string
  planSnapshot: () => import("@/agent/plan/types").Plan | null
  history: HistorySessionState
  branchSearch: () => import("./branch-search-progress").BranchProgressState
  /** `/side` SessionState FACTORY — built fresh on each invocation so the
   *  `messages` value reflects the LIVE transcript (the surface-scoped
   *  `history: Message[]` binding is reassigned per turn). Stored as a
   *  callback rather than a value to avoid stale snapshots. */
  side: () => SideChatSessionState
  /** Track D — debug-tracer runtime toggle. Present iff the boot gate
   *  allocated the mutable proxy port; absent ⇒ `/debug` slash prints
   *  "not wired" + the QUANTA_DEBUG hint. */
  debug: { get: () => DebugCmdState; set: (state: DebugCmdState) => void }
}>

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
): RewindSlashState | undefined => {
  if (typeof sessionId !== "string" || sessionId.length === 0) return undefined
  const git = isCliRewindGitEnabled(process.env) ? createCliRewindGitPort({ cwd }) : undefined
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
const buildImageQueue = (): ImageQueue | undefined => {
  const imageQueueEnabled = env("QUANTA_IMAGE_QUEUE", "1") !== "0"
  if (!imageQueueEnabled) return undefined
  const raw = Number(env("QUANTA_IMAGE_MAX_QUEUE", "5"))
  return createImageQueue({
    maxSize: Number.isFinite(raw) && raw > 0 ? raw : 5,
  })
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

const buildLifecycleBundle = (): LifecycleBundle => {
  const pillsEnabled = isLifecyclePillsEnabled(process.env, process.stderr.isTTY)
  const pillFlags = readPillEnvFlags(process.env)
  // The TaskRegistry is allocated ONLY when subagent + pills are both ON.
  // The loop receives the same instance through `buildTooling` so all four
  // subagent tools share it; the CLI holds the handle for `pendingIds()`.
  const subagentEnabledForPills =
    pillsEnabled && !pillFlags.hideTasks && process.env.QUANTA_SUBAGENT !== undefined
  const taskRegistry: TaskRegistry | undefined = subagentEnabledForPills
    ? new TaskRegistry()
    : undefined
  // FollowUpQueue is allocated when pills + follow-up pill are both ON. The
  // queue is currently producer-less from the CLI; this seam is forward-
  // compatible with mid-turn user input injection (no behavior change yet).
  const followUpQueue: FollowUpQueue | undefined =
    pillsEnabled && !pillFlags.hideFollowUp ? new FollowUpQueue() : undefined
  const pills: LifecyclePills = createLifecyclePills({
    enabled: pillsEnabled,
    hideTasks: pillFlags.hideTasks,
    hideFollowUp: pillFlags.hideFollowUp,
    hideMcp: pillFlags.hideMcp,
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

/** Snapshot the CLI-owned subagent + follow-up queue handles into the
 *  lifecycle pills + flush. Pure helper extracted to keep the `turn()` and
 *  `onTurnEnd` callsites under biome's cognitive-complexity budget.
 *
 *  Reading patterns mirror the spec's data sources:
 *    - subagent: `taskRegistry.pendingIds().length` (running) +
 *      `taskRegistry.list().length` (cumulative — running + settled).
 *    - follow-up: `followUpQueue.size()` (queue depth across all threads).
 *  Either handle absent ⇒ that pill is omitted (no allocation). `flush()`
 *  is a no-op when every pill falls below its threshold, so a quiet turn
 *  leaves no trailing line. */
const snapshotAndFlushLifecyclePills = (
  pills: LifecyclePills,
  taskRegistry: TaskRegistry | undefined,
  followUpQueue: FollowUpQueue | undefined,
): void => {
  if (taskRegistry !== undefined) {
    const running = taskRegistry.pendingIds().length
    const total = taskRegistry.list().length
    pills.update({ subagent: { running, total } })
  }
  if (followUpQueue !== undefined) {
    pills.update({ followUp: { queued: followUpQueue.size() } })
  }
  pills.flush()
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
  envSource: NodeJS.ProcessEnv,
  isTTY: boolean | undefined,
  model: string,
): CostPanel | undefined => {
  if (!isCostPanelEnabled(envSource, isTTY)) return undefined
  return createCostPanel({ enabled: true, model })
}

/** Track per-turn token deltas from cumulative `metrics.snapshot()` counters
 *  and fold into the {@link CostPanel}. Mutates `prev` in place so the
 *  caller-owned baseline keeps the running totals between turns. No-op on
 *  non-positive deltas (defensive against counter resets / dropped snapshots
 *  — never reports a negative usage). */
interface CostPanelDeltaBaseline {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}
/** Conditional cost-panel fold — wraps the two presence checks (panel built,
 *  metrics wired) into ONE call site so the per-turn closure stays inside the
 *  biome cognitive-complexity budget. No-op when either is absent. */
const foldCostPanelIfWired = (
  panel: CostPanel | undefined,
  metrics: { snapshot: () => { counters: Record<string, number> } } | undefined,
  prev: CostPanelDeltaBaseline,
): void => {
  if (panel === undefined || metrics === undefined) return
  foldCostPanelDelta(panel, metrics.snapshot(), prev)
}

const foldCostPanelDelta = (
  panel: CostPanel,
  snap: { counters: Record<string, number> },
  prev: CostPanelDeltaBaseline,
): void => {
  const curIn = snap.counters[GEN_AI_ATTRS.usage.inputTokens] ?? 0
  const curOut = snap.counters[GEN_AI_ATTRS.usage.outputTokens] ?? 0
  const curCache = snap.counters[GEN_AI_ATTRS.usage.cacheReadInputTokens] ?? 0
  const dIn = Math.max(0, curIn - prev.inputTokens)
  const dOut = Math.max(0, curOut - prev.outputTokens)
  const dCache = Math.max(0, curCache - prev.cacheReadTokens)
  prev.inputTokens = curIn
  prev.outputTokens = curOut
  prev.cacheReadTokens = curCache
  panel.incrementTurn({ inputTokens: dIn, outputTokens: dOut, cacheReadTokens: dCache })
}

/** S3 branch-search progress tracker — built ONCE per session. Returns
 *  `undefined` when the env/TTY gate refuses so the `/branches` slash command
 *  keeps its existing "not wired" output (byte-identical). The tracker itself
 *  is empty-state until a search ingests events; the `/branches` panel prints
 *  "(no branch search recorded yet)" until that happens. */
const buildBranchProgressOrUndefined = (
  envSource: NodeJS.ProcessEnv,
  isTTY: boolean | undefined,
): BranchProgressTracker | undefined => {
  if (!isBranchProgressEnabled(envSource, isTTY)) return undefined
  return createBranchProgressTracker()
}

/** S3 plan-store wire — default-OFF. The `/plan` slash command prints
 *  "not wired" unless `QUANTA_PLAN_STORE=1` is set (opt-in). When opt-in,
 *  we mint an in-memory `PlanStore` and thread it through `SessionDeps` so
 *  the agent's plan tools mutate the SAME store the surface reads from. */
const buildPlanStoreOrUndefined = (envSource: NodeJS.ProcessEnv): PlanStore | undefined => {
  const knob = envSource.QUANTA_PLAN_STORE
  if (knob === undefined) return undefined
  const norm = knob.trim().toLowerCase()
  if (norm === "" || norm === "0" || norm === "false" || norm === "off" || norm === "no") {
    return undefined
  }
  return createInMemoryPlanStore({ now: Date.now })
}

/** S3 slashctx-port composer. Folds the 9 optional/required REPL-side
 *  adapters into a single {@link ReplSlashCtx} literal — extracted from
 *  `runRepl` so the host stays inside the biome cognitive-complexity budget
 *  (each conditional spread is one decision). Default-OFF per port:
 *  absent adapter ⇒ field omitted ⇒ the slash command keeps its existing
 *  "not wired in this surface" output. */
interface BuildReplSlashCtxArgs {
  skillsCb: (() => Promise<SkillRow[]>) | undefined
  idleMonitor: IdleMonitor
  imageQueue: ImageQueue | undefined
  rewindState: RewindSlashState | undefined
  mcpSurface: import("./mcp-cmd").McpSurfaceInfo | undefined
  costPanel: CostPanel | undefined
  planStore: PlanStore | undefined
  branchProgress: BranchProgressTracker | undefined
  /** Returns the LIVE `Message[]` ref (the REPL re-binds `history` per turn,
   *  so the slash adapters need a getter — not a captured value). */
  getHistory: () => readonly Message[]
  sessionDeps: SessionDeps
  abortSignal: AbortSignal
  /** Track D — debug-tracer handle. Absent ⇒ `/debug` prints "not wired". */
  debugHandle: import("./repl/session-setup").DebugTracerHandle | undefined
}
const buildReplSlashCtx = (args: BuildReplSlashCtxArgs): ReplSlashCtx => {
  const {
    skillsCb,
    idleMonitor,
    imageQueue,
    rewindState,
    mcpSurface,
    costPanel,
    planStore,
    branchProgress,
    getHistory,
    sessionDeps,
    abortSignal,
    debugHandle,
  } = args
  return {
    ...(skillsCb !== undefined ? { skills: skillsCb } : {}),
    idle: idleMonitor,
    ...(imageQueue !== undefined ? { imageQueue } : {}),
    ...(rewindState !== undefined ? { rewindSession: rewindState } : {}),
    ...(mcpSurface !== undefined ? { mcp: mcpSurface } : {}),
    ...(costPanel !== undefined ? { cost: () => costPanel.renderDetailed() } : {}),
    ...(planStore !== undefined
      ? { planSnapshot: (): import("@/agent/plan/types").Plan | null => planStore.current() }
      : {}),
    ...(branchProgress !== undefined ? { branchSearch: () => branchProgress.snapshot() } : {}),
    // /history is ALWAYS wired in the REPL — the live transcript is the source
    // of truth; a one-shot or shell-entry surface that wants the "not wired"
    // path would omit this field by NOT calling this composer.
    history: { messages: getHistory },
    // /side is ALWAYS wired — built fresh on each invocation so `messages`
    // reflects the LIVE transcript at call-time.
    side: (): SideChatSessionState => ({
      deps: sessionDeps,
      assembleConfig,
      messages: getHistory(),
      signal: abortSignal,
    }),
    // Track D — `/debug` runtime toggle. Absent ⇒ slash prints "not wired".
    ...(debugHandle !== undefined ? { debug: debugHandle } : {}),
  }
}

/** Build the `ctx.skills` callback the slash commands `/skills` and
 *  `/reload-skills` consume. Returns the freshly-discovered set as
 *  `{name, description, paths?}` rows — mirrors what `buildSessionFeatures`
 *  feeds the model, so the user-visible list and the model-visible inventory
 *  cannot drift. Surface-only: no LLM call, just disk scan + bundled merge.
 *  Absent skills config ⇒ `undefined` so the slash commands print "not wired".
 *
 *  NOTE: our loop already re-runs `discoverSkills` per `runAgent` call (i.e.
 *  per user turn), so newly-added SKILL.md files reach the model on the next
 *  prompt automatically. These slash commands exist for USER VISIBILITY —
 *  confirming the disk state BEFORE submitting the next prompt. */
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

/** Build the turn-summary collector + tee-wrap the upstream stream. Default-ON
 *  for TTY surfaces (auto-OFF on pipes/redirects) so the operator sees a
 *  per-turn signal box (tools / verify-guard / compaction / memory / recovery)
 *  WITHOUT opting in. Explicit `QUANTA_TURN_SUMMARY=0|false|off|no` reverts to
 *  the pre-summary code path (`{collector: disabled, stream}` ⇒ the renderer
 *  returns `""` and we write nothing).
 *
 *  Byte-identical: when the collector is disabled the returned `stream`
 *  reference is the literal input — no TeeStream allocated, no extra fan-out,
 *  so the existing recorder/stdout/indicator port path is identical to today's. */
const buildTurnSummaryAndStream = (
  stream: StreamPort,
  envSource: NodeJS.ProcessEnv,
  isTTY: boolean | undefined,
): { collector: TurnSummaryCollector; stream: StreamPort } => {
  const enabled = isTurnSummaryEnabled(envSource, isTTY)
  const verbose = isTurnSummaryVerbose(envSource)
  const collector = createTurnSummary({ enabled, verbose })
  if (!enabled) return { collector, stream }
  return { collector, stream: new TeeStream([stream, collector.asStreamPort()]) }
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
  statusBar: StatusBar,
  stream: StreamPort,
  envSource: NodeJS.ProcessEnv,
  isTTY: boolean | undefined,
  intervalEnv: string,
): { indicator: TurnIndicator; turnStream: StreamPort } => {
  const enabled = isIndicatorEnabled(envSource, isTTY)
  const intervalMs = Number(intervalEnv)
  const indicator = createTurnIndicator({
    statusBar,
    enabled,
    intervalMs: Number.isFinite(intervalMs) && intervalMs > 0 ? intervalMs : 80,
  })
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
  stream: StreamPort,
  envSource: NodeJS.ProcessEnv,
  isTTY: boolean | undefined,
): {
  stream: StreamPort
  debugHandle: import("./repl/session-setup").DebugTracerHandle | undefined
} => {
  // Non-TTY ⇒ forced disable to avoid polluting pipe/redirect output.
  if (isTTY !== true) return { stream, debugHandle: undefined }
  const parsed = parseDebugEnv(envSource.QUANTA_DEBUG)
  if (!parsed.enabled) return { stream, debugHandle: undefined }
  // Live state ref + tracer ref. The tracer is rebuilt on each
  // `set(state)` so options (categories, startedAt) reflect the latest
  // toggle. Initial tracer is built once for the boot-enabled state.
  let state: DebugCmdState =
    parsed.categories !== undefined
      ? { enabled: true, categories: parsed.categories }
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

const buildSkillsCallback = (
  skillsConfig: AgentConfig["skills"] | undefined,
): (() => Promise<SkillRow[]>) | undefined => {
  if (skillsConfig === undefined) return undefined
  return async (): Promise<SkillRow[]> => {
    const userSkills = skillsConfig.dir !== undefined ? await discoverSkills(skillsConfig.dir) : []
    const systemSkills = await discoverSystemSkills()
    // Same precedence as buildSessionFeatures: system wins on name collision.
    const byName = new Map<string, SkillRow>()
    for (const s of userSkills) {
      const row: SkillRow = { name: s.name, description: s.description }
      if (s.paths !== undefined) (row as { paths?: readonly string[] }).paths = s.paths
      byName.set(s.name, row)
    }
    for (const s of systemSkills) {
      const row: SkillRow = { name: s.name, description: s.description }
      if (s.paths !== undefined) (row as { paths?: readonly string[] }).paths = s.paths
      byName.set(s.name, row)
    }
    return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }
}

/** Build and wire the 4-pill status chrome (workspace / mode+effort / skills /
 *  sandbox). Extracted from {@link runRepl} so that the per-pill resolution
 *  logic (planMode→AgentMode, QUANTA_EFFORT, QUANTA_SANDBOX, async skill
 *  discovery) does not push `runRepl` past the biome cognitive-complexity
 *  budget. Returns the live {@link StatusPills} handle; caller owns dispose.
 *
 *  Default-ON contract: when the underlying TTY is absent, `createStatusPills`
 *  itself returns a no-op composer (render="" / update=no-op) so callers can
 *  always call `pills.update(...)` without a TTY check. */
const installPills = (deps: {
  statusBar: StatusBar
  cwd: string
  planMode: boolean
  skillsConfig: AgentConfig["skills"] | undefined
}): ReturnType<typeof createStatusPills> => {
  const initialAgentMode = resolveAgentMode(undefined, deps.planMode)
  const initialEffort: EffortLevel | undefined = parseEffort(env("QUANTA_EFFORT", ""))
  const initialSandbox: SandboxMode = (env("QUANTA_SANDBOX", "default") as SandboxMode) ?? "default"
  const pills = createStatusPills({
    statusBar: deps.statusBar,
    initial: {
      cwd: deps.cwd,
      mode: initialAgentMode,
      ...(initialEffort !== undefined ? { effort: initialEffort } : {}),
      sandboxMode: initialSandbox,
    },
  })
  // Active-skill inventory — populated opportunistically using the same
  // discover seam the slash commands use. No skillsConfig ⇒ pill render
  // skips the slot (composer drops empty/undefined fields).
  const skillsCbForPills = buildSkillsCallback(deps.skillsConfig)
  if (skillsCbForPills !== undefined) {
    void skillsCbForPills()
      .then((rows) => pills.update({ activeSkills: rows.map((r) => ({ name: r.name })) }))
      .catch(() => undefined) // best-effort; pills stay empty on discover error
  }
  // Rule indicator — best-effort fs walk shadowing the agent loop's loaders.
  // Off-loop and cached for the REPL session; the loop's own load is
  // unchanged, so the prompt body stays byte-identical (read-only mirror).
  // `isRulePillEnabled()` defaults to `process.env` internally — keep the
  // env read INSIDE rule-indicator.ts (which is allowlisted) rather than
  // duplicating it at the call site.
  if (isRulePillEnabled()) {
    void buildRuleInventory({ cwd: deps.cwd })
      .then((inv) => {
        if (inv.totalCount > 0) {
          pills.update({
            rules: { activeCount: inv.activeCount, totalCount: inv.totalCount },
          })
        }
      })
      .catch(() => undefined)
  }
  return pills
}

/** Try to handle `input` as an in-REPL slash command. Returns true iff the
 *  input was routed and consumed by the slash surface; false means the
 *  caller must forward it to the model path. `isSlashCommand` rejects paths
 *  like `/path/to/x` so legacy file-resume tokens still fall through to the
 *  agent path. */
export const dispatchReplSlash = async (
  input: string,
  slashCtx?: ReplSlashCtx,
): Promise<boolean> => {
  const head = input.split(/\s+/)[0] ?? ""
  if (!isSlashCommand(head)) return false
  // ADR-0083 multi-modal: `/image add|list|clear` is in-REPL only (the queue
  // is REPL-scoped surface state; the global `BUILTINS` table has no session
  // context). Short-circuit BEFORE delegating to the surface-agnostic
  // dispatcher so the queue mutation stays inside this surface.
  if (head === "/image" && slashCtx?.imageQueue !== undefined) {
    runImageCmd(input, {
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
      cwd: process.cwd(),
      queue: slashCtx.imageQueue,
    })
    return true
  }
  await runSlashCommand(input, {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    cwd: process.cwd(),
    ...(slashCtx?.skills !== undefined ? { skills: slashCtx.skills } : {}),
    ...(slashCtx?.idle !== undefined ? { idle: slashCtx.idle } : {}),
    ...(slashCtx?.rewindSession !== undefined ? { rewindSession: slashCtx.rewindSession } : {}),
    ...(slashCtx?.mcp !== undefined ? { mcp: slashCtx.mcp } : {}),
    // S3 slashctx-port wire — each field omitted entirely when the surface
    // did not build the adapter, so the slash command keeps its existing
    // "not wired" output (byte-identical default-OFF, no crash).
    ...(slashCtx?.cost !== undefined ? { cost: slashCtx.cost } : {}),
    ...(slashCtx?.planSnapshot !== undefined ? { planSnapshot: slashCtx.planSnapshot } : {}),
    ...(slashCtx?.history !== undefined ? { history: slashCtx.history } : {}),
    ...(slashCtx?.branchSearch !== undefined ? { branchSearch: slashCtx.branchSearch } : {}),
    ...(slashCtx?.side !== undefined ? { side: slashCtx.side() } : {}),
    ...(slashCtx?.debug !== undefined ? { debug: slashCtx.debug } : {}),
  })
  return true
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

/** Print a turn-level error inline + flash the status bar. Used by the
 *  interactive turn-runner sink to keep the REPL alive when a single turn
 *  throws. Slice-C: invoked via {@link runOneTurn}.onError so a non-abort
 *  failure paints the message + a transient and the loop continues. */
const renderTurnError = (e: unknown, statusBar: StatusBar): void => {
  const msg = e instanceof Error ? e.message : String(e)
  process.stderr.write(`\n\x1b[31merror:\x1b[0m ${msg}\n`)
  statusBar.transient(`error: ${msg.slice(0, 120)}`, 4000)
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

/** Slice-C: bundle the {@link setupSession} factories the host wires.
 *  Lifted out of `runRepl` so the orchestrator stays inside the spec's
 *  ≤ 50 LOC budget — each factory still resolves to the SAME closure the
 *  prior inline code allocated (byte-identical). */
const sessionSetupDeps: Parameters<typeof setupSession>[0] = {
  buildLifecycleBundle,
  deriveMcpPillServers,
  buildCostPanelOrUndefined,
  buildBranchProgressOrUndefined,
  buildPlanStoreOrUndefined,
  buildTurnSummaryAndStream,
  buildTurnIndicatorAndStream,
  buildDebugTracerAndStream,
  buildWorkMetricsSink,
  installPills,
}

/** Slice-C: UX opts (history + multiline) the prompt pipeline consumes.
 *  Default-ON when the env knob is unset; explicit `=0` reverts to the
 *  no-history single-line path (byte-identical). */
const buildPromptUx = (): { promptHistory?: PromptHistory; multiline?: boolean } => {
  const historyEnabled = env("QUANTA_HISTORY", "1") !== "0"
  const historyMax = Math.max(1, Number(env("QUANTA_HISTORY_MAX", "1000")))
  const historyFile = process.env.QUANTA_HISTORY_FILE
  const promptHistoryOpts: Parameters<typeof createPromptHistory>[0] = {
    maxLines: historyMax,
    ...(historyFile !== undefined ? { filePath: historyFile } : {}),
  }
  const promptHistory = historyEnabled ? createPromptHistory(promptHistoryOpts) : undefined
  const multilineEnabled = env("QUANTA_MULTILINE", "1") !== "0"
  return {
    ...(promptHistory !== undefined ? { promptHistory } : {}),
    multiline: multilineEnabled,
  }
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
  const surfaceState = createSurfaceState(setup)
  try {
    const slashCtx = composeSurfaceSlashCtx(setup, surfaceState)
    await runSessionLoop({
      setup,
      dispatchSlash: (input) => dispatchReplSlash(input, slashCtx),
      sinks: composeTurnSinks(setup, surfaceState),
      ...(surfaceState.imageQueue !== undefined ? { imageQueue: surfaceState.imageQueue } : {}),
      ux: buildPromptUx(),
      registerExitTeardown: (cb) => {
        process.once("exit", cb)
      },
    })
  } finally {
    setup.lifecyclePills.dispose()
    await setup.shutdownMcp()
  }
}

/** Slice-C surface-mutable state owned by `runRepl` — held in a single
 *  closure record so the slash-ctx + turn-sinks closures can READ the live
 *  `history` (re-bound after each interactive turn). The `imageQueue` and
 *  `rewindState` and `costDeltaPrev` are stable once allocated. */
interface SurfaceState {
  imageQueue: ImageQueue | undefined
  rewindState: ReturnType<typeof buildRewindSlashState>
  history: readonly Message[]
  readonly costDeltaPrev: CostPanelDeltaBaseline
}

const createSurfaceState = (setup: Awaited<ReturnType<typeof setupSession>>): SurfaceState => ({
  imageQueue: setup.argPrompt ? undefined : buildImageQueue(),
  rewindState: buildRewindSlashState(setup.sessionId, setup.cwd),
  history: setup.history,
  costDeltaPrev: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
})

const composeSurfaceSlashCtx = (
  setup: Awaited<ReturnType<typeof setupSession>>,
  state: SurfaceState,
): ReplSlashCtx =>
  buildReplSlashCtx({
    skillsCb: buildSkillsCallback(setup.skillsConfig),
    idleMonitor: setup.idleMonitor,
    imageQueue: state.imageQueue,
    rewindState: state.rewindState,
    mcpSurface: setup.mcpSurface,
    costPanel: setup.costPanel,
    planStore: setup.planStore,
    branchProgress: setup.branchProgress,
    getHistory: () => state.history,
    sessionDeps: setup.sessionDeps,
    abortSignal: setup.abort.signal,
    debugHandle: setup.debugHandle,
  })

const composeTurnSinks = (
  setup: Awaited<ReturnType<typeof setupSession>>,
  state: SurfaceState,
): Parameters<typeof runSessionLoop>[0]["sinks"] => {
  const { model, slog, metrics, turnSummary, statusBar } = setup
  return {
    renderTurnDashboard: (): void => {
      if (!metrics) return
      const snap = metrics.snapshot()
      slog.info("metrics.snapshot", { snapshot: snap })
      process.stderr.write(`${renderDashboardText(buildCostDashboard(snap, { model }))}\n`)
      foldCostPanelIfWired(setup.costPanel, metrics, state.costDeltaPrev)
    },
    renderAndResetSummary: (outcome): void => {
      state.history = outcome.messages
      const summary = turnSummary.render(outcome as Parameters<typeof turnSummary.render>[0])
      if (summary !== "") process.stderr.write(summary)
      turnSummary.reset()
    },
    flushLifecyclePills: (): void => {
      snapshotAndFlushLifecyclePills(
        setup.lifecyclePills,
        setup.lifecycleTaskRegistry,
        setup.lifecycleFollowUpQueue,
      )
    },
    renderTurnError: (err): void => renderTurnError(err, statusBar),
  }
}
