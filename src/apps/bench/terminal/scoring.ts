/**
 * TB21-04 — the official Terminal-Bench 2.1 leaderboard scorer.
 *
 * This is a PORT, not an invention. Every function below mirrors one function of
 * the pinned upstream calculator:
 *
 *   repo    https://github.com/harbor-framework/terminal-bench-2-1   (Apache-2.0)
 *   commit  7131e4375048a0e408a8fb404b5f499d726b695b
 *   file    leaderboard/src/leaderboard/core/metrics.py
 *   sha256  b51790e92003a396f6de916d8c65ca8fd4b2c06c63c60af1899b02ab7c8c466a
 *
 * Those exact bytes are vendored at
 * `tests/unit/apps/bench/terminal/fixtures/upstream_metrics.py`, and
 * `scoring-parity.test.ts` executes them as a differential oracle: the port is
 * proven field-for-field equal over a 445-trial k=5 shape, not eyeballed against
 * a published percentage. If you change anything here, that test is the judge.
 *
 * Two rules this module exists to make structural rather than optional:
 *
 *  1. Every admitted trial contributes its ACTUAL reward. An errored trial has
 *     no reward, so it scores zero — but it never leaves the denominator. That
 *     is not a special case in the code, and it must not become one: it falls
 *     out of `isSuccess(null) === false` plus a denominator that counts rows.
 *  2. Nothing in Quanta's diagnostic taxonomy reaches this file. Classification
 *     explains a number; it never changes one.
 *
 * The module is pure: no filesystem, no clock, no policy. Completeness,
 * standard-config admission and the Quanta receipt live in `report.ts`.
 */

/** One trial row, shaped like the Harbor Hub bulk rows upstream consumes. */
export interface ScorableTrial {
  readonly id: string
  readonly taskName: string
  /** The primary reward, verbatim. `null` when Harbor recorded none. */
  readonly reward: number | null
  /** Harbor's convention: total input INCLUDING cache tokens. */
  readonly inputTokens: number | null
  readonly cacheTokens: number | null
  readonly outputTokens: number | null
  readonly costUsd: number | null
  readonly startedAt: string | null
  readonly finishedAt: string | null
}

/** The pass@k columns the leaderboard `metrics_schema` requires. */
export const PASS_AT_KS = [2, 3, 4, 5] as const
export type PassAtK = (typeof PASS_AT_KS)[number]

/** Per-task reward lists, in trial order. Insertion order is load-bearing: the
 *  stderr sum is a float accumulation and upstream walks a `defaultdict`. */
export type RewardsByTask = ReadonlyMap<string, readonly (number | null)[]>

export interface OfficialMetrics {
  readonly accuracy: number
  readonly accuracyStderr: number
  readonly displayAccuracy: string
  readonly nTrials: number
  readonly passAtK: Readonly<Record<PassAtK, number>>
  readonly uncachedInputTokens: number
  readonly cachedInputTokens: number
  readonly outputTokens: number
  readonly totalCostUsd: number
  readonly displayTotalCostUsd: string
  readonly avgTrialDurationSec: number
  readonly rewardHacks: number
}

// ── CPython numeric semantics ────────────────────────────────────────────────
//
// Upstream rounds with CPython's `round()` and formats with `format()`, both of
// which round half-to-EVEN on the exact binary value of the double. JavaScript's
// `Math.round` rounds half-up and `toFixed` rounds half-away-from-zero, so a
// naive port silently disagrees on ties (`round(0.125, 2)` is 0.12 in Python and
// 0.13 with `Math.round(0.125 * 100) / 100`). These helpers reproduce CPython
// exactly by rounding the double's exact rational value with BigInt arithmetic.

/** Exact `x = mantissa * 2**exponent` for a finite non-negative double. */
const decompose = (x: number): { readonly mantissa: bigint; readonly exponent: number } => {
  const view = new DataView(new ArrayBuffer(8))
  view.setFloat64(0, x)
  const hi = view.getUint32(0)
  const lo = view.getUint32(4)
  const biasedExponent = (hi >>> 20) & 0x7ff
  const fraction = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo)
  return biasedExponent === 0
    ? { mantissa: fraction, exponent: -1074 } // subnormal
    : { mantissa: fraction | (1n << 52n), exponent: biasedExponent - 1075 }
}

