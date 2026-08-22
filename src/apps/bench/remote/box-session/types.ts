/**
 * Shared type surface + constants for the box-session cluster. Extracted from the
 * (god-sized) `box-session.ts` so each sibling concern (dataset preflight, auth,
 * snapshot, lifecycle, grade) imports ONE canonical set of interfaces instead of
 * re-deriving them. PURE types + plain constants — no IO, no behavior.
 */

import type {
  OfficialGradeReceipt,
  OfficialGradeReceiptFailure,
} from "@/runner/batch/eval/official-grade"
import type { LspGroundingStatus } from "@/shared"
import type { DatasetFamily } from "../../dataset-family-token"
import { CURRENT_BENCH_BASE_PRESET } from "../../preset"
import type { FamilyRemoteBootstrap } from "../../profiles/types"
import type { SpawnFn, SpawnResult } from "../backend"
import type { BootstrapTracer, BootstrapTracerOpts } from "../bootstrap-tracer"

export interface FullRemoteConfig {
  /** Local quanta repo to rsync to the box (excludes node_modules/.git). */
  readonly repoDir: string
  /** RAW chatgpt.json content (the caller reads it; we strip it here). */
  readonly authJson: string
  /** Local swebench instances.jsonl. */
  readonly datasetPath: string
  /** Subset to run (default: all rows in the dataset). */
  readonly instanceIds?: readonly string[]
  /** Bench preset. Default current base profile. */
  readonly preset?: string
  /** Model id (predictions/report naming). Default `gpt-5.4`. */
  readonly model?: string
  /** Launch-time metadata tag so operators can distinguish pool/full/warm boxes
   *  even before the box-side runtime snapshot exists. */
  readonly launchMode?: "full-remote" | "pool" | "warm-box"
  readonly dryRun?: boolean
  readonly spawn?: SpawnFn
  /** Progress sink — called at each stage so a long run isn't a silent black box. */
  readonly onLog?: (msg: string) => void
  /** Injectable sleep (test seam — default real setTimeout). */
  readonly sleep?: (ms: number) => Promise<void>
  /** Max cloud-init readiness polls (test seam — default 30 × 10s ≈ 5min). */
  readonly maxReadyPolls?: number
  /** OTLP sink for live BOOTSTRAP-phase spans (jun-27 #4). Resolved from
   *  `QUANTA_OTEL_ENDPOINT` at the allowlisted composition root and threaded so
   *  provisionBox emits a span per bootstrap phase WITHOUT reading env. Non-http
   *  / unset ⇒ no bootstrap spans (byte-identical). */
  readonly otelEndpoint?: string
  /** Test seam — bootstrap-tracer factory (default {@link createBootstrapTracer}).
   *  The wiring hellgate injects a recording tracer to prove provisionBox wraps
   *  each phase. */
  readonly makeBootstrapTracer?: (opts: BootstrapTracerOpts) => BootstrapTracer
  readonly region?: string
  readonly ami?: string
  readonly instanceType?: string
  readonly keyName?: string
  readonly keyPath?: string
  readonly subnetId?: string
  readonly vpcId?: string
  readonly sgName?: string
  readonly diskGb?: number
  readonly ttlMinutes?: number
  readonly keep?: boolean
  /** Launch ON-DEMAND instead of spot. Spot is ~3× cheaper but AWS reclaims it
   *  on capacity pressure — observed in ap-northeast-2 reclaiming c7i boxes in
   *  4–17 min, killing runs faster than relaunch can recover. On-demand has no
   *  reclaim. Default false (spot). */
  readonly onDemand?: boolean
  /** SWE-bench dataset name forwarded to the box (drives pip-spec + namespace selection). */
  readonly swebenchDatasetName?: string
  /** Explicit pip-spec override for the swebench grading shim on the box. */
  readonly swebenchPipSpec?: string
  /** TYPED SWE-bench dataset family forwarded to the box. Typed (not `string`)
   *  as of aug-22 HIGH-1: the launching side threads the resolved
   *  `BenchRunConfig.datasetFamily` here instead of letting each consumer
   *  re-derive it from ambient env. */
  readonly swebenchDatasetFamily?: DatasetFamily
  /**
   * PMX-04 — the family's DECLARED remote bootstrap specification, RESOLVED at
   * the launch composition root (which owns the typed `BenchRunConfig`) and
   * carried onto the box config.
   *
   * It is carried rather than re-derived here on purpose: `remote/**` owns
   * provisioning and transport and must not rediscover family behaviour, and
   * resolving it at the root is what lets `ec2-lifecycle.ts` execute a family's
   * bootstrap without ever naming a family. `undefined` (verified/live/pro) ⇒
   * not one extra ssh round trip.
   */
  readonly remoteBootstrap?: FamilyRemoteBootstrap
  /** Fail-closed single-box guard: if another quanta-bench box is already
   *  running, callers must opt in before launching a fresh one. */
  readonly allowExtraBoxes?: boolean
  /** Override the local single-box owner guard dir (test seam). */
  readonly singleBoxGuardDir?: string
  /** Override the cross-process patch-gen budget lease dir (test seam). */
  readonly tokenBudgetDir?: string
  /** Max wait for the global patch-gen budget lease. */
  readonly tokenBudgetWaitMs?: number
  /** Poll cadence while waiting for the global patch-gen budget lease. */
  readonly tokenBudgetPollMs?: number
}

