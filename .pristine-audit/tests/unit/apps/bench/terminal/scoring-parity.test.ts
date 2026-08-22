/**
 * TB21-04 — official scoring parity (RED-first hellgate).
 *
 * The number this file defends is the ONLY thing that makes a Terminal-Bench
 * result comparable to the public leaderboard. So it is never asserted against a
 * literal somebody typed from a screenshot: every expectation below is produced
 * by executing the PINNED upstream calculator itself.
 *
 * Scoring authority
 * -----------------
 *   repo    https://github.com/harbor-framework/terminal-bench-2-1  (Apache-2.0)
 *   commit  7131e4375048a0e408a8fb404b5f499d726b695b
 *   file    leaderboard/src/leaderboard/core/metrics.py
 *   sha256  b51790e92003a396f6de916d8c65ca8fd4b2c06c63c60af1899b02ab7c8c466a
 *
 * Those exact bytes live at `fixtures/upstream_metrics.py`; the sha is re-checked
 * on every run by both this file and the Python driver, so the oracle cannot
 * drift into "whatever we edited it into". `fixtures/upstream_metrics_driver.py`
 * loads it verbatim and prints the metric record for a submission-shaped payload.
 *
 * What is proven here, and what is NOT
 * -----------------------------------
 * PROVEN: `src/apps/bench/terminal/scoring.ts` is field-for-field equal to the
 * upstream implementation — accuracy, accuracy stderr, pass@2..pass@5, resource
 * totals, average duration, reward-hack rate and every display string — over a
 * 445-trial k=5 shape that exercises 0/partial/1 rewards, errored trials with no
 * reward, disqualifications, disjoint token reporting and missing telemetry.
 *
 * NOT PROVEN (recorded honestly rather than faked): the per-trial rewards behind
 * a real checked-in submission are NOT publicly readable. `submission_trials()`
 * fetches them from the Harbor Hub, and the Hub's `get_job_trials` RPC returns an
 * empty page to an anonymous caller (verified against
 * https://ofhuhcpkvzjlejydnvyd.supabase.co with harbor's own publishable key).
 * A real submission JSON therefore checks in its METRICS but not the rewards they
 * came from. So the real-submission parity block below asserts only the fields
 * that ARE computable from that file's own checked-in inputs — trial count,
 * reward-hack rate, and the display strings — and does not pretend to reproduce
 * accuracy or pass@k from a displayed percentage. Reconstructing those would mean
 * inventing a per-task reward vector, which is exactly the fabrication this
 * ticket forbids.
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  computeAvgDurationSec,
  computeMetrics,
  computeOfficialMetrics,
  computePassAtK,
  computeResourceMetrics,
  displayAccuracy,
  formatHackRate,
  formatResourceCells,
  hackRatePct,
  isSuccess,
  pyRound,
  type ScorableTrial,
  submissionByTask,
} from "../../../../../src/apps/bench/terminal/scoring"

const FIXTURES = join(import.meta.dir, "fixtures")
const UPSTREAM_METRICS = join(FIXTURES, "upstream_metrics.py")
const DRIVER = join(FIXTURES, "upstream_metrics_driver.py")
const PINNED_UPSTREAM_SHA256 = "b51790e92003a396f6de916d8c65ca8fd4b2c06c63c60af1899b02ab7c8c466a"

interface HubRow {
  id: string
  task_name: string
  reward: number | null
  error_type: string | null
  started_at: string | null
  finished_at: string | null
  input_tokens: number | null
  cache_tokens: number | null
  output_tokens: number | null
  cost_usd: number | null
}

interface Payload {
  trials: HubRow[]
  disqualified_trials: { trial_id: string; reason: string }[]
}

/** The upstream metric record, exactly as the pinned Python prints it. */
interface UpstreamRecord {
  accuracy: number
  accuracy_stderr: number
  display_accuracy: string
  n_trials: number
  pass_at_2: number
  pass_at_3: number
  pass_at_4: number
  pass_at_5: number
  uncached_input_tokens: number
  cached_input_tokens: number
  output_tokens: number
  total_cost_usd: number
  display_total_cost_usd: string
  avg_trial_duration_sec: number
  reward_hacks: number
  n_disqualified_joined: number
  n_tasks: number
  display_hack_rate: string
  display_tokens_cell: string
  display_cost_cell: string
  raw_accuracy: number
  raw_accuracy_stderr: number
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, "utf8")) as T

/** Run the PINNED upstream calculator. Never mocked — a stubbed oracle would
 *  make every assertion below vacuous. */
