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
 */
import { readFileSync } from "node:fs"
import { KNOB_PRESETS } from "@/runner/knobs"
import { errMessage, logger, setTerminalIo } from "@/shared"
import { costSummaryFromReport, renderCost } from "./analyze/cost"
import { diffRuns, renderDiff } from "./analyze/diff"
import { explainFailure } from "./analyze/explain"
import { renderLeaderboardMarkdown, rowsFromRun } from "./analyze/leaderboard"
import { loadVerdictsFromFile } from "./analyze/verdicts"
import type { GradeBackend } from "./remote/backend"
import { createEc2Backend } from "./remote/ec2"
import { createFanoutBackend } from "./remote/fanout"
import { createFullRemoteBackend } from "./remote/full"
import { createSshBackend } from "./remote/ssh"

// Route `logger` to the real terminal (same wiring index.ts does — without it
// logger.info writes nowhere).
setTerminalIo({
  stdout: (chunk) => {
    void process.stdout.write(chunk)
  },
  stderr: (chunk) => {
    void process.stderr.write(chunk)
  },
})

const KNOWN_SUBCOMMANDS = new Set([
  "run",
  "grade",
  "remote",
  "diff",
  "explain",
  "leaderboard",
  "cost",
  "presets",
  "help",
  "--help",
  "-h",
])

const argValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const hasFlag = (flag: string): boolean => process.argv.includes(flag)

/** Print a render* block (diff / explain / leaderboard markdown) to raw stdout
 *  — NOT via `logger.info`, which prefixes `[info]`, mangles embedded `\n` to
 *  `?`, and de-dups repeated lines (which silently swallowed identical
 *  gold/agent file lines in `explain`). Raw output is also copy-pasteable. */
const printBlock = (s: string): void => {
  process.stdout.write(`${s}\n`)
}

/** Value-taking flags — their following token is a value, NOT a positional. */
const VALUE_FLAGS = new Set([
  "--predictions",
  "--backend",
  "--dataset",
  "--max-workers",
  "--run-id",
  "--key",
  "--out",
  "--region",
  "--preset",
  "--title",
  "--patch",
  "--instance",
  "--shards",
  "--observe-dir",
  "--mode",
])

/** Positional args after the subcommand (argv[2]), skipping flags AND the
 *  value token that follows a value-flag (so `--preset x` doesn't leak `x`). */
const positionals = (): string[] => {
  const rest = process.argv.slice(3)
  const out: string[] = []
  for (let i = 0; i < rest.length; i++) {
    const tok = rest[i]
    if (tok === undefined) continue
    if (tok.startsWith("-")) {
      if (VALUE_FLAGS.has(tok)) i++ // skip its value
      continue
    }
    out.push(tok)
  }
  return out
}

/** model_name_or_path from the first prediction row — names the harness report
 *  file `<model>.<runId>.json`, so the backend must poll for the right name. */
const modelNameFromPredictions = (path: string): string | undefined => {
  try {
    const first = readFileSync(path, "utf8")
      .split("\n")
      .find((l) => l.trim() !== "")
    if (first === undefined) return undefined
    const row = JSON.parse(first) as { model_name_or_path?: unknown }
    return typeof row.model_name_or_path === "string" ? row.model_name_or_path : undefined
  } catch {
    return undefined
  }
}

/** Build ONE backend instance for `spec` (ec2 | ssh:host). A fresh call mints a
 *  fresh box (fanout uses this per shard). */
const buildBaseBackend = (spec: string, modelName: string | undefined): GradeBackend => {
  const mwRaw = argValue("--max-workers")
  const maxWorkers =
    mwRaw !== undefined && Number.isInteger(Number(mwRaw)) ? Number(mwRaw) : undefined
  const common = {
    ...(modelName !== undefined ? { modelName } : {}),
    ...(maxWorkers !== undefined ? { maxWorkers } : {}),
  }
  if (spec === "ec2") {
    const region = argValue("--region")
    return createEc2Backend({
      ...common,
      keep: hasFlag("--keep"),
      ...(region !== undefined ? { region } : {}),
    })
  }
  if (spec.startsWith("ssh:")) {
    const host = spec.slice("ssh:".length)
    const keyPath = argValue("--key") ?? `${process.env.HOME}/Downloads/pickinstead_korea.pem`
    return createSshBackend({ host, keyPath, ...common })
  }
  throw new Error(`unknown --backend "${spec}" (expected: ec2 | ssh:user@host)`)
}