export const D = {
  region: "ap-northeast-2",
  // Resolve Canonical's current Ubuntu 22.04 amd64 image at launch. The previous
  // private prebaked AMI was deleted and made every smoke fail at RunInstances.
  // An explicit cfg.ami / QUANTA_FULL_REMOTE_AMI still wins for prebaked boxes.
  ami: "ssm:/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id",
  // jun-27: 4xlarge (16 vCPU/32GB) default — patch-gen is LLM-API-bound (cores idle
  // on the wire) and grading is serial (max_workers≈6), so the 8xlarge's 32 vCPU were
  // paid-for idle. ~$0.24/hr spot vs ~$0.5/hr. Bump back via the env override for
  // high patch-gen concurrency.
  instanceType: process.env.QUANTA_FULL_REMOTE_INSTANCE_TYPE || "c7i.4xlarge",
  keyName: "pickinstead_korea.pem",
  keyPath: "~/Downloads/pickinstead_korea.pem",
  subnetId: "subnet-9c13f1e7",
  vpcId: "vpc-4340a92a",
  sgName: "quanta-bench-sg",
  diskGb: 600,
  ttlMinutes: 180,
  preset: CURRENT_BENCH_BASE_PRESET,
  model: "gpt-5.4",
} as const

export interface FullRemoteResult {
  readonly reportPath?: string
  readonly resolved?: readonly string[]
  readonly unresolved?: readonly string[]
  readonly errored?: readonly string[]
  readonly emptyPatch?: readonly string[]
  readonly dryRun?: boolean
  readonly plan?: readonly string[]
  /**
   * PMX-03/04 — the OFFICIAL-GRADE RECEIPT this chunk's grader produced, when the
   * family's remote lane declares one.
   *
   * It is the ONLY verdict payload the remote lane may carry for such a family:
   * the four legacy id arrays above cannot express `ambiguous` (the grader
   * declined) or `missing` (never graded), so a family that grades through an
   * official out-of-process grader would lose those rows the moment they were
   * projected. Absent for verified/live/pro ⇒ the four arrays keep their
   * historical meaning and every one of those lanes is byte-identical.
   */
  readonly officialGrade?: OfficialGradeReceipt
  /**
   * PMX-03/04 — why the pieces of this chunk's grade could NOT be merged into
   * one receipt. Mutually exclusive with {@link officialGrade}.
   *
   * A refused merge and a dead box both leave `officialGrade` absent, and the
   * two are opposite operator problems: one means "nothing came back", the other
   * means "two graders disagreed / an instance was graded twice". Carrying the
   * typed codes is what makes them distinguishable downstream instead of both
   * reading as an empty chunk.
   */
  readonly officialGradeFailures?: readonly OfficialGradeReceiptFailure[]
  /** The box run hit the shared OAuth rate limit (a `generation_error` / 429 was
   *  observed in the run log). A pool uses this to BACK OFF before the next chunk
   *  instead of hammering the throttled login. Absent ⇒ not detected. */
  readonly rateLimited?: boolean
}

/**
 * A live, bootstrapped EC2 box. The connection primitives (`ssh`, `aws`, raw
 * `spawn`) are bound to the resolved host/region/key so a caller never re-derives
 * them. `terminate` is a fail-closed cleanup boundary for launched boxes:
 * callers must see a failed AWS terminate instead of silently assuming the box
 * was cleaned up. Created ONLY by {@link provisionBox}.
 */
export interface BoxSession {
  readonly iid: string
  readonly ip: string
  readonly host: string
  readonly keyPath: string
  readonly region: string
  readonly spawn: SpawnFn
  readonly log: (msg: string) => void
  /** ssh to this box. Token/stdin goes over `input` (never an argv). `onData`
   *  streams stdout live. */
  ssh(remoteCmd: string, input?: string, onData?: (chunk: string) => void): Promise<SpawnResult>
  aws(args: readonly string[]): Promise<SpawnResult>
  /** Terminate the box (no-op when `keep` or attach). Throws when launched-box
   *  cleanup fails. */
  terminate(): Promise<void>
}