const upstream = (payload: Payload): UpstreamRecord => {
  const proc = Bun.spawnSync(["python3", DRIVER], {
    stdin: new TextEncoder().encode(JSON.stringify(payload)),
  })
  const stderr = new TextDecoder().decode(proc.stderr)
  if (proc.exitCode !== 0) {
    throw new Error(`upstream oracle failed (exit ${proc.exitCode}):\n${stderr}`)
  }
  return JSON.parse(new TextDecoder().decode(proc.stdout)) as UpstreamRecord
}

const toScorable = (rows: readonly HubRow[]): ScorableTrial[] =>
  rows.map((row) => ({
    id: row.id,
    taskName: row.task_name,
    reward: row.reward,
    inputTokens: row.input_tokens,
    cacheTokens: row.cache_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  }))

const local = (payload: Payload): UpstreamRecord => {
  const trials = toScorable(payload.trials)
  const disqualified = payload.disqualified_trials.map((d) => d.trial_id)
  const metrics = computeOfficialMetrics(trials, disqualified)
  const { byTask, nDisqualified } = submissionByTask(trials, disqualified)
  const { accuracy, accuracyStderr } = computeMetrics(byTask)
  const [tokensCell, costCell] = formatResourceCells(metrics)
  return {
    accuracy: metrics.accuracy,
    accuracy_stderr: metrics.accuracyStderr,
    display_accuracy: metrics.displayAccuracy,
    n_trials: metrics.nTrials,
    pass_at_2: metrics.passAtK[2],
    pass_at_3: metrics.passAtK[3],
    pass_at_4: metrics.passAtK[4],
    pass_at_5: metrics.passAtK[5],
    uncached_input_tokens: metrics.uncachedInputTokens,
    cached_input_tokens: metrics.cachedInputTokens,
    output_tokens: metrics.outputTokens,
    total_cost_usd: metrics.totalCostUsd,
    display_total_cost_usd: metrics.displayTotalCostUsd,
    avg_trial_duration_sec: metrics.avgTrialDurationSec,
    reward_hacks: metrics.rewardHacks,
    n_disqualified_joined: nDisqualified,
    n_tasks: byTask.size,
    display_hack_rate: formatHackRate(metrics.rewardHacks),
    display_tokens_cell: tokensCell,
    display_cost_cell: costCell,
    raw_accuracy: accuracy,
    raw_accuracy_stderr: accuracyStderr,
  }
}

const PARITY: Payload = readJson<Payload>(join(FIXTURES, "parity-trials-445.json"))

const clone = (payload: Payload): Payload => JSON.parse(JSON.stringify(payload)) as Payload

describe("TB21-04 scorer parity — pinned upstream leaderboard calculator", () => {
  test("the vendored oracle is byte-identical to the pinned upstream commit", () => {
    const sha = createHash("sha256").update(readFileSync(UPSTREAM_METRICS)).digest("hex")
    expect(sha).toBe(PINNED_UPSTREAM_SHA256)
    // Non-vacuity: the pin is over the real calculator, not an empty file.
    const source = readFileSync(UPSTREAM_METRICS, "utf8")
    expect(source).toContain("def compute_pass_at_k")
    expect(source).toContain("def compute_metrics")
    expect(source).toContain("def is_success")
  })

  test("the oracle actually runs and reports a non-degenerate 445-trial shape", () => {
    const record = upstream(PARITY)
    expect(record.n_trials).toBe(445)
    expect(record.n_tasks).toBe(89)
    expect(record.accuracy).toBeGreaterThan(0)
    expect(record.accuracy).toBeLessThan(100)
    expect(record.pass_at_5).toBeGreaterThan(record.pass_at_2)
  })

  test("every metric matches the upstream calculator over the 445-trial fixture", () => {
    expect(local(PARITY)).toEqual(upstream(PARITY))
  })

  test("k=1 and ragged trial counts match upstream (stderr skips k<2, pass@k skips n<k)", () => {
    const rows = PARITY.trials
    const ragged: Payload = {
      disqualified_trials: [],
      trials: [
        // one task with a single trial (undefined per-task variance term)
        rows[0]!,
        // one task with three trials (skipped by pass@4 and pass@5)
        rows[5]!,
        rows[6]!,
        rows[7]!,
        // one full k=5 task
        ...rows.slice(10, 15),
      ],
    }
    expect(local(ragged)).toEqual(upstream(ragged))
  })

  test("an empty trial set degenerates exactly the way upstream does", () => {
    const empty: Payload = { disqualified_trials: [], trials: [] }
    expect(local(empty)).toEqual(upstream(empty))
  })
})

