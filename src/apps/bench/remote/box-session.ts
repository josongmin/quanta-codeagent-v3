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

import { execFileSync } from "node:child_process"
import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { mirrorReportToSsot } from "@/runner/batch/report"
import { foldGroundingReceipts } from "@/shared"
import { benchHome } from "../corpus"
import { presetRequiresLiveLspGrounding } from "../preset"
import { resolveDatasetFamilyProfile } from "../profiles/registry"
import type { SpawnFn, SpawnResult } from "./backend"
import { assertRemoteAccessTokenFreshEnough, stripToAccessToken } from "./box-session/auth"
import { bucketsFromGradedInstances } from "./verdict-buckets"
import {
  parseFamilyBoxGradeVerdicts,
  runFamilyBoxGrade,
} from "./box-session/family-box-grade"
import {
  buildChunkScrubCommand,
  closureDiagnosticsPathFor,
  runExitPathFor,
  trajectoriesDirFor,
} from "./box-session/chunk-scrub"
import { runBenchDetachedPoll } from "./box-session/detached-poll"
import { probePyrightGrounding, remoteLspLaunchReceipt } from "./box-session/pyright-grounding"
import { BENCH_SSH_SAFE_OPTS, openOtelReverseTunnel, shq } from "./box-session/shell"
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
  // jun-26: OTLP live-trace export (ADR-0268). The box's agent loop attaches the
  // OTLP exporter (apps/bench/cli.ts boot wire) ONLY when QUANTA_OTEL_ENDPOINT is
  // set in its env — without forwarding it the box stays Default-OFF and the
  // operator gets NO live span stream (falls back to the flaky box→local run.log
  // push). The operator points QUANTA_OTEL_ENDPOINT at a reverse-tunneled laptop
  // receiver (like the oauth proxy). QUANTA_OTEL_SERVICE_NAME rides along so the
  // operator can label the box's spans distinctly.
  "QUANTA_OTEL_ENDPOINT",
  "QUANTA_OTEL_SERVICE_NAME",
  // jun-27: run id stamped on every span (`quanta.run.id` resource attr) so the
  // trace-viewer `?run=<id>` deep-link can filter THIS box's run out of a sink
  // that mixes many concurrent runs. Without forwarding it the box's spans carry
  // no run id and the operator's run-link shows nothing.
  "QUANTA_OTEL_RUN_ID",
  // C5 run-id unification: forward the ARTIFACT/observe id too, so the box's
  // observe/cassette `ctx.runId` (from `benchRunId()` → `runtimeConfig().runId`
  // → QUANTA_RUN_ID) is the SAME value as its OTLP `quanta.run.id`
  // (QUANTA_OTEL_RUN_ID). The operator side now seeds both to one authority
  // (bootBenchOtelExport / ensureBenchTraceSink); without forwarding THIS key
  // the box would mint its own `run-<ts>` and the OTLP span could not join its
  // `<runId>/<instanceId>.<attempt>.jsonl` trajectory. Absent locally ⇒ not
  // forwarded ⇒ box mints its own (byte-identical Default-OFF).
  "QUANTA_RUN_ID",
  // jul-13 (T-B4): context-only span-sink gate. The box's agent loop attaches the
  // trace sink / stamps unified `{traceId,spanId}` on its cassettes+observe ONLY
  // when QUANTA_TRACE_CONTEXT is in its env — and this knob is NOT QUANTA_BENCH_*-
  // prefixed (naming decided in T-B3), so it would be SILENTLY DROPPED by the
  // forward gate. Without forwarding it a full-remote run records with NO sink →
  // no ids → the FETCHED per-box cassettes/observe the trajectory viewer loads
  // (trajectories/<box>/ + observe-<box>.tar.b64) degrade to no-trace — exactly
  // the runs the operator most wants to inspect (same env-forwarding bug class as
  // QUANTA_OTEL_ENDPOINT). Absent locally ⇒ not forwarded ⇒ byte-identical Default-OFF.
  "QUANTA_TRACE_CONTEXT",
  // jun-29 (RFC multi-dataset): buildBenchCommand hardcodes QUANTA_SWEBENCH_NAMESPACE
  // =swebench and defaults dataset_name to Verified. Live/Pro grade against a DIFFERENT
  // HF dataset + Docker namespace (Live: SWE-bench-Live/SWE-bench-Live + `starryzhang`).
  // These are appended AFTER the hardcoded assignment in the env prefix, so the shell's
  // last-wins override applies — a Live/Pro launch reaches the box with no per-dataset
  // fork. Absent ⇒ box stays on the Verified default (byte-identical for Verified runs).
  "QUANTA_SWEBENCH_NAMESPACE",
  "QUANTA_SWEBENCH_DATASET_NAME",
  // The box's own `datasetFamily()` (index.ts) reads this to pick the Live grading dataset
  // default + the Pro/Live parse path. Without forwarding it, a `--dataset-family live` launch
  // reaches the box as "verified" → grades Live ids against the Verified dataset (audit r2 BUG#1).
  "QUANTA_SWEBENCH_DATASET_FAMILY",
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
    // NARROW guard (kept, NOT blanket-removed): a LOCAL cassette path still must
    // never be blindly forwarded — a worker-local file path is meaningless on the
    // box. The supported resume wiring DOES exist now (bench-resume, DEFAULT-OFF):
    // the worker forwards resume KNOBS (`QUANTA_BENCH_RESUME` /
    // `QUANTA_BENCH_RESUME_S3_BUCKET` / `QUANTA_BENCH_CAMPAIGN_ID` /
    // `QUANTA_BENCH_INSTANCE_ID`) and the box-side `resume-launch.ts` prelaunch
    // DOWNLOADS the cassette from S3 and sets `QUANTA_BENCH_REPLAY_TRAJECTORY`
    // locally (see {@link buildResumePrelaunchStep}). So forwarding a local
    // REPLAY_TRAJECTORY is still wrong — use the resume knobs instead.
    throw new Error(
      "[full-remote] QUANTA_BENCH_REPLAY_TRAJECTORY is a LOCAL path; remote/pool runs cannot forward " +
        "a local cassette path to the box. For spot-resume use the bench-resume knobs " +
        "(QUANTA_BENCH_RESUME + QUANTA_BENCH_RESUME_S3_BUCKET + QUANTA_BENCH_CAMPAIGN_ID + " +
        "QUANTA_BENCH_INSTANCE_ID) — the box downloads its cassette from S3 and sets the replay path itself.",
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

/**
 * BOX-SIDE resume prelaunch step (DEFAULT-OFF). When the forwarded env carries
 * the resume knobs (`QUANTA_BENCH_RESUME=…`, set ONLY by the worker's
 * `resumeForwardEnvFor` on a relaunch), prepend a step that runs the resume
 * materializer ON THE BOX: it DOWNLOADS this instance's recorded cassette from
 * S3 (the box has aws creds + the resume env), writes it locally, and EMITS
 * `export QUANTA_BENCH_REPLAY_TRAJECTORY=… / QUANTA_BENCH_REPLAY_ON_MISS=…`,
 * which we `eval` so the bench run REPLAYS then diverges live. This is why the
 * worker forwards resume KNOBS (not a local cassette path) — the box sets
 * `QUANTA_BENCH_REPLAY_TRAJECTORY` itself, so the {@link buildForwardedBenchEnv}
 * local-forward guard is never tripped.
 *
 * Returns "" when no resume knob is present ⇒ byte-identical to the fresh path.
 * The materializer is fail-closed (no eligible cassette ⇒ emits nothing ⇒ fresh
 * run), and `eval "$(…)"` of empty output is a no-op.
 */
const buildResumePrelaunchStep = (forwardedBenchEnv: string): string => {
  if (!forwardedBenchEnv.includes("QUANTA_BENCH_RESUME=")) return ""
  // The resume knobs are already inline-assigned to THIS command; export them so
  // the prelaunch subprocess (which reads process.env) sees them, then eval its
  // `export …` lines to set QUANTA_BENCH_REPLAY_TRAJECTORY for the bench run.
  return (
    `export ${forwardedBenchEnv.trim()}; ` +
    `eval "$(~/.bun/bin/bun run src/apps/bench/resume/resume-launch.ts)"; `
  )
}

/** The literal command the box runs for one chunk. PURE string builder — exported
 *  so the T4 stop-rule + wiring tests can assert the family-derived tokens
 *  (prebuilt-image namespace, on-box env prefix) without provisioning a box. */
export const buildBenchCommand = (params: GradeChunkParams, paths: ChunkPaths): string => {
  // aug-22 HIGH-4: BOTH family-conditional pieces of this command — the
  // prebuilt-image namespace and the on-box env prefix — now come from the ONE
  // family profile. This module used to call `buildProEnv(family, …)` and
  // `resolveSwebenchNamespace(…, family)`, each re-deciding what "pro"/"live"
  // mean, which is why a hypothetical family #4 had to edit box-session too.
  const profile = resolveDatasetFamilyProfile(params.datasetFamily)
  const idsFlag =
    params.instanceIds && params.instanceIds.length > 0
      ? ` --instance ${shq(params.instanceIds.join(","))}`
      : ""
  const trajectoryRecordEnv = params.recordTrajectory
    ? `QUANTA_BENCH_RECORD_TRAJECTORY="${paths.trajectory}" `
    : ""
  const resumePrelaunch = buildResumePrelaunchStep(params.forwardedBenchEnv)
  // Pro (RFC jun-29): point the Scale verifier at the on-box harness clone + its venv python +
  // the shipped dataset (which doubles as the Scale --raw_sample_path), and forward the operator's
  // DockerHub-username / model-name overrides. Empty for Verified/Live ⇒ byte-identical. The
  // verifier reads these (buildProGradeVerifier).
  // HIGH-1 (aug-22): keyed on the chunk's TYPED family, not on the LAUNCHING
  // process's ambient env — `process.env` here supplies only the operator's
  // per-family OVERRIDE knobs, never the family itself.
  const onBoxEnvPrefix = profile.onBoxEnvPrefix({
    datasetPath: paths.dataset,
    env: process.env,
  })
  return (
    // FORK-STORM GUARD (jun-28): on some repos (measured: pydata/xarray) the
    // model's repo commands run via `uv run` leaked ~4700 live `uv` processes
    // during patch-gen — ~6MB anon each ⇒ ~30GB AnonPages ⇒ kernel OOM-killed the
    // box (exit 137, no verdict). Cap the bench user's process count so a runaway
    // spawn fails its own fork (EAGAIN) instead of taking down the host: normal
    // runs sit in the low hundreds, so 2048 leaves wide headroom while bounding
    // peak well under box RAM. Soft limit, `|| true` so a lower box hard-limit
    // never aborts launch. Docker grading runs as root (separate uid) — unaffected.
    `set -o pipefail; ulimit -S -u 2048 2>/dev/null || true; cd ~/quanta && export PATH="$HOME/.local/bin:$PATH"; ` +
    resumePrelaunch +
    `QUANTA_BENCH_PRESET=${shq(params.preset)} QUANTA_PROVIDER=chatgpt-oauth ` +
    // PMX-04 — INLINE grading is for families that grade during patch-gen. A
    // family declaring `boxGrade` grades from a SECOND invocation inside its
    // grader window, and this pass must run with the answer key ABSENT, so the
    // shim is deliberately not enabled here. Its report then records every
    // instance as an explicit "requires the official Python harness — REFUSING
    // to fake-grade" infra error, which is why such a family also supplies
    // `parseBoxGradeVerdicts` and the chunk reads its verdicts elsewhere.
    (profile.boxGrade === undefined ? "QUANTA_SWEBENCH_PYTHON=1 " : "") +
    `QUANTA_PREFS_HOME="$HOME/.quanta" ` +
    `QUANTA_SWEBENCH_PYTHON_BIN="$HOME/swebench-python" ` +
    // Live publishes prebuilt images under `starryzhang`, not `swebench` — derive the
    // namespace from the dataset (parallel to the grading-shim pip-spec). A forwarded
    // QUANTA_SWEBENCH_NAMESPACE (operator override) still comes after and last-wins.
    `QUANTA_SWEBENCH_NAMESPACE=${shq(profile.harnessSpec({ datasetName: process.env.QUANTA_SWEBENCH_DATASET_NAME ?? "" }).namespace)} QUANTA_SWEBENCH_MAX_WORKERS=4 QUANTA_BENCH_CONCURRENCY=${params.concurrency} ` +
    onBoxEnvPrefix +
    params.forwardedBenchEnv +
    trajectoryRecordEnv +
    `~/.bun/bin/bun run src/apps/bench/cli.ts run --swebench ${paths.dataset}${idsFlag} ` +
    `--observe-dir ${paths.observeDir} ` +
    `--model ${shq(params.model)} --predictions ${paths.preds} --report ${paths.report}`
  )
}

/**
 * Fail closed on stale box-side artifacts. Single full-remote runs still use the
 * historical fixed `~/preds.jsonl` / `~/report.json` / `~/run.log` paths; if a
 * previous box image or prior failed run left those behind, blindly fetching
 * them after a crash can mis-attribute stale/gold data as the current run's
 * outputs. Scrub every derived artifact path BEFORE launch so an empty/crashed
 * run fetches nothing instead of contaminated leftovers.
 *
 * WHICH paths — including `paths.dataset`, whose omission was the aug-22 A-B
 * leak — is decided by `chunk-scrub.ts`'s exhaustive classification, not by a
 * list maintained here. This function is now transport only.
 *
 * Exported so the drift-guard hellgate can drive the REAL scrub with a recording
 * ssh rather than re-deriving the command it expects.
 */
export const scrubChunkArtifacts = async (args: {
  ssh: BoxSession["ssh"]
  paths: ChunkPaths
  recordTrajectory: boolean
}): Promise<void> => {
  const cleared = await args.ssh(buildChunkScrubCommand(args.paths, args.recordTrajectory))
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
  // Live OTEL: stream this run's spans to the operator's trace UI for the run's
  // duration (no-op unless QUANTA_OTEL_ENDPOINT points at localhost). Closed in
  // .finally so a thrown poll / box-death still reaps the tunnel child.
  const otelTunnel = openOtelReverseTunnel(
    args.keyPath,
    args.host,
    args.params.otelEndpoint ?? "",
    args.log,
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
    // No-progress (wedged-box) abort budget — pure pass-through. Resolved from env
    // at the ALLOWLISTED composition root (full.ts) and threaded via params, so
    // this mid-tree orchestrator stays env-free (no-process-env-outside-config).
    ...(args.params.noProgressBudgetMs !== undefined
      ? { noProgressBudgetMs: args.params.noProgressBudgetMs }
      : {}),
  }).finally(() => {
    otelTunnel.close()
  })
  return remoteRun.code
}

