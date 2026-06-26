/**
 * Reusable EC2 box session for full-remote bench runs (jun-20 box-lifecycle plan,
 * Phase 1). Extracted from {@link createFullRemoteBackend} so the EXPENSIVE
 * bootstrap surface (launch + cloud-init + rsync + bun install + phantom deps +
 * swebench/uvx warm + pyright nav-grounding) is provisioned ONCE and a persistent
 * pool ({@link ../pool}) can run many chunks on the same box — instead of paying
 * the full boot+sync+install tax on every wave (the old per-wave full-remote did).
 *
 * The split:
 *   - {@link provisionBox}    — launch + bootstrap, returns a live {@link BoxSession}.
 *                               On ANY bootstrap failure it terminates the box and
 *                               rethrows (a half-provisioned box must never linger).
 *   - {@link gradeChunkOnBox} — run ONE patch-gen+grading chunk on an already-
 *                               provisioned session. Owns NO lifecycle: the caller
 *                               (single run or pool) decides when to terminate.
 *                               Box paths are parameterised ({@link ChunkPaths}) so
 *                               a pool can isolate each chunk under its own runId
 *                               dir instead of colliding on the fixed `~/report.json`.
 *
 * ⚠️ SECURITY (unchanged from the origin file): full-remote needs an LLM credential
 * ON the box. Only the SHORT-LIVED access_token is shipped ({@link stripToAccessToken}),
 * over ssh STDIN (never an argv / temp file), and the box enforces IMDSv2 hop-1 +
 * a `shutdown -h` TTL backstop and is ALWAYS terminated. Everything routes through
 * the injected {@link SpawnFn} so the whole flow is unit-testable offline.
 *
 * MODULE LAYOUT (god-module split): the cohesive PURE / self-contained concerns
 * live in `./box-session/` siblings — `types` (shared interfaces + constants),
 * `dataset-preflight`, `auth` (token strip + phantom deps), `pyright-grounding`,
 * `snapshot` (status/probe/inspection + grade-time controller), `verdict-parse`,
 * `shell` (ssh/aws/quote primitives), `ec2-lifecycle` (launch/bootstrap/reuse),
 * and `detached-poll` (the ssh-resilient run loop). This file owns the grade
 * ORCHESTRATION that wires them together, and RE-EXPORTS the full original public
 * surface so every importer stays byte-compatible.
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { mirrorReportToSsot } from "@/runner/batch/report"
import { errMessage, foldGroundingReceipts } from "@/shared"
import { benchHome } from "../corpus"
import { presetRequiresLiveLspGrounding } from "../preset"
import type { SpawnFn, SpawnResult } from "./backend"
import { assertRemoteAccessTokenFreshEnough, stripToAccessToken } from "./box-session/auth"
import { runBenchDetachedPoll } from "./box-session/detached-poll"
import { probePyrightGrounding, remoteLspLaunchReceipt } from "./box-session/pyright-grounding"
import { BENCH_SSH_SAFE_OPTS, shq } from "./box-session/shell"
import {
  createGradeChunkState,
  createSnapshotBase,
  createSnapshotController,
  type GradeChunkState,
  normalizeStatusText,
} from "./box-session/snapshot"
import {
  type BoxSession,
  type ChunkPaths,
  DEFAULT_CHUNK_PATHS,
  type FullRemoteResult,
  GRADE_LOCK_DIR,
  GRADE_LOCK_RELEASE_ERROR,
  type GradeChunkParams,
  type GradeChunkVerdicts,
  POOL_BUSY_ERROR,
} from "./box-session/types"
import {
  classifyReportText,
  detectRateLimit,
  parseVerdicts,
  verdictCount,
} from "./box-session/verdict-parse"

/** Durable dir for fetched full-remote artifacts (predictions / report / closure
 *  sidecar / trajectory). NEVER /tmp — the OS reaps it on the next session and
 *  silently destroys the only post-mortem signal (2026-06-19: lost the patches
 *  needed to RCA a grading false-negative). Lives under benchHome() like the
 *  rest of bench's persistent output. */
