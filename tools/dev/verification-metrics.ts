export interface PhaseTiming {
  readonly phase: "queue" | "lease" | "admission" | "setup" | "run" | "cleanup" | "artifact"
  readonly startedMs: number
  readonly endedMs: number
  readonly estimated?: boolean
}

export interface VerificationSample {
  readonly phases: readonly PhaseTiming[]
  readonly outcome: "passed" | "failed" | "cancelled"
  readonly intraParallel: number
  readonly loadAverage1m: number | null
}

export const summarizeSamples = (
  samples: readonly VerificationSample[],
): {
  readonly count: number
  readonly medianMs: number | null
  readonly p95Ms: number | null
} => {
  const totals = samples.map((sample) => {
    let total = 0
    let previousEnd = Number.NEGATIVE_INFINITY
    for (const phase of sample.phases) {
      if (!(phase.endedMs >= phase.startedMs)) throw new Error("negative phase duration")
      if (phase.startedMs < previousEnd) throw new Error("overlapping phases")
      previousEnd = phase.endedMs
      total += phase.endedMs - phase.startedMs
    }
    return total
  })
  if (totals.length === 0) return { count: 0, medianMs: null, p95Ms: null }
  const sorted = [...totals].sort((left, right) => left - right)
  const median = sorted[Math.floor(sorted.length / 2)] ?? null
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? null
  return { count: totals.length, medianMs: median, p95Ms: p95 }
}
