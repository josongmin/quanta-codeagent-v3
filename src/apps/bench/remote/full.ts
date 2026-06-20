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
import { errMessage } from "@/shared"
import {
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
import {
  acquirePatchGenBudgetLease,
  clampPatchGenConcurrency,
  resolveGlobalPatchGenBudget,
} from "./token-budget"

// Re-export the public surface so existing importers (tests + callers) keep
// resolving these from "./full" after the box-session.ts extraction.
export {
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
  for (const id of result.resolved ?? []) acc.resolved.add(id)
  for (const id of result.unresolved ?? []) acc.unresolved.add(id)
  for (const id of result.errored ?? []) acc.errored.add(id)
  for (const id of result.emptyPatch ?? []) acc.emptyPatch.add(id)
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
const dryRunPlan = (cfg: FullRemoteConfig): readonly string[] => {
  const onDemand = cfg.onDemand ?? false
  const marketLabel = onDemand ? "on-demand" : "spot"
  const ttl = cfg.ttlMinutes ?? D.ttlMinutes
  const preset = cfg.preset ?? D.preset
  const concurrency = resolveConcurrency()
  return [
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
const resolveConcurrency = (): number =>
  clampPatchGenConcurrency(
    Number(process.env.QUANTA_FULL_REMOTE_CONCURRENCY ?? process.env.QUANTA_BENCH_CONCURRENCY) ||
      resolveGlobalPatchGenBudget(),
  )

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
  return provisionBox({ ...cfg, launchMode: cfg.launchMode ?? "full-remote" })
}

const fullRemoteRecordTrajectoryEnabled = (): boolean =>
  process.env.QUANTA_BENCH_RECORD_TRAJECTORY !== undefined &&
  process.env.QUANTA_BENCH_RECORD_TRAJECTORY !== "" &&
  process.env.QUANTA_BENCH_RECORD_TRAJECTORY !== "0"

const runSingleFullRemoteChunk = async (args: {
  readonly session: BoxSession
  readonly cfg: FullRemoteConfig
  readonly preset: string
  readonly model: string
  readonly concurrency: number
  readonly onLog: (msg: string) => void
}): Promise<FullRemoteResult> => {
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
      forwardedBenchEnv: buildForwardedBenchEnv(process.env),
    })
    args.onLog("[full-remote] terminating box…")
    await args.session.terminate()
    return result
  } catch (err) {
    await args.session.terminate()
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
    if (cfg.dryRun) return { dryRun: true, plan: dryRunPlan(cfg) }
    const session = await attachOrProvisionFullRemoteBox(cfg)
    let lease: Awaited<ReturnType<typeof acquirePatchGenBudgetLease>> | undefined
    try {
      lease = await acquireFullRemoteLease(cfg, concurrency, log)
      const effectiveConcurrency = clampPatchGenConcurrency(lease.units)
      logGrantedFullRemoteLease(lease, effectiveConcurrency, log)
      return await runSingleFullRemoteChunk({
        session,
        cfg,
        preset,
        model,
        concurrency: effectiveConcurrency,
        onLog: log,
      })
    } catch (err) {
      if (lease === undefined) {
        await session.terminate().catch(() => undefined)
      }
      throw err
    } finally {
      if (lease !== undefined) {
        await lease.release().catch(() => undefined)
        log(`[full-remote] released global patch-gen budget lease (${lease.units} token(s))`)
      }
    }
  }

  return { run }
}
