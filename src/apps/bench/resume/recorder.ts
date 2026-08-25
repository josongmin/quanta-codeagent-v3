/**
 * Bench-resume WRITE path — tee the per-turn LLM recording to a DURABLE S3
 * segment log alongside the unchanged local trajectory, and maintain a
 * fail-CLOSED resume receipt.
 *
 * WHY: a full-remote bench box can lose its spot instance mid-run. If the box's
 * per-turn cassette is durably mirrored to S3 AND a receipt says "every segment
 * up to seq N landed, not degraded", a fresh box can REPLAY the recorded
 * trajectory and resume the instance instead of re-running it from zero.
 *
 * DEFAULT-OFF + byte-identical: {@link maybeTeeResumeRecording} returns the
 * inner `llm` UNCHANGED unless `resumeActive` (gate ON + bucket configured) AND
 * `QUANTA_BENCH_INSTANCE_ID` is present. The live bench campaign — which sets
 * neither — is unaffected.
 *
 * FAIL-CLOSED durability: the S3 mirror is BEST-EFFORT — a swallowed PUT failure
 * must NEVER kill a live run ({@link teeReplayStore} swallows secondary errors).
 * But resume ELIGIBILITY is STRICT: the first secondary error flips the receipt
 * to `degraded:true` (and {@link import("@/shared/remote-store").isResumeEligible}
 * then refuses it). Reads (`match`/`load`/`reset`) go to the PRIMARY (local)
 * store only — the durable mirror is write-only on this path.
 */

import { join } from "node:path"
import type { LLMPort } from "@/llm"
import {
  jsonlReplayStore,
  type RecordedInteraction,
  type ReplayMatchOpts,
  type ReplayStore,
  recordingLlmPort,
} from "@/llm/replay"
import type { StreamInput } from "@/llm/types"
import { benchHome, benchRunId } from "@/runner/batch/corpus/paths"
import { errMessage, logger } from "@/shared"
import type { ResumeReceipt, ResumeSecurityReceipt } from "@/shared/remote-store"
import { resumeHashRequest } from "./canonicalize"
import { resolveResumeConfig, resumeActive } from "./config"
import { resumeKey } from "./identity"
import { resumeStore } from "./store"

/**
 * Fan-out `ReplayStore`: `append` writes the PRIMARY (awaited, authoritative)
 * then the SECONDARY (best-effort durability). A secondary THROW is reported via
 * `onSecondaryError` and SWALLOWED — never rethrown — so a flaky S3 PUT can
 * never flip an already-successful live turn into a surfaced failure. A primary
 * throw PROPAGATES (the local cassette is authoritative). `match`/`load`/`reset`
 * delegate to the PRIMARY only; `save` writes primary then best-effort secondary.
 */
export const teeReplayStore = (
  primary: ReplayStore,
  secondary: ReplayStore,
  onSecondaryError: (e: unknown) => void,
): ReplayStore => ({
  async append(record: RecordedInteraction): Promise<void> {
    await primary.append(record)
    try {
      await secondary.append(record)
    } catch (e) {
      onSecondaryError(e)
    }
  },
  match(request: StreamInput, opts?: ReplayMatchOpts): Promise<RecordedInteraction | null> {
    return primary.match(request, opts)
  },
  load(): Promise<ReadonlyArray<RecordedInteraction>> {
    return primary.load()
  },
  async save(records: ReadonlyArray<RecordedInteraction>): Promise<void> {
    await primary.save(records)
    try {
      await secondary.save(records)
    } catch (e) {
      onSecondaryError(e)
    }
  },
  reset(): void {
    primary.reset()
  },
})

export interface TeeResumeReplayStoreOpts {
  /** Authoritative local cassette (the unchanged bench trajectory). */
  readonly primary: ReplayStore
  /** Durable S3 mirror (best-effort). */
  readonly secondary: ReplayStore
  readonly key: string
  readonly campaignId: string
  readonly instanceId: string
  /** Persist a receipt (bound to a backend+key by the caller). */
  writeReceipt(r: ResumeReceipt): Promise<void>
  /** Cached live AWS policy/KMS/lifecycle attestation from the gated backend. */
  securityReceipt?(): Promise<ResumeSecurityReceipt>
  /** Existing durable zero-based segment count when reopening a resume key. */
  initialCount?(): Promise<number>
}

/**
 * The resume WRITE store: a {@link teeReplayStore} that ALSO maintains the
 * fail-closed receipt.
 *
 * - On every HEALTHY append, write a receipt `{latestSeq:<count>, degraded:false}`.
 * - On the FIRST secondary/security error, persist a degraded receipt and never
 *   write a healthy receipt again. A failed degraded-receipt PUT is retried on
 *   later appends until it lands, preventing an older healthy receipt from
 *   remaining the durable authority indefinitely.
 * - A receipt-write failure is itself best-effort — it must never kill the run.
 */
