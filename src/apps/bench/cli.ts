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
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { KNOB_PRESETS } from "@/runner/knobs"
import { errMessage, gateOn, logger, runtimeConfig, setTerminalIo } from "@/shared"
import { costSummaryFromReport, renderCost } from "./analyze/cost"
import { diffRuns, renderDiff } from "./analyze/diff"
import { explainFailure } from "./analyze/explain"
import { renderLeaderboardMarkdown, rowsFromRun } from "./analyze/leaderboard"
import { loadVerdictsFromFile } from "./analyze/verdicts"
import type { GradeBackend } from "./remote/backend"
import { createEc2Backend } from "./remote/ec2"
import { createFanoutBackend } from "./remote/fanout"
import { createFullRemoteBackend, runWithRelaunch } from "./remote/full"
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

/** Every `instance_id` in a SWE-bench dataset jsonl — the expected set that
 *  instance-aware relaunch reconciles against to detect partial box loss.
 *  Best-effort: unparseable/blank lines are skipped, a missing file ⇒ []. */
const readDatasetInstanceIds = (path: string): string[] => {
  let raw: string
  try {
    raw = readFileSync(path, "utf8")
  } catch {
    return []
  }
  const ids: string[] = []
  for (const line of raw.split("\n")) {
    const t = line.trim()
    if (t === "") continue
    try {
      const id = (JSON.parse(t) as { instance_id?: unknown }).instance_id
      if (typeof id === "string" && id !== "") ids.push(id)
    } catch {
      /* skip malformed line */
    }
  }
  return ids
}

/** Read a value flag in BOTH `--flag value` and `--flag=value` forms. The
 *  `=`-form previously fell through `indexOf` and was silently ignored. */
const argValue = (flag: string): string | undefined => {
  const i = process.argv.indexOf(flag)
  if (i >= 0) return process.argv[i + 1]
  const pref = `${flag}=`
  const eq = process.argv.find((a) => a.startsWith(pref))
  return eq !== undefined ? eq.slice(pref.length) : undefined
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
  "--model",
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
      // Same escape hatch as full-remote: on-demand when spot is being reclaimed.
      onDemand: gateOn(process.env, "QUANTA_FULL_REMOTE_ONDEMAND"),
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

/** Log the merged outcome of an instance-aware full-remote run — resolved count,
 *  any box-loss (`missing`, surfaced NOT silently dropped), and attempt count. */
const logFullRemoteOutcome = (out: {
  resolved: string[]
  unresolved: string[]
  missing: string[]
  attempts: number
}): void => {
  const lostNote = out.missing.length > 0 ? ` | ⚠️ LOST ${out.missing.length} (box-loss)` : ""
  const attemptNote = out.attempts > 1 ? ` [${out.attempts} attempts]` : ""
  logger.info(
    `full-remote done — resolved ${out.resolved.length} | unresolved ${out.unresolved.length}${lostNote}${attemptNote}`,
  )
  for (const id of out.resolved) logger.info(`  ✅ ${id}`)
  for (const id of out.missing)
    logger.info(`  ❓ LOST (never graded across ${out.attempts} attempts): ${id}`)
}

/** ADR-0536 §6 — full-remote mode (remote patch-gen + grading). Runs the AGENT
 *  on a credential-bearing box; gated behind --allow-remote-secrets. The executor
 *  ships ONLY the stripped short-lived access_token over ssh STDIN (refresh/id
 *  dropped), enforces IMDSv2 hop-1 + TTL, and always terminates. --dry-run plans
 *  it safely without launching. Instance-aware relaunch recovers box loss. */
const cmdGradeFullRemote = async (): Promise<void> => {
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
  const authJson = dry
    ? "{}"
    : readFileSync(`${process.env.HOME}/.quanta/auth/chatgpt.json`, "utf8")
  const instance = argValue("--instance")
  const preset = process.env.QUANTA_BENCH_PRESET ?? argValue("--preset")
  const fullModel = argValue("--model")
  // The expected instance set instance-aware relaunch reconciles against to detect
  // partial loss. `--instance` wins; else every instance_id in the dataset jsonl.
  const expected =
    instance !== undefined
      ? instance
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== "")
      : readDatasetInstanceIds(dataset)
  // HARD GUARD: `--keep` forces 0 relaunches — a kept box is NOT auto-terminated
  // on loss, so relaunching would orphan it (runaway spot billing). Also 0 when
  // the expected set is unknown (can't reconcile what's missing).
  const maxRelaunch =
    hasFlag("--keep") || expected.length === 0 ? 0 : runtimeConfig().fullRemoteRelaunch
  // ON-DEMAND escape hatch for spot capacity crunches (QUANTA_FULL_REMOTE_ONDEMAND
  // =1). Spot is ~3× cheaper but AWS reclaims it under pressure — observed
  // reclaiming c7i boxes in 4–17 min, faster than relaunch can recover. Same
  // process.env-read pattern as QUANTA_FULL_REMOTE_CONCURRENCY.
  const onDemand = gateOn(process.env, "QUANTA_FULL_REMOTE_ONDEMAND")
  // AMI override (`--ami <id>` or QUANTA_FULL_REMOTE_AMI). Without this the prebaked
  // AMI could not be selected from the CLI — it was baked but unreachable, so every
  // run fell back to the hardcoded default. Now selectable per-run.
  const amiOverride = argValue("--ami") ?? process.env.QUANTA_FULL_REMOTE_AMI
  const makeBackend = (ids: readonly string[]) =>
    createFullRemoteBackend({
      repoDir: process.cwd(),
      authJson,
      datasetPath: dataset,
      ...(ids.length > 0 ? { instanceIds: [...ids] } : {}),
      ...(preset !== undefined ? { preset } : {}),
      ...(fullModel !== undefined ? { model: fullModel } : {}),
      ...(amiOverride !== undefined && amiOverride !== "" ? { ami: amiOverride } : {}),
      dryRun: dry,
      keep: hasFlag("--keep"),
      onDemand,
      onLog: (m) => logger.info(m),
    })
  if (dry) {
    const res = await makeBackend(expected).run()
    printBlock(["=== full-remote plan (dry-run) ===", ...(res.plan ?? [])].join("\n"))
    return
  }
  if (expected.length === 0) {
    // Unknown expected set ⇒ no instance-aware reconcile possible; run once.
    logger.info("[full-remote] could not determine instance set — relaunch retry disabled")
    const res = await makeBackend([]).run()
    logFullRemoteOutcome({
      resolved: [...(res.resolved ?? [])],
      unresolved: [...(res.unresolved ?? [])],
      missing: [],
      attempts: 1,
    })
    return
  }
  const out = await runWithRelaunch(makeBackend, {
    expected,
    maxRelaunch,
    onLog: (m) => logger.info(m),
  })
  logFullRemoteOutcome(out)
}