/** Build the grading backend, wrapping in a K-way fan-out when `--shards > 1`
 *  (each shard mints its own fresh box via `buildBaseBackend`). */
const buildBackend = (spec: string, modelName: string | undefined): GradeBackend => {
  const sRaw = argValue("--shards")
  const shards = sRaw !== undefined && Number.isInteger(Number(sRaw)) ? Number(sRaw) : 1
  if (shards > 1) {
    return createFanoutBackend({ shards, makeBackend: () => buildBaseBackend(spec, modelName) })
  }
  return buildBaseBackend(spec, modelName)
}

const cmdGrade = async (): Promise<void> => {
  // ADR-0536 §6 — full-remote mode (remote patch-gen + grading) runs the AGENT
  // on a credential-bearing box (agent executes model-generated code). Opt-in
  // AND gated behind --allow-remote-secrets. The executor (createFullRemoteBackend)
  // ships ONLY the stripped short-lived access_token over ssh STDIN (refresh/id
  // dropped), enforces IMDSv2 hop-1 + TTL, and always terminates. NOTE: actually
  // launching ships a credential across a trust boundary — the harness may block
  // that at runtime (by design); --dry-run plans it safely. `grade-only` default
  // is unaffected.
  const mode = argValue("--mode") ?? "grade-only"
  if (mode === "full") {
    if (!hasFlag("--allow-remote-secrets")) {
      logger.info(
        "refused: --mode full runs patch-gen on the remote box and needs an LLM credential there. " +
          "Re-run with --allow-remote-secrets to acknowledge the risk (ADR-0536 §6). " +
          "Tip: --dry-run shows the plan without launching or shipping anything.",
      )
      process.exit(2)
    }
    const dataset = argValue("--dataset") ?? process.env.QUANTA_SWEBENCH_DATASET
    if (dataset === undefined) {
      logger.info(
        "usage: quanta-bench grade --mode full --allow-remote-secrets --dataset <instances.jsonl> [--instance id] [--dry-run]",
      )
      process.exit(2)
    }
    const dry = hasFlag("--dry-run")
    // Only read the on-disk credential when actually launching (dry-run never
    // touches it). Stripped to access_token only inside the executor.
    const authPath = `${process.env.HOME}/.quanta/auth/chatgpt.json`
    const authJson = dry ? "{}" : readFileSync(authPath, "utf8")
    const instance = argValue("--instance")
    const preset = process.env.QUANTA_BENCH_PRESET ?? argValue("--preset")
    const fullModel = argValue("--model")
    const backend = createFullRemoteBackend({
      repoDir: process.cwd(),
      authJson,
      datasetPath: dataset,
      ...(instance !== undefined ? { instanceIds: instance.split(",") } : {}),
      ...(preset !== undefined ? { preset } : {}),
      ...(fullModel !== undefined ? { model: fullModel } : {}),
      dryRun: dry,
      keep: hasFlag("--keep"),
      onLog: (m) => logger.info(m),
    })
    const res = await backend.run()
    if (res.dryRun) {
      printBlock(["=== full-remote plan (dry-run) ===", ...(res.plan ?? [])].join("\n"))
    } else {
      logger.info(
        `full-remote done — resolved ${res.resolved?.length ?? 0} | unresolved ${res.unresolved?.length ?? 0}`,
      )
      for (const id of res.resolved ?? []) logger.info(`  ✅ ${id}`)
    }
    return
  }

  const predictions = argValue("--predictions")
  const backendSpec = argValue("--backend")
  const dataset = argValue("--dataset") ?? process.env.QUANTA_SWEBENCH_DATASET
  if (predictions === undefined || backendSpec === undefined || dataset === undefined) {
    logger.info(
      "usage: quanta-bench grade --predictions <p.jsonl> --backend <ec2|ssh:user@host> --dataset <instances.jsonl> [--max-workers N] [--run-id id] [--key path] [--keep]",
    )
    process.exit(2)
  }
  const runId = argValue("--run-id") ?? `quanta-cli-${Date.now()}`
  const backend = buildBackend(backendSpec, modelNameFromPredictions(predictions))
  logger.info(`grading via ${backend.name}: ${predictions} (run_id=${runId})`)
  const outDir = argValue("--out")
  const out = await backend.grade(predictions, {
    datasetPath: dataset,
    runId,
    ...(outDir !== undefined ? { outDir } : {}),
  })
  logger.info(
    `resolved ${out.resolved.length} | unresolved ${out.unresolved.length} | error ${out.errored.length} | empty ${out.emptyPatch.length}`,
  )
  for (const id of out.resolved) logger.info(`  ✅ ${id}`)
  for (const id of out.unresolved) logger.info(`  ❌ ${id}`)
  for (const id of out.errored) logger.info(`  ⚠️  ${id}`)
  for (const id of out.emptyPatch) logger.info(`  ∅ ${id}`)
  logger.info(`report: ${out.reportPath}`)
}