/** `round(|x| * 10**digits)` with half-to-even ties, as an exact integer. */
const roundedMagnitude = (x: number, digits: number): bigint => {
  const { mantissa, exponent } = decompose(Math.abs(x))
  const scaled = mantissa * 10n ** BigInt(digits)
  if (exponent >= 0) return scaled << BigInt(exponent)
  const denominator = 1n << BigInt(-exponent)
  const quotient = scaled / denominator
  const remainder = scaled % denominator
  const twice = remainder * 2n
  if (twice > denominator) return quotient + 1n
  if (twice < denominator) return quotient
  return quotient % 2n === 0n ? quotient : quotient + 1n // tie → even
}

/** CPython `round(x, digits)` for `digits >= 0`. */
export const pyRound = (x: number, digits: number): number => {
  if (!Number.isFinite(x)) return x
  if (digits < 0) throw new Error(`pyRound: negative digits (${digits}) is not supported`)
  const magnitude = roundedMagnitude(x, digits)
  const value = Number(`${magnitude}e-${digits}`)
  return x < 0 || Object.is(x, -0) ? -value : value
}

/** CPython `format(x, f".{digits}f")`. */
export const pyFormatFixed = (x: number, digits: number): string => {
  if (!Number.isFinite(x)) return String(x)
  const magnitude = roundedMagnitude(x, digits)
    .toString()
    .padStart(digits + 1, "0")
  const body =
    digits === 0
      ? magnitude
      : `${magnitude.slice(0, magnitude.length - digits)}.${magnitude.slice(magnitude.length - digits)}`
  return x < 0 || Object.is(x, -0) ? `-${body}` : body
}

/** CPython's `,` thousands grouping applied to a formatted magnitude. */
const withGrouping = (formatted: string): string => {
  const negative = formatted.startsWith("-")
  const unsigned = negative ? formatted.slice(1) : formatted
  const dot = unsigned.indexOf(".")
  const integerPart = dot === -1 ? unsigned : unsigned.slice(0, dot)
  const rest = dot === -1 ? "" : unsigned.slice(dot)
  const grouped = integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  return `${negative ? "-" : ""}${grouped}${rest}`
}

// ── The port ─────────────────────────────────────────────────────────────────

/**
 * upstream `is_success` — "A trial succeeds iff reward > 0 (errored trials have
 * none -> failure)".
 *
 * This single predicate is why an errored trial costs a point instead of
 * vanishing: it has no reward, so it is a miss, and the denominator that counts
 * it never learns it was an error.
 */
export const isSuccess = (reward: number | null | undefined): boolean =>
  reward !== null && reward !== undefined && reward > 0

/**
 * upstream `submission_by_task` — per-task reward lists with disqualified trials
 * joined in as reward 0. Disqualification zeroes a REWARD; it never removes a
 * row, and it never touches the trial's resource usage.
 */
export const submissionByTask = (
  trials: readonly ScorableTrial[],
  disqualifiedTrialIds: readonly string[] = [],
): { readonly byTask: RewardsByTask; readonly nDisqualified: number } => {
  const disqualified = new Set(disqualifiedTrialIds)
  const byTask = new Map<string, (number | null)[]>()
  let nDisqualified = 0
  for (const trial of trials) {
    const rewards = byTask.get(trial.taskName) ?? []
    if (disqualified.has(trial.id)) {
      rewards.push(0)
      nDisqualified += 1
    } else {
      rewards.push(trial.reward)
    }
    byTask.set(trial.taskName, rewards)
  }
  return { byTask, nDisqualified }
}

/**
 * upstream `compute_metrics` — `(accuracy, accuracy_stderr)` as percentages.
 *
 *   accuracy = successful / total trials
 *   s^2      = (1/n^2) * sum_i p_i (1 - p_i) / (k_i - 1)
 *
 * A task with a single trial contributes no variance term (`p(1-p)/(k-1)` is
 * undefined at k=1) but still counts in `n`.
 */