describe("TB21-04 scorer parity — red on injection", () => {
  const baseline = upstream(PARITY)

  test("mutating one reward moves accuracy and pass@k, in both implementations", () => {
    const mutated = clone(PARITY)
    const victim = mutated.trials.find((t) => t.reward === 1)
    expect(victim).toBeDefined()
    if (victim === undefined) throw new Error("fixture has no passing trial")
    victim.reward = 0

    const mutatedUpstream = upstream(mutated)
    // The port tracks the authority through the mutation...
    expect(local(mutated)).toEqual(mutatedUpstream)
    // ...and the mutation is actually observable, so this rail cannot pass on a
    // scorer that ignores rewards.
    expect(mutatedUpstream.accuracy).toBeLessThan(baseline.accuracy)
    expect(mutatedUpstream.n_trials).toBe(baseline.n_trials)
    expect(mutatedUpstream).not.toEqual(baseline)
  })

  test("an ERRORED trial lowers accuracy instead of disappearing from the denominator", () => {
    const mutated = clone(PARITY)
    const victim = mutated.trials.find((t) => t.reward === 1)
    if (victim === undefined) throw new Error("fixture has no passing trial")
    // Exactly what Harbor records for a crashed trial: no reward at all.
    victim.reward = null
    victim.error_type = "NonZeroAgentExitCodeError"

    const after = upstream(mutated)
    expect(local(mutated)).toEqual(after)
    expect(after.n_trials).toBe(baseline.n_trials) // denominator UNCHANGED
    expect(after.accuracy).toBeLessThan(baseline.accuracy) // and it costs a point
    expect(local(mutated).n_trials).toBe(445)
  })

  test("removing one disqualification raises accuracy and lowers the hack rate", () => {
    expect(PARITY.disqualified_trials.length).toBeGreaterThan(0)
    const mutated = clone(PARITY)
    const dropped = mutated.disqualified_trials.pop()
    expect(dropped).toBeDefined()

    const after = upstream(mutated)
    expect(local(mutated)).toEqual(after)
    expect(after.reward_hacks).toBeLessThan(baseline.reward_hacks)
    // The dropped trial was a real success, so its reward returns to the metric.
    expect(after.accuracy).toBeGreaterThan(baseline.accuracy)
  })

  test("a disqualified trial keeps its resource usage but loses its reward", () => {
    const withOne = clone(PARITY)
    const success = withOne.trials.find(
      (t) => t.reward === 1 && !withOne.disqualified_trials.some((d) => d.trial_id === t.id),
    )
    if (success === undefined) throw new Error("fixture has no un-disqualified success")
    withOne.disqualified_trials.push({ trial_id: success.id, reason: "reward_hacking" })

    const after = upstream(withOne)
    expect(local(withOne)).toEqual(after)
    expect(after.accuracy).toBeLessThan(baseline.accuracy)
    expect(after.total_cost_usd).toBe(baseline.total_cost_usd)
    expect(after.cached_input_tokens).toBe(baseline.cached_input_tokens)
  })
})