const cmdGrade = async (): Promise<void> => {
  if ((argValue("--mode") ?? "grade-only") === "full") return cmdGradeFullRemote()

  const predictions = argValue("--predictions")
  const backendSpec = argValue("--backend")
  const dataset = argValue("--dataset") ?? process.env.QUANTA_SWEBENCH_DATASET
  if (predictions === undefined || backendSpec === undefined || dataset === undefined) {
    logger.info(
      "usage: quanta-bench grade --predictions <p.jsonl> --backend <ec2|ssh:user@host> --dataset <instances.jsonl> [--max-workers N] [--run-id id] [--key path] [--keep] [--skip-resolved <prior-report.json>]",
    )
    process.exit(2)
  }
  // Incremental grading: `--skip-resolved <prior-report.json>` drops predictions
  // whose instance is already resolved in a prior swebench report, grades only
  // the remainder, then merges the prior resolved set into the final tally. After
  // a few fixes you re-grade ONLY the not-yet-resolved instances — most of the
  // wall-clock (image pull + tests) is spent solely on what can still change.
  let gradePredictions = predictions
  let priorResolved: string[] = []
  const skipReport = argValue("--skip-resolved")
  if (skipReport !== undefined) {
    const rep = JSON.parse(readFileSync(skipReport, "utf8")) as { resolved_ids?: unknown }
    priorResolved = Array.isArray(rep.resolved_ids) ? (rep.resolved_ids as string[]) : []
    const done = new Set(priorResolved)
    const rows = readFileSync(predictions, "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
    const remaining = rows.filter((l) => {
      try {
        return !done.has((JSON.parse(l) as { instance_id?: string }).instance_id ?? "")
      } catch {
        return true
      }
    })
    gradePredictions = join(tmpdir(), `quanta-preds-incr-${Date.now()}.jsonl`)
    writeFileSync(gradePredictions, `${remaining.join("\n")}\n`)
    logger.info(
      `incremental: ${priorResolved.length} already-resolved skipped, grading ${remaining.length}/${rows.length}`,
    )
  }

  const runId = argValue("--run-id") ?? `quanta-cli-${Date.now()}`
  const backend = buildBackend(backendSpec, modelNameFromPredictions(gradePredictions))
  logger.info(`grading via ${backend.name}: ${gradePredictions} (run_id=${runId})`)
  const outDir = argValue("--out")
  const out = await backend.grade(gradePredictions, {
    datasetPath: dataset,
    runId,
    ...(outDir !== undefined ? { outDir } : {}),
  })
  const mergedResolved = [...new Set([...priorResolved, ...out.resolved])].sort()
  if (priorResolved.length > 0) {
    logger.info(
      `merged with prior: resolved ${mergedResolved.length} (= ${priorResolved.length} prior + ${out.resolved.length} new)`,
    )
  }
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
export { argValue, buildBackend, modelNameFromPredictions, positionals }
