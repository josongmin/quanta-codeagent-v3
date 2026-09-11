import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { availableParallelism, loadavg, totalmem } from "node:os"
import { dirname } from "node:path"
import { summarizeSamples, type VerificationSample } from "./verification-metrics"
import type { VerificationTier } from "./verification-result"

/**
 * Machine-readable record of ONE verification campaign.
 *
 * WHY. Everything a campaign knew about itself — how long it waited for the
 * lane, who held it, whether the process tree actually drained, why it
 * stopped — existed only as log lines. Diagnosing a stalled or killed run
 * meant grepping a multi-megabyte transcript and reconstructing the order by
 * eye. This is the same argument the gate receipt already won for gates, one
 * level up: the campaign's own verdict is a value, not prose.
 *
 * NOT AN AUTHORITY. Nothing reads this to decide whether to re-run; that is
 * the exact-receipt's job, and confusing the two is how a diagnostic file
 * becomes a false green. This is written AFTER the verdict is fixed and only
 * ever answers "what happened".
 */

export const CAMPAIGN_RECEIPT_SCHEMA = "quanta.verification-campaign-receipt.v1" as const

/**
 * `reused` is a real outcome, not a non-event: a campaign that returned on the
 * exact receipt did happen, and leaving it out let `last-campaign.json`
 * describe some older run while the operator was looking at a fresh reuse.
 */
export type CampaignOutcome = "passed" | "failed" | "terminated" | "reused"

export interface CampaignHostSample {
  readonly cpus: number
  readonly loadAverage1m: number
  readonly totalMemoryBytes: number
}

export interface CampaignReceipt {
  readonly schema: typeof CAMPAIGN_RECEIPT_SCHEMA
  readonly pid: number
  /**
   * The HEAD the campaign actually ran over — captured AFTER the repository
   * lease is held.
   *
   * It used to be captured once, before the lease wait, and a contender can
   * wait behind another checkout's campaign for a long time (the wrapper's own
   * WAIT line reports elapsed seconds and the shard lane budgets minutes). Any
   * commit landing in that window left this field describing a state the run
   * never saw. `queuedHead` below preserves what it was when we got in line, so
   * the drift is visible rather than overwritten.
   */
  readonly head: string
  /** HEAD when the campaign started waiting for the lease. */
  readonly queuedHead: string
  /** HEAD at exit. Differs from `head` only if the tree moved mid-campaign. */
  readonly endHead: string | null
  /** OID of the comparison base (`origin/main`) frozen with `head`, so local
   *  and hosted admission compare the same commit range. */
  readonly baseOid: string | null
  /** True when `queuedHead !== head`: the tree moved while we waited. */
  readonly headMovedInQueue: boolean
  readonly command: string
  /** Parsed from argv when the command is `gate.ts <tier>`; otherwise null. Not a verdict. */
  readonly verificationTier: VerificationTier | "precommit" | null
  readonly leasePort: number | null
  /** Milliseconds spent waiting for another checkout to release the lane. */
  readonly leaseWaitMs: number
  readonly startedAt: string
  readonly finishedAt: string
  readonly elapsedMs: number
  readonly outcome: CampaignOutcome
  readonly exitCode: number | null
  /** Set only when the campaign was stopped by a signal. */
  readonly cancellationReason?: string
  /** Did every worker process group actually empty before release? */
  readonly drained: boolean
  readonly survivingGroups: readonly number[]
  readonly hostAtStart: CampaignHostSample
  readonly hostAtEnd: CampaignHostSample
  readonly timing: {
    readonly count: number
    readonly medianMs: number | null
    readonly p95Ms: number | null
  }
}

const campaignTiming = (input: {
  readonly startedAtMs: number
  readonly finishedAtMs: number
  readonly leaseWaitMs: number
  readonly outcome: CampaignOutcome
  readonly loadAverage1m: number
}): VerificationSample => {
  const leaseEnd = input.startedAtMs + Math.max(0, input.leaseWaitMs)
  const runEnd = Math.max(leaseEnd, input.finishedAtMs)
  return {
    phases: [
      { phase: "lease", startedMs: input.startedAtMs, endedMs: leaseEnd },
      { phase: "run", startedMs: leaseEnd, endedMs: runEnd },
    ],
    outcome:
      input.outcome === "terminated"
        ? "cancelled"
        : input.outcome === "failed"
          ? "failed"
          : "passed",
    intraParallel: 1,
    loadAverage1m: input.loadAverage1m,
  }
}

export const sampleCampaignHost = (): CampaignHostSample => ({
  cpus: availableParallelism(),
  loadAverage1m: Number((loadavg()[0] ?? 0).toFixed(2)),
  totalMemoryBytes: totalmem(),
})

export const buildCampaignReceipt = (input: {
  readonly pid: number
  readonly head: string
  readonly queuedHead: string
  readonly endHead: string | null
  readonly baseOid: string | null
  readonly headMovedInQueue: boolean
  readonly command: string
  readonly verificationTier: VerificationTier | "precommit" | null
  readonly leasePort: number | null
  readonly leaseWaitMs: number
  readonly startedAtMs: number
  readonly finishedAtMs: number
  readonly outcome: CampaignOutcome
  readonly exitCode: number | null
  readonly cancellationReason?: string
  readonly drained: boolean
  readonly survivingGroups: readonly number[]
  readonly hostAtStart: CampaignHostSample
  readonly hostAtEnd: CampaignHostSample
}): CampaignReceipt => {
  const timing = summarizeSamples([
    campaignTiming({
      startedAtMs: input.startedAtMs,
      finishedAtMs: input.finishedAtMs,
      leaseWaitMs: input.leaseWaitMs,
      outcome: input.outcome,
      loadAverage1m: input.hostAtEnd.loadAverage1m,
    }),
  ])
  return {
    schema: CAMPAIGN_RECEIPT_SCHEMA,
    pid: input.pid,
    head: input.head,
    queuedHead: input.queuedHead,
    endHead: input.endHead,
    baseOid: input.baseOid,
    headMovedInQueue: input.headMovedInQueue,
    command: input.command,
    verificationTier: input.verificationTier,
    leasePort: input.leasePort,
    leaseWaitMs: Math.max(0, Math.round(input.leaseWaitMs)),
    startedAt: new Date(input.startedAtMs).toISOString(),
    finishedAt: new Date(input.finishedAtMs).toISOString(),
    elapsedMs: Math.max(0, Math.round(input.finishedAtMs - input.startedAtMs)),
    outcome: input.outcome,
    exitCode: input.exitCode,
    ...(input.cancellationReason === undefined
      ? {}
      : { cancellationReason: input.cancellationReason }),
    drained: input.drained,
    survivingGroups: [...input.survivingGroups],
    hostAtStart: input.hostAtStart,
    hostAtEnd: input.hostAtEnd,
    timing,
  }
}

/** Atomic, and never able to fail a campaign: diagnostics are not a verdict. */
export const writeCampaignReceipt = (path: string, receipt: CampaignReceipt): boolean => {
  const temporary = `${path}.${process.pid}.tmp`
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
    renameSync(temporary, path)
    return true
  } catch {
    rmSync(temporary, { force: true })
    return false
  }
}