const cmdDiff = (): void => {
  const [a, b] = positionals()
  if (a === undefined || b === undefined) {
    logger.info("usage: quanta-bench diff <reportA.json> <reportB.json>")
    process.exit(2)
  }
  printBlock(renderDiff(diffRuns(loadVerdictsFromFile(a), loadVerdictsFromFile(b))))
}

const cmdExplain = (): void => {
  const dataset = argValue("--dataset") ?? process.env.QUANTA_SWEBENCH_DATASET
  const instance = argValue("--instance")
  if (dataset === undefined || instance === undefined) {
    logger.info(
      "usage: quanta-bench explain --dataset <instances.jsonl> --instance <id> [--patch <agent.patch>]",
    )
    process.exit(2)
  }
  const patch = argValue("--patch")
  const e = explainFailure({
    datasetPath: dataset,
    instanceId: instance,
    ...(patch !== undefined ? { agentPatchPath: patch } : {}),
  })
  printBlock(e.summary)
}

const cmdLeaderboard = (): void => {
  const reports = positionals()
  if (reports.length === 0) {
    logger.info(
      "usage: quanta-bench leaderboard <report.json> [more.json …] [--preset name] [--title T]",
    )
    process.exit(2)
  }
  const preset = argValue("--preset") ?? "agentless-v1"
  const rows = reports.flatMap((p) => {
    const v = loadVerdictsFromFile(p)
    const model = (() => {
      try {
        return (JSON.parse(readFileSync(p, "utf8")) as { model?: string }).model ?? "unknown"
      } catch {
        return "unknown"
      }
    })()
    return rowsFromRun(v, { preset, model })
  })
  printBlock(renderLeaderboardMarkdown(rows, argValue("--title") ?? "SWE-bench leaderboard"))
}

const cmdCost = (): void => {
  const [report] = positionals()
  if (report === undefined) {
    logger.info("usage: quanta-bench cost <report.json> [--observe-dir <dir>]")
    process.exit(2)
  }
  const observeDir = argValue("--observe-dir")
  printBlock(
    renderCost(
      costSummaryFromReport({
        reportPath: report,
        ...(observeDir !== undefined ? { observeDir } : {}),
      }),
    ),
  )
}

const cmdPresets = (): void => {
  logger.info("Bench presets — select with QUANTA_BENCH_PRESET=<name> (value, NOT on/off):")
  for (const [name, knobs] of Object.entries(KNOB_PRESETS)) {
    const body = Object.entries(knobs)
      .map(([id, v]) => `${id}=${v}`)
      .join(", ")
    logger.info(`  ${name.padEnd(16)} ${body === "" ? "(no-op baseline)" : body}`)
  }
}

const HELP = `quanta-bench — unified SWE-bench CLI (ADR-0536)

  run          local patch-gen + optional local grading (legacy flat flags)
  grade        grade existing predictions on a remote backend (ec2 | ssh:host)
  diff         compare two run reports (A/B, regression)
  explain      agent-vs-gold failure analysis for one instance
  leaderboard  render a resolved/unresolved table from run report(s)
  cost         token / $ / wall-clock summary for a run report
  presets      list bench presets

Run a subcommand with no/invalid args to see its usage. No subcommand ⇒ 'run'.`

const main = async (): Promise<void> => {
  const sub = process.argv[2]
  // Legacy: no subcommand, or a leading flag ⇒ route to `run` (byte-compat with
  // the historical `index.ts --swebench …` entry).
  if (sub === undefined || sub.startsWith("-") || !KNOWN_SUBCOMMANDS.has(sub)) {
    if (sub === "help" || sub === "--help" || sub === "-h") {
      printBlock(HELP)
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
    case "presets":
      cmdPresets()
      return
    default:
      printBlock(HELP)
  }
}

// Only run when invoked directly (not when imported by a test) so unit tests
// can exercise the helpers without launching the CLI.
if (import.meta.main) {
  main().catch((err) => {
    logger.info(`quanta-bench error: ${errMessage(err)}`)
    process.exit(1)
  })
}

// Exported for unit tests (pure CLI-arg helpers — the routing-bug surface).
export { buildBackend, modelNameFromPredictions, positionals }
