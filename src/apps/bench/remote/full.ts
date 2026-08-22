/**
 * Full-remote executor (ADR-0536 §6 / P3) — runs BOTH patch-gen and grading on
 * a fresh EC2 box, for fully-detached long runs.
 *
 * jun-20 box-lifecycle refactor: the EXPENSIVE bootstrap surface (launch +
 * cloud-init + rsync + bun install + phantom deps + swebench/uvx warm + pyright)
 * and the per-chunk grade execution now live in {@link ./box-session} so a
 * persistent pool ({@link ./pool}) can amortise ONE box over many chunks. This
 * file is the THIN single-run wrapper: provision a box, grade once, terminate —
 * plus the caller-level instance-aware relaunch ({@link runWithRelaunch}).
 *
 * ⚠️ SECURITY: full-remote needs an LLM credential ON the box (it runs the agent,
 * which executes model-generated code). The hardening lives in box-session.ts and
 * is unchanged: only the SHORT-LIVED access_token is shipped (refresh/id stripped),
 * over ssh STDIN, with IMDSv2 hop-1 + TTL self-terminate + ALWAYS-terminate. The
 * whole flow is unit-tested offline via an injected SpawnFn.
 */
import { basename } from "node:path"
import { resolveNoProgressBudgetMs } from "@/runner/batch/eval/no-progress-watchdog"
import { errMessage } from "@/shared"
import { familyPlanNotes } from "../profiles/plan"
import { type BenchRunConfig, buildSubprocessFamilyEnv, resolveBenchRunConfig } from "../run-config"
import { resolveBenchTrajectoryDefault } from "../trajectory"
import {
  assertDatasetGradeableForFamily,
  assertRemoteDatasetLaunchable,
  assertRemoteDatasetSelectionExists,
  assertRemoteStrictGroundingSupported,
  attachBox,
  type BoxSession,
  buildForwardedBenchEnv,
  countLiveBoxes,
  coveredInstances,
  D,
  type FullRemoteConfig,
  type FullRemoteResult,
  findIdleBox,
  gradeChunkOnBox,
  provisionBox,
} from "./box-session"
import { acquireSingleBoxGuard, type SingleBoxGuard } from "./single-box-guard"
import {
  acquirePatchGenBudgetLease,
  clampPatchGenConcurrency,
  resolveGlobalPatchGenBudget,
} from "./token-budget"
import { absorbFullRemoteResult } from "./verdict-buckets"

// Re-export the public surface so existing importers (tests + callers) keep
// resolving these from "./full" after the box-session.ts extraction.
export {
  assertDatasetGradeableForFamily,
  assertRemoteDatasetLaunchable,
  assertRemoteDatasetSelectionExists,
  assertRemoteStrictGroundingSupported,
  attachBox,
  buildForwardedBenchEnv,
  countLiveBoxes,
  coveredInstances,
  createLineStreamer,
  type FullRemoteConfig,
  type FullRemoteResult,
  findIdleBox,
  fullRemoteArtifactDir,
  gradeChunkOnBox,
  PHANTOM_DEPS,
  provisionBox,
  pyrightLaunchProofVerdict,
  stripToAccessToken,
} from "./box-session"

export interface RelaunchOutcome {
  readonly resolved: string[]
  readonly unresolved: string[]
  readonly errored: string[]
  readonly emptyPatch: string[]
  /** Local report paths, one per attempt that produced a report (newest last). */
  readonly reportPaths: string[]
  readonly attempts: number
  /** Expected instances that NEVER earned a verdict across all attempts — a
   *  genuine loss the operator must see (NOT silently counted as resolved=0). */
  readonly missing: string[]
}

interface RelaunchAccumulator {
  readonly resolved: Set<string>
  readonly unresolved: Set<string>
  readonly errored: Set<string>
  readonly emptyPatch: Set<string>
}

const createRelaunchAccumulator = (): RelaunchAccumulator => ({
  resolved: new Set<string>(),
  unresolved: new Set<string>(),
  errored: new Set<string>(),
  emptyPatch: new Set<string>(),
})

