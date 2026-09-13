#!/usr/bin/env bun
/**
 * `quanta-bench` — unified bench CLI (ADR-0536 P0).
 *
 * Subcommand dispatcher layered over the existing flat-flag runner (`runMain`
 * in `./index`) + the remote grade backends (`./remote`) + the analysis layer
 * (`./analyze`). Legacy invocation with NO subcommand (or a leading flag like
 * `--swebench`) routes to `run` so the historical
 * `bun run src/apps/bench/index.ts --swebench …` keeps working verbatim.
 *
 *   quanta-bench run         …flat flags…                 # local patch-gen + (optional) local grade
 *   quanta-bench grade       --predictions p.jsonl --backend <ec2|ssh:user@host> [--dataset ds] [--max-workers N] [--run-id id] [--key path] [--keep]
 *   quanta-bench diff        <reportA.json> <reportB.json>
 *   quanta-bench explain     --dataset <instances.jsonl> --instance <id> [--patch <agent.patch>]
 *   quanta-bench leaderboard <report.json> [more.json …] [--preset name] [--title T]
 *   quanta-bench presets
 *
 * `remote` grading = `grade --backend ec2` (the secure default: patch-gen stays
 * local, only grading is remote). Full remote patch-gen is ADR-0536 §6 (P3).
 *
 * The per-subcommand handlers live under `./commands/<name>.ts`; this file is
 * the thin argv parser + dispatcher + composition root (ADR-0536 P0 cleanup).
 */
import { installWorkspaceTrustAuthority, TRUST_EVERY_FOLDER } from "@/agent/workspace-trust"
import { errMessage, logger } from "@/shared"
import { knownDatasetFamilyTokens } from "./dataset-family-token"
import { routeBenchTerminalIo } from "./entry-bootstrap"
import { bootBenchOtelExport } from "./otel"
import { CURRENT_BENCH_BASE_PRESET } from "./preset"

// Route `logger` to the real terminal (shared SSOT with index.ts — without it
// logger.info writes nowhere).
routeBenchTerminalIo()

const KNOWN_SUBCOMMANDS = new Set([
  "run",
  "grade",
  "pool",
  "terminal",
  "box",
  "auth",
  "remote",
  "diff",
  "explain",
  "leaderboard",
  "cost",
  "bestk-passk",
  "wave2-ab",
  "wave2-coverage",
  "wave2-backlog",
  "presets",
  "trace",
  "trace-url",
  "help",
  "--help",
  "-h",
])

/** PMX-01 — the family selector block is GENERATED from the ONE token registry
 *  at CALL time, not hand-listed and not frozen at import time. Hand-listing is
 *  how `promax` would have shipped invisible to operators; computing it here also
 *  means a runtime-registered family shows up. */
const familyHelpBlock = (): string =>
  [
    "",
    `Dataset family (SWE suite only): --dataset-family <${knownDatasetFamilyTokens().join("|")}>`,
    "  Omit it for SWE-bench Verified. An explicit unknown/blank family is REFUSED, never",
    "  silently defaulted — a typo must not grade one corpus with another's harness.",
    "  `promax` (SWE-bench ProMax) is a dataset FAMILY, not a benchmark suite, and shares",
    "  neither a grader nor a report partition with `pro` (SWE-bench Pro).",
  ].join("\n")

const printHelp = (): void => {
  process.stdout.write(`${HELP}\n${familyHelpBlock()}\n`)
}

const HELP = `quanta-bench — unified SWE-bench CLI (ADR-0536)

  run          local patch-gen + optional local grading (legacy flat flags)
  grade        grade existing predictions on a remote backend (ec2 | ssh:host)
  terminal     Terminal-Bench 2.1 (doctor | canary | run | report) — a SUITE, not a dataset family
  diff         compare two run reports (A/B, regression)
  explain      agent-vs-gold failure analysis for one instance
  leaderboard  render an official/local/research split table from run report(s)
  cost         token / $ / wall-clock summary for a run report
  bestk-passk  OFFLINE Best@K-vs-Pass@K ceiling: re-grade the repair-breadth candidate pool (gated QUANTA_BENCH_BESTK_PASSK)
  wave2-ab     compare thin-strict vs execfull with clean report/prediction provenance
  wave2-coverage  classify multi-file misses as same/partial/disjoint
  wave2-backlog   bucket clean receipts into completeness / generation / oracle
  presets      list bench presets
  trace        launch the live OTEL waterfall UI (receiver + browser); 'trace <run-id>' deep-links to one run
  trace-url    open/print the trace-viewer deep-link for a run-id (sink already running)

Default live execution preset: ${CURRENT_BENCH_BASE_PRESET}
Explicit selectors still win: QUANTA_BENCH_PRESET > QUANTA_BENCH_SOTA > QUANTA_KNOBS_PRESET > --preset.

Run a subcommand with no/invalid args to see its usage. No subcommand ⇒ 'run'.`

