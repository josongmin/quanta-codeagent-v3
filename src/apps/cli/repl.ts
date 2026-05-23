import { homedir } from "node:os"
import { emitKeypressEvents } from "node:readline"
import * as readline from "node:readline/promises"
import {
  type AgentConfig,
  buildSystemPrompt,
  type EffortLevel,
  parseEffort,
  RetryingLLM,
  resolveAgentMode,
} from "@/agent"
import { FollowUpQueue } from "@/agent/follow-up-queue"
import type { ImageBlock, LLMPort, Message } from "@/llm"
import {
  buildCostDashboard,
  buildShellOtelObserver,
  renderDashboardText,
  StructuredLogger,
  summarizeWorkMetrics,
} from "@/observability"
import type { PermissionContext, PermissionMode, ToolAction } from "@/permission"
import { type PromptPayload, type PromptSource, runInteractive, runOnce } from "@/runner"
import { logger } from "@/shared"
import { discoverSkills, discoverSystemSkills } from "@/skill"
import type { StreamPort } from "@/stream"
import { TeeStream } from "@/stream"
import { TaskRegistry } from "@/subagent"
import { composeShellObservers } from "@/tool"
import { diffPreviewEnabled, renderActionDiff } from "./diff-preview"
import { createIdleMonitor, type IdleMonitor } from "./idle-monitor"
import { runImageCmd } from "./image-cmd"
import { loadImageBlock } from "./image-loader"
import { createImageQueue, type ImageQueue } from "./image-queue"
import {
  argvImages,
  argvPrompt,
  assembleConfig,
  buildLLM,
  buildSkillsConfig,
  buildStreaming,
  buildSummarizerLlm,
  buildTooling,
  composeLLM,
  DEFAULT_MODEL,
  env,
  isPathLikeToken,
  loadFeatures,
  newSessionFlag,
  observeDir,
  pickPersona,
  pickProvider,
  resolveResume,
  type SessionDeps,
  titleFlag,
} from "./internal"
import {
  createLifecyclePills,
  isLifecyclePillsEnabled,
  type LifecyclePills,
  type McpPillServer,
  readPillEnvFlags,
} from "./lifecycle-pills"
import { createPromptHistory, type PromptHistory } from "./prompt-history"
import { AbortError, readLine } from "./raw-line-reader"
import { createRejectCounter, type RejectCounter } from "./reject-counter"
import { buildRuleInventory, isRulePillEnabled } from "./rule-indicator"
import { runSessionCommand } from "./session-commands"
import { switchToSessionCwd } from "./session-io"
import { buildShellStreamPainter } from "./shell-stream-painter"
import {
  describeSlashCommand,
  isSlashCommand,
  runSlashCommand,
  type SkillRow,
  slashCompleter,
} from "./slash-commands"
import { installStatusBar, type StatusBar } from "./status-bar"
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

/** ADR-0083: resolve `--image <path>` attachments to {@link ImageBlock}s, or
 *  exit 1 with a clear message on a load failure (bad path / unsupported type /
 *  oversize). Extracted from `runRepl` so the loader's try/catch does not push
 *  that already-large function over the biome cognitive-complexity budget.
 *  Empty when no `--image` is passed (byte-identical text-only seed). */
const loadSeedImages = (): ImageBlock[] => {
  try {
    return argvImages().map(loadImageBlock)
  } catch (e) {
    logger.error((e as Error).message)
    process.exit(1)
  }
}

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

/** Interactive REPL loop: each line continues the same conversation.
 *
 *  Slash commands routed in-REPL (Codex `forceReloadSkills` parity for
 *  `/skills` and `/reload-skills`): when the user types `/<letter>…`,
 *  short-circuit to {@link runSlashCommand} with `slashCtx` instead of sending
 *  it to the model. `/exit` / `/quit` keep their existing meaning (loop break)
 *  and are checked BEFORE the slash dispatch so they cannot be hijacked by a
 *  future registered command of the same name. Empty `slashCtx` ⇒ commands
 *  that need session state print "not wired" and exit 0 (default-OFF). */
/** Try to handle `input` as an in-REPL slash command. Returns true iff the
 *  input was routed (caller should `continue` the outer loop); false ⇒ the
 *  caller must send it to the model via `turn(...)`. Extracted from
 *  `runReplLoop` to keep that function under the biome cognitive-complexity
 *  budget. `isSlashCommand` rejects paths like `/path/to/x` so legacy
 *  file-resume tokens still fall through to the agent path. */
const tryRunReplSlash = async (
  input: string,
  slashCtx?: Partial<{
    skills: () => Promise<SkillRow[]>
    idle: IdleMonitor
    imageQueue: ImageQueue
  }>,
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
  })
  return true
}

export const runReplLoop = async (
  rl: readline.Interface,
  signal: AbortSignal,
  turn: (text: string) => Promise<void>,
  slashCtx?: Partial<{
    skills: () => Promise<SkillRow[]>
    idle: IdleMonitor
    imageQueue: ImageQueue
  }>,
): Promise<void> => {
  while (!signal.aborted) {
    const input = (await rl.question("\nquanta› ")).trim()
    if (input === "") continue
    if (input === "/exit" || input === "/quit") break
    if (await tryRunReplSlash(input, slashCtx)) continue
    await turn(input)
  }
}