/** Box-side paths for one grading chunk. Defaults reproduce the historical fixed
 *  paths (so a single full-remote run is byte-identical); a pool overrides them
 *  with runId-scoped paths so concurrent/sequential chunks never collide on the
 *  shared `~/report.json` / `~/instances.jsonl`. */
export interface ChunkPaths {
  readonly dataset: string
  readonly preds: string
  readonly report: string
  readonly runLog: string
  readonly observeDir: string
  readonly trajectory: string
}

// NOTE on `~` vs `$HOME`: every path below is interpolated UNQUOTED into the
// remote command (cat/tee/--flag), where tilde-expansion works — EXCEPT
// `trajectory`, which is also placed inside DOUBLE QUOTES in the record env
// (`QUANTA_BENCH_RECORD_TRAJECTORY="…"`), where bash does NOT expand `~`. So
// trajectory MUST use `$HOME` (which expands in both contexts). A pool building
// runId-scoped overrides must follow the same rule for its trajectory path.
export const DEFAULT_CHUNK_PATHS: ChunkPaths = {
  dataset: "~/instances.jsonl",
  preds: "~/preds.jsonl",
  report: "~/report.json",
  runLog: "~/run.log",
  observeDir: "~/observe",
  trajectory: "$HOME/quanta/bench-trajectory.jsonl",
}

/** Parameters for one patch-gen+grading chunk on an already-provisioned box. */
export interface GradeChunkParams {
  /** Local dataset file to scp up for THIS chunk. */
  readonly datasetPath: string
  /** RAW chatgpt.json — re-stripped + re-shipped per chunk (a pool refreshes the
   *  token between chunks so a long-lived run never runs on a stale access_token). */
  readonly authJson: string
  readonly instanceIds?: readonly string[]
  readonly preset: string
  readonly model: string
  readonly concurrency: number
  /** Box-side paths. Default {@link DEFAULT_CHUNK_PATHS}. */
  readonly paths?: ChunkPaths
  /** Suffix for LOCAL artifact filenames (`report-<suffix>.json`). Single run ⇒
   *  iid; pool ⇒ runId so chunks don't overwrite each other's local artifacts. */
  readonly artifactSuffix: string
  /** Whether to record + fetch the LLM-trajectory cassette (operator opt-in). */
  readonly recordTrajectory: boolean
  /** Forwarded `QUANTA_BENCH_*` env prefix (already built via
   *  {@link buildForwardedBenchEnv}). */
  readonly forwardedBenchEnv: string
  /** TYPED dataset family for THIS chunk (aug-22 HIGH-1). REQUIRED so the box
   *  command builder cannot fall back to reading the launching process's ambient
   *  `process.env.QUANTA_SWEBENCH_DATASET_FAMILY` — which is what decided the Pro
   *  on-box env prefix and the prebuilt-image namespace before, and which only
   *  held the right value because the composition root had mutated ambient env. */
  readonly datasetFamily: DatasetFamily
  /** jun-20 multi-auth (T-6): auth-pool account that leased this chunk. Surfaced
   *  in the box status snapshot for operator attribution. Omitted in single-auth. */
  readonly accountLabel?: string
  /** Test seam — injectable sleep for the detached run+poll loop (default real). */
  readonly pollSleep?: (ms: number) => Promise<void>
  /** Test seam — detached run+poll cadence (default {@link RUN_POLL_INTERVAL_MS}). */
  readonly pollIntervalMs?: number
  /** Test seam — injectable clock for the detached run+poll wall-clock ceiling. */
  readonly pollNow?: () => number
  /** Idle-abort budget (ms) for the NO-PROGRESS watchdog: a box whose run.log
   *  stops growing for this long while polls still succeed (the jun-27 wedged-box
   *  hang) is aborted to the requeue path. Resolved once from the bench env via
   *  {@link resolveNoProgressBudgetMs}; `undefined`/`Infinity` ⇒ off (default). */
  readonly noProgressBudgetMs?: number
  /** OTLP endpoint for the live OTEL reverse tunnel (operator-side). Resolved from
   *  `QUANTA_OTEL_ENDPOINT` at the allowlisted full.ts root and threaded here so
   *  box-session opens the tunnel WITHOUT reading env itself. `undefined`/non-
   *  localhost ⇒ no tunnel (byte-identical). */
  readonly otelEndpoint?: string
}

