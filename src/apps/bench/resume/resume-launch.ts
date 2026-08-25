/**
 * Bench-resume READ / LAUNCH path.
 *
 * When a box is LOST (spot reclaim / crash) and an ELIGIBLE cassette exists in
 * S3, the relaunched instance must REPLAY the recorded turns and then diverge
 * LIVE. This module is the single seam that turns a durable resume key into the
 * concrete inputs the bench replay engine consumes:
 *
 *   - {@link prepareResume} — runs on EITHER the worker (to decide) OR the box
 *     itself (to materialize): reads the receipt through the fail-CLOSED
 *     {@link isResumeEligible} gate, and ONLY for an eligible, non-degraded
 *     cassette `concat()`s the segment log into a LOCAL jsonl + returns the
 *     replay env (`QUANTA_BENCH_REPLAY_TRAJECTORY` + on-miss
 *     `record-and-passthrough`). A broken/absent/degraded cassette ⇒ undefined
 *     ⇒ a FRESH run, NEVER a half-replay.
 *   - {@link resumeReplayBoxEnv} — the worker → box env knobs: the box DOWNLOADS
 *     its OWN cassette from S3 (it already has aws creds + the resume env), so
 *     the worker forwards the resume KNOBS (bucket/campaign/instance + on-miss)
 *     rather than a local file path. This dodges the box-session local-replay
 *     guard cleanly: no `QUANTA_BENCH_REPLAY_TRAJECTORY` is ever forwarded — the
 *     box-side {@link prepareResume} sets it locally after the download.
 *
 * EVERYTHING here is behind `resumeActive` (DEFAULT-OFF): `prepareResume`
 * returns undefined the instant the gate is off, and `resumeReplayBoxEnv`
 * returns `{}` for a no-resume launch — so the live campaign is byte-identical.
 *
 * `import.meta.main`: when this file is RUN directly on the box
 * (`bun run resume-launch.ts`), it executes the box-side materialization and
 * prints `export KEY=value` lines for the bench run-script to `source` — this is
 * how the recorded cassette becomes the box's `QUANTA_BENCH_REPLAY_TRAJECTORY`
 * without forwarding any local file.
 */
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { errMessage } from "@/shared"
import { isResumeEligible, sameResumeSecurity } from "@/shared/remote-store"
import { resolveResumeConfig, resumeActive } from "./config"
import { resumeKey } from "./identity"
import { type ResumeStore, resumeStore } from "./store"

/** The replay env the box's bench run consumes (from `apps/bench/trajectory.ts`):
 *  replay the cassette, then diverge LIVE on the first miss. */
export interface ResumeReplayEnv {
  QUANTA_BENCH_REPLAY_TRAJECTORY: string
  QUANTA_BENCH_REPLAY_ON_MISS: "record-and-passthrough"
}

export interface PreparedResume {
  /** Local jsonl the recorded segments were concatenated into. */
  readonly localCassettePath: string
  /** Env to set on the bench run so it replays then diverges live. */
  readonly replayEnv: ResumeReplayEnv
}

export interface PrepareResumeOpts {
  /** Diagnostic sink (default console.error) — explains WHY a resume was skipped. */
  readonly log?: (msg: string) => void
  /** Test seam: override the durable store factory (default = real S3 store). */
  readonly makeStore?: (
    cfg: {
      bucket: string
      region?: string
      kmsKeyArn: string
      principalArn: string
      maxRetentionDays: number
    },
    key: string,
  ) => ResumeStore
  /** Test seam: directory the materialized cassette is written under. */
  readonly workDir?: string
}

/**
 * Decide + materialize a resume for one instance. Returns undefined (⇒ FRESH
 * run) when resume is OFF, the cassette is not eligible, or ANY read/concat
 * error occurs — fail-CLOSED so a broken cassette can never become a partial
 * replay. Otherwise concatenates the durable segment log into a local jsonl and
 * returns it + the replay env.
 */
export const prepareResume = async (
  env: Record<string, string | undefined>,
  instanceId: string,
  opts: PrepareResumeOpts = {},
): Promise<PreparedResume | undefined> => {
  const log = opts.log ?? ((_m: string) => {})
  const cfg = resolveResumeConfig(env)
  // DEFAULT-OFF byte-identical guard: nothing — no store, no S3 — when inactive.
  if (!resumeActive(cfg)) return undefined

  const key = resumeKey({ campaignId: cfg.campaignId, instanceId })
  try {
    const store = (opts.makeStore ?? defaultMakeStore)(
      {
        bucket: cfg.bucket,
        kmsKeyArn: cfg.kmsKeyArn,
        principalArn: cfg.principalArn,
        maxRetentionDays: cfg.maxRetentionDays,
        ...(cfg.region !== undefined ? { region: cfg.region } : {}),
      },
      key,
    )
    const currentSecurity = await store.securityReceipt()
    if (currentSecurity === undefined) throw new Error("resume security attestation missing")
    const receipt = await store.readReceipt()
    // FAIL-CLOSED gate: absent / degraded / malformed ⇒ NOT eligible ⇒ fresh.
    if (!isResumeEligible(receipt) || !sameResumeSecurity(receipt?.security, currentSecurity)) {
      log(
        `[resume] ${key}: no eligible cassette (${receipt === undefined ? "receipt absent" : receipt.degraded ? "receipt degraded" : "receipt malformed"}) — fresh run`,
      )
      return undefined
    }
    // Concatenate the durable segment log. `concat()` itself fails LOUDLY on a
    // listed-but-unreadable segment (corruption) — caught below ⇒ fresh run.
    const cassette = await store.segments.concat()
    const dir = opts.workDir ?? mkdtempSync(join(tmpdir(), "bench-resume-"))
    const localCassettePath = join(dir, `${sanitizeFile(key)}.jsonl`)
    writeFileSync(localCassettePath, cassette)
    log(`[resume] ${key}: replaying ${cassette.length}B recorded cassette → ${localCassettePath}`)
    return {
      localCassettePath,
      replayEnv: {
        QUANTA_BENCH_REPLAY_TRAJECTORY: localCassettePath,
        QUANTA_BENCH_REPLAY_ON_MISS: "record-and-passthrough",
      },
    }
  } catch (err) {
    // ANY S3 read / concat error ⇒ fresh run (NEVER a half-replay). Log the cause.
    log(`[resume] ${key}: read/concat failed (${errMessage(err)}) — fresh run`)
    return undefined
  }
}

