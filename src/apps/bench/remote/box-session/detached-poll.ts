/**
 * DETACHED run + poll loop (ssh-resilience, RCA jun-20). Extracted from
 * `box-session.ts`. Launches the bench under `setsid` so an ssh teardown's
 * SIGHUP never reaches it, then polls with SHORT reconnecting ssh calls instead
 * of holding one fragile 60-90min foreground stream. Bounds consecutive poll
 * failures (spot-reclaim death) + a wall-clock ceiling so a dead box is requeued
 * by the pool rather than spinning forever. All IO routes through the injected
 * `ssh` / `aws`.
 */

import { makeNoProgressWatchdog } from "@/runner/batch/eval/no-progress-watchdog"
import type { SpawnResult } from "../backend"
import { defaultSleep, shq } from "./shell"
import { BOX_DIED_DURING_RUN_ERROR } from "./types"

/** Poll cadence for the detached run. The box does the work; we just re-check. */
const RUN_POLL_INTERVAL_MS = 15_000
/** Consecutive failed polls (ssh exit !== 0) before a LIVENESS confirmation runs.
 *  jun-25: 20→6. The confirmation is an `aws describe-instances` (source of
 *  truth) that only ABORTS on a genuinely-gone box and RESETS on a live one, so
 *  this threshold just decides how SOON we ask AWS — a lower value cannot
 *  false-abort a healthy box. At 20 a partitioned box (each hung poll now ~2min
 *  after the ServerAliveCountMax fix) took ~45min to even ask AWS; 6 fires the
 *  liveness probe in ~3min (connect-refused fast-fail) to ~12min (partition),
 *  so a dead box is requeued in minutes, not the prior ~30min+ hang. */
const RUN_MAX_CONSEC_POLL_FAILURES = 6
/** Absolute wall-clock ceiling on the detached run+poll loop — a backstop in case
 *  the liveness probe ITSELF keeps reporting "running" (e.g. an AWS describe lies
 *  / the box is half-zombied) yet `run.exit` never lands. The EC2 TTL backstop
 *  (`shutdown -h +<ttlMinutes>`, ≤ 360min) self-terminates the box, so a ceiling
 *  comfortably above the longest legitimate chunk (a few hours) guarantees the
 *  poll can never outlive the box it is polling. */
const RUN_WALL_CEILING_MS = 6 * 60 * 60 * 1000
/** Box-running states from `describe-instances …State.Name`. Anything else
 *  (`shutting-down`, `terminated`, `stopping`, `stopped`) — or an empty/None
 *  result (the instance vanished from the API) — means the box is GONE. */
const LIVE_INSTANCE_STATES: ReadonlySet<string> = new Set(["running", "pending"])
/** Sentinel splitting the exit-code field from the fresh run.log tail in one poll. */
const RUN_EXIT_MARK = "==XQ-RUN-EXIT-XQ=="

const oneLine = (s: string): string => s.trim().split(/\s+/)[0] ?? ""

interface CompletionArtifacts {
  readonly reportJson: string
  readonly predictionsJsonl: string
}

/**
 * The box this poll loop was watching DIED mid-run (spot reclaim / unreachable),
 * so `run.exit` will never land. Thrown to break the otherwise-forever poll so
 * the pool's existing dead-box requeue path ({@link ../pool} handleDeadBoxChunkError)
 * fires on a fresh box instead of the worker spinning at the 15s cadence forever.
 */
export class BoxDiedDuringRunError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "BoxDiedDuringRunError"
  }
}

/** Liveness confirmation: is the instance still in a running/pending state? An
 *  AWS describe FAILURE is treated as INCONCLUSIVE (returns true) — a transient
 *  control-plane error must NOT be mistaken for a dead box and abort a healthy
 *  run; only a CONCLUSIVE non-live / vanished state returns false. */
const isInstanceStillLive = async (
  awsFn: (args: readonly string[]) => Promise<SpawnResult>,
  iid: string,
): Promise<boolean> => {
  const desc = await awsFn([
    "ec2",
    "describe-instances",
    "--instance-ids",
    iid,
    "--query",
    "Reservations[0].Instances[0].State.Name",
    "--output",
    "text",
  ])
  // A describe error (network/creds/throttle) is INCONCLUSIVE — keep polling.
  if (desc.code !== 0) return true
  const state = oneLine(desc.stdout)
  // Empty / "None" = the instance is gone from the API ⇒ dead. A throttle that
  // exits 0 with empty stdout is rare; the wall-clock ceiling is the backstop.
  if (state === "" || state === "None") return false
  return LIVE_INSTANCE_STATES.has(state)
}

