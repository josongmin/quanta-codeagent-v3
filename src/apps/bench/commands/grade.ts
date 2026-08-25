/**
 * `quanta-bench grade` (+ `--mode full` full-remote) — extracted from cli.ts
 * (ADR-0536 P0). Backend construction (ec2 | ssh | fanout) + grade-only and
 * full-remote dispatch. Moved verbatim; behaviour-identical.
 */

import { createHash } from "node:crypto"
import { readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gateOn, logger, runtimeConfig } from "@/shared"
import { describeAuthSource, resolveAuthLaunchFile } from "../auth-pool"
import { resolveBenchmarkRunConfig } from "../benchmark-suite"
import { ensureBenchTraceSink } from "../default-trace-sink"
import { resolveRemoteBenchExecutionPreset } from "../preset"
import type { GradeBackend } from "../remote/backend"
import type { FullRemoteConfig, FullRemoteResult } from "../remote/box-session"
import { createEc2Backend } from "../remote/ec2"
import { createFanoutBackend } from "../remote/fanout"
import { refreshRemoteAuthJson } from "../remote/fresh-auth"
import { createFullRemoteBackend, runWithRelaunch } from "../remote/full"
import { createSshBackend } from "../remote/ssh"
import { type BenchRunConfig, readDatasetFamilySelector } from "../run-config"
import { resolveFullRemoteExpectedInstanceIds } from "./grade-expected"
import {
  allowExtraBoxes,
  argValue,
  hasFlag,
  modelNameFromPredictions,
  parseMaxWorkers,
  printBlock,
  resolveCliAuthSource,
  resolvedIdsFromReport,
} from "./shared"

/** BFND-01 — resolve the SWE-suite run config at the grade composition root.
 *  `grade`/`remote` are SWE-only subcommands, so the suite resolver always
 *  yields the swe-bench branch; we return its nested typed T2 config. */
const resolveGradeRunConfig = (argvFamily: string | undefined): BenchRunConfig => {
  const cfg = resolveBenchmarkRunConfig({ subcommand: "grade", argvFamily, env: process.env })
  if (cfg.benchmarkSuite !== "swe-bench") {
    throw new Error("grade is the swe-bench composition root")
  }
  return cfg.swe
}

/** Filesystem-safe bounded run id. The instance selector can contain hundreds
 * of bytes (especially for a multi-instance smoke); forwarding it verbatim made
 * `mkdir observe/<runId>` fail with ENAMETOOLONG before the first model call. */
export const fullRemoteRunId = (instanceSelector: string | undefined, now = Date.now()): string => {
  const selector = instanceSelector?.trim() || "all"
  const count = selector === "all" ? 0 : selector.split(",").filter((id) => id.trim() !== "").length
  const first = selector
    .split(",", 1)[0]
    ?.replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36)
  const digest = createHash("sha256").update(selector).digest("hex").slice(0, 12)
  return `fullremote-${first || "all"}-${count}x-${digest}-${now}`
}

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
/**
 * The one line an operator actually reads, as a PURE string.
 *
 * It used to print `resolved` and `unresolved` only. For most families the
 * omitted `errored` bucket is small; for ProMax it is the entire golden-authority
 * class — a golden patch that failed to apply, an `ambiguous` grade where the
 * grader declined to decide, and an assigned instance the evaluator never
 * reported on. `resolved 12 | unresolved 40` on a 170-instance campaign then
 * reads as 12 of 52 when the truth may be 12 of 170: a denominator that omits its
 * own errors, printed where it is least likely to be questioned.
 *
 * Pure and exported so the claim is testable without driving a remote run.
 */
export const renderFullRemoteOutcomeLine = (out: {
  resolved: readonly string[]
  unresolved: readonly string[]
  errored?: readonly string[]
  missing: readonly string[]
  attempts: number
  /** the run BROKE on a deterministic refusal rather than spending its
   *  attempts, so the uncovered instances are not box loss. */
  stoppedEarly?: boolean
}): string => {
  const erroredCount = out.errored?.length ?? 0
  // Omitted entirely when zero, so a family with no errors reads exactly as before.
  const erroredNote = erroredCount > 0 ? ` | errored ${erroredCount}` : ""
  // The CAUSE is only claimed when it is known. A run stopped by a deterministic
  // refusal lands its uncovered instances here too, and calling that box-loss
  // contradicts the log line printed immediately before it.
  const lostCause = out.stoppedEarly === true ? "run stopped early" : "box-loss"
  const lostNote = out.missing.length > 0 ? ` | ⚠️ LOST ${out.missing.length} (${lostCause})` : ""
  const attemptNote = out.attempts > 1 ? ` [${out.attempts} attempts]` : ""
  return `full-remote done — resolved ${out.resolved.length} | unresolved ${out.unresolved.length}${erroredNote}${lostNote}${attemptNote}`
}

const logFullRemoteOutcome = (out: {
  resolved: string[]
  unresolved: string[]
  errored?: string[]
  missing: string[]
  attempts: number
  stoppedEarly?: boolean
}): void => {
  logger.info(renderFullRemoteOutcomeLine(out))
  for (const id of out.resolved) logger.info(`  ✅ ${id}`)
  const why =
    out.stoppedEarly === true
      ? `never graded — the run stopped after ${out.attempts} attempt(s)`
      : `never graded across ${out.attempts} attempts`
  for (const id of out.missing) logger.info(`  ❓ LOST (${why}): ${id}`)
}