const defaultMakeStore = (
  cfg: {
    bucket: string
    region?: string
    kmsKeyArn: string
    principalArn: string
    maxRetentionDays: number
  },
  key: string,
): ResumeStore =>
  resumeStore(
    {
      bucket: cfg.bucket,
      security: {
        kmsKeyArn: cfg.kmsKeyArn,
        principalArn: cfg.principalArn,
        maxRetentionDays: cfg.maxRetentionDays,
      },
      ...(cfg.region !== undefined ? { region: cfg.region } : {}),
    },
    key,
  )

/** Collapse a resume key into a single filesystem-safe basename component. */
const sanitizeFile = (key: string): string => key.replace(/[^A-Za-z0-9._-]+/g, "_")

/**
 * The worker → box env knobs for a resume relaunch. The box DOWNLOADS its own
 * cassette from S3 (it has aws creds + this env), so we forward the resume
 * KNOBS — NOT a local file path — and let the box-side {@link prepareResume} set
 * `QUANTA_BENCH_REPLAY_TRAJECTORY` locally after the download. `record-and-
 * passthrough` rides along so the box diverges live after the recorded turns.
 *
 * `undefined` (no resume) ⇒ `{}` so the fresh requeue path is byte-identical.
 */
export const resumeReplayBoxEnv = (
  resume:
    | {
        campaignId: string
        instanceId: string
        bucket: string
        kmsKeyArn: string
        principalArn: string
        maxRetentionDays: number
        region?: string
      }
    | undefined,
): Record<string, string> => {
  if (resume === undefined) return {}
  return {
    QUANTA_BENCH_RESUME: "on",
    QUANTA_BENCH_RESUME_S3_BUCKET: resume.bucket,
    QUANTA_BENCH_CAMPAIGN_ID: resume.campaignId,
    QUANTA_BENCH_INSTANCE_ID: resume.instanceId,
    QUANTA_BENCH_RESUME_KMS_KEY_ARN: resume.kmsKeyArn,
    QUANTA_BENCH_RESUME_PRINCIPAL_ARN: resume.principalArn,
    QUANTA_BENCH_RESUME_MAX_RETENTION_DAYS: String(resume.maxRetentionDays),
    QUANTA_BENCH_REPLAY_ON_MISS: "record-and-passthrough",
    ...(resume.region !== undefined ? { AWS_REGION: resume.region } : {}),
  }
}

/**
 * BOX-SIDE entrypoint (`bun run resume-launch.ts`): materialize this box's
 * cassette from S3 and EMIT `export KEY=value` lines so the bench run-script can
 * `source` them — turning the downloaded cassette into the box's
 * `QUANTA_BENCH_REPLAY_TRAJECTORY` without any local-file forwarding. Prints
 * NOTHING (and exits 0) when resume is OFF or the cassette is not eligible, so
 * the box simply runs FRESH — byte-identical to a non-resume launch.
 */
const runBoxResumePrelaunch = async (): Promise<void> => {
  const instanceId = process.env.QUANTA_BENCH_INSTANCE_ID
  if (instanceId === undefined || instanceId === "") return
  const prepared = await prepareResume(process.env, instanceId)
  if (prepared === undefined) return
  // Single-quote the value so a path with shell metachars is inert when sourced.
  const q = (v: string): string => `'${v.replace(/'/g, "'\\''")}'`
  process.stdout.write(
    [
      `export QUANTA_BENCH_REPLAY_TRAJECTORY=${q(prepared.replayEnv.QUANTA_BENCH_REPLAY_TRAJECTORY)}`,
      `export QUANTA_BENCH_REPLAY_ON_MISS=${q(prepared.replayEnv.QUANTA_BENCH_REPLAY_ON_MISS)}`,
      "",
    ].join("\n"),
  )
}

if (import.meta.main) {
  runBoxResumePrelaunch().catch((e) => {
    process.stderr.write(`[resume-launch] prelaunch failed: ${errMessage(e)}\n`)
    process.exit(1)
  })
}