export interface BoxStatusSnapshot {
  readonly phase: "running" | "fetching" | "idle"
  readonly mode: "pool" | "full-remote"
  readonly runId?: string
  /** jun-20 multi-auth (T-6): which auth-pool account last owned this chunk, so
   *  `box ls` / postmortems can attribute a 429 to a specific account. Absent in
   *  single-auth mode. Never a token — just the operator-facing label. */
  readonly accountLabel?: string
  readonly workload: string
  readonly dataset: string
  readonly instanceCount: number
  readonly instancePreview?: readonly string[]
  readonly preset: string
  readonly model: string
  readonly concurrency: number
  readonly startedAt?: string
  readonly updatedAt: string
  readonly runLogPath?: string
  readonly reportPath?: string
  readonly predictionsPath?: string
  readonly observeDir?: string
  readonly trajectoryPath?: string
  readonly resolvedCount?: number
  readonly unresolvedCount?: number
  readonly erroredCount?: number
  readonly emptyPatchCount?: number
  readonly rateLimited?: boolean
  readonly lastExitCode?: number
  readonly lastLogLine?: string
  /** LSP-02 — typed grounding status for THIS box at grade time (launch proof
   *  of the task language server). Lets `box ls` distinguish missing_binary vs
   *  ready vs degraded WITHOUT parsing `lastLogLine`. Absent for non-grounding
   *  presets / when the probe was skipped. */
  readonly lspGrounding?: LspGroundingStatus
  /** #9: the report bytes were present but failed to parse (truncated / corrupt
   *  fetch) — distinct from a genuinely-empty box-loss. Surfaced as machine-
   *  readable telemetry (not just a log) so `box ls` / postmortems can attribute
   *  a zero-verdict chunk to a corrupt fetch rather than a real miss. */
  readonly reportUnparseable?: boolean
}

export interface BoxRuntimeProbe {
  readonly activeRunDetected: boolean
  readonly runLogPath?: string
  readonly runLogUpdatedAt?: string
  readonly reportPath?: string
  readonly reportExists?: boolean
  readonly predictionsPath?: string
  readonly predictionsLines?: number
  readonly observeDir?: string
  readonly runExitPath?: string
  readonly runExitExists?: boolean
  readonly lastLogLine?: string
}

export type BoxSnapshotState =
  | "ok"
  | "missing"
  | "write-failed"
  | "invalid"
  | "read-failed"
  | "not-ready"

export interface BoxInspection {
  readonly lifecycle: "bootstrapping" | "idle" | "busy" | "unreachable"
  readonly bootstrapped: boolean
  readonly busy: boolean
  readonly snapshotHealthy: boolean
  readonly snapshotState: BoxSnapshotState
  readonly snapshot?: BoxStatusSnapshot
  readonly probe?: BoxRuntimeProbe
}

export interface GradeChunkVerdicts {
  readonly resolved: string[]
  readonly unresolved: string[]
  readonly errored: string[]
  readonly emptyPatch: string[]
}

/** #9: distinguish a GENUINELY-ABSENT report (`empty`) from a report that WAS
 *  written but arrived truncated/half-flushed/corrupt (`unparseable`). The
 *  pre-fix code collapsed both into `emptyVerdicts()`, so a successful grade
 *  whose report suffered a transport/flush glitch was silently reclassified as a
 *  box-loss (and re-graded on a fresh box, wasting it — or eventually marked
 *  lost despite grading having succeeded). The caller treats `unparseable`
 *  loudly + (a fetch-retry, not a whole-grade discard). */
export type ReportTextStatus = "empty" | "unparseable" | "ok"

/** Box-side directory used as an ATOMIC grade lock (`mkdir` is atomic + fails if
 *  it exists). Held for the duration of one chunk's grade so a reused box can
 *  never run two grades at once. */
export const GRADE_LOCK_DIR = "~/.pool-grade.lock"
export const BOX_STATUS_PATH = "~/.quanta/bench-box-status.json"
export const BOX_STATUS_TMP_PATH = "~/.quanta/bench-box-status.json.tmp"

/** Thrown by {@link gradeChunkOnBox} when the box is already grading (lock held).
 *  The pool drops the box WITHOUT terminating it (it belongs to the other run). */
export const POOL_BUSY_ERROR = "POOL_BOX_BUSY"
export const GRADE_LOCK_RELEASE_ERROR = "GRADE_LOCK_RELEASE_FAILED"
/** Stable marker the detached run+poll loop stamps into a {@link BoxDiedDuringRunError}
 *  so the pool can route it to the dead-box REQUEUE path even when a SECONDARY
 *  grade-lock-release failure (the dead box's ssh also 255s) gets wrapped around
 *  it — otherwise the lock-release substring would mis-route a real box death to
 *  the abort branch. */
export const BOX_DIED_DURING_RUN_ERROR = "BOX_DIED_DURING_RUN"