/** Production REPL loop with REAL `<Tab>` autocompletion.
 *
 *  Bun's `node:readline` polyfill ignores the `completer` option (probe-
 *  verified 2026-05), so this variant bypasses readline entirely and reads
 *  lines via raw-mode keypress events through {@link readLine}. Sibling
 *  prompts (permission confirm) that don't need completion still go through
 *  an ad-hoc `readline/promises` `question()` — see `runRepl`.
 *
 *  Kept separate from {@link runReplLoop} so the existing readline-based
 *  test harness (`tests/unit/apps/cli/skills-slash-hellgate.test.ts`) is
 *  unaffected: tests inject a fake readline through `runReplLoop`; the CLI
 *  entry point dispatches to `runReplLoopRaw` instead. */
export interface RunReplLoopRawOptions {
  readonly signal: AbortSignal
  readonly turn: (text: string) => Promise<void>
  readonly slashCtx?: Partial<{
    skills: () => Promise<SkillRow[]>
    idle: IdleMonitor
    imageQueue: ImageQueue
  }>
  /** Meta line painted under the prompt (Codex-style composer). Typical
   *  content: `provider · model · ~/cwd`. Absent ⇒ no meta row. */
  readonly meta?: string
  /** Optional bash-style prompt history. Default OFF when undefined —
   *  raw-line-reader stays byte-identical to the no-history path. */
  readonly history?: PromptHistory
  /** Heredoc multiline mode. Default OFF; opt-in via QUANTA_MULTILINE. */
  readonly multiline?: boolean
}

