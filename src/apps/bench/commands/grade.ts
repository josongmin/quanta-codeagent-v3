/**
 * `quanta-bench grade` (+ `--mode full` full-remote) — extracted from cli.ts
 * (ADR-0536 P0). Backend construction (ec2 | ssh | fanout) + grade-only and
 * full-remote dispatch. Moved verbatim; behaviour-identical.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gateOn, logger, runtimeConfig } from "@/shared"
import { describeAuthSource, resolveAuthLaunchFile } from "../auth-pool"
import { resolveDatasetFamily } from "../dataset-family"
import { ensureBenchTraceSink } from "../default-trace-sink"
import { resolveBenchExecutionPreset } from "../preset"
import type { GradeBackend } from "../remote/backend"
import { createEc2Backend } from "../remote/ec2"
import { createFanoutBackend } from "../remote/fanout"
import { refreshRemoteAuthJson } from "../remote/fresh-auth"
import { createFullRemoteBackend, runWithRelaunch } from "../remote/full"
import { createSshBackend } from "../remote/ssh"
import {
  allowExtraBoxes,
  argValue,
  hasFlag,
  modelNameFromPredictions,
  parseMaxWorkers,
  printBlock,
  readDatasetInstanceIds,
  resolveCliAuthSource,
  resolvedIdsFromReport,
} from "./shared"

/** Build ONE backend instance for `spec` (ec2 | ssh:host). A fresh call mints a
 *  fresh box (fanout uses this per shard). */
const buildBaseBackend = (spec: string, modelName: string | undefined): GradeBackend => {
  const mw = parseMaxWorkers(argValue("--max-workers"))
  if (!mw.ok) {
    logger.info(
      `refused: --max-workers must be a positive integer (got "${mw.raw}") — ` +
        "it is passed verbatim to the remote swebench grade harness.",
    )
    process.exit(2)
  }
  const maxWorkers = mw.value
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
export const buildBackend = (spec: string, modelName: string | undefined): GradeBackend => {
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
      "usage: quanta-bench grade --mode full --allow-remote-secrets --dataset <instances.jsonl> [--instance id] [--dry-run] [--allow-extra-boxes]",
    )
    process.exit(2)
  }
  const dry = hasFlag("--dry-run")
  // Only read the on-disk credential when actually launching (dry-run never
  // touches it). Stripped to access_token only inside the executor.
  //
  // jun-20: the credential path is overridable via `QUANTA_BENCH_AUTH_FILE` so a
  // SECOND ChatGPT account can drive a parallel full-remote fleet without sharing
  // the default account's rate-limit budget. Symptom that forced this: two
  // concurrent bench efforts on ONE OAuth token starved each other → sustained
  // 429 surfacing as `generation_error` ("LLM stream failed after retries") on
  // BOTH. Point each fleet at its own account file to decouple the rate limits.
  // jun-20 multi-auth: resolve through the SAME source abstraction `pool` uses,
  // so full-remote can't silently diverge to a different auth truth. Single-auth
  // stays byte-identical; pool mode now also honors fail-fast `--auth-label`.
  const authSource = resolveCliAuthSource()
  const authFile = resolveAuthLaunchFile(authSource)
  const authJson = dry ? "{}" : await refreshRemoteAuthJson(authFile)
  const instance = argValue("--instance")
  const preset = resolveBenchExecutionPreset({
    envVars: process.env,
    argvPreset: argValue("--preset"),
  })
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
      preset,
      ...(fullModel !== undefined ? { model: fullModel } : {}),
      ...(amiOverride !== undefined && amiOverride !== "" ? { ami: amiOverride } : {}),
      dryRun: dry,
      keep: hasFlag("--keep"),
      allowExtraBoxes: allowExtraBoxes(),
      onDemand,
      onLog: (m) => logger.info(m),
    })
  if (dry) {
    const res = await makeBackend(expected).run()
    printBlock(
      [
        "=== full-remote plan (dry-run) ===",
        describeAuthSource(authSource),
        ...(res.plan ?? []),
      ].join("\n"),
    )
    return
  }
  // Default-ON tracing: embed a durable sink + point this run at it so the agent
  // waterfall is auto-captured to a file (never silently lost). Opt out with
  // QUANTA_OTEL_ENDPOINT=off, or set your own endpoint to use an external sink.
  const trace = ensureBenchTraceSink(process.env, {
    runId: `fullremote-${argValue("--instance") ?? "all"}-${Date.now()}`,
    log: (m) => logger.info(m),
  })
  try {
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
  } finally {
    await trace?.stop()
  }
}

export const cmdGrade = async (): Promise<void> => {
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
    // FILTER to non-empty strings (and accept the double-encoded-JSON-string form
    // some swebench exports emit) — same robustness as analyze/verdicts.ts strArray.
    // The prior `as string[]` cast shipped numbers/nulls straight into `done` and
    // into the merged tally, polluting the resolved count when fed a malformed report.
    priorResolved = resolvedIdsFromReport(rep.resolved_ids)
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
  // RFC jun-29 — thread the dataset family so the ssh grade-only path picks the
  // right harness fork + image namespace (live ⇒ SWE-bench-Live + starryzhang).
  // Resolved from --dataset-family / QUANTA_SWEBENCH_DATASET_FAMILY (default verified).
  const family = resolveDatasetFamily(argValue("--dataset-family"), process.env)
  const out = await backend.grade(gradePredictions, {
    datasetPath: dataset,
    runId,
    family,
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
  // Surface the per-instance failure logs for ERROR ids — diagnosable locally
  // without a manual ssh to the (often-gone) box.
  if (out.errorLogDir !== undefined) {
    logger.info(`error logs (run_instance.log per id): ${out.errorLogDir}/`)
  }
}