const runRelaunchAttempt = async (
  makeBackend: (instanceIds: readonly string[]) => { run: () => Promise<FullRemoteResult> },
  instanceIds: readonly string[],
  attempt: number,
  onLog: ((m: string) => void) | undefined,
): Promise<FullRemoteResult> => {
  try {
    return await makeBackend(instanceIds).run()
  } catch (err) {
    onLog?.(`[full-remote] attempt ${attempt} threw: ${errMessage(err)}`)
    return {}
  }
}

const accumulateRelaunchAttempt = (
  acc: RelaunchAccumulator,
  reportPaths: string[],
  result: FullRemoteResult,
): void => {
  if (result.reportPath !== undefined) reportPaths.push(result.reportPath)
  absorbFullRemoteResult(acc, result)
}

const remainingRelaunchInstances = (
  expected: readonly string[],
  acc: RelaunchAccumulator,
): readonly string[] => {
  const covered = coveredInstances({
    resolved: [...acc.resolved],
    unresolved: [...acc.unresolved],
    errored: [...acc.errored],
    emptyPatch: [...acc.emptyPatch],
  })
  return expected.filter((id) => !covered.has(id))
}

const relaunchOutcomeOf = (
  acc: RelaunchAccumulator,
  reportPaths: string[],
  attempts: number,
  missing: readonly string[],
): RelaunchOutcome => ({
  resolved: [...acc.resolved],
  unresolved: [...acc.unresolved],
  errored: [...acc.errored],
  emptyPatch: [...acc.emptyPatch],
  reportPaths,
  attempts,
  missing: [...missing],
})

const maybeLogRelaunchRetry = (args: {
  readonly onLog: ((m: string) => void) | undefined
  readonly remaining: readonly string[]
  readonly expectedCount: number
  readonly attempt: number
  readonly total: number
}): void => {
  if (!(args.remaining.length > 0 && args.attempt < args.total)) return
  args.onLog?.(
    `[full-remote] ⚠️ ${args.remaining.length}/${args.expectedCount} instance(s) lost (spot reclaim / ssh-255) — relaunching ONLY the missing on a fresh box (attempt ${args.attempt + 1}/${args.total})…`,
  )
}

const maybeLogRelaunchExhausted = (args: {
  readonly onLog: ((m: string) => void) | undefined
  readonly total: number
  readonly remaining: readonly string[]
}): void => {
  if (args.remaining.length === 0) return
  args.onLog?.(
    `[full-remote] exhausted ${args.total} attempt(s); ${args.remaining.length} instance(s) still lost: ${args.remaining.join(", ")}`,
  )
}

/**
 * Caller-level, INSTANCE-AWARE relaunch — the resilience the executor comment
 * promised ("Flaky/blip box loss is handled by CALLER-LEVEL retry") but the CLI
 * never implemented, so a spot reclaim / ssh-255 drop silently lost the WHOLE
 * run (observed: 53- and 4-instance shards wiped).
 *
 * Each attempt mints a FRESH box (a relaunch, not a re-poll of the dead box) and
 * runs ONLY the instances still missing a verdict — so a 49/50 partial loss
 * re-runs 1 instance, not 50, AND a mid-run death can never be silently
 * under-counted (the missing instance is retried, then surfaced in `missing` if
 * still lost). A thrown attempt (launch failure) re-runs the same remaining set.
 * Bounded by `maxRelaunch` so a genuinely-broken config can't loop forever.
 */
export const runWithRelaunch = async (
  makeBackend: (instanceIds: readonly string[]) => { run: () => Promise<FullRemoteResult> },
  opts: { expected: readonly string[]; maxRelaunch: number; onLog?: (m: string) => void },
): Promise<RelaunchOutcome> => {
  const acc = createRelaunchAccumulator()
  const reportPaths: string[] = []
  const total = Math.max(0, opts.maxRelaunch) + 1
  let remaining = [...opts.expected]
  let attempt = 0
  while (remaining.length > 0 && attempt < total) {
    attempt += 1
    const result = await runRelaunchAttempt(makeBackend, remaining, attempt, opts.onLog)
    accumulateRelaunchAttempt(acc, reportPaths, result)
    remaining = [...remainingRelaunchInstances(opts.expected, acc)]
    maybeLogRelaunchRetry({
      onLog: opts.onLog,
      remaining,
      expectedCount: opts.expected.length,
      attempt,
      total,
    })
  }
  maybeLogRelaunchExhausted({ onLog: opts.onLog, total, remaining })
  return relaunchOutcomeOf(acc, reportPaths, attempt, remaining)
}