const detachedLaunchCommand = (benchCmd: string, runLog: string, runExit: string): string =>
  `rm -f ${runExit}; setsid bash -c ${shq(`${benchCmd} > ${runLog} 2>&1; echo $? > ${runExit}`)} </dev/null >/dev/null 2>&1 & echo LAUNCHED`

const parseableJsonProbe = (path: string): string =>
  `[ -s ${path} ] && python3 -c ${shq("import json,sys; json.load(open(sys.argv[1]))")} ${path} >/dev/null 2>&1`

const completeArtifactProbe = (runExit: string, artifacts: CompletionArtifacts): string => {
  const reportComplete = parseableJsonProbe(artifacts.reportJson)
  const predictionsComplete = `[ -s ${artifacts.predictionsJsonl} ]`
  return `if [ -s ${runExit} ]; then cat ${runExit}; elif ${reportComplete} && ${predictionsComplete}; then echo 0; fi`
}

const detachedProbeCommand = (
  runExit: string,
  runLog: string,
  seen: number,
  completionArtifacts?: CompletionArtifacts,
): string => {
  const exitProbe =
    completionArtifacts === undefined
      ? `cat ${runExit} 2>/dev/null`
      : completeArtifactProbe(runExit, completionArtifacts)
  return `${exitProbe}; echo "${RUN_EXIT_MARK}"; tail -n +${seen + 1} ${runLog} 2>/dev/null`
}

const parseDetachedProbe = (stdout: string): { exitCode?: number; freshLines: string[] } => {
  const mark = stdout.indexOf(RUN_EXIT_MARK)
  const exitField = (mark >= 0 ? stdout.slice(0, mark) : "").trim()
  const fresh = mark >= 0 ? stdout.slice(mark + RUN_EXIT_MARK.length) : ""
  return {
    ...(/^\d+$/.test(exitField) ? { exitCode: Number(exitField) } : {}),
    freshLines: fresh.split("\n").slice(0, -1),
  }
}

/**
 * Drain the fresh log lines from a SUCCESSFUL probe and surface the run's exit
 * code when the sentinel has landed. Mutates the caller's line-cursor (`seen`)
 * via the returned count so the next probe asks only for unseen lines. Pure of
 * IO beyond the supplied `onLine` sink.
 */
const applyDetachedProbeSuccess = (
  stdout: string,
  seen: number,
  onLine: (chunk: string) => void,
): { seen: number; exitCode?: number; progressed: boolean } => {
  const parsed = parseDetachedProbe(stdout)
  let next = seen
  // `progressed` = did the run.log gain a NON-BLANK line this poll. The parse
  // emits a spurious leading "" every poll (the `echo MARK` newline lands in the
  // fresh slice), so a bare `seen` delta is ALWAYS positive — it cannot tell a
  // wedged box from a working one. Only non-blank growth is real forward progress.
  let progressed = false
  for (const line of parsed.freshLines) {
    onLine(`${line}\n`)
    next += 1
    if (line.trim() !== "") progressed = true
  }
  if (parsed.exitCode === undefined) return { seen: next, progressed }
  return { seen: next, exitCode: parsed.exitCode, progressed }
}

/**
 * Box-death bound for an UNBROKEN run of failed polls (BUG 1 fix). Once the
 * consecutive-failure threshold trips, CONFIRM box liveness: a dead box THROWS
 * a {@link BoxDiedDuringRunError} so the pool requeues the chunk; a still-live
 * but unreachable box resets the counter (returns 0) so the next window earns
 * its own confirmation rather than hammering AWS every tick.
 */
const confirmBoxLivenessOnPollFailures = async (
  aws: (awsArgs: readonly string[]) => Promise<SpawnResult>,
  iid: string,
  consecFailures: number,
  log: (msg: string) => void,
): Promise<number> => {
  if (consecFailures < RUN_MAX_CONSEC_POLL_FAILURES) return consecFailures
  log(`[full-remote] ${consecFailures} consecutive failed polls — confirming box ${iid} liveness…`)
  if (!(await isInstanceStillLive(aws, iid))) {
    throw new BoxDiedDuringRunError(
      `${BOX_DIED_DURING_RUN_ERROR}: box ${iid} is no longer running (spot reclaim / unreachable) after ${consecFailures} consecutive failed polls — run.exit will never land`,
    )
  }
  // Still live but persistently unreachable over ssh — reset the counter so the
  // next window gets its own confirmation rather than re-probing AWS every tick,
  // and lean on the wall-clock ceiling backstop.
  return 0
}

