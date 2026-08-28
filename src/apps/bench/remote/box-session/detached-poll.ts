/**
 * DETACHED run + poll loop (ssh-resilience, RCA jun-20). Extracted from
 * `box-session.ts`. Launches the bench under `setsid` so an ssh teardown's
 * SIGHUP never reaches it, then polls with SHORT reconnecting ssh calls instead
 * of holding one fragile 60-90min foreground stream. Bounds consecutive poll
 * failures (spot-reclaim death) + a wall-clock ceiling so a dead box is requeued
 * by the pool rather than spinning forever. All IO routes through the injected
 * `ssh` / `aws`.
 */

import {
  makeNoProgressWatchdog,
  type NoProgressWatchdog,
} from "@/runner/batch/eval/no-progress-watchdog"
import type { SpawnResult } from "../backend"
import { defaultSleep, shq } from "./shell"
import { BOX_DIED_DURING_RUN_ERROR, runSidPathFor } from "./types"

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

/** How long the launcher waits for the new session to record its own id before
 *  calling the launch a failure. The write is one `ps` and one redirect, so this
 *  is generous; it exists because the record happens INSIDE the detached child
 *  and is therefore concurrent with the launcher's own return. */
const SID_RECORD_POLLS = 50
const SID_RECORD_POLL_SECONDS = "0.1"

/**
 * Launch the bench DETACHED, and record the session it now owns.
 *
 * `setsid` makes the bench its own session leader — that is what keeps an ssh
 * teardown's SIGHUP away from it, and it is also what makes the run REAPABLE
 * later: everything the run spawns inherits that session unless it deliberately
 * leaves. The grade's gold boundary needs to ask "is ANYTHING from this run
 * still on the box", and it cannot ask without knowing which session to name.
 *
 * The id is read from INSIDE the new session (`ps -o sid= -p $$`, where `$$` is
 * the session leader itself) rather than from `ps -o sid= -p $!` in the
 * launching shell. `$!` is the `setsid` process, which — depending on whether
 * the launching shell put the job in its own process group — either IS the
 * leader or has already forked and exited; and reading its sid can race the
 * `setsid()` call itself, in which case the value recorded is the SSH SESSION's
 * id. Naming the wrong session is worse than naming none, so the value is taken
 * where it is unambiguous.
 *
 * The launcher then WAITS for the file and fails the launch if it never lands:
 * a run whose session was never recorded can never be proven reaped, and the
 * grade refuses such a box outright. Failing here instead surfaces it at launch,
 * before an hour of paid patch-gen.
 */
const detachedLaunchCommand = (benchCmd: string, runLog: string, runExit: string): string => {
  const runSid = runSidPathFor(runExit)
  const inner = `ps -o sid= -p $$ | tr -d ' ' > ${runSid}; ${benchCmd} > ${runLog} 2>&1; echo $? > ${runExit}`
  return (
    `rm -f ${runExit} ${runSid}; setsid bash -c ${shq(inner)} </dev/null >/dev/null 2>&1 & ` +
    `n=0; while [ $n -lt ${SID_RECORD_POLLS} ] && [ ! -s ${runSid} ]; do ` +
    `n=$((n+1)); sleep ${SID_RECORD_POLL_SECONDS}; done; ` +
    `[ -s ${runSid} ] || { echo "no session id recorded at ${runSid}" >&2; exit 3; }; echo LAUNCHED`
  )
}

/**
 * What proving the detached run's session EMPTY needs.
 *
 * `subject` and `refusal` are the CALLER's words: this module can prove a
 * session empty, but it does not know why anyone wants that, and a generic
 * module that hardcodes one caller's consequence ("the answer key") is a
 * sentence that goes stale the moment a second caller appears. `settleMs` is
 * likewise the caller's own kill-ladder settle window rather than a second
 * constant here — a signalled process gets one grace period on this box, not two
 * competing ones.
 */
export interface DetachedRunSessionInput {
  readonly ssh: (cmd: string) => Promise<SpawnResult>
  readonly log: (m: string) => void
  /** what the caller calls this run in its own diagnostics. */
  readonly subject: string
  /** the consequence sentence every refusal ends with. */
  readonly refusal: string
  /** the run's exit sentinel — the sid file sits beside it. */
  readonly runExit: string
  readonly settleMs: number
  readonly sleep: (ms: number) => Promise<void>
}

/**
 * The session id the launch recorded, or a REFUSAL.
 *
 * A missing / unreadable / non-numeric `run.sid` refuses rather than proceeding:
 * a run whose session was never recorded can never be proven reaped, and "we
 * could not check" is not "there is nothing there".
 */
