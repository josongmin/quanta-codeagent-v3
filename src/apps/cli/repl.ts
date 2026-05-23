import * as readline from "node:readline/promises"
import {
  type AgentConfig,
  type AgentOutcome,
  buildSystemPrompt,
  RetryingLLM,
  runAgent,
} from "@/agent"
import type { ContentBlock, ImageBlock, LLMPort, Message } from "@/llm"
import {
  buildCostDashboard,
  buildShellOtelObserver,
  renderDashboardText,
  StructuredLogger,
  summarizeWorkMetrics,
} from "@/observability"
import type { PermissionContext, PermissionMode, ToolAction } from "@/permission"
import { logger } from "@/shared"
import { discoverSkills, discoverSystemSkills } from "@/skill"
import { composeShellObservers } from "@/tool"
import { loadImageBlock } from "./image-loader"
import { AbortError, readLine } from "./raw-line-reader"
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
import { runSessionCommand } from "./session-commands"
import { persistTurn, switchToSessionCwd } from "./session-io"
import { buildShellStreamPainter } from "./shell-stream-painter"
import {
  describeSlashCommand,
  isSlashCommand,
  runSlashCommand,
  type SkillRow,
  slashCompleter,
} from "./slash-commands"

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
export const runReplLoopRaw = async (
  signal: AbortSignal,
  turn: (text: string) => Promise<void>,
  slashCtx?: Partial<{ skills: () => Promise<SkillRow[]> }>,
): Promise<void> => {
  process.stderr.write("\n")
  while (!signal.aborted) {
    let input: string
    try {
      input = (
        await readLine({
          prompt: "quanta› ",
          completer: (line) => slashCompleter(line)[0],
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
  const sessionDeps: SessionDeps = {
    llm: finalLLM,
    registry,
    stream,
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
  const session = (messages: Message[]): Promise<AgentOutcome> =>
    runAgent(assembleConfig(messages, sessionDeps))

  const turn = async (text: string): Promise<void> => {
    // ADR-0083: attach seed images to the FIRST turn only, then drain so
    // subsequent REPL lines are text-only (byte-identical when no --image).
    const content: ContentBlock[] = [{ type: "text", text }, ...pendingImages]
    pendingImages = []
    history.push({ role: "user", content })
    const outcome = await session(history)
    history = outcome.messages
    await persistTurn({ state, idMeta, sessionId, messages: history, outcome })
    if (metrics) {
      const snap = metrics.snapshot()
      slog.info("metrics.snapshot", { snapshot: snap })
      // ADR-0085: render the cost & cache dashboard to stderr after each turn
      // when metrics are enabled — keeps the structured log AND gives the
      // operator a human-readable cost/latency/cache summary inline.
      process.stderr.write(`${renderDashboardText(buildCostDashboard(snap, { model }))}\n`)
    }
  }

  try {
    if (argPrompt) {
      await turn(argPrompt)
    } else {
      const skillsCb = buildSkillsCallback(skillsConfig)
      await runReplLoopRaw(
        abort.signal,
        turn,
        skillsCb !== undefined ? { skills: skillsCb } : undefined,
      )
    }
  } finally {
    await shutdownMcp()
  }
}