export const runReplLoopRaw = async (opts: RunReplLoopRawOptions): Promise<void> => {
  const { signal, turn, slashCtx, meta, history, multiline } = opts
  process.stderr.write("\n")
  while (!signal.aborted) {
    let input: string
    try {
      input = (
        await readLine({
          prompt: "› ",
          completer: (line) => slashCompleter(line)[0],
          describe: describeSlashCommand,
          ...(meta !== undefined ? { meta } : {}),
          ...(history !== undefined ? { history } : {}),
          ...(multiline === true ? { multiline: true } : {}),
          signal,
        })
      ).trim()
    } catch (e) {
      if (e instanceof AbortError) return
      throw e
    }
    if (input === "") {
      process.stderr.write("\n")
      continue
    }
    if (input === "/exit" || input === "/quit") break
    if (await tryRunReplSlash(input, slashCtx)) {
      process.stderr.write("\n")
      continue
    }
    await turn(input)
    process.stderr.write("\n")
  }
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

/** Render the per-turn cost+cache dashboard to stderr + log a structured
 *  snapshot. No-op when metrics are off (default). Extracted from the
 *  in-loop block so each closure stays within the biome cognitive-complexity
 *  budget. ADR-0085. */
const renderTurnDashboard = (
  metrics: { snapshot: () => Parameters<typeof buildCostDashboard>[0] } | undefined,
  model: string,
  slog: StructuredLogger,
): void => {
  if (!metrics) return
  const snap = metrics.snapshot()
  slog.info("metrics.snapshot", { snapshot: snap })
  process.stderr.write(`${renderDashboardText(buildCostDashboard(snap, { model }))}\n`)
}

/** Print a turn-level error inline + flash the status bar. Used by the
 *  interactive wrapTurn to keep the REPL alive when a single turn throws.
 *  Extracted to keep wrapTurn under the biome cognitive-complexity budget. */
const renderTurnError = (e: unknown, statusBar: StatusBar): void => {
  const msg = e instanceof Error ? e.message : String(e)
  process.stderr.write(`\n\x1b[31merror:\x1b[0m ${msg}\n`)
  statusBar.transient(`error: ${msg.slice(0, 120)}`, 4000)
}

/** Read one trimmed line from the raw-mode reader. Returns `null` on
 *  AbortError (the prompt was aborted via `signal`). Other exceptions
 *  propagate to the caller. Extracted from {@link buildCliPromptSource} to
 *  keep its `next` closure under the biome cognitive-complexity budget. */
const readReplLine = async (
  signal: AbortSignal | undefined,
  uxOpts?: { promptHistory?: PromptHistory; multiline?: boolean },
): Promise<string | null> => {
  try {
    const raw = await readLine({
      prompt: "› ",
      completer: (line) => slashCompleter(line)[0],
      describe: describeSlashCommand,
      ...(signal !== undefined ? { signal } : {}),
      ...(uxOpts?.promptHistory !== undefined ? { history: uxOpts.promptHistory } : {}),
      ...(uxOpts?.multiline === true ? { multiline: true } : {}),
    })
    return raw.trim()
  } catch (e) {
    if (e instanceof AbortError) return null
    throw e
  }
}

/** Read one REPL line and classify it: `null` ⇒ loop exit, `undefined` ⇒
 *  caller should keep looping (blank line or in-REPL slash handled here),
 *  `string` ⇒ forward as the next user prompt. Extracted from the
 *  `PromptSource.next` closure to keep it under the biome complexity budget. */
const classifyReplLine = async (
  signal: AbortSignal | undefined,
  slashCtx:
    | Partial<{ skills: () => Promise<SkillRow[]>; idle: IdleMonitor; imageQueue: ImageQueue }>
    | undefined,
  uxOpts?: { promptHistory?: PromptHistory; multiline?: boolean },
): Promise<string | null | undefined> => {
  const input = await readReplLine(signal, uxOpts)
  if (input === null) return null
  if (input === "/exit" || input === "/quit") return null
  const handled = input === "" || (await tryRunReplSlash(input, slashCtx))
  if (handled) {
    process.stderr.write("\n")
    return undefined
  }
  return input
}

/** CLI `PromptSource` adapter for the Layer-2 `runInteractive` driver.
 *  Wraps the raw-mode line reader + resolves `/exit` + in-REPL slash dispatch
 *  + blank-line behavior inline — the driver only sees clean prompt strings
 *  (or `null` for loop exit). UI primitives (readline, status bar, Esc-Esc,
 *  shell-stream painter) stay in apps/cli per RFC 3.1 slice rules.
 *
 *  ADR-0083 multi-modal: when `slashCtx.imageQueue` is wired, `next()` drains
 *  the queue on every accepted prompt and returns the `{ text, images }`
 *  PromptPayload form so `runInteractive` attaches the images to THAT turn.
 *  Single-shot: the queue is emptied as a side-effect of `drain()` — the
 *  user re-queues with `/image add` for the following turn. Empty queue
 *  ⇒ returns the plain string form (backward-compat / byte-identical).
 *
 *  Extracted from `runRepl` so each closure stays under the biome cognitive-
 *  complexity budget. The trailing `\n` per branch matches the prior
 *  `runReplLoopRaw` post-line behavior byte-identically. */
const buildCliPromptSource = (
  slashCtx:
    | Partial<{ skills: () => Promise<SkillRow[]>; idle: IdleMonitor; imageQueue: ImageQueue }>
    | undefined,
  uxOpts?: { promptHistory?: PromptHistory; multiline?: boolean },
): PromptSource => ({
  next: async (signal) => {
    while (signal?.aborted !== true) {
      const next = await classifyReplLine(signal, slashCtx, uxOpts)
      if (next === undefined) continue
      if (next === null) return null
      // Drain the per-turn image queue if wired + non-empty. Single-shot:
      // `drain()` clears the queue as a side-effect so subsequent turns are
      // text-only unless the user re-queues with another `/image add`.
      const queued = slashCtx?.imageQueue?.drain() ?? []
      if (queued.length === 0) return next
      return { text: next, images: queued.map((e) => e.block) }
    }
    return null
  },
})

/**
 * Main REPL/one-shot entry: assembles the agent stack, resolves the resume
 * state machine, and dispatches to either `runReplLoop` (interactive) or a
 * single `turn()` call (one-shot when argv carries a positional prompt).
 *
 * This is a verbatim relocation of the post-routing body of `main()` from
 * `index.ts`. Caller (`index.ts::main`) is responsible for the argv-routing
 * short-circuits (`session` subcommand / `/<slash>` / `--help`) BEFORE
 * delegating here.
 */

/** Wrap an inner CLI {@link PromptSource} with the Cursor-inspired idle /
 *  snooze gate + reject-counter graceful exit. Extracted from `runRepl` so
 *  that host stays under biome's cognitive-complexity budget.
 *
 *  Order in the `next` loop:
 *   1. `rejects.shouldAutoExit()` ⇒ return `null` (graceful loop exit —
 *      the `runRepl` `finally` still shuts MCP and tears down the status
 *      bar; we do NOT call `process.exit`).
 *   2. `idle.isSnoozed()` ⇒ paint hint banner; the inner read still fires
 *      so the user can type `/resume` to wake.
 *   3. `idle.isIdle()` ⇒ soft hint only (no gate — blocking on idle would
 *      deadlock since a keystroke IS the wake event).
 *   4. After a non-null line: if still snoozed, decline + loop back;
 *      otherwise `idle.markActive()` and return. */
const wrapPromptSourceWithIdleGate = (args: {
  readonly inner: PromptSource
  readonly idle: IdleMonitor
  readonly rejects: RejectCounter
  readonly statusBar: StatusBar
}): PromptSource => {
  const { inner, idle, rejects, statusBar } = args
  const paintGateBanners = (): void => {
    if (idle.isSnoozed()) {
      statusBar.transient("⏸ snoozed — type /resume to wake", 4000)
      process.stderr.write("[snoozed — type /resume to wake, or wait for the snooze window]\n")
      return
    }
    if (idle.isIdle()) {
      statusBar.transient("[idle 60s — auto-paused. type or /resume]", 3000)
    }
  }
  /** One read cycle: returns the next prompt payload, `null` for loop exit,
   *  or `undefined` to signal "retry" (snoozed declined input). Splitting
   *  this off keeps `next` flat enough for the biome complexity budget.
   *  Returns the {@link PromptPayload} verbatim so a multi-modal payload
   *  (`{ text, images }`) flows through this idle/reject gate unchanged. */
  const readOneGated = async (signal?: AbortSignal): Promise<PromptPayload | null | undefined> => {
    if (rejects.shouldAutoExit()) {
      process.stderr.write("\n[20 consecutive denials — exiting. To re-enable, restart quanta]\n")
      return null
    }
    paintGateBanners()
    const next = await inner.next(signal)
    if (next === null) return null
    if (idle.isSnoozed()) {
      process.stderr.write("(snoozed — input declined; type /resume to wake)\n")
      return undefined
    }
    idle.markActive()
    return next
  }
  return {
    next: async (signal) => {
      while (signal?.aborted !== true) {
        const out = await readOneGated(signal)
        if (out === null) return null
        if (out !== undefined) return out
      }
      return null
    },
  }
}

export const runRepl = async (): Promise<void> => {
  const provider = pickProvider()
  const model = env("QUANTA_MODEL", DEFAULT_MODEL[provider])
  const maxTurns = Number(env("QUANTA_MAX_TURNS", "40"))
  // Secure-by-default (S7): unattended auto-allow of every mutating tool
  // gated only by a regex denylist is not secure-by-default. Default is now
  // `default` (ask on mutation; read-only still auto-allows). An explicit
  // QUANTA_PERMISSION=acceptEdits|bypass|auto is still honored.
  const mode = env("QUANTA_PERMISSION", "default") as PermissionMode
  // HIGH-4: `cwd` may be re-captured AFTER an id-mode resume if the loaded
  // session's `meta.cwd` differs (e.g. a fork-worktree session). We chdir
  // there BEFORE this binding is used to construct `SessionDeps` so tools
  // (Read/Edit/Bash) operate inside the right tree.
  let cwd = process.cwd()
  const slog = new StructuredLogger()

  // Cursor-inspired idle suppress + reject auto-exit (default-ON).
  //
  // QUANTA_IDLE_SUPPRESS=0 ⇒ both mechanisms collapse to no-ops:
  //   - idle monitor uses `Infinity` thresholds (isIdle/isSnoozed always false)
  //   - reject counter uses `Infinity` (shouldAutoExit always false)
  // The `/snooze` and `/resume` slash commands still resolve to the same
  // monitor instance, so a power user can re-enable the gating mid-run by
  // calling `/snooze` explicitly (which sets `snoozedUntil`).
  const idleSuppressOn = env("QUANTA_IDLE_SUPPRESS", "1") !== "0"
  const idleMsRaw = Number(env("QUANTA_IDLE_MS", "60000"))
  const snoozeDefaultMsRaw = Number(env("QUANTA_SNOOZE_DEFAULT_MS", "300000"))
  const rejectLimitRaw = Number(env("QUANTA_REJECT_LIMIT", "20"))
  const idleMonitor = createIdleMonitor({
    idleThresholdMs:
      idleSuppressOn && Number.isFinite(idleMsRaw) ? idleMsRaw : Number.POSITIVE_INFINITY,
    defaultSnoozeMs:
      idleSuppressOn && Number.isFinite(snoozeDefaultMsRaw) ? snoozeDefaultMsRaw : 300_000,
  })
  const rejectCounter = createRejectCounter({
    threshold:
      idleSuppressOn && Number.isFinite(rejectLimitRaw) && rejectLimitRaw > 0
        ? rejectLimitRaw
        : Number.POSITIVE_INFINITY,
  })

  let llm: LLMPort
  try {
    llm = buildLLM(provider, model)
  } catch (e) {
    logger.error((e as Error).message)
    process.exit(1)
  }
  // All features default OFF → behavior unchanged when no QUANTA_* flag set.
  const {
    planMode,
    metrics,
    state,
    resume,
    mcpTools,
    mcpClients,
    lspTools,
    lspNavTools,
    gitToolList,
  } = await loadFeatures(slog)

  // Lifecycle pills (subagent / follow-up queue / MCP health). Default-ON
  // when stderr is a TTY; `QUANTA_LIFECYCLE_PILLS=0|false|off|no` disables
  // entirely. Per-pill suppression via `QUANTA_PILL_TASKS|FOLLOWUP|MCP=0`.
  // Non-TTY surfaces (pipes, eval/bench) get an inert instance ⇒ no writes.
  const {
    pills: lifecyclePills,
    taskRegistry: lifecycleTaskRegistry,
    followUpQueue: lifecycleFollowUpQueue,
  } = buildLifecycleBundle()

  const {
    store,
    embedder,
    sessionId: initialSessionId,
    registry,
    memoryConfig,
    subagentConfig,
    skillsConfig,
    compactionBreakerConfig,
    verifyGuardConfig,
  } = buildTooling(mcpTools, lspTools, lspNavTools, gitToolList, slog, lifecycleTaskRegistry)

  // Seed the MCP pill from `loadMcpTools`'s live `mcpClients` array — each
  // surviving entry is a server that started + listed tools ("connected").
  // We can't observe configured-but-failed servers from here (loadMcpTools
  // returns only successes), so the pill shows "connected" rows only when
  // any MCP server is wired. `toolCount` is derived from the `mcp__<server>__`
  // prefix on the bridged tool names — no MCP-client API access required.
  if (mcpClients.length > 0) {
    lifecyclePills.update({ mcp: { servers: deriveMcpPillServers(mcpTools) } })
  }

  // `let` because a resumed session reassigns it before any turn (preserved).
  let sessionId = initialSessionId

  // Observability (RFC-0002 §5.4/§8). Default OFF → byte-identical to today.
  const { stream, run } = buildStreaming(observeDir(), slog)
  const permission: PermissionContext = { mode }

  const abort = new AbortController()
  const shutdownMcp = async (): Promise<void> => {
    for (const c of mcpClients) await c.stop().catch(() => undefined)
  }
  process.on("SIGINT", () => {
    process.stderr.write("\n(interrupt — finishing current step)\n")
    abort.abort()
  })

  // Bounded retry around transient LLM failures (pre-stream only), then the
  // optional same-turn fallback + auto classifier (both default OFF ⇒
  // finalLLM === retryingLLM, byte-identical to today).
  const retryingLLM = new RetryingLLM({ inner: llm, signal: abort.signal })
  const finalLLM = composeLLM(retryingLLM, provider, abort.signal, mode, permission, slog)

  // No persistent readline.Interface: the REPL prompt now goes through
  // `runReplLoopRaw` (raw-mode keypress reader with real Tab completion —
  // Bun's `node:readline` ignores the `completer` option), and the
  // permission-confirm prompt opens an ad-hoc readline only when it fires
  // so the two never compete for stdin events.
  const onConfirm = async (action: ToolAction): Promise<boolean> => {
    // Inline unified-diff preview BEFORE the readline question so the user
    // sees the proposed change, not just a tool name. Best-effort: any
    // failure (file missing, binary, parse) returns undefined and we fall
    // through to the legacy plain prompt — byte-identical to today.
    // Default-ON when QUANTA_DIFF_PREVIEW is unset + stderr is a TTY;
    // explicit `QUANTA_DIFF_PREVIEW=0` reverts to plain confirm.
    if (diffPreviewEnabled()) {
      const preview = await renderActionDiff(action)
      if (preview !== undefined) process.stderr.write(`${preview}\n`)
    }
    const adhoc = readline.createInterface({ input: process.stdin, output: process.stderr })
    try {
      const ans = await adhoc.question(`Allow ${action.tool}? [y/N] `)
      const accepted = ans.trim().toLowerCase() === "y"
      // Cursor §4.1: reset on accept, count consecutive denials. The
      // prompt-source consults `shouldAutoExit()` BEFORE issuing the next
      // turn, so an exit fires the line AFTER the 20th denial (when the
      // user would otherwise type another prompt).
      if (accepted) rejectCounter.recordAccept()
      else rejectCounter.recordDeny()
      // Any confirm dialog at all = active user interaction; mark active.
      idleMonitor.markActive()
      return accepted
    } finally {
      adhoc.close()
    }
  }

  const argPrompt = argvPrompt()
  // ADR-0083 multi-modal: load any `--image <path>` attachments ONCE (helper
  // keeps runRepl's complexity flat). They ride on the FIRST user turn only.
  let pendingImages: ImageBlock[] = loadSeedImages()

  // Preserve the legacy "quanta ready" timing: log BEFORE resume work for
  // every legacy path (default-OFF + V1 path-mode) so the new code path can
  // never perturb the existing ordering. ID-mode runs (which are reachable
  // only behind a flag) get an additional session line below.
  const newSession = newSessionFlag()
  const inIdModeAtStart = newSession || (resume !== undefined && !isPathLikeToken(resume))
  if (!inIdModeAtStart) {
    logger.info(`quanta ready (provider=${provider}, model=${model}, mode=${mode}, cwd=${cwd})`)
  }
  const resolved = await resolveResume({
    resume,
    newSession,
    title: titleFlag(),
    cwd,
    initialSessionId: sessionId,
    slog,
    // CLI surface wires the legacy `session: <id>` log line — keeps
    // byte-identical output while @/runner stays surface-agnostic
    // (no @/shared#logger dependency in the resume-fsm core).
    onSessionMinted: (id) => logger.info(`session: ${id}`),
  })
  // HIGH-5: `--new-session --resume <id>` is ambiguous (which id wins?). The
  // sentinel surfaces from resolveResume; print a clear error + exit 1
  // instead of silently ignoring `--new-session`.
  if (resolved.conflictError !== undefined) {
    logger.error(resolved.conflictError)
    process.exit(1)
  }
  if (resolved.missingIdError !== undefined) {
    logger.error(`--resume: session id not found: ${resolved.missingIdError}`)
    process.exit(1)
  }
  const { idMeta } = resolved
  let history: Message[] = resolved.history
  sessionId = resolved.sessionId
  // HIGH-4: if the resumed session points at a different cwd (e.g. a
  // fork --worktree session), switch into it so tools (Read/Edit/Bash) run
  // against the right directory. The path was stored by the prior save —
  // already trusted; sanitization of *ids* happens in the session store.
  // We still verify the directory exists on disk before chdir.
  if (idMeta) cwd = switchToSessionCwd(cwd, idMeta.cwd, slog)
  if (inIdModeAtStart && idMeta) {
    logger.info(
      `quanta ready (provider=${provider}, model=${model}, mode=${mode}, cwd=${cwd}, session=${idMeta.id})`,
    )
  }

  // Built AFTER the resume block so a resumed `sessionId` is captured (the
  // store-gated branch in assembleConfig must see the post-resume id, exactly
  // as the prior call-time closure did).
  // System prompt is built here (instead of inside `assembleConfig`) so the
  // pure composition module stays env-free; the persona is resolved via
  // `pickPersona()` which reads the env at the composition root.
  const system = buildSystemPrompt(cwd, { persona: pickPersona() })
  // ADR-0081 L4 surface wire: compose the CLI's shell-output observers.
  //   - painter paints stdout/stderr chunks to stderr live (interactive TTY
  //     only, so `cat … | bun cli …` stays byte-identical to the buffered path)
  //   - OTel observer updates per-run counters when metrics is wired
  // composeShellObservers swallows per-observer throws; when neither is built
  // the field is undefined and runShell skips event allocation entirely.
  const painterObs = process.stdin.isTTY ? buildShellStreamPainter() : undefined
  const otelObs = metrics ? buildShellOtelObserver(metrics) : undefined
  const onShellEvent =
    painterObs !== undefined || otelObs !== undefined
      ? composeShellObservers(painterObs, otelObs)
      : undefined
  // ADR-0064 L4: default per-turn work-metrics sink (built in `buildWorkMetricsSink`,
  // gated on the SAME `QUANTA_METRICS` knob as the cost dashboard). Metrics OFF
  // ⇒ undefined ⇒ the loop allocates no collector (byte-identical).
  const workMetricsSink = buildWorkMetricsSink(metrics !== undefined)

  // Bottom status bar — vim-style. Painted via scroll-region so it
  // never gets shoved off-screen by LLM stream output. Default text
  // shows provider/model/cwd/mode + the cancellation cheatsheet.
  // (Moved here so the turn-indicator and TeeStream wiring — which both
  // need the statusBar in hand — can run BEFORE `sessionDeps` captures
  // the final `turnStream` reference.)
  const home = homedir()
  const shortCwd = cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
  const statusDefault = `${provider} · ${model} · ${mode} · ${shortCwd}    Esc Esc · cancel    Ctrl+C · exit`
  const statusBar = installStatusBar(statusDefault)

  // Per-turn signal collector (tools / verify-guard / compaction / memory /
  // recovery). Tees the upstream `stream` BEFORE the indicator tee so both
  // surfaces observe the SAME event order. Default-ON for TTY ⇒ the panel is
  // rendered at turn end; non-TTY or `QUANTA_TURN_SUMMARY=0` ⇒ no tee + the
  // renderer returns `""` so the post-dashboard stderr write is a no-op.
  const { collector: turnSummary, stream: summaryStream } = buildTurnSummaryAndStream(
    stream,
    process.env,
    process.stdout.isTTY,
  )
  // Live turn indicator (spinner + elapsed + token counter). Default-ON
  // when stdout is a TTY; explicit `QUANTA_SPINNER=0|false|off|no` flips
  // it off. Non-TTY surfaces (pipes, redirects, eval/bench harnesses) get
  // a disabled indicator ⇒ `turnStream === stream` (no tee, byte-identical
  // recorder/stdout fan-out to the pre-indicator path). See
  // `buildTurnIndicatorAndStream` for the gate + tee construction.
  const { indicator: turnIndicator, turnStream } = buildTurnIndicatorAndStream(
    statusBar,
    summaryStream,
    process.env,
    process.stdout.isTTY,
    env("QUANTA_SPINNER_INTERVAL_MS", "80"),
  )

  const sessionDeps: SessionDeps = {
    llm: finalLLM,
    registry,
    // `turnStream` is the indicator-tee'd port when the spinner is enabled
    // (TTY + QUANTA_SPINNER!=0); otherwise it is the literal `stream` from
    // `buildStreaming` so the recorder/stdout fan-out is byte-identical to
    // the pre-indicator path on non-TTY surfaces.
    stream: turnStream,
    permission,
    system,
    cwd,
    maxTurns,
    signal: abort.signal,
    onConfirm,
    store,
    sessionId,
    embedder,
    memoryConfig,
    planMode,
    metrics,
    run,
    subagentConfig,
    skillsConfig,
    compactionBreakerConfig,
    verifyGuardConfig,
    summarizerLlm: buildSummarizerLlm(provider, abort.signal),
    onShellEvent,
    workMetricsSink,
    ...(lifecycleFollowUpQueue !== undefined ? { followUpQueue: lifecycleFollowUpQueue } : {}),
  }
  /** Install a stdin keypress listener for the duration of one turn.
   *  Returns a `dispose()` that the caller MUST invoke (try/finally) to
   *  restore the previous terminal state. Two cancellation gestures:
   *
   *    - **Ctrl+C** ⇒ hard exit (outer `abort.abort()`).
   *    - **Esc (twice within 2 s)** ⇒ soft cancel of the current turn
   *      via `turnAbort.abort()`. The first Esc paints a hint; the
   *      second within the window triggers the abort.
   *
   *  Raw mode is REQUIRED for keypress events to fire while the LLM
   *  streams (terminal would otherwise line-buffer input). On non-TTY
   *  stdin we no-op — there's no interactive cancellation to wire up. */
  const installTurnCancel = (
    turnAbort: AbortController,
    status: StatusBar,
  ): { dispose: () => void } => {
    const stdin = process.stdin
    if (stdin.isTTY !== true) return { dispose: (): void => undefined }
    let escCount = 0
    let lastEsc = 0
    const ESC_WINDOW_MS = 2000
    type Key = { name?: string; ctrl?: boolean }
    const onKey = (_str: string | undefined, key: Key | undefined): void => {
      if (key === undefined) return
      if (key.ctrl === true && key.name === "c") {
        status.transient("⛔ interrupted — exiting…", 1500)
        abort.abort()
        return
      }
      if (key.name !== "escape") {
        escCount = 0
        return
      }
      const now = Date.now()
      if (escCount === 1 && now - lastEsc < ESC_WINDOW_MS) {
        status.transient("⛔ turn cancelled", 1500)
        turnAbort.abort()
        escCount = 0
        return
      }
      escCount = 1
      lastEsc = now
      status.transient("Press Esc again within 2s to cancel · Ctrl+C to exit", ESC_WINDOW_MS)
    }
    emitKeypressEvents(stdin)
    const wasRaw = stdin.isRaw ?? false
    stdin.setRawMode(true)
    stdin.resume()
    stdin.on("keypress", onKey)
    return {
      dispose: (): void => {
        stdin.removeListener("keypress", onKey)
        stdin.setRawMode(wasRaw)
        stdin.pause()
      },
    }
  }

  // Status pills (4-pill chrome): workspace / mode+effort / skills / sandbox.
  // Default-ON when stdout is a TTY; gated by QUANTA_PILLS=0 / individual
  // QUANTA_PILL_<NAME>=0 envs (see status-pills.ts). Wiring extracted to
  // `installPills` so `runRepl` stays under the biome cognitive-complexity budget.
  const pills = installPills({ statusBar, cwd, planMode, skillsConfig })

  const turn = async (text: string): Promise<void> => {
    // Per-turn AbortController + composite signal: the LLM stream sees
    // an `AbortSignal.any([outerAbort, turnAbort])`, so EITHER a hard
    // exit (Ctrl+C / SIGINT) OR a soft per-turn cancel (Esc Esc) tears
    // it down without poisoning subsequent turns.
    const turnAbort = new AbortController()
    const turnSignal = AbortSignal.any([abort.signal, turnAbort.signal])
    const cancel = installTurnCancel(turnAbort, statusBar)
    // Spinner + elapsed + (live) token counter for the duration of THIS
    // turn. `start()` is a no-op when the indicator is disabled (non-TTY
    // or QUANTA_SPINNER=0); `stop()` in the `finally` is the SOLE
    // teardown path, so an abort / error / SIGINT all reach the same
    // clearTransient call. Wired BEFORE runOnce so the spinner is on
    // screen at the instant the first LLM byte hits the wire.
    turnIndicator.start()
    // An abort during the turn (Esc-Esc / Ctrl+C) is the user's intent —
    // tear the spinner down immediately so the status bar's default text
    // is visible the moment the cancel fires (instead of waiting for the
    // `finally` after runOnce unwinds, which can lag a few hundred ms on
    // slow-network providers).
    const onAbortStopIndicator = (): void => turnIndicator.stop()
    turnSignal.addEventListener("abort", onAbortStopIndicator, { once: true })

    try {
      // ADR-0083: attach seed images to the FIRST turn only, then drain so
      // subsequent REPL lines are text-only (byte-identical when no --image).
      // `runOnce` (surface-agnostic Layer-2 driver) handles the
      // history.push → runAgent → persistTurn atom; the CLI surface keeps
      // the status bar / Esc-Esc / dashboard wrappers here. Byte-identical
      // post-condition: `history = result.messages`, `pendingImages = []`
      // (drained as before).
      const seedImages = pendingImages
      pendingImages = []
      const turnDeps = { ...sessionDeps, signal: turnSignal }
      const result = await runOnce({
        deps: turnDeps,
        assembleConfig,
        history,
        prompt: text,
        pendingImages: seedImages,
        state,
        idMeta,
      })
      history = result.messages
      if (metrics) {
        const snap = metrics.snapshot()
        slog.info("metrics.snapshot", { snapshot: snap })
        // ADR-0085: render the cost & cache dashboard to stderr after each turn
        // when metrics are enabled — keeps the structured log AND gives the
        // operator a human-readable cost/latency/cache summary inline.
        process.stderr.write(`${renderDashboardText(buildCostDashboard(snap, { model }))}\n`)
      }
      // Turn-summary panel — rendered AFTER the cost dashboard so the two
      // sit together at turn end. Returns "" when no signal fired or when
      // the collector is disabled, so this is a no-op on non-TTY / opt-out.
      const summary = turnSummary.render(result.outcome)
      if (summary !== "") process.stderr.write(summary)
      turnSummary.reset()
      // Lifecycle pills flush — mirrors the interactive `onTurnEnd` branch
      // so a one-shot `quanta "<prompt>"` invocation also shows the row
      // (or nothing, when every pill is below its threshold).
      snapshotAndFlushLifecyclePills(lifecyclePills, lifecycleTaskRegistry, lifecycleFollowUpQueue)
    } catch (e) {
      // A turn-scoped abort is the user's intent; swallow the error and
      // hand control back to the prompt. The outer abort still propagates
      // (the next turn will see `abort.signal.aborted === true` and skip).
      //
      // Stop the indicator BEFORE the error transient — `stop()` calls
      // `clearTransient` which would otherwise wipe the error message a
      // moment after it was painted.
      turnIndicator.stop()
      if (turnAbort.signal.aborted && !abort.signal.aborted) return
      // Any other turn-level error MUST NOT kill the REPL — surface it
      // inline + on the status bar, then return so the next prompt fires.
      const msg = e instanceof Error ? e.message : String(e)
      process.stderr.write(`\n\x1b[31merror:\x1b[0m ${msg}\n`)
      statusBar.transient(`error: ${msg.slice(0, 120)}`, 4000)
    } finally {
      // SOLE indicator teardown on the happy path — idempotent on the
      // indicator side, so a prior catch-branch `stop()` (or the abort
      // listener firing) makes this a no-op. Listener cleanup keeps the
      // turn's AbortSignal from leaking handlers across turns.
      turnSignal.removeEventListener("abort", onAbortStopIndicator)
      turnIndicator.stop()
      cancel.dispose()
      // Reset turn-summary counters here as well so an error/abort path
      // doesn't leak signals into the next turn (the happy path resets
      // immediately after render — this is the safety net).
      turnSummary.reset()
    }
  }

  try {
    if (argPrompt) {
      await turn(argPrompt)
    } else {
      // Status bar already installed above; just ensure teardown on exit.
      // Pills dispose first so any late paint cannot resurrect a stale row
      // AFTER the scroll region is reset.
      process.once("exit", () => {
        pills.dispose()
        statusBar.teardown()
      })
      const skillsCb = buildSkillsCallback(skillsConfig)
      // ADR-0083 multi-modal: per-REPL image queue. Default-ON; disabled
      // entirely via `QUANTA_IMAGE_QUEUE=0` so a paranoid surface can keep
      // the original text-only path (`/image …` then prints unknown
      // command). Capacity from `QUANTA_IMAGE_MAX_QUEUE` (default 5).
      const imageQueue: ImageQueue | undefined = buildImageQueue()
      const slashCtx: Partial<{
        skills: () => Promise<SkillRow[]>
        idle: IdleMonitor
        imageQueue: ImageQueue
      }> = {
        ...(skillsCb !== undefined ? { skills: skillsCb } : {}),
        idle: idleMonitor,
        ...(imageQueue !== undefined ? { imageQueue } : {}),
      }
      // Bash-style ↑/↓ history + Ctrl+R reverse-i-search. Default ON
      // (QUANTA_HISTORY=0 to disable). Path/max overridable via env.
      const historyEnabled = env("QUANTA_HISTORY", "1") !== "0"
      const historyMax = Math.max(1, Number(env("QUANTA_HISTORY_MAX", "1000")))
      const historyFile = process.env.QUANTA_HISTORY_FILE
      const promptHistoryOpts: Parameters<typeof createPromptHistory>[0] = {
        maxLines: historyMax,
        ...(historyFile !== undefined ? { filePath: historyFile } : {}),
      }
      const promptHistory = historyEnabled ? createPromptHistory(promptHistoryOpts) : undefined
      // Heredoc multiline (`"""` / `'''` fence). Default ON; OFF when
      // QUANTA_MULTILINE=0.
      const multilineEnabled = env("QUANTA_MULTILINE", "1") !== "0"
      // Initial blank row matches the prior `runReplLoopRaw` header write so
      // the very first composer row sits one line below the resume log.
      process.stderr.write("\n")
      const innerPromptSource = buildCliPromptSource(slashCtx, {
        ...(promptHistory !== undefined ? { promptHistory } : {}),
        multiline: multilineEnabled,
      })
      const cliPromptSource = wrapPromptSourceWithIdleGate({
        inner: innerPromptSource,
        idle: idleMonitor,
        rejects: rejectCounter,
        statusBar,
      })
      // wrapTurn installs the Esc-Esc per-turn cancel + signal composition +
      // dashboard render + REPL-survives-on-error around each runOnce call.
      // Mirrors the prior `turn()` closure body byte-identically; lifted into
      // a hook so the runInteractive driver stays surface-agnostic.
      //
      // Byte-identical per-turn output sequence (matches the prior
      // `runReplLoopRaw` + `turn()` composition):
      //   install cancel → runOnce → dashboard → dispose cancel → "\n"
      await runInteractive({
        deps: sessionDeps,
        assembleConfig,
        promptSource: cliPromptSource,
        history,
        state,
        idMeta,
        signal: abort.signal,
        seedImages: pendingImages,
        wrapTurn: async (run) => {
          const turnAbort = new AbortController()
          const turnSignal = AbortSignal.any([abort.signal, turnAbort.signal])
          const cancel = installTurnCancel(turnAbort, statusBar)
          let result: Awaited<ReturnType<typeof run>> | undefined
          try {
            result = await run({ ...sessionDeps, signal: turnSignal })
            renderTurnDashboard(metrics, model, slog)
            // Turn-summary panel — rendered AFTER the cost dashboard so the
            // two sit together at turn end. Returns "" when no signal fired
            // OR when the collector is disabled; in both cases this is a
            // no-op (byte-identical to the pre-summary code path).
            const summary = turnSummary.render(result.outcome)
            if (summary !== "") process.stderr.write(summary)
            turnSummary.reset()
          } catch (e) {
            // Turn-scoped abort = user intent; swallow + return undefined so
            // the loop solicits the next prompt without updating history.
            // Any other error MUST NOT kill the REPL — render it inline.
            if (!(turnAbort.signal.aborted && !abort.signal.aborted)) {
              renderTurnError(e, statusBar)
            }
            result = undefined
          } finally {
            cancel.dispose()
            // Safety-net reset for the error/abort path (the happy path
            // resets immediately after render). Idempotent on a fresh
            // collector ⇒ harmless to call twice.
            turnSummary.reset()
          }
          process.stderr.write("\n")
          return result
        },
        onTurnEnd: ({ messages }) => {
          // Mirror the legacy update of the surface-scoped `history`
          // binding so any downstream surface state remains in sync.
          history = messages
          // Lifecycle pills snapshot — read the CLI-owned TaskRegistry +
          // FollowUpQueue handles (the loop wired the SAME instances, so
          // these counts are the live values just after the turn settled).
          // `flush()` is a no-op when every pill falls below its threshold
          // (no subagent activity + empty queue + no MCP) so a quiet
          // turn leaves no trailing line. Default-OFF surfaces (non-TTY,
          // QUANTA_LIFECYCLE_PILLS=0) get an inert pills instance ⇒ no write.
          snapshotAndFlushLifecyclePills(
            lifecyclePills,
            lifecycleTaskRegistry,
            lifecycleFollowUpQueue,
          )
        },
      })
    }
  } finally {
    lifecyclePills.dispose()
    await shutdownMcp()
  }
}