const readRunSessionId = async (input: DetachedRunSessionInput): Promise<string> => {
  const sidPath = runSidPathFor(input.runExit)
  const read = await input.ssh(`cat ${sidPath}`)
  if (read.code === 255) {
    throw new Error(
      `[full-remote] ${input.subject}: the box became unreachable while reading the run's ` +
        `recorded session id at ${sidPath}, so whether anything from the run is still on it ` +
        `could not be established. ${input.refusal} (${read.stderr.trim() || "ssh exit 255"})`,
    )
  }
  const sid = read.stdout.trim()
  if (read.code !== 0 || sid === "") {
    throw new Error(
      `[full-remote] ${input.subject}: the run recorded NO session id at ${sidPath} (exit ` +
        `${read.code}${read.stderr.trim() === "" ? "" : `: ${read.stderr.trim()}`}). Without it ` +
        `the run's leftovers can be neither enumerated nor reaped. ${input.refusal}`,
    )
  }
  if (!/^[1-9][0-9]*$/.test(sid)) {
    throw new Error(
      `[full-remote] ${input.subject}: the recorded session id at ${sidPath} is not a session id ` +
        `(${JSON.stringify(sid.slice(0, 40))}), so the run's leftovers cannot be enumerated. ` +
        `${input.refusal}`,
    )
  }
  return sid
}

/**
 * How many processes of the run's session are still on the box.
 *
 * `pgrep -s <sid>` exits 0 and PRINTS them, exits 1 when the session is empty,
 * and exits 2/3/127 when it could not run — and all three of the latter print
 * nothing. Reading "it failed" as "the session is empty" is the same collapse
 * the sibling gold-boundary probes already refuse, so it is refused here too.
 * An exit 0 that printed no pid is a shape `pgrep` cannot emit, which means the
 * answer came from something other than `pgrep`; that is refused as well.
 */
const probeRunSessionSurvivors = async (
  input: DetachedRunSessionInput,
  sid: string,
): Promise<number> => {
  const probe = await input.ssh(`pgrep -s ${sid}`)
  if (probe.code === 255) {
    throw new Error(
      `[full-remote] ${input.subject}: the box became unreachable while checking session ${sid} ` +
        "for surviving processes, so whether the run left anything behind could not be " +
        `established. ${input.refusal} (${probe.stderr.trim() || "ssh exit 255"})`,
    )
  }
  if (probe.code === 1) return 0
  const pids = probe.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
  if (probe.code !== 0 || pids.length === 0) {
    throw new Error(
      `[full-remote] ${input.subject}: could not enumerate session ${sid} (exit ${probe.code}` +
        `${probe.stderr.trim() === "" ? "" : `: ${probe.stderr.trim()}`}), so whether the run ` +
        `left anything behind could not be established. ${input.refusal}`,
    )
  }
  return pids.length
}

/**
 * Reap the run's session by PROCESS GROUP.
 *
 * `kill -- -<pgid>` rather than a pid list: a survivor is by definition
 * something we did not launch by name, and its children are not in our list
 * either. The groups come from the BOX (`ps -o pgid= -s <sid>`), so a survivor
 * that forked is taken along with its parent, and a survivor that moved to its
 * own process group inside the session is still covered.
 *
 * The self-check guards a destructive command: if the recorded id somehow names
 * the CALLER's own ssh session (a mis-recorded launch, a recycled pid), reaping
 * it would kill the connection mid-check. That refuses instead.
 */
const reapRunSession = async (
  input: DetachedRunSessionInput,
  sid: string,
  force: boolean,
): Promise<void> => {
  const signal = force ? "-9 " : ""
  const reaped = await input.ssh(
    `own=$(ps -o sid= -p $$ | tr -d ' '); ` +
      `[ "$own" = "${sid}" ] && { echo SELF >&2; exit 9; }; ` +
      `for g in $(ps -o pgid= -s ${sid} 2>/dev/null | tr -d ' ' | sort -u); do ` +
      `kill ${signal}-- -"$g" 2>/dev/null; done; exit 0`,
  )
  if (reaped.code === 255) {
    throw new Error(
      `[full-remote] ${input.subject}: the box became unreachable while reaping session ${sid}. ` +
        `${input.refusal}`,
    )
  }
  if (reaped.code !== 0) {
    throw new Error(
      `[full-remote] ${input.subject}: could not reap session ${sid} (exit ${reaped.code}` +
        `${reaped.stderr.trim() === "" ? "" : `: ${reaped.stderr.trim()}`}) — nothing was ` +
        `signalled. ${input.refusal}`,
    )
  }
}

/**
 * PROVE the detached run's whole SESSION is empty — reaping it if it is not, and
 * RE-PROBING rather than assuming a signal worked.
 *
 * A caller that only asks "is the command line I launched still running" gets
 * one command line. That is what {@link detachedLaunchCommand} put on the box;
 * it is not what the box is now running. Anything the run spawned — including
 * anything an unsandboxed agent left behind during it — inherits this session,
 * whatever it is called and whatever it is doing, and only the session id can
 * name it.
 *
 * The ladder is deliberately the same shape as the caller's own: reap, settle,
 * escalate, settle, and only then refuse. A refusal that comes after an attempt
 * to fix the situation is the honest one; refusing without trying is what threw
 * away completed runs before.
 *
 * SCOPE — the residual hole, stated rather than implied closed:
 *
 *   A process that starts its OWN new session (`setsid`, a daemonizing
 *   double-fork) LEAVES this session, and this proof cannot see it. What is
 *   covered is what the run spawned; what is not covered is what deliberately
 *   detached from it.
 *
 *   Closing THAT would mean enumerating the box's LEGITIMATE baseline — sshd,
 *   `systemd --user` and its transient units, agetty, the pool's own probes —
 *   and refusing everything else. That enumeration cannot be written honestly
 *   without a real box in front of you, and a guessed whitelist false-positives
 *   on the baseline and refuses healthy, paid runs. So no whitelist is invented
 *   here, and this function claims exactly what it proves: the run's own session
 *   is empty.
 */
