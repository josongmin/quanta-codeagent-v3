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
import type { ImageBlock, LLMPort, Message } from "@/llm"
import {
  buildCostDashboard,
  buildShellOtelObserver,
  renderDashboardText,
  StructuredLogger,
  summarizeWorkMetrics,
} from "@/observability"
import type { PermissionContext, PermissionMode, ToolAction } from "@/permission"
import { type PromptSource, runInteractive, runOnce } from "@/runner"
import { logger } from "@/shared"
import { discoverSkills, discoverSystemSkills } from "@/skill"
import type { StreamPort } from "@/stream"
import { TeeStream } from "@/stream"
import { composeShellObservers } from "@/tool"
import { diffPreviewEnabled, renderActionDiff } from "./diff-preview"
import { loadImageBlock } from "./image-loader"
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
import { createPromptHistory, type PromptHistory } from "./prompt-history"
import { AbortError, readLine } from "./raw-line-reader"
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
  slashCtx?: Partial<{ skills: () => Promise<SkillRow[]> }>,
): Promise<boolean> => {
  const head = input.split(/\s+/)[0] ?? ""
  if (!isSlashCommand(head)) return false
  await runSlashCommand(input, {
    out: (s) => process.stdout.write(s),
    err: (s) => process.stderr.write(s),
    cwd: process.cwd(),
    ...(slashCtx?.skills !== undefined ? { skills: slashCtx.skills } : {}),
  })
  return true
}

export const runReplLoop = async (
  rl: readline.Interface,
  signal: AbortSignal,
  turn: (text: string) => Promise<void>,
  slashCtx?: Partial<{ skills: () => Promise<SkillRow[]> }>,
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
  readonly slashCtx?: Partial<{ skills: () => Promise<SkillRow[]> }>
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
  slashCtx: Partial<{ skills: () => Promise<SkillRow[]> }> | undefined,
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
 *  Extracted from `runRepl` so each closure stays under the biome cognitive-
 *  complexity budget. The trailing `\n` per branch matches the prior
 *  `runReplLoopRaw` post-line behavior byte-identically. */
const buildCliPromptSource = (
  slashCtx: Partial<{ skills: () => Promise<SkillRow[]> }> | undefined,
  uxOpts?: { promptHistory?: PromptHistory; multiline?: boolean },
): PromptSource => ({
  next: async (signal) => {
    while (signal?.aborted !== true) {
      const next = await classifyReplLine(signal, slashCtx, uxOpts)
      if (next === undefined) continue
      return next
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
  } = buildTooling(mcpTools, lspTools, lspNavTools, gitToolList, slog)
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
      return ans.trim().toLowerCase() === "y"
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

  // Live turn indicator (spinner + elapsed + token counter). Default-ON
  // when stdout is a TTY; explicit `QUANTA_SPINNER=0|false|off|no` flips
  // it off. Non-TTY surfaces (pipes, redirects, eval/bench harnesses) get
  // a disabled indicator ⇒ `turnStream === stream` (no tee, byte-identical
  // recorder/stdout fan-out to the pre-indicator path). See
  // `buildTurnIndicatorAndStream` for the gate + tee construction.
  const { indicator: turnIndicator, turnStream } = buildTurnIndicatorAndStream(
    statusBar,
    stream,
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
      const slashCtx = skillsCb !== undefined ? { skills: skillsCb } : undefined
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
      const cliPromptSource = buildCliPromptSource(slashCtx, {
        ...(promptHistory !== undefined ? { promptHistory } : {}),
        multiline: multilineEnabled,
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
          }
          process.stderr.write("\n")
          return result
        },
        onTurnEnd: ({ messages }) => {
          // Mirror the legacy update of the surface-scoped `history`
          // binding so any downstream surface state remains in sync.
          history = messages
        },
      })
    }
  } finally {
    await shutdownMcp()
  }
}