/** Dry-run plan lines — printed instead of provisioning anything. */
const dryRunPlan = (cfg: FullRemoteConfig, runConfig: BenchRunConfig): readonly string[] => {
  const family = runConfig.datasetFamily
  const onDemand = cfg.onDemand ?? false
  const marketLabel = onDemand ? "on-demand" : "spot"
  const ttl = cfg.ttlMinutes ?? D.ttlMinutes
  const preset = cfg.preset ?? D.preset
  const concurrency = resolveConcurrency()
  return [
    // LOW-10: the RESOLVED family drives the box's harness fork, pip spec and
    // image namespace, so a plan that omits it cannot distinguish a correct
    // Verified launch from a silently mis-resolved Live/Pro one.
    `[dry-run] dataset-family=${family}`,
    // PMX-01: whatever THIS family wants an operator to see before spending a
    // box (ProMax ⇒ the frozen upstream pin + bundle root). Empty for every
    // family that declares no notes, so existing plans are byte-identical.
    ...familyPlanNotes(runConfig),
    `[dry-run] would launch ${cfg.instanceType ?? D.instanceType} ${marketLabel} (IMDSv2 hop-1, shutdown -h +${ttl})`,
    `[dry-run] would bootstrap bun+uv+pyright langserver, then rsync ${cfg.repoDir} (excl node_modules/.git) + bun install`,
    "[dry-run] would ship STRIPPED token over ssh stdin (access_token only; refresh/id dropped)",
    `[dry-run] would run: bun run bench run --swebench <dataset> --grade-backend local (preset=${preset}, requested patch-gen concurrency=${concurrency}, grading SERIAL [concurrent grading false-negatives — see box-session.ts])`,
    `[dry-run] would request up to ${concurrency} global patch-gen token(s) from the shared budget=${resolveGlobalPatchGenBudget()}`,
    "[dry-run] would scp report+observe back, then terminate the box",
  ]
}

/**
 * Patch-gen concurrency on the remote box (c7i.8xlarge = 32 vCPU). Default 16 —
 * the binding limit is the shared gpt-5.4 login rate, not box CPU, and the
 * default operational posture is ONE box unless the caller EXPLICITLY opts into
 * more. Override via QUANTA_FULL_REMOTE_CONCURRENCY OR the alias
 * QUANTA_BENCH_CONCURRENCY. Clamped [1,16].
 */
const resolveConcurrency = (): number => {
  // Extract the raw env string FIRST, then parse on a separate line with an
  // explicit finite/positive guard — a garbage value falls back to the global
  // budget rather than coercing to NaN inside clamp (no-raw-number-env contract).
  const raw = process.env.QUANTA_FULL_REMOTE_CONCURRENCY ?? process.env.QUANTA_BENCH_CONCURRENCY
  const parsed = raw !== undefined && raw !== "" ? Number(raw) : Number.NaN
  return clampPatchGenConcurrency(
    Number.isFinite(parsed) && parsed > 0 ? parsed : resolveGlobalPatchGenBudget(),
  )
}

const acquireFullRemoteLease = async (
  cfg: FullRemoteConfig,
  requestedUnits: number,
  onLog: (msg: string) => void,
): Promise<Awaited<ReturnType<typeof acquirePatchGenBudgetLease>>> =>
  acquirePatchGenBudgetLease({
    label: `full:${basename(cfg.datasetPath)}`,
    requestedUnits,
    ...(cfg.tokenBudgetDir !== undefined ? { dir: cfg.tokenBudgetDir } : {}),
    ...(cfg.tokenBudgetWaitMs !== undefined ? { waitMs: cfg.tokenBudgetWaitMs } : {}),
    ...(cfg.tokenBudgetPollMs !== undefined ? { pollMs: cfg.tokenBudgetPollMs } : {}),
    onLog,
  })

