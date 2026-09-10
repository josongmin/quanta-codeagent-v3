import { SessionBootstrapError } from "@/host/bootstrap"
import { AgentArgsError } from "@/host/runtime"
import { applyGoalPreset } from "@/objective"
import { installOtelSpanExportFromEnv } from "@/observability/otel-span-export"
import { selectRemoteRunner } from "@/remote"
import { pickProviderCore, projectLlmTransport } from "@/runner/assemble"
import { errMessage, gateDisabled, logger, setTerminalIo } from "@/shared"
import { CLI_SEEDED_GATE_NAMES } from "./cli-seeded-gates"
import { loadEnvFiles } from "./dotenv"
import { applyToolProfileFlag } from "./internal/argv"
import { runRemoteCmd } from "./remote-cmd"
import { buildCliRemoteSeams } from "./remote-dependencies/seams"
import { runRepl, runSessionMain, runSlashMain, topLevelUsage } from "./repl"
import { SessionStartupError } from "./repl/session-startup-error"
import { installCliSandbox } from "./sandbox-wire"
import { isSlashCommand } from "./slash-commands"
import { captureStatusBootProjection } from "./status-cmd"
import { installUnhandledRejectionDefense } from "./unhandled-rejection-defense"
import { renderVersion } from "./version-cmd"
import { QUANTA_VERSION } from "./welcome-banner"

setTerminalIo({
  stdout: (chunk) => {
    void process.stdout.write(chunk)
  },
  stderr: (chunk) => {
    void process.stderr.write(chunk)
  },
  stdoutIsTTY: process.stdout.isTTY,
  stderrIsTTY: process.stderr.isTTY,
})

loadEnvFiles([".env.dev", ".env.local", ".env"])
applyGoalPreset(process.env, !gateDisabled(process.env, "QUANTA_GOAL"))

// jun-03 — CLI-host default-ON for the absorbed feature gates. The SLICES stay
// default-OFF by construction (their `=== "1"` gates + hellgate tests are
// unchanged, so off=byte-identical holds for every non-CLI embedding); the CLI
// host simply OPTS IN by default by seeding each gate to "1" when the operator
// has not set it. An explicit `QUANTA_X=0` (any value ≠ "1") still wins, so the
// off escape hatch is intact. Set AFTER dotenv load so a `.env*` value or a
// real shell export is never clobbered.
//
// WS-E jul-10 (UUX-1-09): the gate LIST (with per-gate descriptions + the full
// per-gate history commentary) moved to `./cli-feature-gates.ts` — a pure data
// leaf this side-effecting entrypoint could never be, so `/help` derives its
// env rows from the SAME list the seed loop consumes (parity pinned by
// `help-env-seeded-gates-parity.hellgate`). The LLM TOOL gates the CLI opts in
// by default are DERIVED from the tool-surface SSOT (`seedEnvVarsForSurface`)
// — adding a CLI-default-ON tool to the manifest auto-seeds its gate here; no
// parallel list to drift.
for (const gate of CLI_SEEDED_GATE_NAMES) {
  if (process.env[gate] === undefined) process.env[gate] = "1"
}

captureStatusBootProjection(
  projectLlmTransport({
    transport: process.env.QUANTA_LLM_TRANSPORT,
    env: process.env,
    credentialProvider: pickProviderCore({ env: process.env }),
  }),
)

/** Validated `QUANTA_REMOTE_TIMEOUT_MS` → optional `{ defaultTimeoutMs }`.
 *  A raw `Number.parseInt` would forward `NaN` on garbage input (silently
 *  disabling the remote timeout); we only set the field when the value parses
 *  to a finite positive integer, otherwise the runner's own default stands. */
const remoteTimeoutOverride = (raw: string | undefined): { defaultTimeoutMs?: number } => {
  if (raw === undefined) return {}
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? { defaultTimeoutMs: n } : {}
}

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

/**
 * OTLP span export (ADR-0268) — the missing last mile. Wires the agent loop's
 * spans to an OTel collector when QUANTA_OTEL_ENDPOINT is set; Default-OFF no-op
 * (no sink registered, byte-identical) otherwise. The exporter's flush timer is
 * `unref`'d so this never keeps the process alive; a best-effort final flush
 * drains the tail on natural exit (the periodic timer already shipped
 * steady-state spans, so process.exit paths lose at most one batch).
 */
