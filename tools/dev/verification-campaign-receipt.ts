import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { availableParallelism, loadavg, totalmem } from "node:os"
import { dirname } from "node:path"

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

export type CampaignOutcome = "passed" | "failed" | "terminated"

export interface CampaignHostSample {
  readonly cpus: number
  readonly loadAverage1m: number
  readonly totalMemoryBytes: number
}

export interface CampaignReceipt {
  readonly schema: typeof CAMPAIGN_RECEIPT_SCHEMA
  readonly pid: number
  readonly head: string
  readonly command: string
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
}

export const sampleCampaignHost = (): CampaignHostSample => ({
  cpus: availableParallelism(),
  loadAverage1m: Number((loadavg()[0] ?? 0).toFixed(2)),
  totalMemoryBytes: totalmem(),
})

export const buildCampaignReceipt = (input: {
  readonly pid: number
  readonly head: string
  readonly command: string
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
}): CampaignReceipt => ({
  schema: CAMPAIGN_RECEIPT_SCHEMA,
  pid: input.pid,
  head: input.head,
  command: input.command,
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
})

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
