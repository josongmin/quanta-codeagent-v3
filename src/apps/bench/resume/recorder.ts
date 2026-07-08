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
  recordingLlmPort,
  type RecordedInteraction,
  type ReplayMatchOpts,
  type ReplayStore,
} from "@/llm/replay"
import type { StreamInput } from "@/llm/types"
import { benchHome, benchRunId } from "@/runner/batch/corpus/paths"
import type { ResumeReceipt } from "@/shared/remote-store"
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
}

/**
 * The resume WRITE store: a {@link teeReplayStore} that ALSO maintains the
 * fail-closed receipt.
 *
 * - On every HEALTHY append, write a receipt `{latestSeq:<count>, degraded:false}`.
 * - On the FIRST secondary error, write ONE degraded receipt `{degraded:true}`
 *   and SUPPRESS all further receipt writes (the run stays degraded; we don't
 *   thrash the receipt or accidentally un-degrade it).
 * - A receipt-write failure is itself best-effort — it must never kill the run.
 */
export const teeResumeReplayStore = (opts: TeeResumeReplayStoreOpts): ReplayStore => {
  let degraded = false
  let count = 0

  const safeWriteReceipt = async (receipt: ResumeReceipt): Promise<void> => {
    try {
      await opts.writeReceipt(receipt)
    } catch {
      // Receipt persistence is itself best-effort durability — a failed receipt
      // PUT must never surface as a run failure. The next healthy append retries.
    }
  }

  const markDegraded = (): void => {
    if (degraded) return // first error only; subsequent writes suppressed
    degraded = true
    void safeWriteReceipt({
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
      await tee.append(record) // primary awaited; secondary best-effort (may markDegraded)
      count++
      if (!degraded) {
        await safeWriteReceipt({
          key: opts.key,
          campaignId: opts.campaignId,
          instanceId: opts.instanceId,
          latestSeq: count,
          degraded: false,
          updatedAt: new Date().toISOString(),
        })
      }
    },
    match: tee.match,
    load: tee.load,
    save: tee.save,
    reset: tee.reset,
  }
}

/**
 * Wrap `llm` so each recorded interaction is tee'd to the durable resume store,
 * OR return `llm` UNCHANGED (byte-identical) when resume is not active.
 *
 * Active ⇔ `resumeActive(resolveResumeConfig(env))` AND a non-empty
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
  const cfg = resolveResumeConfig(env)
  if (!resumeActive(cfg)) return llm

  const instanceId = env.QUANTA_BENCH_INSTANCE_ID
  if (instanceId === undefined || instanceId === "") {
    // fail-closed: enabled but no instance id ⇒ do NOT guess, resume-write OFF.
    console.warn(
      "[bench-resume] QUANTA_BENCH_RESUME active but QUANTA_BENCH_INSTANCE_ID is unset — resume-write OFF (not guessing the instance id)",
    )
    return llm
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
    },
    key,
  )

  // SAME local path the local-only recorder would use ⇒ local trajectory
  // unchanged. Fall back to the UNIFIED bench-home default (jul-9 — matches
  // defaultBenchTrajectoryPath: <benchHome>/runs/<runId>/trajectory.jsonl, NOT cwd)
  // when the caller omits it.
  const primary = jsonlReplayStore({
    path: localTrajectoryPath ?? join(benchHome(), "runs", benchRunId(), "trajectory.jsonl"),
  })

  const store = teeResumeReplayStore({
    primary,
    secondary: resume.replayStore,
    key,
    campaignId: cfg.campaignId,
    instanceId,
    writeReceipt: resume.writeReceipt,
  })

  // Stamp the record `id` with the SAME canonicalizing hash (policy "exact",
  // recordingLlmPort's default policy) so a cassette's id field is canonical too.
  // Not load-bearing for matching — `match` rehashes candidates with the
  // store-side `hashRequest` — but keeps the persisted id consistent.
  return recordingLlmPort({
    inner: llm,
    store,
    hashRequest: (req) => resumeHashRequest(req, "exact"),
  })
}