export const computeMetrics = (
  byTask: RewardsByTask,
): { readonly accuracy: number; readonly accuracyStderr: number } => {
  let total = 0
  let successful = 0
  for (const rewards of byTask.values()) {
    total += rewards.length
    for (const reward of rewards) if (isSuccess(reward)) successful += 1
  }
  const accuracy = total === 0 ? 0 : (100 * successful) / total

  const n = byTask.size
  let variance = 0
  for (const rewards of byTask.values()) {
    const k = rewards.length
    if (k < 2) continue
    let hits = 0
    for (const reward of rewards) if (isSuccess(reward)) hits += 1
    const p = hits / k
    variance += (p * (1 - p)) / (k - 1)
  }
  variance = n === 0 ? 0 : variance / (n * n)
  return { accuracy, accuracyStderr: 100 * Math.sqrt(variance) }
}

/**
 * upstream `compute_pass_at_k` — the unbiased per-task estimator
 * `1 - C(n-c, k) / C(n, k)`, averaged over tasks, rounded to 4 places. A task
 * with fewer than k trials is skipped for that k.
 */
export const computePassAtK = (
  byTask: RewardsByTask,
  ks: readonly number[] = PASS_AT_KS,
): Record<number, number> => {
  const out: Record<number, number> = {}
  for (const k of ks) {
    const values: number[] = []
    for (const rewards of byTask.values()) {
      const n = rewards.length
      if (n < k) continue
      let c = 0
      for (const reward of rewards) if (isSuccess(reward)) c += 1
      if (n - c < k) {
        values.push(1)
        continue
      }
      let miss = 1
      for (let i = 0; i < k; i += 1) miss *= (n - c - i) / (n - i)
      values.push(1 - miss)
    }
    out[k] =
      values.length === 0 ? 0 : pyRound(values.reduce((sum, v) => sum + v, 0) / values.length, 4)
  }
  return out
}

/**
 * upstream `compute_resource_metrics` — whole-submission token/cost totals.
 *
 * `inputTokens` INCLUDES cache tokens (harbor's convention), so uncached =
 * input - cache, clamped at 0 for agents that report them disjoint. Every trial
 * that ran counts, disqualified ones included: disqualification zeroes a reward,
 * not the dollars that were spent. Missing telemetry counts 0.
 */
export const computeResourceMetrics = (
  trials: readonly ScorableTrial[],
): {
  readonly uncachedInputTokens: number
  readonly cachedInputTokens: number
  readonly outputTokens: number
  readonly totalCostUsd: number
  readonly displayTotalCostUsd: string
} => {
  let uncached = 0
  let cached = 0
  let output = 0
  let cost = 0
  for (const trial of trials) {
    const input = trial.inputTokens ?? 0
    const cache = trial.cacheTokens ?? 0
    uncached += Math.max(input - cache, 0)
    cached += cache
    output += trial.outputTokens ?? 0
    cost += trial.costUsd ?? 0
  }
  const total = pyRound(cost, 2)
  return {
    uncachedInputTokens: uncached,
    cachedInputTokens: cached,
    outputTokens: output,
    totalCostUsd: total,
    displayTotalCostUsd: `$${withGrouping(pyFormatFixed(total, 2))}`,
  }
}

/** Exact epoch microseconds for an ISO-8601 instant, or `null` when unparseable.
 *  Integer arithmetic so the duration matches Python's exact `timedelta`. */
const epochMicros = (iso: string): number | null => {
  const match = /^(.*?)(?:\.(\d+))?(Z|[+-]\d{2}:?\d{2})?$/.exec(iso.trim())
  if (match === null) return null
  const [, head = "", fraction = "", zone = ""] = match
  const ms = Date.parse(`${head}${zone === "" ? "" : zone}`)
  if (Number.isNaN(ms)) return null
  const micros = Number.parseInt(`${fraction}000000`.slice(0, 6), 10)
  return ms * 1000 + (Number.isNaN(micros) ? 0 : micros)
}