const wireOtelSpanExport = (): void => {
  const otelExport = installOtelSpanExportFromEnv(process.env)
  process.on("beforeExit", () => {
    void otelExport.teardown()
  })
}

/**
 * `quanta remote …` (ADR-0290). Lifted out of {@link main} — the route body is
 * signal wiring plus a conditionally-spread options object, and `main` should
 * read as the route TABLE it is. Ends in `process.exit`, hence `Promise<never>`.
 */
const routeRemote = async (): Promise<never> => {
  const ac = new AbortController()
  const onSig = () => ac.abort()
  process.on("SIGINT", onSig)
  process.on("SIGTERM", onSig)
  const resolved = buildCliRemoteSeams(process.env)
  const runner = selectRemoteRunner(process.env, resolved.seams)
  const code = await runRemoteCmd(process.argv.slice(3), {
    runner,
    ...(resolved.reason === "ready"
      ? {}
      : {
          unconfiguredReason:
            resolved.reason === "missing-binary" || resolved.reason === "unknown"
              ? resolved.reason
              : "disabled",
        }),
    io: {
      out: (s) => process.stdout.write(s),
      err: (s) => process.stderr.write(s),
    },
    signal: ac.signal,
    ...(process.env.QUANTA_REMOTE_DEFAULT_IMAGE !== undefined
      ? { defaultImage: process.env.QUANTA_REMOTE_DEFAULT_IMAGE }
      : {}),
    ...remoteTimeoutOverride(process.env.QUANTA_REMOTE_TIMEOUT_MS),
  })
  process.off("SIGINT", onSig)
  process.off("SIGTERM", onSig)
  process.exit(code)
}

/**
 * `quanta batch …` (ADR-0463) — CSV row fan-out. Lifted out of {@link main} for
 * the same reason, and it is the longest route by far: `--help` short-circuits
 * BEFORE the API-key-requiring parent assembly, then the headless parent config
 * and its SubagentRunner are built so each CSV row runs as a child. Dynamic
 * imports keep that assembly off the common startup path. Ends in
 * `process.exit`, hence `Promise<never>`.
 */
const routeBatch = async (): Promise<never> => {
  const batchArgv = process.argv.slice(3)
  const { runBatchCmd } = await import("./batch-cmd")
  // `--help` renders usage WITHOUT assembling the (API-key-requiring) parent
  // config: runBatchCmd returns on help before it ever calls the runner, so
  // the stub is genuinely never invoked.
  if (batchArgv.includes("--help") || batchArgv.includes("-h")) {
    process.exit(
      await runBatchCmd(batchArgv, {
        runner: () => Promise.reject(new Error("unreachable: batch --help")),
      }),
    )
  }
  const ac = new AbortController()
  const onSig = () => ac.abort()
  process.on("SIGINT", onSig)
  process.on("SIGTERM", onSig)
  // ADR-0303 thin-surface — these moved DOWN into `@/host/runtime`, so the
  // CLI reaches them by reaching DOWN (allowed) instead of sideways into
  // `apps/agent` (a cross-surface edge the coupling ratchet forbids).
  const [
    { parseAgentArgs, buildBaseFromArgs, toAssembleRequest },
    { createSubagentRunner, loadNamedAgents },
  ] = await Promise.all([import("@/host/runtime"), import("@/agent")])
  // F2 (round-2) — load `.quanta/agents` (+ native dir) ONCE and thread the
  // resolver onto the assemble partial so a `quanta batch` row whose model
  // emits `agent_type:"foo"` resolves the named definition (parity with the
  // headless `apps/agent` surface). `buildBaseFromArgs` lifts the partial slot
  // onto `AgentConfig.namedAgentResolver`, which the SubagentRunner consults
  // per spawn. cwd = `process.cwd()` (batch has no jailed cwd before assembly;
  // each child row inherits the headless parent base's cwd, also process.cwd()).
  // FAIL-OPEN + default-OFF byte-identical: no agent dir ⇒ EMPTY registry ⇒
  // slot stays absent ⇒ no named agent ever resolves; a thrown loader is
  // swallowed to `undefined` so assembly can NEVER fault on the registry load.
  const batchPartial = toAssembleRequest(
    parseAgentArgs(["--mode", "headless", "-p", "batch-runner-parent"]),
  )
  const batchNamedAgents = await loadNamedAgents(process.cwd()).catch(() => undefined)
  if (batchNamedAgents !== undefined && batchNamedAgents.size > 0) {
    batchPartial.namedAgentResolver = batchNamedAgents
  }
  // A headless parent config is enough to build the row-dispatch SubagentRunner
  // (batch never enters the parent's own agent loop — each row is a child, so
  // the placeholder `-p` is never consumed; it only satisfies headless arg
  // validation).
  const base = buildBaseFromArgs(batchPartial, ac.signal)
  const runner = createSubagentRunner(base)
  const code = await runBatchCmd(batchArgv, { runner })
  process.off("SIGINT", onSig)
  process.off("SIGTERM", onSig)
  process.exit(code)
}