/**
 * Detached run + poll — ssh-resilience (RCA jun-20). Launches `benchCmd` under
 * `setsid` so it is its OWN session leader: an ssh teardown's SIGHUP never
 * reaches it, and the bench runs to completion regardless of any local-side
 * disconnect. Output goes to `runLog`, the exit code to a `runExit` sentinel.
 * Then we POLL with SHORT reconnecting ssh calls — a dropped/255 poll is
 * NON-FATAL (the next tick reconnects); no single long-lived ssh is ever held,
 * which is what was orphaning boxes (a 60-90min foreground stream dies on any
 * idle NAT-drop or active reset). Returns the bench's real exit code.
 */
export const runBenchDetachedPoll = async (args: {
  ssh: (cmd: string, input?: string, onData?: (chunk: string) => void) => Promise<SpawnResult>
  aws: (awsArgs: readonly string[]) => Promise<SpawnResult>
  iid: string
  benchCmd: string
  runLog: string
  runExit: string
  onLine: (chunk: string) => void
  log?: (msg: string) => void
  sleep?: (ms: number) => Promise<void>
  pollIntervalMs?: number
  now?: () => number
  /** Idle budget (ms): if the box's run.log produces NO new lines for this long
   *  while polls still SUCCEED (the box is alive but wedged — the jun-27 77min
   *  throttle hang), abort the instance so the run isn't stuck. Default Infinity
   *  ⇒ off (byte-identical). Resolve via resolveNoProgressBudgetMs(env). */
  noProgressBudgetMs?: number
  completionArtifacts?: CompletionArtifacts
}): Promise<{ code: number }> => {
  const sleep = args.sleep ?? defaultSleep
  const now = args.now ?? (() => Date.now())
  const log = args.log ?? (() => {})
  // No-progress watchdog: progress() fires ONLY when run.log grows; a wedged box
  // (polls succeed, log frozen) trips stalled() and aborts to the requeue path —
  // distinct from box-DEATH (consecutive poll FAILURES, handled below).
  const watchdog = makeNoProgressWatchdog({
    budgetMs: args.noProgressBudgetMs ?? Number.POSITIVE_INFINITY,
    now,
  })
  const launch = await args.ssh(detachedLaunchCommand(args.benchCmd, args.runLog, args.runExit))
  if (launch.code !== 0) {
    throw new Error(
      `[full-remote] detached bench launch failed (code ${launch.code}): ${launch.stderr}`,
    )
  }
  const startedAt = now()
  let seen = 0
  // BUG 1 fix: a spot reclaim mid-grade never writes `run.exit`, and every ssh
  // poll to the dead box returns 255 — the old `for(;;)` ignored that and spun
  // forever. Bound CONSECUTIVE poll failures: after the threshold, CONFIRM box
  // liveness (aws describe-instances) and THROW a BoxDiedDuringRunError if it is
  // gone, so the pool requeues the chunk on a fresh box. A wall-clock ceiling is
  // the backstop if the liveness probe itself can't conclude.
  let consecFailures = 0
  for (;;) {
    // ONE short ssh per tick: exit sentinel (empty until done) + NEW run.log lines.
    const probe = await args.ssh(
      detachedProbeCommand(args.runExit, args.runLog, seen, args.completionArtifacts),
    )
    if (probe.code === 0) {
      consecFailures = 0 // a successful poll resets the box-death suspicion.
      const applied = applyDetachedProbeSuccess(probe.stdout, seen, args.onLine)
      if (applied.progressed) watchdog.progress() // real (non-blank) run.log growth = progress
      seen = applied.seen
      if (applied.exitCode !== undefined) return { code: applied.exitCode }
    } else {
      // A failed/dropped poll is non-fatal IN ISOLATION (NAT-drop ⇒ next tick
      // reconnects), but an UNBROKEN run of them is the box-death signature.
      consecFailures += 1
      consecFailures = await confirmBoxLivenessOnPollFailures(
        args.aws,
        args.iid,
        consecFailures,
        log,
      )
    }
    if (now() - startedAt >= RUN_WALL_CEILING_MS) {
      throw new BoxDiedDuringRunError(
        `${BOX_DIED_DURING_RUN_ERROR}: detached run on box ${args.iid} exceeded the ${Math.round(
          RUN_WALL_CEILING_MS / 60000,
        )}min wall-clock ceiling without an exit sentinel — abandoning to the pool's requeue path`,
      )
    }
    // Wedged-but-alive (polls succeed, run.log frozen past the idle budget) — the
    // 77min throttle hang. Abort to the SAME requeue path as box-death so the run
    // moves on instead of polling a stuck box forever (off unless budget is finite).
    if (watchdog.stalled()) {
      throw new BoxDiedDuringRunError(`${BOX_DIED_DURING_RUN_ERROR}: ${watchdog.reason(args.iid)}`)
    }
    await sleep(args.pollIntervalMs ?? RUN_POLL_INTERVAL_MS)
  }
}