/**
 * upstream `_duration_sec` — wall-clock seconds between two ISO instants, or
 * `null` when either is missing/unparseable.
 *
 * Exported so a trial RECEIPT and the official average are computed by the very
 * same function; two implementations of "how long did this take" would be free
 * to disagree at the sub-second edge.
 */
export const trialDurationSec = (
  startedAt: string | null,
  finishedAt: string | null,
): number | null => {
  if (startedAt === null || finishedAt === null) return null
  if (startedAt === "" || finishedAt === "") return null
  const start = epochMicros(startedAt)
  const end = epochMicros(finishedAt)
  if (start === null || end === null) return null
  return (end - start) / 1_000_000
}

/** upstream `compute_avg_duration_sec` — mean wall-clock seconds over the trials
 *  that report BOTH timestamps. */
export const computeAvgDurationSec = (trials: readonly ScorableTrial[]): number => {
  const durations: number[] = []
  for (const trial of trials) {
    const seconds = trialDurationSec(trial.startedAt, trial.finishedAt)
    if (seconds !== null) durations.push(seconds)
  }
  return durations.length === 0
    ? 0
    : pyRound(durations.reduce((sum, d) => sum + d, 0) / durations.length, 1)
}

/** upstream `_hack_rate_pct` — percent of trials disqualified for reward hacking. */
export const hackRatePct = (nDisqualified: number, nTrials: number): number =>
  nTrials === 0 ? 0 : pyRound((100 * nDisqualified) / nTrials, 2)

/** upstream `format_hack_rate` — the Hacks column label. The leading minus
 *  signals that the rate has already been deducted from accuracy. */
export const formatHackRate = (pct: number): string => `-${pyFormatFixed(pct, 1)}%`

/** upstream `compute_submission_metrics`'s `display_accuracy`: the headline bold,
 *  the ± stderr regular weight. */
export const displayAccuracy = (accuracy: number, stderr: number): string =>
  `**${pyFormatFixed(accuracy, 1)}%** ± ${pyFormatFixed(stderr, 1)}%`

/** upstream `format_resource_cells` — `[tokens, cost]` in `RESOURCE_HEADERS`
 *  order; an em-dash when the metrics carry no telemetry. */
export const formatResourceCells = (metrics: {
  readonly uncachedInputTokens?: number
  readonly cachedInputTokens?: number
  readonly outputTokens?: number
  readonly totalCostUsd?: number
}): readonly [string, string] => {
  const tokens =
    (metrics.uncachedInputTokens ?? 0) +
    (metrics.cachedInputTokens ?? 0) +
    (metrics.outputTokens ?? 0)
  const cost = metrics.totalCostUsd
  return [
    tokens ? withGrouping(String(tokens)) : "—",
    cost ? `$${withGrouping(pyFormatFixed(cost, 2))}` : "—",
  ]
}

/**
 * upstream `compute_submission_metrics`, minus its one impure step (it fetches
 * the trials from the Harbor Hub; here they are passed in).
 *
 * Disqualification is honoured through the reward-0 join, so it zeroes a trial's
 * reward — accuracy and pass@k — and not its resource usage.
 */
export const computeOfficialMetrics = (
  trials: readonly ScorableTrial[],
  disqualifiedTrialIds: readonly string[] = [],
): OfficialMetrics => {
  const { byTask } = submissionByTask(trials, disqualifiedTrialIds)
  const { accuracy, accuracyStderr } = computeMetrics(byTask)
  const passAtK = computePassAtK(byTask)
  return {
    accuracy: pyRound(accuracy, 2),
    accuracyStderr: pyRound(accuracyStderr, 2),
    displayAccuracy: displayAccuracy(accuracy, accuracyStderr),
    nTrials: trials.length,
    passAtK: {
      2: passAtK[2] ?? 0,
      3: passAtK[3] ?? 0,
      4: passAtK[4] ?? 0,
      5: passAtK[5] ?? 0,
    },
    ...computeResourceMetrics(trials),
    avgTrialDurationSec: computeAvgDurationSec(trials),
    rewardHacks: hackRatePct(disqualifiedTrialIds.length, trials.length),
  }
}