const logGrantedFullRemoteLease = (
  lease: Awaited<ReturnType<typeof acquirePatchGenBudgetLease>>,
  effectiveConcurrency: number,
  onLog: (msg: string) => void,
): void => {
  onLog(
    `[full-remote] global patch-gen budget granted ${lease.units}/${lease.requestedUnits} token(s); box concurrency=${effectiveConcurrency} (in-use now <= ${lease.limit})`,
  )
}

type FullRemoteLease = Awaited<ReturnType<typeof acquirePatchGenBudgetLease>>

interface FullRemoteRunAttempt {
  readonly lease: FullRemoteLease | undefined
  readonly result: FullRemoteResult | undefined
  readonly primaryErr: unknown
}

const runFullRemoteAttempt = async (args: {
  readonly cfg: FullRemoteConfig
  readonly preset: string
  readonly model: string
  readonly concurrency: number
  readonly runConfig: BenchRunConfig
  readonly log: (msg: string) => void
}): Promise<FullRemoteRunAttempt> => {
  let lease: FullRemoteLease | undefined
  try {
    lease = await acquireFullRemoteLease(args.cfg, args.concurrency, args.log)
    const effectiveConcurrency = clampPatchGenConcurrency(lease.units)
    logGrantedFullRemoteLease(lease, effectiveConcurrency, args.log)
    const session = await attachOrProvisionFullRemoteBox(args.cfg)
    return {
      lease,
      result: await runSingleFullRemoteChunk({
        session,
        cfg: args.cfg,
        preset: args.preset,
        model: args.model,
        concurrency: effectiveConcurrency,
        runConfig: args.runConfig,
        onLog: args.log,
      }),
      primaryErr: undefined,
    }
  } catch (err) {
    return { lease, result: undefined, primaryErr: err }
  }
}

const mergeFullRemoteCleanupError = (earlier: unknown, later: unknown): Error =>
  new Error(
    `[full-remote] cleanup failed in multiple phases: earlier=${errMessage(earlier)}; later=${errMessage(later)}`,
  )

const releaseFullRemoteResources = async (args: {
  readonly lease: FullRemoteLease | undefined
  readonly guard: SingleBoxGuard | undefined
  readonly log: (msg: string) => void
}): Promise<unknown> => {
  let cleanupErr: unknown
  if (args.lease !== undefined) {
    try {
      await args.lease.release()
      args.log(
        `[full-remote] released global patch-gen budget lease (${args.lease.units} token(s))`,
      )
    } catch (err) {
      cleanupErr = err
    }
  }
  try {
    await args.guard?.release()
  } catch (err) {
    cleanupErr = cleanupErr === undefined ? err : mergeFullRemoteCleanupError(cleanupErr, err)
  }
  return cleanupErr
}

const finalizeFullRemoteRun = (args: {
  readonly result: FullRemoteResult | undefined
  readonly primaryErr: unknown
  readonly cleanupErr: unknown
}): FullRemoteResult => {
  if (args.primaryErr !== undefined) {
    if (args.cleanupErr !== undefined) {
      throw new Error(
        `[full-remote] run failed and cleanup failed: primary=${errMessage(args.primaryErr)}; ` +
          `cleanup=${errMessage(args.cleanupErr)}`,
      )
    }
    throw args.primaryErr
  }
  if (args.cleanupErr !== undefined) throw args.cleanupErr
  if (args.result === undefined) {
    throw new Error("[full-remote] internal error: run completed without result or error")
  }
  return args.result
}

const attachOrProvisionFullRemoteBox = async (cfg: FullRemoteConfig): Promise<BoxSession> => {
  const idle = await findIdleBox(cfg).catch(() => undefined)
  if (idle !== undefined) return attachBox(cfg, idle)
  const live = await countLiveBoxes(cfg)
  if (live > 0 && cfg.allowExtraBoxes !== true) {
    throw new Error(
      `[full-remote] refusing to launch another box while ${live} quanta-bench box(es) are already live (running/pending). ` +
        "Wait for the existing box to go idle, or re-run with explicit extra-box opt-in.",
    )
  }
  return provisionBox({
    ...cfg,
    launchMode: cfg.launchMode ?? "full-remote",
    // Resolve the OTEL endpoint HERE (allowlisted root) so provisionBox emits live
    // bootstrap spans without reading env. "" when unset ⇒ no spans (byte-identical).
    otelEndpoint: cfg.otelEndpoint ?? process.env.QUANTA_OTEL_ENDPOINT ?? "",
  })
}