export const teeResumeReplayStore = (opts: TeeResumeReplayStoreOpts): ReplayStore => {
  let degraded = false
  let degradedReceiptPersisted = false
  let count = 0
  let countInitialized = opts.initialCount === undefined

  const safeWriteReceipt = async (receipt: ResumeReceipt): Promise<boolean> => {
    try {
      await opts.writeReceipt(receipt)
      return true
    } catch (e) {
      // Receipt persistence is itself best-effort durability — a failed receipt
      // PUT must never surface as a run failure. The REASON still has to travel:
      // without it a run with no receipts is indistinguishable from a run that
      // never tried to write one.
      logger.warn(`bench.resume.recorder.writeReceipt: ${errMessage(e)}`)
      return false
    }
  }

  const markDegraded = (): void => {
    degraded = true
  }

  const initializeCount = async (): Promise<void> => {
    if (countInitialized) return
    countInitialized = true
    try {
      const initial = await opts.initialCount?.()
      if (!Number.isSafeInteger(initial) || (initial as number) < 0)
        throw new Error("invalid count")
      count = initial as number
    } catch (e) {
      // `markDegraded` says THAT the count is untrusted; it never says why, so a
      // provider fault and a malformed count read identically downstream.
      logger.warn(`bench.resume.recorder.initialCount: ${errMessage(e)}`)
      markDegraded()
    }
  }

  const persistDegraded = async (): Promise<void> => {
    if (degradedReceiptPersisted) return
    degradedReceiptPersisted = await safeWriteReceipt({
      key: opts.key,
      campaignId: opts.campaignId,
      instanceId: opts.instanceId,
      latestSeq: count,
      degraded: true,
      updatedAt: new Date().toISOString(),
    })
  }

  const tee = teeReplayStore(opts.primary, opts.secondary, markDegraded)

  return {
    async append(record: RecordedInteraction): Promise<void> {
      await initializeCount()
      await tee.append(record) // primary awaited; secondary best-effort (may markDegraded)
      count++
      let security: ResumeSecurityReceipt | undefined
      if (!degraded) {
        try {
          security = await opts.securityReceipt?.()
        } catch {
          markDegraded()
        }
      }
      if (degraded) return persistDegraded()
      await safeWriteReceipt({
        key: opts.key,
        campaignId: opts.campaignId,
        instanceId: opts.instanceId,
        latestSeq: count,
        degraded: false,
        updatedAt: new Date().toISOString(),
        ...(security !== undefined ? { security } : {}),
      })
    },
    match: tee.match,
    load: tee.load,
    async save(records): Promise<void> {
      await tee.save(records)
      count = records.length
      countInitialized = true
      // S3 save cannot delete a stale tail on shrink and bypasses append receipt
      // sequencing. Make the resume key ineligible rather than claim continuity.
      markDegraded()
      await persistDegraded()
    },
    reset: tee.reset,
  }
}

/**
 * Wrap `llm` so each recorded interaction is tee'd to the durable resume store,
 * OR return `llm` UNCHANGED (byte-identical) when resume is not active.
 *
 * Active ⇔ `resumeActive(resolveResumeConfig(env))` (complete remote-security
 * configuration) AND a non-empty
 * `QUANTA_BENCH_INSTANCE_ID` (the box launch sets it). If the instanceId is
 * absent while resume is enabled, we LOG and treat resume-write as OFF — we
 * never GUESS the instance id (fail-closed).
 *
 * The PRIMARY store is the SAME local jsonl path {@link import(
 * "../trajectory").maybeRecordTrajectory} would use (`localTrajectoryPath`), so
 * the local trajectory remains unchanged; this REPLACES the local-only
 * recording wrap with a tee'd wrap.
 */
export const maybeTeeResumeRecording = (
  llm: LLMPort,
  env: Record<string, string | undefined>,
  localTrajectoryPath?: string,
): LLMPort => {
  const store = maybeResumeReplayStore(env, localTrajectoryPath)
  if (store === undefined) return llm

  // Stamp the record `id` with the SAME canonicalizing hash (policy "exact",
  // recordingLlmPort's default policy) so a cassette's id field is canonical too.
  return recordingLlmPort({
    inner: llm,
    store,
    hashRequest: (req) => resumeHashRequest(req, "exact"),
  })
}

/** Build the one shared local+durable store used by both fresh recording and
 * resume replay expansion. Undefined preserves the default-off path exactly. */
export const maybeResumeReplayStore = (
  env: Record<string, string | undefined>,
  localTrajectoryPath?: string,
  limit?: number,
): ReplayStore | undefined => {
  const cfg = resolveResumeConfig(env)
  if (!resumeActive(cfg)) return undefined

  const instanceId = env.QUANTA_BENCH_INSTANCE_ID
  if (instanceId === undefined || instanceId === "") {
    return undefined
  }

  const key = resumeKey({ campaignId: cfg.campaignId, instanceId })
  // exactOptionalPropertyTypes: thread region only when present. The CANONICALIZING
  // `resumeHashRequest` masks volatile tokens (durations / clock / ISO / workdir
  // suffixes) BEFORE hashing so a cassette recorded on THIS box replays HIT on a
  // fresh resume box even though tool-output timings differ.
  const resume = resumeStore(
    {
      bucket: cfg.bucket,
      ...(cfg.region !== undefined ? { region: cfg.region } : {}),
      hashRequest: resumeHashRequest,
      security: {
        kmsKeyArn: cfg.kmsKeyArn,
        principalArn: cfg.principalArn,
        maxRetentionDays: cfg.maxRetentionDays,
      },
    },
    key,
  )

  // SAME local path the local-only recorder would use ⇒ local trajectory
  // unchanged. Fall back to the UNIFIED bench-home default (jul-9 — matches
  // defaultBenchTrajectoryPath: <benchHome>/runs/<runId>/trajectory.jsonl, NOT cwd)
  // when the caller omits it.
  const primary = jsonlReplayStore({
    path: localTrajectoryPath ?? join(benchHome(), "runs", benchRunId(), "trajectory.jsonl"),
    hashRequest: resumeHashRequest,
    ...(limit !== undefined ? { limit } : {}),
  })

  const store = teeResumeReplayStore({
    primary,
    secondary: resume.replayStore,
    key,
    campaignId: cfg.campaignId,
    instanceId,
    writeReceipt: resume.writeReceipt,
    securityReceipt: async () => {
      const receipt = await resume.securityReceipt()
      if (receipt === undefined) throw new Error("resume security attestation missing")
      return receipt
    },
    initialCount: async () => (await resume.segments.listSegments()).length,
  })
  return store
}