export const fullRemoteArtifactDir = (): string => {
  const dir = join(benchHome(), "full-remote")
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Charset a runId / artifact suffix is allowed to contain. The suffix is the
 *  ONLY caller-supplied value that flows UNQUOTED into remote ssh commands —
 *  the pool derives box paths from it ({@link ChunkPaths}: `~/runs/<runId>/…`)
 *  and those paths are interpolated raw into `tail`/`cat`/`setsid bash -c …`. A
 *  suffix with a shell metachar (` `, `;`, `$(…)`, backtick, `|`, `/`, `..`)
 *  would break out of the intended command. The pool already documents the
 *  "filesystem-safe (no spaces / slashes)" contract; this is the boundary that
 *  ENFORCES it (defense-in-depth — a future caller can't smuggle an injection). */
const SAFE_SUFFIX_RE = /^[A-Za-z0-9._-]+$/

/** Assert a caller-supplied runId / artifact suffix cannot break out of the
 *  remote command it is interpolated into. Rejects (never escapes) so a bad
 *  suffix fails LOUDLY at the boundary instead of silently mangling box paths or
 *  smuggling a command. */
export const assertSafeArtifactSuffix = (suffix: string): void => {
  // A dot-only suffix (".", "..", "...") matches SAFE_SUFFIX_RE yet is a path
  // component: with slashes already banned the suffix IS one component, so ".."
  // yields `~/runs/../instances.jsonl` = `~/instances.jsonl`, escaping the runId
  // dir. Reject it explicitly (the char-class regex alone does not).
  if (!SAFE_SUFFIX_RE.test(suffix) || /^\.+$/.test(suffix)) {
    throw new Error(
      `[full-remote] unsafe artifact suffix / runId ${JSON.stringify(suffix)} — must match ` +
        `${SAFE_SUFFIX_RE} and not be a dot-only path component (no spaces, slashes, shell ` +
        "metacharacters, or `.`/`..`); it is interpolated into remote ssh box paths.",
    )
  }
}

/** Keys set EXPLICITLY in the remote command — excluded from the generic forward
 *  to avoid double-assignment. */
const EXPLICIT_BOX_ENV: ReadonlySet<string> = new Set([
  "QUANTA_BENCH_PRESET",
  "QUANTA_BENCH_CONCURRENCY",
  "QUANTA_BENCH_RECORD_TRAJECTORY",
  "QUANTA_BENCH_REPLAY_TRAJECTORY",
  "QUANTA_BENCH_REPLAY_ON_MISS",
])

/** Non-`QUANTA_BENCH_`-prefixed env knobs that ALSO must reach the box. These
 *  are runtime-config dials read by the bench runner itself (not preset-bundled,
 *  not BENCH-prefixed) — without forwarding they silently fall back to the box
 *  default. jun-20: `QUANTA_MAX_TURNS` (→ `maxTurnsBatch`) was stuck at the
 *  preset 60 on the box, so complex instances `max_turns_exhausted` even when a
 *  higher local budget was set. Same env-forwarding bug class the BENCH filter
 *  guards against. */
const FORWARD_EXTRA_ENV: ReadonlySet<string> = new Set([
  "QUANTA_MAX_TURNS",
  // jun-26: reasoning-summary is DEFAULT-ON for bench as a CODE default (rides
  // rsync), so the default needs no forwarding. But an operator OPT-OUT
  // (`QUANTA_REASONING_SUMMARY=0`, e.g. to A/B the reasoning-model silent-stall
  // fix on the box) is NOT QUANTA_BENCH_*-prefixed and would be SILENTLY DROPPED
  // — the box would stay default-ON and the experiment arm read as a null effect
  // (same env-forwarding bug class as QUANTA_MAX_TURNS). Forward it so the
  // override actually reaches the box.
  "QUANTA_REASONING_SUMMARY",
])

/**
 * Build the `KEY=val ` prefix that forwards the operator's local bench knobs
 * (every set, non-empty `QUANTA_BENCH_*` except the explicitly-handled ones) into
 * the remote box command. PURE — deterministic over the given env. Sorted for a
 * stable command string. Each value is shell-quoted.
 *
 * WHY this exists as a tested seam: without forwarding, env-only knobs that are
 * NOT bundled in any preset (QUANTA_BENCH_SPEC_FIDELITY_STEER /
 * QUANTA_BENCH_VERIFICATION_PLAN / …) never reach the box, so a remote experiment
 * arm is SILENTLY INERT and the whole A/B reads as a null effect (jun-16
 * env-forwarding bug class). The test pins that the experiment knobs survive.
 */
export const buildForwardedBenchEnv = (env: NodeJS.ProcessEnv): string => {
  const replayPath = env.QUANTA_BENCH_REPLAY_TRAJECTORY
  if (replayPath !== undefined && replayPath !== "" && replayPath !== "0") {
    throw new Error(
      "[full-remote] QUANTA_BENCH_REPLAY_TRAJECTORY is local-only today; remote/pool runs cannot " +
        "blindly forward a local cassette path to the box. Run the replay locally or add explicit " +
        "cassette upload wiring first.",
    )
  }
  return Object.keys(env)
    .filter(
      (k) =>
        (k.startsWith("QUANTA_BENCH_") || FORWARD_EXTRA_ENV.has(k)) &&
        !EXPLICIT_BOX_ENV.has(k) &&
        env[k] !== undefined &&
        env[k] !== "",
    )
    .sort()
    .map((k) => `${k}=${shq(env[k] as string)} `)
    .join("")
}

/* ── GRADE ORCHESTRATION ─────────────────────────────────────────────────────
 * Runs ONE patch-gen + grading chunk on an already-provisioned box: acquires the
 * atomic grade lock, publishes the running snapshot, ships dataset + token, runs
 * the detached bench poll, fetches artifacts, parses verdicts, and releases the
 * lock — owning NO box lifecycle. The pure/self-contained pieces it wires up live
 * in `./box-session/` siblings; the two helpers below stay here because they
 * COUPLE to the grade-time mutable {@link GradeChunkState} / box ssh. */

const assignVerdictCounts = (state: GradeChunkState, verdicts: GradeChunkVerdicts): void => {
  state.finalResolvedCount = verdicts.resolved.length
  state.finalUnresolvedCount = verdicts.unresolved.length
  state.finalErroredCount = verdicts.errored.length
  state.finalEmptyPatchCount = verdicts.emptyPatch.length
}

const acquireGradeLock = async (ssh: BoxSession["ssh"], iid: string): Promise<void> => {
  const lock = await ssh(`mkdir ${GRADE_LOCK_DIR} 2>/dev/null && echo LOCKED || echo BUSY`)
  if (lock.code !== 0) {
    throw new Error(
      `[full-remote] grade lock probe failed (code ${lock.code}): ${lock.stderr || lock.stdout}`,
    )
  }
  if (!lock.stdout.includes("LOCKED")) {
    throw new Error(
      `${POOL_BUSY_ERROR}: box ${iid} is grading another run (lock held) — not reusing`,
    )
  }
}

const releaseGradeLock = async (ssh: BoxSession["ssh"]): Promise<void> => {
  const released = await ssh(`rmdir ${GRADE_LOCK_DIR} 2>/dev/null`)
  if (released.code !== 0) {
    throw new Error(
      `${GRADE_LOCK_RELEASE_ERROR}: ${released.stderr.trim() || released.stdout.trim() || `rmdir exited ${released.code}`}`,
    )
  }
}

const uploadChunkDataset = async (args: {
  spawn: SpawnFn
  keyPath: string
  datasetPath: string
  host: string
  targetPath: string
}): Promise<void> => {
  const scpDs = await args.spawn("scp", [
    "-i",
    args.keyPath,
    // SSOT host-key/safety posture (jun-25): without StrictHostKeyChecking=no +
    // UserKnownHostsFile=/dev/null this scp FAILED "Host key verification failed"
    // on a recycled-IP box AFTER readiness already succeeded — the exact
    // known_hosts-collision class makeSsh fences, which this transport skipped.
    ...BENCH_SSH_SAFE_OPTS,
    "-o",
    "ConnectTimeout=15",
    args.datasetPath,
    `${args.host}:${args.targetPath}`,
  ])
  if (scpDs.code !== 0) {
    throw new Error(`[full-remote] scp dataset failed (code ${scpDs.code}): ${scpDs.stderr}`)
  }
}

const shipAccessToken = async (
  ssh: BoxSession["ssh"],
  log: (msg: string) => void,
  authJson: string,
): Promise<void> => {
  assertRemoteAccessTokenFreshEnough(authJson)
  log("[full-remote] shipping stripped token (access_token only) over ssh stdin…")
  const shipped = await ssh(
    "mkdir -p ~/.quanta/auth && cat > ~/.quanta/auth/chatgpt.json && chmod 600 ~/.quanta/auth/chatgpt.json",
    stripToAccessToken(authJson),
  )
  if (shipped.code !== 0) {
    throw new Error(`[full-remote] token ship failed (code ${shipped.code}): ${shipped.stderr}`)
  }
}

const buildBenchCommand = (params: GradeChunkParams, paths: ChunkPaths): string => {
  const idsFlag =
    params.instanceIds && params.instanceIds.length > 0
      ? ` --instance ${shq(params.instanceIds.join(","))}`
      : ""
  const trajectoryRecordEnv = params.recordTrajectory
    ? `QUANTA_BENCH_RECORD_TRAJECTORY="${paths.trajectory}" `
    : ""
  return (
    `set -o pipefail; cd ~/quanta && export PATH="$HOME/.local/bin:$PATH"; QUANTA_BENCH_PRESET=${shq(params.preset)} QUANTA_PROVIDER=chatgpt-oauth QUANTA_SWEBENCH_PYTHON=1 ` +
    `QUANTA_PREFS_HOME="$HOME/.quanta" ` +
    `QUANTA_SWEBENCH_PYTHON_BIN="$HOME/swebench-python" ` +
    `QUANTA_SWEBENCH_NAMESPACE=swebench QUANTA_SWEBENCH_MAX_WORKERS=4 QUANTA_BENCH_CONCURRENCY=${params.concurrency} ` +
    params.forwardedBenchEnv +
    trajectoryRecordEnv +
    `~/.bun/bin/bun run src/apps/bench/cli.ts run --swebench ${paths.dataset}${idsFlag} ` +
    `--observe-dir ${paths.observeDir} ` +
    `--model ${shq(params.model)} --predictions ${paths.preds} --report ${paths.report}`
  )
}

const runExitPathFor = (paths: ChunkPaths): string => paths.runLog.replace(/run\.log$/, "run.exit")

const closureDiagnosticsPathFor = (paths: ChunkPaths): string =>
  paths.report.replace(/\.json$/, ".closure-diagnostics.json")

/**
 * Fail closed on stale box-side artifacts. Single full-remote runs still use the
 * historical fixed `~/preds.jsonl` / `~/report.json` / `~/run.log` paths; if a
 * previous box image or prior failed run left those behind, blindly fetching
 * them after a crash can mis-attribute stale/gold data as the current run's
 * outputs. Scrub every derived artifact path BEFORE launch so an empty/crashed
 * run fetches nothing instead of contaminated leftovers.
 */
const scrubChunkArtifacts = async (args: {
  ssh: BoxSession["ssh"]
  paths: ChunkPaths
  recordTrajectory: boolean
}): Promise<void> => {
  const targets = [
    args.paths.preds,
    args.paths.report,
    args.paths.runLog,
    runExitPathFor(args.paths),
    closureDiagnosticsPathFor(args.paths),
    ...(args.recordTrajectory ? [args.paths.trajectory] : []),
  ]
  const cleared = await args.ssh(
    `rm -f ${targets.join(" ")}; rm -rf ${args.paths.observeDir}; mkdir -p ${args.paths.observeDir}`,
  )
  if (cleared.code !== 0) {
    throw new Error(
      `[full-remote] stale-artifact scrub failed (code ${cleared.code}): ${cleared.stderr}`,
    )
  }
}

const runChunkBench = async (args: {
  ssh: BoxSession["ssh"]
  aws: BoxSession["aws"]
  iid: string
  log: (msg: string) => void
  keyPath: string
  host: string
  paths: ChunkPaths
  params: GradeChunkParams
  onLine: (chunk: string) => void
}): Promise<number> => {
  args.log(
    `[full-remote] running patch-gen + grading on box (minutes). Watch live:\n` +
      `    ssh -i ${args.keyPath} ${args.host} 'tail -f ${args.paths.runLog}'`,
  )
  const remoteRun = await runBenchDetachedPoll({
    ssh: args.ssh,
    aws: args.aws,
    iid: args.iid,
    log: args.log,
    benchCmd: buildBenchCommand(args.params, args.paths),
    runLog: args.paths.runLog,
    runExit: runExitPathFor(args.paths),
    onLine: args.onLine,
    completionArtifacts: {
      reportJson: args.paths.report,
      predictionsJsonl: args.paths.preds,
    },
    ...(args.params.pollSleep !== undefined ? { sleep: args.params.pollSleep } : {}),
    ...(args.params.pollIntervalMs !== undefined
      ? { pollIntervalMs: args.params.pollIntervalMs }
      : {}),
    ...(args.params.pollNow !== undefined ? { now: args.params.pollNow } : {}),
  })
  return remoteRun.code
}

const fetchRemoteFile = async (ssh: BoxSession["ssh"], remotePath: string): Promise<SpawnResult> =>
  await ssh(`cat ${remotePath} 2>/dev/null`)

const fetchRemoteCommand = async (
  ssh: BoxSession["ssh"],
  command: string,
): Promise<SpawnResult> => await ssh(command)

const saveLocalArtifact = (
  localPath: string,
  content: string,
  log: (msg: string) => void,
  label: string,
): string | undefined => {
  if (content.trim() === "") return undefined
  try {
    writeFileSync(localPath, content)
    log(`${label}: ${localPath}`)
    return localPath
  } catch {
    return undefined
  }
}

const fetchOptionalArtifact = async (args: {
  ssh: BoxSession["ssh"]
  remotePath: string
  localPath: string
  log: (msg: string) => void
  label: string
}): Promise<string | undefined> => {
  try {
    const fetched = await fetchRemoteFile(args.ssh, args.remotePath)
    if (fetched.code !== 0) return undefined
    return saveLocalArtifact(args.localPath, fetched.stdout, args.log, args.label)
  } catch {
    return undefined
  }
}

const fetchOptionalCommandArtifact = async (args: {
  ssh: BoxSession["ssh"]
  command: string
  localPath: string
  log: (msg: string) => void
  label: string
}): Promise<string | undefined> => {
  try {
    const fetched = await fetchRemoteCommand(args.ssh, args.command)
    if (fetched.code !== 0 || fetched.stdout.length === 0) return undefined
    return saveLocalArtifact(args.localPath, fetched.stdout, args.log, args.label)
  } catch {
    return undefined
  }
}

const fetchChunkArtifacts = async (args: {
  ssh: BoxSession["ssh"]
  paths: ChunkPaths
  artifactSuffix: string
  recordTrajectory: boolean
  log: (msg: string) => void
}): Promise<{ reportText: string; reportPath?: string }> => {
  const fetchedReport = await fetchRemoteFile(args.ssh, args.paths.report)
  await fetchOptionalArtifact({
    ssh: args.ssh,
    remotePath: args.paths.preds,
    localPath: join(fullRemoteArtifactDir(), `preds-${args.artifactSuffix}.jsonl`),
    log: args.log,
    label: "[full-remote] predictions saved",
  })
  // ALWAYS pull the operational run.log back before the box is terminated. It
  // holds the only on-box diagnostics — LSP server-exit WARNs (crash/OOM),
  // throttle/429 markers, warm-up exhaustion — and the box is destroyed at
  // end-of-run, so a death NOT fetched here is a death investigated by live
  // ssh-babysitting (or lost entirely). Not gated on `recordTrajectory`: this is
  // the cheap, always-useful failure-forensics artifact, not the heavy cassette.
  await fetchOptionalArtifact({
    ssh: args.ssh,
    remotePath: args.paths.runLog,
    localPath: join(fullRemoteArtifactDir(), `runlog-${args.artifactSuffix}.log`),
    log: args.log,
    label: "[full-remote] run.log saved",
  })
  await fetchOptionalCommandArtifact({
    ssh: args.ssh,
    command: `if [ -d ${args.paths.observeDir} ]; then tar -C ${args.paths.observeDir} -cf - . | base64 -w0; fi`,
    localPath: join(fullRemoteArtifactDir(), `observe-${args.artifactSuffix}.tar.b64`),
    log: args.log,
    label: "[full-remote] observe archive saved",
  })
  await fetchOptionalArtifact({
    ssh: args.ssh,
    remotePath: closureDiagnosticsPathFor(args.paths),
    localPath: join(fullRemoteArtifactDir(), `closure-${args.artifactSuffix}.json`),
    log: args.log,
    label: "[full-remote] closure diagnostics saved",
  })
  if (args.recordTrajectory) {
    await fetchOptionalArtifact({
      ssh: args.ssh,
      remotePath: args.paths.trajectory,
      localPath: join(fullRemoteArtifactDir(), `trajectory-${args.artifactSuffix}.jsonl`),
      log: args.log,
      label: "[full-remote] trajectory cassette saved",
    })
  }
  const reportPath = saveLocalArtifact(
    join(fullRemoteArtifactDir(), `report-${args.artifactSuffix}.json`),
    fetchedReport.stdout,
    args.log,
    "[full-remote] report saved",
  )
  if (reportPath !== undefined) {
    // Canonical SSOT mirror — same sink as the local batch's writeReport, so
    // full-remote per-box reports also collect in one fixed place.
    await mirrorReportToSsot(reportPath, fetchedReport.stdout)
    return {
      reportText: fetchedReport.stdout,
      reportPath,
    }
  }
  return {
    reportText: fetchedReport.stdout,
  }
}

export const collectRunDiagnostics = async (args: {
  ssh: BoxSession["ssh"]
  runLogPath: string
  latestLogLine: string | undefined
  remoteRunCode: number
  emptyVerdicts: boolean
  log: (msg: string) => void
}): Promise<{ lastLogLine?: string; rateLimited: boolean }> => {
  const tail = await args.ssh(`tail -60 ${args.runLogPath} 2>/dev/null`)
  // #8: the rate-limit signal drives ALL worker backoff. Reading only the last 60
  // lines makes a 429 storm that happened during patch-gen invisible once grading
  // output scrolls past it → no backoff → the next chunk hammers a still-throttled
  // login. Scan the FULL log for throttle markers; the tail is kept ONLY for the
  // human-facing status line. The TS `detectRateLimit` regex stays authoritative —
  // the remote grep merely hauls candidate lines out of the whole file so they
  // survive into the window we re-validate.
  const throttleScan = await args.ssh(
    `grep -aiE 'generation_error|too many requests|rate[ _-]?limit|(http|status)[ /:]*429' ${args.runLogPath} 2>/dev/null | head -20`,
  )
  const lastLogLine = normalizeStatusText(
    tail.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .at(-1) ??
      args.latestLogLine ??
      "",
  )
  const rateLimited = detectRateLimit(tail.stdout) || detectRateLimit(throttleScan.stdout)
  if (args.emptyVerdicts) {
    args.log(
      `[full-remote] ⚠️ no verdicts in report (run exit ${args.remoteRunCode}). Box run.log tail:`,
    )
    args.log(tail.stdout || "(run.log empty)")
  }
  if (rateLimited) {
    args.log(
      "[full-remote] ⚠️ rate-limit signal (generation_error / 429) in run log — caller should back off.",
    )
  }
  return {
    ...(lastLogLine !== "" ? { lastLogLine } : {}),
    rateLimited,
  }
}

const executeGradeChunk = async (args: {
  session: BoxSession
  params: GradeChunkParams
  paths: ChunkPaths
  artifactSuffix: string
  state: ReturnType<typeof createGradeChunkState>
  snapshots: ReturnType<typeof createSnapshotController>
}): Promise<FullRemoteResult> => {
  const { host, keyPath, spawn, log } = args.session
  const ssh = args.session.ssh.bind(args.session)
  await args.snapshots.start()
  await shipAccessToken(ssh, log, args.params.authJson)
  await uploadChunkDataset({
    spawn,
    keyPath,
    datasetPath: args.params.datasetPath,
    host,
    targetPath: args.paths.dataset,
  })
  await scrubChunkArtifacts({
    ssh,
    paths: args.paths,
    recordTrajectory: args.params.recordTrajectory,
  })
  args.state.finalExitCode = await runChunkBench({
    ssh,
    aws: args.session.aws.bind(args.session),
    iid: args.session.iid,
    log,
    keyPath,
    host,
    paths: args.paths,
    params: args.params,
    onLine: args.snapshots.makeLineStreamer(),
  })
  await args.snapshots.publish("fetching", {
    ...(args.state.finalExitCode !== undefined ? { lastExitCode: args.state.finalExitCode } : {}),
  })
  log(`[full-remote] run finished (exit ${args.state.finalExitCode}); fetching report…`)
  const fetched = await fetchChunkArtifacts({
    ssh,
    paths: args.paths,
    artifactSuffix: args.artifactSuffix,
    recordTrajectory: args.params.recordTrajectory,
    log,
  })
  const parsed = parseVerdicts(fetched.reportText)
  const reportStatus = classifyReportText(fetched.reportText)
  if (reportStatus === "unparseable") {
    args.state.finalReportUnparseable = true
    log(
      `[full-remote] ⚠️ report present but UNPARSEABLE (${fetched.reportText.length} bytes, run exit ${args.state.finalExitCode ?? -1}) — likely truncated/half-flushed fetch, NOT a clean box-loss. Re-fetch before treating as lost.`,
    )
  }
  assignVerdictCounts(args.state, parsed)
  const diagnostics = await collectRunDiagnostics({
    ssh,
    runLogPath: args.paths.runLog,
    latestLogLine: args.state.latestLogLine,
    remoteRunCode: args.state.finalExitCode ?? -1,
    emptyVerdicts: verdictCount(parsed) === 0,
    log,
  })
  if (diagnostics.lastLogLine !== undefined) {
    args.state.finalLastLogLine = diagnostics.lastLogLine
  }
  args.state.finalRateLimited = diagnostics.rateLimited
  return {
    ...(fetched.reportPath !== undefined ? { reportPath: fetched.reportPath } : {}),
    ...parsed,
    ...(diagnostics.rateLimited ? { rateLimited: true } : {}),
  }
}

/**
 * KEYSTONE INVARIANT (jun-24, ~60-test outage RCA): decide the terminal outcome of
 * a graded chunk from the PRIMARY (grade) outcome and the CLEANUP (grade-lock
 * release) outcome.
 *
 * When BOTH a primary error and a cleanup error occur, the PRIMARY error MUST
 * propagate: a co-occurring grade-lock-release failure is almost always the SAME
 * box death (the lock cannot be released on an unreachable box), and the primary
 * error is the one carrying the box-death signal (ssh-255 / connect-timed-out) the
 * pool's classifier needs to REQUEUE the chunk. Surfacing the cleanup error instead
 * masks that signal and turns a recoverable box death into a hard pool abort.
 *
 * Pure + exhaustively unit-tested (red-on-injection) so this branch can never
 * silently regress to error-wrapping. Behaviour is byte-identical to the prior
 * inline logic.
 */
export const resolveChunkOutcome = <T>(
  primaryErr: unknown,
  cleanupErr: unknown,
  result: T | undefined,
  fallback: T,
): T => {
  if (cleanupErr !== undefined) {
    // KEYSTONE: primary (box-death) wins over a co-occurring cleanup failure.
    if (primaryErr !== undefined) throw primaryErr
    throw cleanupErr
  }
  if (primaryErr !== undefined) throw primaryErr
  return result ?? fallback
}

/**
 * Run ONE patch-gen + grading chunk on an already-provisioned box. Ships a fresh
 * stripped token, scps the dataset, runs `bench run` (grading SERIAL — concurrent
 * on-box grading false-negatives correct patches), then fetches report +
 * predictions + closure sidecar + (optional) trajectory back to durable local
 * storage. Owns NO box lifecycle — the caller terminates / reuses the box.
 */
export const gradeChunkOnBox = async (
  session: BoxSession,
  params: GradeChunkParams,
): Promise<FullRemoteResult> => {
  const ssh = session.ssh.bind(session)
  const paths = params.paths ?? DEFAULT_CHUNK_PATHS
  const { artifactSuffix } = params
  // Boundary guard: artifactSuffix is the pool runId — the one caller value that
  // reaches the box paths UNQUOTED. Reject a shell-metachar suffix before any
  // remote command is built/run (shell-injection defense-in-depth).
  assertSafeArtifactSuffix(artifactSuffix)
  const state = createGradeChunkState()
  // LSP-02: capture the box's typed grounding status (launch proof of the task
  // server) once at grade start so every published snapshot — and thus `box ls`
  // — carries the SAME enum the local report uses, not a log-tail guess. Reuses
  // the existing cheap `--version` probe; skipped for non-grounding presets.
  const lspGrounding = presetRequiresLiveLspGrounding(params.preset)
    ? foldGroundingReceipts([remoteLspLaunchReceipt(await probePyrightGrounding((c) => ssh(c)))])
    : undefined
  const snapshots = createSnapshotController(
    session,
    {
      ...createSnapshotBase(params, paths, artifactSuffix),
      ...(lspGrounding !== undefined ? { lspGrounding } : {}),
    },
    state,
  )
  let result: FullRemoteResult | undefined
  let primaryErr: unknown

  // ATOMIC busy-lock: `mkdir` fails non-zero if the dir already exists, so two
  // runs can NEVER grade the SAME reused box concurrently — which would race the
  // shared docker run_id cache and false-negative correct patches (the jun-19
  // concurrent-grade hazard). A freshly-launched box has no lock ⇒ acquires
  // cleanly; a busy box throws POOL_BUSY_ERROR (the pool drops it WITHOUT
  // terminating — it belongs to the other run). Released in the `finally`.
  await acquireGradeLock(ssh, session.iid)
  try {
    result = await executeGradeChunk({
      session,
      params,
      paths,
      artifactSuffix,
      state,
      snapshots,
    })
  } catch (err) {
    primaryErr = err
  } finally {
    snapshots.stop()
  }
  let cleanupErr: unknown
  try {
    // Release the grade lock so the box can be reused for the next chunk/run.
    await releaseGradeLock(ssh)
  } catch (err) {
    cleanupErr = err
  }
  await snapshots.finish()
  // KEYSTONE: primary (box-death) error wins over a co-occurring grade-lock-release
  // failure so the pool's classifier can requeue. See {@link resolveChunkOutcome}.
  return resolveChunkOutcome<FullRemoteResult>(primaryErr, cleanupErr, result, {})
}

export { PHANTOM_DEPS, stripToAccessToken } from "./box-session/auth"
export {
  assertRemoteDatasetLaunchable,
  assertRemoteDatasetSelectionExists,
  assertRemoteStrictGroundingSupported,
  RemoteDatasetPreflightError,
  RemoteDatasetSelectionPreflightError,
  UnsupportedRemoteStrictLspGroundingError,
} from "./box-session/dataset-preflight"
export { BoxDiedDuringRunError } from "./box-session/detached-poll"
export {
  attachBox,
  countLiveBoxes,
  findIdleBox,
  inspectBox,
  provisionBox,
} from "./box-session/ec2-lifecycle"
export { pyrightLaunchProofVerdict, remoteLspLaunchReceipt } from "./box-session/pyright-grounding"
export { boxRunLogPath, createLineStreamer } from "./box-session/snapshot"
export type {
  BoxInspection,
  BoxRuntimeProbe,
  BoxSession,
  BoxSnapshotState,
  BoxStatusSnapshot,
  ChunkPaths,
  FullRemoteConfig,
  FullRemoteResult,
  GradeChunkParams,
  GradeChunkVerdicts,
  ReportTextStatus,
} from "./box-session/types"
// ── PUBLIC SURFACE RE-EXPORTS (byte-compatible with the pre-split module) ─────
// Every symbol an importer used before the god-module split still resolves from
// `box-session` exactly as before — the cohesive concerns simply live in
// `./box-session/` siblings now.
export {
  BOX_DIED_DURING_RUN_ERROR,
  D,
  DEFAULT_CHUNK_PATHS,
  GRADE_LOCK_RELEASE_ERROR,
  POOL_BUSY_ERROR,
} from "./box-session/types"
export {
  classifyReportText,
  coveredInstances,
  detectRateLimit,
  emptyVerdicts,
  parseVerdicts,
  verdictCount,
} from "./box-session/verdict-parse"