const acquireFullRemoteSingleBoxGuard = async (
  cfg: FullRemoteConfig,
): Promise<SingleBoxGuard | undefined> => {
  if (cfg.allowExtraBoxes === true) return undefined
  return acquireSingleBoxGuard({
    label: `full:${basename(cfg.datasetPath)}`,
    ...(cfg.singleBoxGuardDir !== undefined ? { dir: cfg.singleBoxGuardDir } : {}),
    ...(cfg.sleep !== undefined ? { sleep: cfg.sleep } : {}),
    ...(cfg.onLog !== undefined ? { onLog: cfg.onLog } : {}),
  })
}

// DEFAULT-ON (industry-SOTA opt-OUT): full-remote records + fetches the box's
// LLM-trajectory cassette unless the operator sets QUANTA_BENCH_RECORD_TRAJECTORY
// to a falsy token (0/off/false/no). Same resolver as the local bench default so
// the box env, stale-scrub, and fetch-back all agree on whether to record.
const fullRemoteRecordTrajectoryEnabled = (): boolean =>
  resolveBenchTrajectoryDefault(process.env).path !== undefined

const runSingleFullRemoteChunk = async (args: {
  readonly session: BoxSession
  readonly cfg: FullRemoteConfig
  readonly preset: string
  readonly model: string
  readonly concurrency: number
  /** TYPED run config resolved ONCE in `createFullRemoteBackend.run()` (aug-22
   *  HIGH-1). The launching side no longer re-reads ambient env for it. It is
   *  the whole config, not a bare family, because the subprocess WIRE shape
   *  depends on whether the operator NAMED the family (re-audit R3). */
  readonly runConfig: BenchRunConfig
  readonly onLog: (msg: string) => void
}): Promise<FullRemoteResult> => {
  const terminateWithContext = async (primaryErr?: unknown): Promise<void> => {
    try {
      await args.session.terminate()
    } catch (cleanupErr) {
      if (primaryErr !== undefined) {
        throw new Error(
          `[full-remote] remote chunk failed and box termination failed for ${args.session.iid}: ` +
            `primary=${errMessage(primaryErr)}; cleanup=${errMessage(cleanupErr)}`,
        )
      }
      throw cleanupErr
    }
  }
  try {
    const result = await gradeChunkOnBox(args.session, {
      datasetPath: args.cfg.datasetPath,
      authJson: args.cfg.authJson,
      ...(args.cfg.instanceIds !== undefined ? { instanceIds: args.cfg.instanceIds } : {}),
      preset: args.preset,
      model: args.model,
      concurrency: args.concurrency,
      artifactSuffix: args.session.iid,
      recordTrajectory: fullRemoteRecordTrajectoryEnabled(),
      // HIGH-1 (aug-22): the TYPED family threaded off the box config drives BOTH
      // the on-box env prefix / image namespace (params.datasetFamily below) AND
      // the SUBPROCESS WIRE. The wire is a per-call ENVELOPE — a copy of the
      // parent env with the resolved family encoded onto it — so nothing in the
      // LAUNCHING process can read the family back out of ambient `process.env`
      // as an authority. Previously the composition root mutated `process.env`
      // and this line picked the value back up from there.
      //
      // re-audit R3: the ENVELOPE takes the whole run config, so an ABSENT
      // selector emits no family key at all (HEAD's wire shape) instead of
      // stamping a fabricated `='verified'` onto every default box command.
      forwardedBenchEnv: buildForwardedBenchEnv(
        buildSubprocessFamilyEnv(args.runConfig, process.env),
      ),
      datasetFamily: args.runConfig.datasetFamily,
      // No-progress (wedged-box) idle-abort budget, resolved HERE at the
      // allowlisted full-remote composition root (env reads belong at the root;
      // box-session stays env-free). Unset ⇒ Infinity ⇒ off (byte-identical).
      noProgressBudgetMs: resolveNoProgressBudgetMs(process.env),
      // OTEL live-tunnel endpoint, likewise resolved at the root and threaded so
      // box-session opens the reverse tunnel without reading env (no-process-env).
      // "" when unset ⇒ no tunnel (the regex match fails) — byte-identical.
      otelEndpoint: process.env.QUANTA_OTEL_ENDPOINT ?? "",
    })
    args.onLog("[full-remote] terminating box…")
    await terminateWithContext()
    return result
  } catch (err) {
    await terminateWithContext(err)
    throw err
  }
}