/** ADR-0536 §6 — full-remote mode (remote patch-gen + grading). Runs the AGENT
 *  on a credential-bearing box; gated behind --allow-remote-secrets. The executor
 *  ships ONLY the stripped short-lived access_token over ssh STDIN (refresh/id
 *  dropped), enforces IMDSv2 hop-1 + TTL, and always terminates. --dry-run plans
 *  it safely without launching. Instance-aware relaunch recovers box loss. */
/**
 * The two refuse-and-exit argument gates `--mode full` opens with: the explicit
 * secrets acknowledgement, and a dataset to run. Extracted so the command body
 * stays under the cognitive-complexity ceiling; both messages and both exit
 * codes are unchanged.
 *
 * Returns the resolved dataset path — `process.exit` is `never`, so the caller
 * gets a plain `string` and no second undefined-check.
 */
const requireFullRemoteArgs = (): string => {
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
  return dataset
}

/**
 * INJECTED PORTS for the full-remote command root.
 *
 * Same shape `cmdBox` got, and for the same reason: proving what this command
 * hands its backend requires DRIVING the command, and the un-injected root
 * constructs the real full-remote backend. `cmdBox`'s first hellgate draft cost
 * ten live spot instances by reaching the real provisioner, so the port both
 * RECORDS and REPLACES it. The production call site passes nothing and is
 * byte-identical.
 */
export interface FullRemoteCommandPorts {
  readonly makeFullRemoteBackend?: (cfg: FullRemoteConfig) => {
    run: () => Promise<FullRemoteResult>
  }
}

export const cmdGradeFullRemote = async (ports: FullRemoteCommandPorts = {}): Promise<void> => {
  // T2 — re-resolve the ONE typed config (idempotent: cmdGrade already validated +
  // serialized the family into env). Threaded as the TYPED family into the preset
  // AND onto the full-remote backend config (`swebenchDatasetFamily`), so the box
  // launch reads the typed field instead of a fresh `resolveDatasetFamily(undefined, env)`.
  const runConfig = resolveGradeRunConfig(readDatasetFamilySelector(process.argv))
  const dataset = requireFullRemoteArgs()
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
  const preset = resolveRemoteBenchExecutionPreset({
    family: runConfig.datasetFamily,
    envVars: process.env,
    argvPreset: argValue("--preset"),
  })
  const fullModel = argValue("--model")
  // The expected instance set instance-aware relaunch reconciles against to detect
  // partial loss — and, for a family with a sample manifest, the AUTHORITY that
  // decides which instances this campaign runs at all.
  //
  // aug-22 residual #1: this used to be `--instance` else "every id in the
  // dataset", so a full-remote ProMax campaign could name PMX-7 in its
  // provenance while running an entirely different set. The one owner of that
  // decision is now `resolveFullRemoteExpectedInstanceIds`, which shares the
  // manifest/`--instance` two-authority refusal with the local path.
  const expected = [
    ...resolveFullRemoteExpectedInstanceIds({
      datasetPath: dataset,
      family: runConfig.datasetFamily,
      env: process.env,
      ...(instance !== undefined ? { instanceFilter: instance } : {}),
      surface: "full-remote",
    }),
  ]
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
  const makeFullRemoteBackend = ports.makeFullRemoteBackend ?? createFullRemoteBackend
  const makeBackend = (ids: readonly string[]) =>
    makeFullRemoteBackend({
      repoDir: process.cwd(),
      authJson,
      datasetPath: dataset,
      ...(ids.length > 0 ? { instanceIds: [...ids] } : {}),
      // T2 — thread the TYPED family onto the box config so the full-remote
      // preflight/launch reads it here instead of a fresh env read that dropped argv.
      // re-audit R3: set ONLY for an EXPLICIT selector. `undefined` on this field
      // means "the operator selected nothing" — the provenance the subprocess wire
      // encoder needs to reproduce HEAD's absent-selector shape (no family key at
      // all). Consumers that need a concrete family call `datasetFamilyOrDefault`.
      ...(runConfig.familySelector === "explicit"
        ? { swebenchDatasetFamily: runConfig.datasetFamily }
        : {}),
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
    runId: fullRemoteRunId(argValue("--instance")),
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
        // Carried here too: this is the branch with an UNKNOWN expected set, so
        // `missing` is structurally empty and `errored` is the only signal an
        // operator gets that instances were graded but not measured.
        errored: [...(res.errored ?? [])],
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

export { resolveFullRemoteExpectedInstanceIds } from "./grade-expected"

export const cmdGrade = async (ports: FullRemoteCommandPorts = {}): Promise<void> => {
  // T2 — resolve the ONE typed run config (fail-closed: an explicit-but-unknown
  // family errors instead of silently grading as Verified).
  //
  // HIGH-1 (aug-22): the resolved family is NOT written back into the ambient
  // `process.env`. Every in-process consumer below takes the TYPED
  // `runConfig.datasetFamily` (preset selection, the ssh grade-only harness/
  // namespace, the full-remote box config). The subprocess/SSH wire is encoded
  // into a per-call ENVELOPE at the boundary that owns it
  // (`remote/full.ts` → `buildSubprocessFamilyEnv`), never here.
  const runConfig = resolveGradeRunConfig(readDatasetFamilySelector(process.argv))
  if ((argValue("--mode") ?? "grade-only") === "full") return cmdGradeFullRemote(ports)

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
  // Reads the TYPED family off the ONE resolved config (no fresh env read).
  const family = runConfig.datasetFamily
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