const main = async (): Promise<void> => {
  // S1 — OS sandbox wire-up. Reads `QUANTA_SANDBOX` ONCE at boot (after
  // dotenv load so `.env.local` overrides are honored). Default-OFF: when
  // unset / "default" / "off" / "" the slot stays uninstalled and
  // `runShell` is byte-identical to pre-S1. Degraded backends surface a
  // one-line stderr warning before the first sandboxed command runs.
  await installCliSandbox()
  wireOtelSpanExport()

  // Early route: `quanta session …` is fully handled by the subcommand
  // dispatcher and never touches the agent loop / REPL wiring below.
  if (process.argv[2] === "session") {
    const code = await runSessionMain()
    process.exit(code)
  }

  // CLI "attach to a running daemon" — `quanta attach [ws-url]`. The legacy CLI
  // is in-process-only; this subcommand makes it a WS CLIENT of a daemon's
  // shared session.v1 endpoint (discovery→adopt handshake, live event render,
  // stdin→input.append+turn.run, y/N approvals). Default-OFF byte-identical: a
  // bare `quanta` run never reaches here, so the in-process REPL path is
  // untouched. Dynamic import keeps the WS/attach slice off the common startup
  // path. `--help` renders usage WITHOUT opening a socket.
  if (process.argv[2] === "attach") {
    const { runAttachCmd } = await import("./attach-cmd")
    process.exit(await runAttachCmd(process.argv.slice(3)))
  }

  // ADR-0290 — `quanta remote …` subcommand. Default-OFF: when
  // `QUANTA_REMOTE_RUNNER` is unset / `none` the dispatcher exits with
  // `remote-not-configured` (exit 64) WITHOUT spawning any subprocess.
  if (process.argv[2] === "remote") {
    await routeRemote()
  }

  // ADR-0463 — `quanta batch …` CSV row-fan-out subcommand. Default-OFF: inert
  // unless the `batch` subcommand is explicitly typed (a bare `quanta` run never
  // reaches this). Assembles a parent AgentConfig via the SAME buildBaseFromArgs
  // the agent app uses, builds the real SubagentRunner, and runs one child agent
  // loop per CSV row. Dynamic imports keep the heavy agent-assembly out of the
  // common startup path.
  if (process.argv[2] === "batch") {
    await routeBatch()
  }

  // TICKET-19 — `quanta mcp-server` reverse-MCP subcommand (quanta AS an MCP
  // server over stdio). SECURITY/RCE surface: gated on `QUANTA_MCP_SERVER=1`
  // (strict `=== '1'`); unset ⇒ the command exits 64 and assembles NOTHING
  // (default-OFF byte-identical — a bare `quanta` run never reaches this). The
  // composition root (`mcp-server-setup.ts`) is the ONLY place `@/agent` +
  // `@/mcp` meet; dynamic import keeps the heavy agent assembly off the common
  // startup path. Mirrors the `batch` route: `--help` short-circuits before any
  // assembly, and SIGINT/SIGTERM abort the stdin pump cleanly.
  if (process.argv[2] === "mcp-server") {
    const mcpArgv = process.argv.slice(3)
    const { runMcpServerCmd } = await import("./mcp-server-setup")
    // `--help` and the gate-off path return BEFORE assembly (no API key needed),
    // so no AbortController / signal handlers are wired for them. The command
    // owns its own SIGINT/SIGTERM handling around the stdin pump.
    process.exit(await runMcpServerCmd(mcpArgv))
  }

  // jul-16 ticket 02 — `quanta serve --stdio` session.v1 server subcommand
  // (quanta AS a session server an IDE / sidecar drives over stdin/stdout, the
  // Codex app-server shape). MATURITY-gated on `QUANTA_SERVE_STDIO=1` (strict
  // `=== '1'`); unset ⇒ the command exits 64 and serves NOTHING (default-OFF
  // byte-identical — a bare `quanta` run never reaches this). The composition
  // root (`serve-stdio-cmd.ts`) injects the stdio transport into
  // `openHeadlessRuntimeSession`; dynamic import keeps the heavy bootstrap off
  // the common startup path. Mirrors the `mcp-server` route: `--help` and the
  // gate-off path return BEFORE any assembly, and stdin EOF / SIGTERM trigger a
  // graceful session close inside the command.
  if (process.argv[2] === "serve") {
    const serveArgv = process.argv.slice(3)
    const { runServeStdioEntry } = await import("./serve-stdio-entry")
    process.exit(await runServeStdioEntry(serveArgv))
  }

  // ADR-0312 — `quanta webhook` GitHub-webhook HOST subcommand (inbound HTTP →
  // verified-HMAC + dedup + mention-filter → reactor-watch IPC). SECURITY/RCE-
  // adjacent inbound-network surface: gated on `QUANTA_GITHUB_WEBHOOK=1` (strict
  // `=== '1'`); unset ⇒ the command exits 64 and binds NOTHING (default-OFF byte-
  // identical — a bare `quanta` run never reaches this). The composition root
  // (`webhook-server-setup.ts`) drains the live `createWebhookEventSource`
  // pipeline into `publishReactorWatchTrigger`; dynamic import keeps it off the
  // common startup path. Mirrors the `mcp-server` route: `--help` and the
  // gate-off / missing-secret paths return BEFORE any bind, and SIGINT/SIGTERM
  // stop the listener + poll pump cleanly.
  if (process.argv[2] === "webhook") {
    const webhookArgv = process.argv.slice(3)
    const { runWebhookServerCmd } = await import("./webhook-server-setup")
    process.exit(await runWebhookServerCmd(webhookArgv))
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

  // jun-11 (R3 worklist #7) — top-level `--version` / `-v` BEFORE any LLM/REPL
  // wiring so a version query never falls through to an empty-prompt REPL (the
  // dash tokens are dropped by `argvPrompt`, so today `quanta --version` silently
  // starts the REPL — a confusing no-op). Reuses the SAME `renderVersion()` the
  // `/version` slash + welcome banner use; no new version-string wiring. Mirrors
  // the `--help` short-circuit above.
  if (rawArgs.includes("--version") || rawArgs.includes("-v")) {
    process.stdout.write(`${renderVersion({ version: QUANTA_VERSION })}\n`)
    process.exit(0)
  }

  // DOF-11 — validate the shipping CLI's profile flag before session/LLM
  // assembly, then seed the existing bootstrap authority. `/profile` mutates
  // the ToolProfileSessionState created from this same env input.
  applyToolProfileFlag(rawArgs, process.env)

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
//
// The handler + its EXACTLY-once registration live in a pure leaf so the two
// CRITICAL contracts (single diagnostic line, never `process.exit`; wired once
// to the CLI entry) are fault-injectable in a unit hellgate
// (`unhandled-rejection-defense-hellgate.test.ts`).
installUnhandledRejectionDefense()

main().catch((e) => {
  if (e instanceof AgentArgsError) {
    logger.error(e.message)
    process.exit(64)
  }
  if (e instanceof SessionBootstrapError || e instanceof SessionStartupError) {
    logger.error(e.message)
    process.exit(e.exitCode)
  }
  logger.error(`fatal: ${errMessage(e)}`)
  // ADR-0303 — honor a typed launcher error's exit code (e.g. the batch path's
  // ProviderKeyMissingError ⇒ 2, preserving the prior missing-credentials POSIX
  // exit that `buildBaseFromArgs` used to `process.exit(2)` directly); generic
  // errors stay exit 1.
  const code =
    typeof (e as { exitCode?: unknown })?.exitCode === "number"
      ? (e as { exitCode: number }).exitCode
      : 1
  process.exit(code)
})