/**
 * Single-run full-remote backend: provision a fresh box, run ONE patch-gen +
 * grading chunk, terminate. The bootstrap + grade execution are owned by
 * {@link ./box-session}; this wrapper just wires the lifecycle (and the dry-run
 * plan). For multi-chunk amortisation use {@link ./pool}.
 */
export const createFullRemoteBackend = (
  cfg: FullRemoteConfig,
): { run: () => Promise<FullRemoteResult> } => {
  const preset = cfg.preset ?? D.preset
  const model = cfg.model ?? D.model
  const log = cfg.onLog ?? (() => {})
  const concurrency = resolveConcurrency()
  // Make the EFFECTIVE box concurrency observable up-front (the jun-20 confound
  // was invisible because only the box-side echoed it). With N boxes this is the
  // per-box loop count whose product hits the shared login rate.
  log(
    `[full-remote] requested patch-gen concurrency=${concurrency} per box (override: QUANTA_FULL_REMOTE_CONCURRENCY | QUANTA_BENCH_CONCURRENCY)`,
  )

  const run = async (): Promise<FullRemoteResult> => {
    // T2/HIGH-1 — resolve the TYPED family ONCE for this launch, off the box
    // config's typed field. `process.env` is the INGRESS fallback only for
    // callers that never resolved a config (the CLI always sets the typed
    // field); it is never written here, and every downstream decision on this
    // launch (preflight, on-box env prefix, image namespace, pip-spec, the
    // subprocess wire) takes THIS value rather than re-reading ambient env.
    //
    // LOW-10: resolved ABOVE the dry-run early return, so `--dry-run` reports
    // the SAME family the real launch would use (and fails closed on the same
    // invalid selectors) instead of planning without ever consulting it.
    const runConfig = resolveBenchRunConfig({
      argvFamily: cfg.swebenchDatasetFamily,
      env: process.env,
    })
    const family = runConfig.datasetFamily
    if (cfg.dryRun) return { dryRun: true, plan: dryRunPlan(cfg, runConfig) }
    assertRemoteDatasetLaunchable({
      datasetPath: cfg.datasetPath,
      surface: "full-remote",
      family,
    })
    assertDatasetGradeableForFamily({
      datasetPath: cfg.datasetPath,
      ...(cfg.instanceIds !== undefined ? { instanceIds: cfg.instanceIds } : {}),
      surface: "full-remote",
      family,
    })
    assertRemoteDatasetSelectionExists({
      datasetPath: cfg.datasetPath,
      ...(cfg.instanceIds !== undefined ? { instanceIds: cfg.instanceIds } : {}),
      surface: "full-remote",
      family,
    })
    assertRemoteStrictGroundingSupported({
      preset,
      datasetPath: cfg.datasetPath,
      ...(cfg.instanceIds !== undefined ? { instanceIds: cfg.instanceIds } : {}),
      surface: "full-remote",
      family,
    })
    const guard = await acquireFullRemoteSingleBoxGuard(cfg)
    const attempt = await runFullRemoteAttempt({
      cfg,
      preset,
      model,
      concurrency,
      runConfig,
      log,
    })
    const cleanupErr = await releaseFullRemoteResources({
      lease: attempt.lease,
      guard,
      log,
    })
    return finalizeFullRemoteRun({
      result: attempt.result,
      primaryErr: attempt.primaryErr,
      cleanupErr,
    })
  }

  return { run }
}