const main = async (): Promise<void> => {
  const sub = process.argv[2]
  // Legacy: no subcommand, or a leading flag ⇒ route to `run` (byte-compat with
  // the historical `index.ts --swebench …` entry).
  if (sub === undefined || sub.startsWith("-") || !KNOWN_SUBCOMMANDS.has(sub)) {
    if (sub === "help" || sub === "--help" || sub === "-h") {
      printHelp()
      return
    }
    const { runMain } = await import("./run-main")
    await runMain()
    return
  }
  switch (sub) {
    case "run": {
      const { runMain } = await import("./run-main")
      await runMain()
      return
    }
    case "grade":
    case "remote": {
      const { cmdGrade } = await import("./commands/grade")
      await cmdGrade()
      return
    }
    case "pool": {
      const { cmdPool } = await import("./commands/pool")
      await cmdPool()
      return
    }
    case "terminal": {
      // TB21-00A — the Terminal-Bench branch is REGISTERED here: one nested
      // dispatcher (`./commands/terminal`) that resolves the BFND-01 suite
      // branch + the ONE typed run config, and owns doctor/canary/run/report.
      //
      // It replaces a "not yet wired" stub that only validated the suite
      // identity. The `--dataset-family` refusal it performed is preserved (and
      // strengthened): `cmdTerminal` runs it on EVERY action, before dispatch,
      // through the same BFND-01 resolver — so MED-6's failure mode (the live
      // CLI path handing the resolver a hardcoded `undefined` while unit tests
      // exercised the pure resolver) cannot come back through this seam.
      // The AMBIENT reads (argv + env) happen HERE, at the allowlisted bench
      // composition root, and are threaded in as values — the terminal modules
      // below never re-read `process.env`.
      const { cmdTerminal } = await import("./commands/terminal")
      await cmdTerminal({ argv: process.argv, env: process.env })
      return
    }
    case "box": {
      const { cmdBox } = await import("./commands/box")
      await cmdBox()
      return
    }
    case "auth": {
      const { cmdAuth } = await import("./commands/auth")
      await cmdAuth()
      return
    }
    case "diff": {
      const { cmdDiff } = await import("./commands/analyze")
      cmdDiff()
      return
    }
    case "explain": {
      const { cmdExplain } = await import("./commands/analyze")
      cmdExplain()
      return
    }
    case "leaderboard": {
      const { cmdLeaderboard } = await import("./commands/analyze")
      cmdLeaderboard()
      return
    }
    case "cost": {
      const { cmdCost } = await import("./commands/analyze")
      cmdCost()
      return
    }
    case "bestk-passk": {
      const { cmdBestkPassk } = await import("./commands/analyze")
      await cmdBestkPassk()
      return
    }
    case "wave2-ab": {
      const { cmdWave2Ab } = await import("./commands/analyze")
      cmdWave2Ab()
      return
    }
    case "wave2-coverage": {
      const { cmdWave2Coverage } = await import("./commands/analyze")
      cmdWave2Coverage()
      return
    }
    case "wave2-backlog": {
      const { cmdWave2Backlog } = await import("./commands/analyze")
      cmdWave2Backlog()
      return
    }
    case "presets": {
      const { cmdPresets } = await import("./commands/analyze")
      cmdPresets()
      return
    }
    case "trace": {
      const { cmdTrace } = await import("./commands/trace")
      cmdTrace()
      return
    }
    case "trace-url": {
      const { cmdTraceUrl } = await import("./commands/trace")
      cmdTraceUrl()
      return
    }
    default:
      printHelp()
  }
}

// Only run when invoked directly (not when imported by a test) so unit tests
// can exercise the helpers without launching the CLI.
if (import.meta.main) {
  // Workspace trust (`@/agent/workspace-trust`): this harness runs agents in trees it
  // created itself and executes their code anyway (dataset checkouts and their tests), so
  // every folder it works in is trusted — language-server grounding stays on.
  installWorkspaceTrustAuthority(TRUST_EVERY_FOLDER)
  // OTLP span export (ADR-0268) — this is the PRIMARY bench entry: the operator's
  // `quanta-bench run --swebench …` AND the full-remote box (which runs
  // `bun run src/apps/bench/cli.ts run --swebench …`). When QUANTA_OTEL_ENDPOINT is
  // forwarded to the box (see remote/box-session FORWARD_EXTRA_ENV), the box's
  // agent loop spans STREAM to the operator's collector instead of the flaky
  // box→local run.log push. Default-OFF no-op when the endpoint is unset
  // (byte-identical). Installed here (not in `main`) so the routing fn stays pure.
  // Auto-issue a run id + attach via the shared boot seam (same path the legacy
  // index.ts entry uses, so they never drift). The deep-link is surfaced up front
  // so the operator clicks straight to THIS run's waterfall (`?run=<id>` filters
  // it out of a sink that mixes many concurrent runs). Default-OFF byte-identical.
  const { otelExport, runId: benchRunId, traceLink } = bootBenchOtelExport(process.env)
  if (traceLink !== undefined) logger.info(`[otel] run ${benchRunId} live trace → ${traceLink}`)
  // `beforeExit` can run more than once when its callback starts async work.
  // Own the final flush in this top-level lifecycle instead: a completed run
  // gets one bounded teardown attempt, then the process can exit naturally.
  void (async () => {
    let failed = false
    try {
      await main()
    } catch (err) {
      failed = true
      logger.info(`quanta-bench error: ${errMessage(err)}`)
    } finally {
      await otelExport.teardown()
    }
    if (failed) process.exitCode = 1
  })()
}
