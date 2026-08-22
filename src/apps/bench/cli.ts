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
import { errMessage, logger } from "@/shared"
import {
  cmdBestkPassk,
  cmdCost,
  cmdDiff,
  cmdExplain,
  cmdLeaderboard,
  cmdPresets,
  cmdWave2Ab,
  cmdWave2Backlog,
  cmdWave2Coverage,
} from "./commands/analyze"
import { cmdAuth } from "./commands/auth"
import { cmdBox } from "./commands/box"
import { cmdGrade } from "./commands/grade"
import { cmdPool } from "./commands/pool"
import { cmdTrace, cmdTraceUrl } from "./commands/trace"
import { knownDatasetFamilyTokens } from "./dataset-family-token"
import { routeBenchTerminalIo } from "./entry-bootstrap"
import { bootBenchOtelExport } from "./otel"
import { CURRENT_BENCH_BASE_PRESET } from "./preset"
import { readDatasetFamilySelector } from "./run-config"

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
    const { runMain } = await import("./index")
    await runMain()
    return
  }
  switch (sub) {
    case "run": {
      const { runMain } = await import("./index")
      await runMain()
      return
    }
    case "grade":
    case "remote":
      await cmdGrade()
      return
    case "pool":
      await cmdPool()
      return
    case "terminal": {
      // BFND-01 — resolve the terminal-bench suite config at the composition root.
      // Execution/reporting for Terminal-Bench lands in later foundation stages
      // (BFND-02 report envelope + BFND-03 dashboard projectors); today this
      // validates the suite identity (and REFUSES a --dataset-family selector,
      // which is a SWE-only axis) so the discriminator is resolved once, here.
      // MED-6 (aug-22): the REAL argv is threaded here. It was hardcoded to
      // `undefined`, so `quanta-bench terminal --dataset-family pro` resolved
      // cleanly and only the ENV spelling was refused — the documented RED rail
      // was green in unit tests (which called the pure resolver directly) while
      // the live CLI path let a SWE-only axis through on a Terminal-Bench run.
      const { resolveBenchmarkRunConfig } = await import("./benchmark-suite")
      resolveBenchmarkRunConfig({
        subcommand: "terminal",
        // LOW-10: the SELECTOR reader (not the generic `argValue`), so a
        // valueless `--dataset-family` is refused instead of reading back as
        // absent — which used to slip a SWE-only axis past this very rail.
        argvFamily: readDatasetFamilySelector(process.argv),
        env: process.env,
      })
      logger.info(
        "quanta-bench terminal: Terminal-Bench execution is not yet wired at this " +
          "composition root (foundation stage BFND-01 resolves the suite identity only).",
      )
      return
    }
    case "box":
      await cmdBox()
      return
    case "auth":
      await cmdAuth()
      return
    case "diff":
      cmdDiff()
      return
    case "explain":
      cmdExplain()
      return
    case "leaderboard":
      cmdLeaderboard()
      return
    case "cost":
      cmdCost()
      return
    case "bestk-passk":
      await cmdBestkPassk()
      return
    case "wave2-ab":
      cmdWave2Ab()
      return
    case "wave2-coverage":
      cmdWave2Coverage()
      return
    case "wave2-backlog":
      cmdWave2Backlog()
      return
    case "presets":
      cmdPresets()
      return
    case "trace":
      cmdTrace()
      return
    case "trace-url":
      cmdTraceUrl()
      return
    default:
      printHelp()
  }
}

// Only run when invoked directly (not when imported by a test) so unit tests
// can exercise the helpers without launching the CLI.
if (import.meta.main) {
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
  process.on("beforeExit", () => {
    void otelExport.teardown()
  })
  main().catch((err) => {
    logger.info(`quanta-bench error: ${errMessage(err)}`)
    process.exit(1)
  })
}

export { buildBackend } from "./commands/grade"
export { summarizePoolRunLines } from "./commands/pool"
export {
  argValue,
  modelNameFromPredictions,
  parseMaxWorkers,
  positionals,
  resolvedIdsFromReport,
} from "./commands/shared"
// Re-exported for the CLI-dispatch unit tests, which import these from the cli
// barrel under their historical names. The substantive logic now lives under
// ./commands/ (and ./otel); these re-exports keep the test import surface stable.
export { otelUiPort, traceViewerUrl as traceUrl } from "./otel"