const fetchRemoteFile = async (ssh: BoxSession["ssh"], remotePath: string): Promise<SpawnResult> =>
  await ssh(`cat ${remotePath} 2>/dev/null`)

const fetchRemoteCommand = async (ssh: BoxSession["ssh"], command: string): Promise<SpawnResult> =>
  await ssh(command)

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

/**
 * Fetch the box's PER-INSTANCE trajectory cassettes (one FILE per instance run,
 * SWE-agent shape) + their `.meta.json` sidecars, and extract them into a
 * per-box subdir under the local full-remote artifact dir:
 *   `<artifactDir>/trajectories/<suffix>/<ts>-<instanceId>.jsonl`
 *
 * One `tar | base64` round-trip (mirrors the observe archive), then a local
 * `base64 -d | tar -x`. Best-effort: any failure (no dir, empty run, no local
 * tar) logs nothing fatal and leaves the run untouched. The per-box subdir keeps
 * two boxes that re-ran the same instance from colliding, and the viewer's
 * folder scan turns each extracted file into one session.
 */
const fetchTrajectoryFiles = async (args: {
  ssh: BoxSession["ssh"]
  paths: ChunkPaths
  artifactSuffix: string
  log: (msg: string) => void
}): Promise<void> => {
  const trajDir = trajectoriesDirFor(args.paths)
  const b64Path = join(fullRemoteArtifactDir(), `trajectories-${args.artifactSuffix}.tar.b64`)
  const saved = await fetchOptionalCommandArtifact({
    ssh: args.ssh,
    // Only the .jsonl cassettes + .meta.json sidecars; skip if the dir is absent
    // or empty so `fetchOptionalCommandArtifact` treats it as "nothing to fetch".
    command: `if [ -d ${trajDir} ] && [ -n "$(ls -A ${trajDir} 2>/dev/null)" ]; then tar -C ${trajDir} -cf - . | base64 -w0; fi`,
    localPath: b64Path,
    log: args.log,
    label: "[full-remote] trajectory cassettes archived",
  })
  if (saved === undefined) return
  // Extract locally into a per-box subdir. Best-effort: never let a missing
  // local `tar`/`base64` or a corrupt archive crash the post-run fetch.
  try {
    const dest = join(fullRemoteArtifactDir(), "trajectories", args.artifactSuffix)
    mkdirSync(dest, { recursive: true })
    execFileSync("bash", ["-c", `base64 -d < ${shq(b64Path)} | tar -x -C ${shq(dest)}`], {
      stdio: "ignore",
    })
    // Extract succeeded ⇒ the per-instance .jsonl files are the artifact; drop the
    // now-redundant archive. (On failure we keep it as the fallback.)
    rmSync(b64Path, { force: true })
    args.log(`[full-remote] trajectory cassettes extracted: ${dest}`)
  } catch {
    // leave the .tar.b64 in place as the fallback artifact
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
    await fetchTrajectoryFiles({
      ssh: args.ssh,
      paths: args.paths,
      artifactSuffix: args.artifactSuffix,
      log: args.log,
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
  // 🔴 SCRUB FIRST, THEN UPLOAD (aug-22 A-B). The scrub now clears
  // `paths.dataset` too — the previous chunk's corpus, which for ProMax carries
  // `patch` / `test_patch` in every row — and it therefore MUST run before this
  // chunk's dataset is placed. In the old order (upload, then scrub) adding the
  // dataset to the scrub list would have deleted the file the run was about to
  // grade, which is why the omission survived: it could not be fixed in place.
  await scrubChunkArtifacts({
    ssh,
    paths: args.paths,
    recordTrajectory: args.params.recordTrajectory,
  })
  await uploadChunkDataset({
    spawn,
    keyPath,
    datasetPath: args.params.datasetPath,
    host,
    targetPath: args.paths.dataset,
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
  // PMX-04 — THE SECOND INVOCATION. A family that declares `boxGrade` has just
  // finished PATCH-GEN ONLY, with the answer key absent. Grading happens now,
  // inside the grader window, and the teardown bound to the same executor call
  // removes the key afterwards — including when the grade throws.
  const boxGradeText = await runFamilyBoxGrade({
    ssh,
    log,
    family: args.params.datasetFamily,
    bootstrap: args.params.remoteBootstrap,
    paths: args.paths,
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
  // Verdicts come from the family's OWN grade artifact when it has one; the
  // bench report of a patch-gen-only pass is all-infra by construction.
  const parsed: GradeChunkVerdicts =
    boxGradeText === undefined
      ? parseVerdicts(fetched.reportText)
      : // The family reports official STATES; `verdict-buckets` owns how those
        // land in the four legacy arrays. This module still classifies nothing.
        bucketsFromGradedInstances(
          parseFamilyBoxGradeVerdicts(args.params.datasetFamily, boxGradeText),
        )
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
  assertDatasetGradeableForFamily,
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
