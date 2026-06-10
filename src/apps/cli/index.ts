import { SessionBootstrapError } from "@/host/bootstrap"
import { selectRemoteRunner } from "@/remote"
import { errMessage, logger, setTerminalIo } from "@/shared"
import { seedEnvVarsForSurface } from "@/tool"
import { loadEnvFiles } from "./dotenv"
import { runRemoteCmd } from "./remote-cmd"
import { runRepl, runSessionMain, runSlashMain, topLevelUsage } from "./repl"
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
  stdoutIsTTY: process.stdout.isTTY,
  stderrIsTTY: process.stderr.isTTY,
})

loadEnvFiles([".env.dev", ".env.local", ".env"])

// jun-03 — CLI-host default-ON for the absorbed feature gates. The SLICES stay
// default-OFF by construction (their `=== "1"` gates + hellgate tests are
// unchanged, so off=byte-identical holds for every non-CLI embedding); the CLI
// host simply OPTS IN by default by seeding each gate to "1" when the operator
// has not set it. An explicit `QUANTA_ENABLE_X=0` (any value ≠ "1") still wins,
// so the off escape hatch is intact. Set AFTER dotenv load so a `.env*` value or
// a real shell export is never clobbered. NOTE: prompt-suggestion costs one
// extra (tools-denied, single-shot) LLM call per turn — disable with
// `QUANTA_ENABLE_PROMPT_SUGGESTION=0` if that latency/spend is unwanted.
// CLI surface FEATURE gates — these are CLI surface behaviors, NOT LLM tools
// (env-probe/prompt-suggestion), so they are NOT in the tool-surface manifest
// and stay listed explicitly here.
const CLI_FEATURE_GATES = [
  "QUANTA_ENABLE_ENV_PROBE",
  "QUANTA_ENABLE_PROMPT_SUGGESTION",
  // ADR-0474 — stale-read-guard: block write/edit of a file externally modified
  // since the agent read it ("re-read first"). Protective correctness guard.
  "QUANTA_STALE_READ_GUARD",
  // ADR-0471 (H2) — untrusted-source envelope: wrap external tool output
  // (web_fetch/mcp/plugin/bash/file-content) in a `<untrusted-source name="...">`
  // envelope + teach the model (one standing system rule) to read it as DATA,
  // never instructions, and FLAG suspected prompt-injection. Structural
  // prompt-injection defense — low cost, high ROI, so the CLI opts in by default.
  // Default-OFF at the runtime-config layer keeps non-CLI surfaces (web-daemon/
  // headless) byte-identical; `QUANTA_UNTRUSTED_ENVELOPE=0` still wins here (we
  // only seed when unset).
  "QUANTA_UNTRUSTED_ENVELOPE",
  // H9 — read `file_unchanged` dedup: a re-read of the SAME (path, offset, limit)
  // whose mtime is unchanged returns a compact `file_unchanged` sentinel instead
  // of re-sending the full content (large token savings in iterative loops). Pure
  // token/correctness win, so the CLI opts in by default. Default-OFF at the
  // runtime-config layer keeps non-CLI surfaces byte-identical; `QUANTA_READ_DEDUP=0`
  // (any value ≠ "1") still wins here (we only seed when unset).
  "QUANTA_READ_DEDUP",
  // Multi-agent coordination behavior knobs (RFC jun-4/jun-6, ADR-0479/0480/0482)
  // — the agent↔agent "tiki-taka" protocol. These are BEHAVIOR modifiers on the
  // already-wired host seams, NOT LLM tools (so they are not in the tool-surface
  // manifest): TEAM_DAG makes spawn_batch honor `dependencies` (ordered fan-out),
  // TEAM_BROKER lets a soft-denied worker escalate to the leader's HITL authority
  // (worker can NEVER self-grant — see coordination-broker-wire.ts), TEAM_IDLE
  // gives the leader a fan-in barrier over resident side-agent daemons. CLI opts
  // in by default; the SLICES stay default-OFF at the runtime-config layer, so
  // non-CLI embeddings are byte-identical and `QUANTA_TEAM_*=0` still wins.
  "QUANTA_TEAM_DAG",
  "QUANTA_TEAM_BROKER",
  "QUANTA_TEAM_IDLE",
  // followup_task (ADR-0041/0437) — the agent↔agent ACTIVE-call tool: deliver a
  // message to an existing child AND trigger/interrupt its turn (vs the passive
  // subagent_send_message mailbox the child must poll). Wired via optional-ports
  // `wireOptionalAgentPorts`; now that its gate routes through the canonical
  // `gateOn` SSOT it accepts the standard "1" like every other gate, so it rides
  // the normal seed loop below (the old strict-"on" special case is gone).
  "QUANTA_SUBAGENT_FOLLOWUP",
]
// The LLM TOOL gates the CLI opts in by default are DERIVED from the tool-
// surface SSOT (`seedEnvVarsForSurface`) — the single source of truth. Adding a
// CLI-default-ON tool to the manifest auto-seeds its gate here; no parallel list
// to drift. `QUANTA_X=0` (any non-truthy token) still wins (we only seed when unset).
for (const gate of [...CLI_FEATURE_GATES, ...seedEnvVarsForSurface("cli")]) {
  if (process.env[gate] === undefined) process.env[gate] = "1"
}

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
      ...(process.env.QUANTA_REMOTE_DEFAULT_IMAGE !== undefined
        ? { defaultImage: process.env.QUANTA_REMOTE_DEFAULT_IMAGE }
        : {}),
      ...remoteTimeoutOverride(process.env.QUANTA_REMOTE_TIMEOUT_MS),
    })
    process.off("SIGINT", onSig)
    process.off("SIGTERM", onSig)
    process.exit(code)
  }

  // ADR-0463 — `quanta batch …` CSV row-fan-out subcommand. Default-OFF: inert
  // unless the `batch` subcommand is explicitly typed (a bare `quanta` run never
  // reaches this). Assembles a parent AgentConfig via the SAME buildBaseFromArgs
  // the agent app uses, builds the real SubagentRunner, and runs one child agent
  // loop per CSV row. Dynamic imports keep the heavy agent-assembly out of the
  // common startup path.
  if (process.argv[2] === "batch") {
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