export const assertDetachedRunSessionReaped = async (
  input: DetachedRunSessionInput,
): Promise<void> => {
  const sid = await readRunSessionId(input)
  let survivors = await probeRunSessionSurvivors(input, sid)
  if (survivors === 0) return
  for (const force of [false, true]) {
    input.log(
      `[full-remote] ${input.subject}: ${survivors} process(es) from the run's own session ${sid} ` +
        "are still on the box after the bench command itself is gone. Reaping the session" +
        `${force ? " (SIGKILL)" : ""}, then re-checking.`,
    )
    await reapRunSession(input, sid, force)
    await input.sleep(input.settleMs)
    survivors = await probeRunSessionSurvivors(input, sid)
    if (survivors === 0) return
  }
  throw new Error(
    `[full-remote] ${input.subject}: ${survivors} process(es) from the run's session ${sid} ` +
      `survived being reaped — a detached reader left behind is exactly what this looks like. ` +
      `${input.refusal}`,
  )
}

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
  // The probe is `<exit>; echo MARK; tail …`, so `fresh` ALWAYS begins with the
  // newline `echo` printed after MARK. Left in, that yields a spurious leading ""
  // every poll → `seen` over-counts by 1 → next `tail -n +${seen+1}` SKIPS a real
  // run.log line. Over a run this silently DESYNCS the operator log from the box
  // (jun-27: the orchestrator log froze at case 1 while the box was on case 7).
  // Strip exactly that one leading newline so the cursor tracks real lines.
  const body = fresh.startsWith("\n") ? fresh.slice(1) : fresh
  return {
    ...(/^\d+$/.test(exitField) ? { exitCode: Number(exitField) } : {}),
    freshLines: body.split("\n").slice(0, -1),
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
 * Throws {@link BoxDiedDuringRunError} if the poll loop must stop waiting for an exit
 * sentinel that is never going to land — either the wall-clock ceiling elapsed, or the
 * box is alive-but-wedged past its idle budget.
 *
 * These two are ONE unit because they are the same verdict from the loop's point of
 * view: give up on this box and hand the chunk back to the pool's requeue path. They
 * share the error type deliberately — the pool keys its requeue off it — so a future
 * edit that gives one of them a different type has to change them together.
 */
const assertDetachedRunNotAbandoned = (args: {
  iid: string
  startedAt: number
  now: () => number
  watchdog: NoProgressWatchdog
}): void => {
  if (args.now() - args.startedAt >= RUN_WALL_CEILING_MS) {
    throw new BoxDiedDuringRunError(
      `${BOX_DIED_DURING_RUN_ERROR}: detached run on box ${args.iid} exceeded the ${Math.round(
        RUN_WALL_CEILING_MS / 60000,
      )}min wall-clock ceiling without an exit sentinel — abandoning to the pool's requeue path`,
    )
  }
  // Wedged-but-alive (polls succeed, run.log frozen past the idle budget) — the
  // 77min throttle hang. Abort to the SAME requeue path as box-death so the run
  // moves on instead of polling a stuck box forever (off unless budget is finite).
  if (args.watchdog.stalled()) {
    throw new BoxDiedDuringRunError(
      `${BOX_DIED_DURING_RUN_ERROR}: ${args.watchdog.reason(args.iid)}`,
    )
  }
}

/**
 * The poll loop's injectable ports, resolved once at entry to their production
 * defaults.
 *
 * A unit because "which clock, sleep and log is this run on" is a single decision: a
 * test either drives the whole set deterministically or none of it. Defaulting them
 * one-by-one at each point of use is what let a later-added call site read the real
 * `Date.now()` while the rest of the loop ran on the injected clock.
 */
const resolveDetachedPollPorts = (args: {
  sleep?: (ms: number) => Promise<void>
  now?: () => number
  log?: (msg: string) => void
  pollIntervalMs?: number
}): {
  sleep: (ms: number) => Promise<void>
  now: () => number
  log: (msg: string) => void
  pollIntervalMs: number
} => ({
  sleep: args.sleep ?? defaultSleep,
  now: args.now ?? (() => Date.now()),
  log: args.log ?? (() => {}),
  pollIntervalMs: args.pollIntervalMs ?? RUN_POLL_INTERVAL_MS,
})

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
  const { sleep, now, log, pollIntervalMs } = resolveDetachedPollPorts(args)
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
    assertDetachedRunNotAbandoned({ iid: args.iid, startedAt, now, watchdog })
    await sleep(pollIntervalMs)
  }
}