describe("TB21-04 scorer parity — real checked-in official submission", () => {
  /** A REAL leaderboard submission, verbatim from the pinned commit:
   *  leaderboard/submissions/2026-07-10-gpt-5-6-luna-max-codex.json
   *  sha256 3e289210be5bdb5ce1c13a77b456650ad1103a48f925cbbd0333d71f82680b8e */
  const SUBMISSION = join(FIXTURES, "official-submission-2026-07-10-gpt-5-6-luna-max-codex.json")
  interface Submission {
    trials: string[]
    disqualified_trials: { trial_id: string; reason: string }[]
    metrics: {
      accuracy: number
      accuracy_stderr: number
      display_accuracy: string
      n_trials: number
      reward_hacks: number
      display_reward_hacks: { url: string; label: string }
      total_cost_usd: number
      display_total_cost_usd: string
    }
  }
  const submission = readJson<Submission>(SUBMISSION)

  test("the fixture is the unmodified upstream submission", () => {
    const sha = createHash("sha256").update(readFileSync(SUBMISSION)).digest("hex")
    expect(sha).toBe("3e289210be5bdb5ce1c13a77b456650ad1103a48f925cbbd0333d71f82680b8e")
    expect(submission.trials.length).toBe(445)
    expect(submission.disqualified_trials.length).toBe(33)
  })

  test("our trial count reproduces the submission's checked-in n_trials", () => {
    // Upstream: `n_trials = len(trials)`. Both sides are checked-in inputs, so
    // this is a real parity check and not a percentage read off a page.
    expect(
      computeOfficialMetrics(
        submission.trials.map((id) => ({
          id,
          taskName: id,
          reward: null,
          inputTokens: null,
          cacheTokens: null,
          outputTokens: null,
          costUsd: null,
          startedAt: null,
          finishedAt: null,
        })),
        submission.disqualified_trials.map((d) => d.trial_id),
      ).nTrials,
    ).toBe(submission.metrics.n_trials)
  })

  test("our reward-hack rate reproduces the submission's checked-in value", () => {
    expect(hackRatePct(submission.disqualified_trials.length, submission.trials.length)).toBe(
      submission.metrics.reward_hacks,
    )
    expect(formatHackRate(submission.metrics.reward_hacks)).toBe(
      submission.metrics.display_reward_hacks.label,
    )
  })

  test("our display formatters reproduce the submission's checked-in display strings", () => {
    expect(displayAccuracy(submission.metrics.accuracy, submission.metrics.accuracy_stderr)).toBe(
      submission.metrics.display_accuracy,
    )
    expect(formatResourceCells({ totalCostUsd: submission.metrics.total_cost_usd })[1]).toBe(
      submission.metrics.display_total_cost_usd,
    )
  })

  test("the checked-in accuracy is attainable as an exact successes/trials ratio", () => {
    // Not a formula derivation: `accuracy = 100 * successes / n_trials` comes
    // from the pinned source. This only proves the checked-in number is a real
    // count-derived value and pins WHICH count (317/445) it must be.
    const attainable = Array.from({ length: submission.metrics.n_trials + 1 }, (_, s) => s).filter(
      (s) => pyRound((100 * s) / submission.metrics.n_trials, 2) === submission.metrics.accuracy,
    )
    expect(attainable).toEqual([317])
  })

  test("red on injection: dropping one disqualification breaks the submission parity", () => {
    const injected = submission.disqualified_trials.slice(0, -1)
    expect(hackRatePct(injected.length, submission.trials.length)).not.toBe(
      submission.metrics.reward_hacks,
    )
  })

  test("red on injection: a one-trial count change breaks the submission parity", () => {
    expect(
      hackRatePct(submission.disqualified_trials.length, submission.trials.length - 1),
    ).not.toBe(submission.metrics.reward_hacks)
  })
})

describe("TB21-04 scorer parity — the primitives upstream is built from", () => {
  test("is_success is `reward > 0`, so a null/0 reward is a miss and 0.5 is a hit", () => {
    expect(isSuccess(1)).toBe(true)
    expect(isSuccess(0.5)).toBe(true)
    expect(isSuccess(0)).toBe(false)
    expect(isSuccess(null)).toBe(false)
    expect(isSuccess(undefined)).toBe(false)
    expect(isSuccess(-1)).toBe(false)
  })

  test("pyRound matches CPython's round() including the half-to-even ties", () => {
    const cases: [number, number][] = [
      [2.675, 2],
      [0.125, 2],
      [12.625, 2],
      [0.135, 2],
      [2.5, 0],
      [3.5, 0],
      [-2.5, 0],
      [71.23595505617978, 2],
      [1.3949999999999998, 2],
      [0.80895, 4],
      [634.75, 1],
      [1998.935, 2],
    ]
    const proc = Bun.spawnSync(
      [
        "python3",
        "-c",
        "import json,sys; print(json.dumps([round(x, n) for x, n in json.load(sys.stdin)]))",
      ],
      { stdin: new TextEncoder().encode(JSON.stringify(cases)) },
    )
    expect(proc.exitCode).toBe(0)
    const expected = JSON.parse(new TextDecoder().decode(proc.stdout)) as number[]
    expect(cases.map(([x, nd]) => pyRound(x, nd))).toEqual(expected)
    // Non-vacuity: at least one of these is a genuine half-to-even tie that
    // naive `Math.round(x * 10 ** nd) / 10 ** nd` gets wrong.
    expect(expected[1]).toBe(0.12)
    expect(Math.round(0.125 * 100) / 100).toBe(0.13)
  })

  test("computeMetrics/computePassAtK/computeResourceMetrics are individually exported and pure", () => {
    const trials = toScorable(PARITY.trials.slice(0, 10))
    const { byTask } = submissionByTask(trials, [])
    expect(computeMetrics(byTask).accuracy).toBeGreaterThanOrEqual(0)
    expect(Object.keys(computePassAtK(byTask))).toEqual(["2", "3", "4", "5"])
    expect(computeResourceMetrics(trials).cachedInputTokens).toBeGreaterThan(0)
    expect(computeAvgDurationSec(trials)).toBeGreaterThan(0)
  })
})
