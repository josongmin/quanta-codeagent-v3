import { selectRemoteRunner } from "@/remote"
import { errMessage, logger, setTerminalIo } from "@/shared"
import { loadEnvFiles } from "./dotenv"
import { runRemoteCmd } from "./remote-cmd"
import { runRepl, runSessionMain, runSlashMain, topLevelUsage } from "./repl"
import { SessionBootstrapError } from "./repl/session-bootstrap"
import { SessionStartupError } from "./repl/session-startup-error"
import { installCliSandbox } from "./sandbox-wire"
import { isSlashCommand } from "./slash-commands"

setTerminalIo({
  stdout: (chunk) => {
    void process.stdout.write(chunk)
  },
  stderr: (chunk) => {
    void process.stderr.write(chunk)
  },
})

loadEnvFiles([".env.dev", ".env.local", ".env"])

// Phase-3 split (RFC may-22-unified-agent-runtime §3): pure structural
// refactor with ZERO behavior change for existing CLI users. `index.ts` now
// owns only the argv-routing short-circuits (`session` subcommand, built-in
// `/<slash>` commands, top-level `--help`) — the REPL loop, agent assembly,
// resume state machine and per-turn save plumbing live in `./repl` (delegated
// via `runRepl()`) and `./session-io`.
//
// Earlier history: ADR-0024 (export-gap closure) moved pure-ish CLI helpers
// to `./internal` so unit tests could import them directly. This phase
// completes that split by moving the orchestration body itself out of the
// entrypoint, leaving `index.ts` as the assembly orchestrator only.

const main = async (): Promise<void> => {
  // S1 — OS sandbox wire-up. Reads `QUANTA_SANDBOX` ONCE at boot (after
  // dotenv load so `.env.local` overrides are honored). Default-OFF: when
  // unset / "default" / "off" / "" the slot stays uninstalled and
  // `runShell` is byte-identical to pre-S1. Degraded backends surface a
  // one-line stderr warning before the first sandboxed command runs.
  await installCliSandbox()

  // Early route: `quanta session …` is fully handled by the subcommand
  // dispatcher and never touches the agent loop / REPL wiring below.
  if (process.argv[2] === "session") {
    const code = await runSessionMain()
    process.exit(code)
  }

  // ADR-0290 — `quanta remote …` subcommand. Default-OFF: when
  // `QUANTA_REMOTE_RUNNER` is unset / `none` the dispatcher exits with
  // `remote-not-configured` (exit 64) WITHOUT spawning any subprocess.
  if (process.argv[2] === "remote") {
    const ac = new AbortController()
    const onSig = () => ac.abort()
    process.on("SIGINT", onSig)
    process.on("SIGTERM", onSig)
    const runner = selectRemoteRunner(process.env, {})
    const code = await runRemoteCmd(process.argv.slice(3), {
      runner,
      io: {
        out: (s) => process.stdout.write(s),
        err: (s) => process.stderr.write(s),
      },
      signal: ac.signal,
      ...(process.env["QUANTA_REMOTE_DEFAULT_IMAGE"] !== undefined
        ? { defaultImage: process.env["QUANTA_REMOTE_DEFAULT_IMAGE"] }
        : {}),
      ...(process.env["QUANTA_REMOTE_TIMEOUT_MS"] !== undefined
        ? { defaultTimeoutMs: Number.parseInt(process.env["QUANTA_REMOTE_TIMEOUT_MS"], 10) }
        : {}),
    })
    process.off("SIGINT", onSig)
    process.off("SIGTERM", onSig)
    process.exit(code)
  }

  // Tier-2 absorption #2-1: built-in slash commands short-circuit BEFORE any
  // LLM / session plumbing. The gate matches only `/<letter>...` so legacy
  // path-mode resume arguments and bare `--flag` invocations still fall
  // through to the agent / REPL path.
  const slashTok = process.argv[2]
  if (slashTok !== undefined && isSlashCommand(slashTok)) {
    process.exit(await runSlashMain(slashTok))
  }

  // MEDIUM-10: top-level `--help` / `-h` BEFORE any LLM/REPL wiring so a help
  // request never becomes a prompt. Routed only when the help flag appears in
  // the bare argv (no `session` subcommand involved — handled above).
  const rawArgs = process.argv.slice(2)
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    process.stdout.write(topLevelUsage())
    process.exit(0)
  }

  // Delegate to the REPL/one-shot orchestrator. All agent assembly, resume
  // state machine, interactive loop and per-turn save plumbing lives there.
  await runRepl()
}

// R-Phase4 P3-1: defense-in-depth handler for promise rejections that escape
// the agent loop's `try/catch` boundaries (background MCP cleanup, off-loop
// timers, fire-and-forget logger flushes, etc.). Logs to stderr via the shared
// logger so the operator sees a single diagnostic line; deliberately does NOT
// exit — the loop owns process lifetime, and exiting here would lose any
// trajectory the loop is still finalising. If a rejection actually reaches
// here it indicates a contract bug somewhere; the log line names it.
process.on("unhandledRejection", (reason) => {
  const msg = errMessage(reason)
  logger.error(`unhandled rejection (defense-in-depth): ${msg}`)
})

main().catch((e) => {
  if (e instanceof SessionBootstrapError || e instanceof SessionStartupError) {
    logger.error(e.message)
    process.exit(e.exitCode)
  }
  logger.error(`fatal: ${errMessage(e)}`)
  process.exit(1)
})
