import { existsSync } from "node:fs"
import * as readline from "node:readline/promises"
import { type AgentOutcome, RetryingLLM, runAgent, saveSession } from "@/agent"
import type { LLMPort, Message } from "@/llm"
import { StructuredLogger } from "@/observability"
import type { PermissionContext, PermissionMode, ToolAction } from "@/permission"
import { type SavePayload, saveSessionById } from "@/session"
import { logger } from "@/shared"
import { loadEnvFiles } from "./dotenv"
import {
  argvPrompt,
  assembleConfig,
  buildLLM,
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
  pickProvider,
  resolveResume,
  type SessionDeps,
  titleFlag,
} from "./internal"
import { runSessionCommand } from "./session-commands"

loadEnvFiles([".env.dev", ".env.local", ".env"])

// ADR-0024 (export-gap closure): pure-ish CLI helpers now live in
// `./internal` so unit tests can import them directly. This entrypoint keeps
// only the orchestration that depends on `process` / `readline` / `main()`.

/** HIGH-4 helper: if the resumed id-mode session lives in a different cwd
 *  (e.g. a fork-worktree session), chdir into it BEFORE the cwd captured by
 *  SessionDeps is read. Exits 1 with a clear error when the directory is
 *  missing on disk (worktree removed since the session was saved). Returns
 *  the post-chdir cwd. */
const switchToSessionCwd = (current: string, target: string, slog: StructuredLogger): string => {
  if (target === current) return current
  if (!existsSync(target)) {
    logger.error(`Session cwd missing: ${target}. The worktree may have been removed.`)
    process.exit(1)
  }
  process.chdir(target)
  const next = process.cwd()
  slog.info("session.cwd.switched", { from: current, to: next })
  return next
}

/** MEDIUM-10: top-level usage block. Printed when the user passes `--help` or
 *  `-h` BEFORE any prompt forwarding logic so a typo doesn't become an LLM
 *  prompt. The session subcommand has its own help under
 *  `quanta session --help`. */
const topLevelUsage = (): string =>
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

/** Interactive REPL loop: each line continues the same conversation. */
const runRepl = async (
  rl: readline.Interface,
  signal: AbortSignal,
  turn: (text: string) => Promise<void>,
): Promise<void> => {
  while (!signal.aborted) {
    const input = (await rl.question("\nquanta› ")).trim()
    if (input === "") continue
    if (input === "/exit" || input === "/quit") break
    await turn(input)
  }
}

/** Route `quanta session …` to the session subcommand dispatcher. Returns the
 *  exit code so the caller can `process.exit(...)`. None of the agent/REPL
 *  wiring runs in this branch — that's how byte-identical default-OFF holds
 *  when no `session` subcommand is given. */
const runSessionMain = async (): Promise<number> => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
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

const main = async (): Promise<void> => {
  // Early route: `quanta session …` is fully handled by the subcommand
  // dispatcher and never touches the agent loop / REPL wiring below.
  if (process.argv[2] === "session") {
    const code = await runSessionMain()
    process.exit(code)
  }

  // MEDIUM-10: top-level `--help` / `-h` BEFORE any LLM/REPL wiring so a help
  // request never becomes a prompt. Routed only when the help flag appears in
  // the bare argv (no `session` subcommand involved — handled above).
  const rawArgs = process.argv.slice(2)
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    process.stdout.write(topLevelUsage())
    process.exit(0)
  }

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

  const rl = readline.createInterface({ input: process.stdin, output: process.stderr })
  const onConfirm = async (action: ToolAction): Promise<boolean> => {
    const ans = await rl.question(`Allow ${action.tool}? [y/N] `)
    return ans.trim().toLowerCase() === "y"
  }

  const argPrompt = argvPrompt()

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
  const sessionDeps: SessionDeps = {
    llm: finalLLM,
    registry,
    stream,
    permission,
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
  }
  const session = (messages: Message[]): Promise<AgentOutcome> =>
    runAgent(assembleConfig(messages, sessionDeps))

  const turn = async (text: string): Promise<void> => {
    history.push({ role: "user", content: [{ type: "text", text }] })
    const outcome = await session(history)
    history = outcome.messages
    if (state) {
      await saveSession(state, {
        sessionId,
        messages: history,
        reason: outcome.reason,
        turns: outcome.turns,
      })
    }
    if (idMeta) {
      // Auto-save in id-mode: per-turn persistence so `quanta --resume <id>`
      // self-persists without the user touching `--state`. No log emitted
      // here — would be too chatty inside the REPL.
      const payload: SavePayload = {
        reason: outcome.reason,
        turns: outcome.turns,
        messages: history,
      }
      await saveSessionById(idMeta, payload)
    }
    if (metrics) slog.info("metrics.snapshot", { snapshot: metrics.snapshot() })
  }

  try {
    if (argPrompt) {
      await turn(argPrompt)
    } else {
      await runRepl(rl, abort.signal, turn)
    }
    rl.close()
  } finally {
    await shutdownMcp()
  }
}

// R-Phase4 P3-1: defense-in-depth handler for promise rejections that escape
// the agent loop's `try/catch` boundaries (background MCP cleanup, off-loop
// timers, fire-and-forget logger flushes, etc.). Logs to stderr via the shared
// logger so the operator sees a single diagnostic line; deliberately does NOT
// exit — the loop owns process lifetime, and exiting here would lose any
// trajectory the loop is still finalising. If a rejection actually reaches
// here it indicates a contract bug somewhere; the log line names it.
process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason)
  logger.error(`unhandled rejection (defense-in-depth): ${msg}`)
})

main().catch((e) => {
  logger.error(`fatal: ${(e as Error).message}`)
  process.exit(1)
})
