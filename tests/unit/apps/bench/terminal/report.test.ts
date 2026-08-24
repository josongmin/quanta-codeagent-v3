/**
 * TB21-04 — lossless trial parsing, outcome taxonomy, admission (RED-first).
 *
 * The defect being replaced: `tools/leaderboard-dashboard/tb-report-emit.ts`
 * folds every trial of a task into ONE any-pass row, so five k=5 trials become a
 * boolean, trial ids/cost/tokens/trajectories are gone, and infra outcomes
 * silently leave the denominator. Every rail here is about that fold being
 * impossible to reintroduce.
 *
 * The inputs are REAL Harbor bytes: `fixtures/harbor-jobs/**​/result.json` is
 * emitted by harbor 0.21.0's own `TrialResult` pydantic model
 * (`generate_harbor_job.py`), which is exactly what
 * `harbor/trial/trial.py:419` writes to `trial_dir/result.json`. Edge cases are
 * produced by mutating those real bytes, never by inventing a shape.
 *
 * NOTHING here reaches `writeReport`; the canonical mirror at
 * `~/.quanta/bench/results` is never touched by this file.
 */
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CANONICAL_TASK_IDS,
  canonicalTaskRef,
  EXPECTED_TASK_COUNT,
  MIN_TRIALS_PER_TASK,
  TERMINAL_BENCH_DATASET,
  TERMINAL_BENCH_DATASET_REF,
} from "../../../../../src/apps/bench/terminal/dataset"
import { scanHarborJobDir } from "../../../../../src/apps/bench/terminal/harbor-results"
import {
  buildTerminalRunReport,
  isTrialDefect,
  parseHarborTrialResult,
  TERMINAL_TRIAL_OUTCOMES,
  type TerminalRunInput,
  type TerminalTrialOutcome,
  type TerminalTrialRecord,
} from "../../../../../src/apps/bench/terminal/report"
import { nth, present } from "../../../../_helpers/expect-present"

const FIXTURES = join(import.meta.dir, "fixtures")
const CANARY = join(FIXTURES, "harbor-jobs", "canary-k5")
const NONSTANDARD = join(FIXTURES, "harbor-jobs", "nonstandard")
const TB20 = join(FIXTURES, "harbor-jobs", "tb20-legacy")

const RUN_META: Omit<TerminalRunInput, "trials" | "defects"> = {
  datasetRef: TERMINAL_BENCH_DATASET_REF,
  timestamp: "2026-08-22T00:00:00.000Z",
  arm: "baseline",
  k: MIN_TRIALS_PER_TASK,
  harborJobIds: ["622b427f-0ddc-54db-b64b-90960667e6be"],
  sourcePaths: [CANARY],
  model: "openai/gpt-5.6-luna",
  preset: "tb21-canary",
}

/** Read the canary job through the REAL filesystem scanner + REAL parser. */
const canaryTrials = (): TerminalTrialRecord[] => {
  const scanned = scanHarborJobDir(CANARY)
  const parsed = scanned.map((file) => parseHarborTrialResult(file))
  const records = parsed.filter((p): p is TerminalTrialRecord => !isTrialDefect(p))
  expect(records.length).toBe(scanned.length)
  return records
}

const buildFrom = (
  trials: readonly TerminalTrialRecord[],
  overrides: Partial<TerminalRunInput> = {},
) => buildTerminalRunReport({ ...RUN_META, trials, defects: [], ...overrides })

/** A receipt with its trajectory facts genuinely ABSENT (not set to undefined),
 *  which is what a trial that never wrote one actually looks like. */
const withoutTrajectory = (trial: TerminalTrialRecord): TerminalTrialRecord => {
  const { trajectoryPath: _path, atifValid: _valid, ...rest } = trial
  return rest
}

/** Metrics of a report that MUST have been scored. A rejected run has none, and
 *  silently reading `undefined` would make the comparisons below vacuous. */
const metricsOf = (report: ReturnType<typeof buildFrom>) => {
  if (report.metrics === undefined) {
    throw new Error(`expected a scored report, got verdict=${report.admission.verdict}`)
  }
  return report.metrics
}

describe("TB21-04 — Harbor result scanning is filesystem-only", () => {
  test("the scanner finds every real trial dir and hands back raw bytes, not verdicts", () => {
    const files = scanHarborJobDir(CANARY)
    expect(files.length).toBe(15)
    for (const file of files) {
      expect(file.sourcePath.endsWith("result.json")).toBe(true)
      expect(typeof file.raw).toBe("object")
      // The scanner classifies nothing — that is `report.ts`'s job.
      expect(Object.keys(file)).not.toContain("outcome")
      expect(Object.keys(file)).not.toContain("reward")
    }
  })

  test("the scanner reports ATIF trajectory presence from the real tree", () => {
    const files = scanHarborJobDir(CANARY)
    const withTrajectory = files.filter((f) => f.trajectoryPath !== undefined)
    // The fixture deliberately leaves some trials without an on-disk trajectory.
    expect(withTrajectory.length).toBeGreaterThan(0)
    expect(withTrajectory.length).toBeLessThan(files.length)
    for (const file of withTrajectory) {
      expect(readFileSync(file.trajectoryPath as string, "utf8")).toContain("ATIF-v1.7")
    }
  })

  test("an unreadable result.json becomes a defect, never a fabricated trial", () => {
    const dir = mkdtempSync(join(tmpdir(), "tb21-scan-"))
    try {
      mkdirSync(join(dir, "broken"), { recursive: true })
      writeFileSync(join(dir, "broken", "result.json"), "{not json")
      const files = scanHarborJobDir(dir)
      expect(files.length).toBe(1)
      expect(files[0]?.raw).toBeUndefined()
      expect(files[0]?.readError).toBeTruthy()
      const parsed = parseHarborTrialResult(nth(files, 0, "files"))
      expect(isTrialDefect(parsed)).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("TB21-04 — one receipt per distinct trial id (the fold is gone)", () => {
  test("five trials of one task stay FIVE receipts with five distinct ids", () => {
    const trials = canaryTrials()
    expect(trials.length).toBe(15)
    const byTask = new Map<string, TerminalTrialRecord[]>()
    for (const trial of trials) {
      byTask.set(trial.taskId, [...(byTask.get(trial.taskId) ?? []), trial])
    }
    expect(byTask.size).toBe(3)
    for (const [, group] of byTask) expect(group.length).toBe(MIN_TRIALS_PER_TASK)
    expect(new Set(trials.map((t) => t.trialId)).size).toBe(15)
  })

  test("one pass and one fail of the SAME task remain two receipts, not one any-pass row", () => {
    const trials = canaryTrials()
    const taskId = nth(CANONICAL_TASK_IDS, 0, "taskId")
    const group = trials.filter((t) => t.taskId === taskId)
    const report = buildFrom(group)

    expect(report.trials.length).toBe(MIN_TRIALS_PER_TASK)
    const outcomes = report.trials.map((t) => t.outcome).sort()
    expect(outcomes).toContain("graded_pass")
    expect(outcomes).toContain("graded_fail")
    // The any-pass fold would report 1/1 = 100%.
    expect(report.metrics?.nTrials).toBe(MIN_TRIALS_PER_TASK)
    expect(report.metrics?.accuracy).toBeLessThan(100)
  })

  test("each receipt carries the lossless per-trial facts the fold destroyed", () => {
    const trial = canaryTrials().find((t) => t.outcome === "graded_pass")
    expect(trial).toBeDefined()
    if (trial === undefined) throw new Error("fixture has no graded pass")
    expect(trial.trialId).toMatch(/^[0-9a-f-]{36}$/)
    expect(trial.taskId).toBe(nth(CANONICAL_TASK_IDS, 0, "CANONICAL_TASK_IDS"))
    expect(trial.taskRef).toBe(canonicalTaskRef(trial.taskId))
    expect(trial.reward).toBe(1)
    expect(trial.datasetSource).toBe(TERMINAL_BENCH_DATASET)
    expect(trial.startedAt).toBeTruthy()
    expect(trial.finishedAt).toBeTruthy()
    expect(trial.durationSec).toBeGreaterThan(0)
    expect(trial.cachedInputTokens).toBeGreaterThan(0)
    expect(trial.uncachedInputTokens).toBeGreaterThan(0)
    expect(trial.outputTokens).toBeGreaterThan(0)
    expect(trial.costUsd).toBeGreaterThan(0)
    expect(trial.trajectoryPath).toBeTruthy()
    expect(trial.atifValid).toBe(true)
    // Supplemental Quanta facts, verbatim from agent_result.metadata.quanta_agent.
    expect(trial.quanta?.reasoningEffort).toBe("high")
    expect(trial.quanta?.reasoningEffortWireHonored).toBe(true)
    expect(trial.quanta?.promotable).toBe(true)
    expect(trial.quanta?.termination).toBe("completed")
    // Never the trajectory CONTENT — only its path.
    expect(JSON.stringify(trial)).not.toContain("ATIF-v1.7")
  })

  test("the raw reward used for scoring is the harbor primary reward, verbatim", () => {
    const partial = canaryTrials().find((t) => t.reward === 0.5)
    expect(partial).toBeDefined()
    // A partial reward is a SUCCESS upstream (reward > 0) and must not be
    // rounded to a boolean anywhere on the way in.
    expect(partial?.outcome).toBe("graded_pass")
  })

  test("the reward on the receipt is the reward that reaches the scorer", () => {
    const trials = canaryTrials()
    const before = metricsOf(buildFrom(trials))
    const index = trials.findIndex((t) => t.reward === 0)
    expect(index).toBeGreaterThanOrEqual(0)
    const after = metricsOf(
      buildFrom(trials.map((t, i) => (i === index ? { ...t, reward: 1 } : t))),
    )
    // Wiring proof: nothing between the receipt and `scoring.ts` re-derives the
    // reward from `outcome`, `passed`, or anything else.
    expect(after.accuracy).toBeGreaterThan(before.accuracy)
    expect(after.nTrials).toBe(before.nTrials)
  })
})

describe("TB21-04 — outcome taxonomy", () => {
  test("the taxonomy declares every kind the ticket requires, and nothing unaccounted for", () => {
    // TB21-04's eight.
    const required: readonly TerminalTrialOutcome[] = [
      "agent_crash",
      "agent_timeout",
      "environment_error",
      "graded_fail",
      "graded_pass",
      "malformed_result",
      "missing_reward",
      "verifier_error",
    ]
    // Deliberate ADDITIONS beyond the ticket, each recorded here so the set stays
    // EXACT: an accidental new kind still fails this rail, while an intended one
    // has to be justified in writing at the point it is admitted.
    //
    //  - `no_agent_activity` (aug-22): a trial the agent never attempted. Harbor
    //    reports it as completed, exception-free, reward 0, with every token
    //    counter null; folding it into `graded_fail` scored a measurement hole as
    //    a capability result. Found by the first live 2.1 canary.
    const admittedAdditions: readonly TerminalTrialOutcome[] = ["no_agent_activity"]

    expect([...TERMINAL_TRIAL_OUTCOMES].sort()).toEqual([...required, ...admittedAdditions].sort())
    for (const kind of required) expect(TERMINAL_TRIAL_OUTCOMES).toContain(kind)
  })

  test("real harbor exception types classify without directory-name heuristics", () => {
    const trials = canaryTrials()
    const byOutcome = new Map(trials.map((t) => [t.outcome, t]))
    expect(byOutcome.get("agent_timeout")?.exceptionType).toBe("AgentTimeoutError")
    expect(byOutcome.get("agent_crash")?.exceptionType).toBe("NonZeroAgentExitCodeError")
    expect(byOutcome.get("missing_reward")?.reward).toBeNull()
    expect(byOutcome.get("missing_reward")?.exceptionType).toBeUndefined()
    expect(byOutcome.get("graded_fail")?.reward).toBe(0)
  })

  test("verifier and environment faults are their own kinds", () => {
    const base = nth(scanHarborJobDir(CANARY), 0, "base")
    const withException = (type: string) => {
      const raw = JSON.parse(JSON.stringify(base.raw)) as Record<string, unknown>
      raw.verifier_result = null
      raw.exception_info = {
        exception_type: type,
        exception_message: `${type} raised`,
        exception_traceback: "",
        occurred_at: "2026-08-20T09:10:00Z",
      }
      const parsed = parseHarborTrialResult({ ...base, raw })
      if (isTrialDefect(parsed)) throw new Error("unexpected defect")
      return parsed.outcome
    }
    expect(withException("VerifierTimeoutError")).toBe("verifier_error")
    expect(withException("VerifierOutputParseError")).toBe("verifier_error")
    expect(withException("EnvironmentStartTimeoutError")).toBe("environment_error")
    expect(withException("SandboxBuildFailedError")).toBe("environment_error")
    expect(withException("AgentSetupTimeoutError")).toBe("agent_timeout")
    expect(withException("ApiRateLimitError")).toBe("agent_crash")
  })

  test("an unnameable primary reward is MALFORMED — never guessed at", () => {
    const base = nth(scanHarborJobDir(CANARY), 0, "base")
    const withRewards = (rewards: unknown) => {
      const raw = JSON.parse(JSON.stringify(base.raw)) as Record<string, unknown>
      raw.verifier_result = { rewards }
      const parsed = parseHarborTrialResult({ ...base, raw })
      if (isTrialDefect(parsed)) throw new Error("unexpected defect")
      return parsed
    }
    // harbor `_extract_primary_reward`: the `reward` key wins...
    expect(withRewards({ reward: 1, tests_passed: 3 }).reward).toBe(1)
    // ...a SOLE key is the primary reward whatever it is called...
    expect(withRewards({ tests_passed: 0.25 }).reward).toBe(0.25)
    // ...and several keys with no `reward` has no primary reward at all.
    const ambiguous = withRewards({ tests_passed: 3, tests_total: 5 })
    expect(ambiguous.outcome).toBe("malformed_result")
    expect(ambiguous.reward).toBeNull()
    // A non-numeric reward is malformed too, never coerced.
    const nonNumeric = withRewards({ reward: "1" })
    expect(nonNumeric.outcome).toBe("malformed_result")
    expect(nonNumeric.reward).toBeNull()
  })

  test("a malformed trial makes the run incomplete without inventing a reward", () => {
    const trials = canaryTrials()
    const malformed: TerminalTrialRecord = {
      ...nth(trials, 0, "trials"),
      trialId: "malformed-1",
      outcome: "malformed_result",
      reward: null,
    }
    const report = buildFrom([...trials, malformed])
    expect(report.outcomes.malformed_result).toBe(1)
    expect(report.admission.complete).toBe(false)
    expect(report.admission.reasons).toContain("malformed-result:1")
    // It stays in the denominator with reward 0 — upstream's rule, verbatim.
    expect(metricsOf(report).nTrials).toBe(16)
  })

  test("classification NEVER changes the score — the reward alone does", () => {
    const trials = canaryTrials()
    const before = metricsOf(buildFrom(trials))
    // Re-label every trial's error without touching a single reward.
    const relabelled = trials.map((t) => ({ ...t, outcome: "environment_error" as const }))
    const after = metricsOf(buildFrom(relabelled))
    expect(after.accuracy).toBe(before.accuracy)
    expect(after.nTrials).toBe(before.nTrials)
    expect(after.passAtK).toEqual(before.passAtK)
  })

  test("an errored trial LOWERS official-shaped accuracy instead of disappearing", () => {
    const trials = canaryTrials()
    const withError = buildFrom(trials)
    // Same run with the errored trials simply dropped — the old dashboard fold.
    const dropped = buildFrom(trials.filter((t) => t.exceptionType === undefined))

    expect(metricsOf(withError).nTrials).toBe(15)
    expect(metricsOf(dropped).nTrials).toBeLessThan(15)
    expect(metricsOf(withError).accuracy).toBeLessThan(metricsOf(dropped).accuracy)
    expect(withError.outcomes.agent_timeout).toBe(1)
    expect(withError.outcomes.agent_crash).toBe(1)
    expect(withError.outcomes.missing_reward).toBe(1)
  })

  test("a missing reward is INCOMPLETE, never a fabricated miss", () => {
    const trials = canaryTrials()
    const report = buildFrom(trials)
    const missing = report.trials.find((t) => t.outcome === "missing_reward")
    expect(missing?.reward).toBeNull()
    // Never coerced to 0 on the receipt...
    expect(missing?.reward).not.toBe(0)
    // ...and the run says so.
    expect(report.admission.complete).toBe(false)
    expect(report.admission.reasons).toContain("missing-reward:1")
  })
})

describe("TB21-04 — completeness and standard-config admission", () => {
  /** A full 89x5 synthetic run assembled from the REAL canonical task manifest. */
  const fullRun = (k: number): TerminalTrialRecord[] => {
    const template = present(
      canaryTrials().find((t) => t.outcome === "graded_pass"),
      "template",
    )
    const out: TerminalTrialRecord[] = []
    for (const taskId of CANONICAL_TASK_IDS) {
      for (let attempt = 0; attempt < k; attempt += 1) {
        out.push({
          ...template,
          trialId: `${taskId}#${attempt}`,
          taskId,
          taskName: taskId,
          taskRef: present(canonicalTaskRef(taskId), "canonicalTaskRef(taskId)"),
          reward: attempt === 0 ? 1 : 0,
          outcome: attempt === 0 ? "graded_pass" : "graded_fail",
        })
      }
    }
    return out
  }

  test("a complete k=5 run over the pinned task set is official and promotable", () => {
    const report = buildFrom(fullRun(5))
    expect(report.admission.expectedTrials).toBe(EXPECTED_TASK_COUNT * 5)
    expect(report.admission.admittedTrials).toBe(445)
    expect(report.admission.observedTaskCount).toBe(EXPECTED_TASK_COUNT)
    expect(report.admission.complete).toBe(true)
    expect(report.admission.standardConfig).toBe(true)
    expect(report.admission.verdict).toBe("official")
    expect(report.admission.promotable).toBe(true)
  })

  test("a 444-trial k=5 run must NOT render as complete", () => {
    const trials = fullRun(5).slice(0, 444)
    const report = buildFrom(trials)
    expect(report.admission.admittedTrials).toBe(444)
    expect(report.admission.expectedTrials).toBe(445)
    expect(report.admission.complete).toBe(false)
    expect(report.admission.verdict).toBe("incomplete")
    expect(report.admission.promotable).toBe(false)
    expect(report.admission.reasons.join(" ")).toContain("444")
    // And nothing invented a 445th trial to close the gap.
    expect(report.trials.length).toBe(444)
  })

  test("k=1 expects exactly one admitted trial per task", () => {
    const complete = buildFrom(fullRun(1), { k: 1 })
    expect(complete.admission.expectedTrials).toBe(EXPECTED_TASK_COUNT)
    expect(complete.admission.complete).toBe(true)
    // The very same trial set is INCOMPLETE when the run declares k=5.
    const asK5 = buildFrom(fullRun(1), { k: 5 })
    expect(asK5.admission.complete).toBe(false)
  })

  test("a 3-task canary is honestly incomplete against the 89-task dataset", () => {
    const report = buildFrom(canaryTrials())
    expect(report.admission.observedTaskCount).toBe(3)
    expect(report.admission.expectedTaskCount).toBe(89)
    expect(report.admission.complete).toBe(false)
    expect(report.admission.verdict).toBe("incomplete")
  })

  // ── ONE-DEFECT ISOLATION ──────────────────────────────────────────────────
  // Each case below starts from an otherwise PERFECT 89x5 run and breaks exactly
  // one thing, so the clause under test is the only reason the run is incomplete.
  // Without these, the completeness rails pass for unrelated reasons and the
  // clauses they claim to defend can be deleted while the suite stays green.

  test("88 complete tasks are still an INCOMPLETE run (task coverage is its own rule)", () => {
    const trials = fullRun(5).filter(
      (t) => t.taskId !== nth(CANONICAL_TASK_IDS, 88, "CANONICAL_TASK_IDS"),
    )
    const report = buildFrom(trials)
    expect(report.admission.observedTaskCount).toBe(88)
    expect(report.admission.admittedTrials).toBe(440)
    // Every task it DID run is at full k=5, so nothing else can flag this.
    expect(report.admission.reasons).not.toContain("tasks-not-at-k5:1")
    expect(report.admission.complete).toBe(false)
    expect(report.admission.verdict).toBe("incomplete")
  })

  test("ONE missing reward makes an otherwise perfect 445-trial run incomplete", () => {
    const trials = fullRun(5)
    const control = buildFrom(trials)
    expect(control.admission.complete).toBe(true) // paired control

    const report = buildFrom(
      trials.map((t, i) =>
        i === 3 ? { ...t, reward: null, outcome: "missing_reward" as const } : t,
      ),
    )
    expect(report.admission.observedTaskCount).toBe(89)
    expect(report.admission.admittedTrials).toBe(445)
    expect(report.admission.complete).toBe(false)
    expect(report.admission.verdict).toBe("incomplete")
    expect(report.admission.reasons).toEqual(["missing-reward:1"])
    // The denominator is untouched: no invented zero, no dropped row.
    expect(metricsOf(report).nTrials).toBe(445)
  })

  test("ONE malformed trial makes an otherwise perfect 445-trial run incomplete", () => {
    const trials = fullRun(5)
    const report = buildFrom(
      trials.map((t, i) =>
        i === 7 ? { ...t, reward: null, outcome: "malformed_result" as const } : t,
      ),
    )
    expect(report.admission.complete).toBe(false)
    expect(report.admission.reasons).toEqual(["malformed-result:1"])
    expect(metricsOf(report).nTrials).toBe(445)
  })

  test("ONE unreadable trial record makes an otherwise perfect run incomplete", () => {
    const report = buildFrom(fullRun(5), {
      defects: [{ sourcePath: "/jobs/x/result.json", reason: "unparseable JSON" }],
    })
    expect(report.admission.complete).toBe(false)
    expect(report.admission.reasons).toEqual(["unreadable-trial-records:1"])
    // 444 real receipts + 1 unreadable record is never back-filled to 445.
    expect(report.trials.length).toBe(445)
    expect(report.defects.length).toBe(1)
  })

  test("ONE extra trial on one task makes an otherwise perfect run incomplete", () => {
    const trials = fullRun(5)
    const report = buildFrom([
      ...trials,
      { ...nth(trials, 0, "trials"), trialId: "extra-1", reward: 1 },
    ])
    expect(report.admission.admittedTrials).toBe(446)
    expect(report.admission.observedTaskCount).toBe(89)
    expect(report.admission.complete).toBe(false)
    expect(report.admission.reasons).toEqual(["admitted-trials:446/445", "tasks-not-at-k5:1"])
  })

  test("duplicate trial ids FAIL the run", () => {
    const trials = fullRun(5)
    const duplicated = [
      ...trials,
      { ...nth(trials, 0, "trials"), taskId: nth(trials, 0, "trials").taskId },
    ]
    const report = buildFrom(duplicated)
    expect(report.admission.verdict).toBe("rejected")
    expect(report.admission.duplicateTrialIds).toEqual([nth(trials, 0, "trials").trialId])
    expect(report.admission.promotable).toBe(false)
    // Both copies stay on the receipt — a duplicate is evidence, not a silent drop.
    expect(report.trials.length).toBe(446)
    expect(report.metrics).toBeUndefined()
  })

  test("an unknown task id is REJECTED", () => {
    const trials = fullRun(5)
    const report = buildFrom([
      ...trials,
      {
        ...nth(trials, 0, "trials"),
        trialId: "intruder",
        taskId: "terminal-bench/not-a-real-task",
      },
    ])
    expect(report.admission.verdict).toBe("rejected")
    expect(report.admission.rejections.map((r) => r.kind)).toContain("unknown_task")
  })

  test("a wrong task version/ref is REJECTED", () => {
    const trials = fullRun(5)
    const tampered = [
      {
        ...nth(trials, 0, "trials"),
        taskRef: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
      },
      ...trials.slice(1),
    ]
    const report = buildFrom(tampered)
    expect(report.admission.verdict).toBe("rejected")
    expect(report.admission.rejections.map((r) => r.kind)).toContain("task_ref_mismatch")
  })

  test("a missing or wrong DATASET ref fails the build", () => {
    const trials = fullRun(5)
    expect(() => buildFrom(trials, { datasetRef: "" })).toThrow(/datasetRef/)
    expect(() => buildFrom(trials, { datasetRef: "sha256:deadbeef" })).toThrow(/datasetRef/)
  })

  test("nonstandard timeout/resource overrides make the run NONSTANDARD, not official", () => {
    const scanned = scanHarborJobDir(NONSTANDARD)
    expect(scanned.length).toBe(1)
    const override = parseHarborTrialResult(nth(scanned, 0, "scanned"))
    if (isTrialDefect(override)) throw new Error("unexpected defect")
    expect(override.configOverrides).toEqual(["agent.override_timeout_sec=7200"])

    const trials = fullRun(5)
    const report = buildFrom([
      { ...nth(trials, 0, "trials"), configOverrides: override.configOverrides },
      ...trials.slice(1),
    ])
    expect(report.admission.complete).toBe(true)
    expect(report.admission.standardConfig).toBe(false)
    expect(report.admission.verdict).toBe("nonstandard")
    expect(report.admission.promotable).toBe(false)
    // Still scored — nonstandard is a provenance fact, not a denominator edit.
    expect(report.metrics?.nTrials).toBe(445)
  })

  test("a rewarded trial with no trajectory makes the run non-promotable", () => {
    const trials = fullRun(5)
    const report = buildFrom([withoutTrajectory(nth(trials, 0, "trials")), ...trials.slice(1)])
    expect(report.admission.verdict).toBe("official")
    expect(report.admission.complete).toBe(true)
    expect(report.admission.promotable).toBe(false)
    expect(report.admission.reasons.join(" ")).toContain("trajectory")
  })

  test("a FAILED trial with no trajectory is fine — upstream requires it only for rewarded ones", () => {
    const trials = fullRun(5)
    const failing = trials.findIndex((t) => t.reward === 0)
    const report = buildFrom(trials.map((t, i) => (i === failing ? withoutTrajectory(t) : t)))
    expect(report.admission.promotable).toBe(true)
  })
})

describe("TB21-04 — versionless TB2.0 artifacts are quarantined", () => {
  test("a 2.0 trial (retired dataset, no task ref) is rejected, not silently scored", () => {
    const scanned = scanHarborJobDir(TB20)
    expect(scanned.length).toBe(1)
    const legacy = parseHarborTrialResult(nth(scanned, 0, "scanned"))
    if (isTrialDefect(legacy)) throw new Error("unexpected defect")
    expect(legacy.datasetSource).toBe("terminal-bench/terminal-bench-2-0")
    expect(legacy.taskRef).toBeUndefined()

    const report = buildFrom([legacy])
    expect(report.admission.verdict).toBe("rejected")
    const kinds = report.admission.rejections.map((r) => r.kind)
    expect(kinds).toContain("dataset_source_mismatch")
    expect(kinds).toContain("missing_task_ref")
    expect(report.metrics).toBeUndefined()
  })
})

describe("TB21-04 — baseline and lever runs never union into one metric", () => {
  test("a trial set carrying two arms is refused", () => {
    const trials = canaryTrials()
    const mixed = trials.map((t, i) => ({ ...t, arm: i % 2 === 0 ? "baseline" : "levers" }))
    expect(() => buildFrom(mixed)).toThrow(/arm/i)
  })

  test("a trial whose arm contradicts the run's declared arm is refused", () => {
    const trials = canaryTrials().map((t) => ({ ...t, arm: "levers" }))
    expect(() => buildFrom(trials, { arm: "baseline" })).toThrow(/arm/i)
  })

  test("two separate arms score separately and keep their own denominators", () => {
    const trials = canaryTrials()
    const baseline = buildFrom(
      trials.map((t) => ({ ...t, arm: "baseline" })),
      { arm: "baseline" },
    )
    const levers = buildFrom(
      trials.map((t) => ({ ...t, arm: "levers" })),
      { arm: "levers" },
    )
    expect(baseline.arm).toBe("baseline")
    expect(levers.arm).toBe("levers")
    expect(baseline.metrics?.nTrials).toBe(15)
    expect(levers.metrics?.nTrials).toBe(15)
  })
})

describe("TB21-04 — report identity", () => {
  test("the report declares its suite, version and pinned dataset explicitly", () => {
    const report = buildFrom(canaryTrials())
    expect(report.schemaVersion).toBe("terminal-bench-report/v2")
    expect(report.benchmarkSuite).toBe("terminal-bench")
    expect(report.benchmarkVersion).toBe("2.1")
    expect(report.dataset).toBe(TERMINAL_BENCH_DATASET)
    expect(report.datasetRef).toBe(TERMINAL_BENCH_DATASET_REF)
    // Terminal reports must NOT carry a SWE dataset family.
    expect(Object.keys(report)).not.toContain("datasetFamily")
  })

  test("Harbor job ids and source paths are preserved as provenance", () => {
    const report = buildFrom(canaryTrials())
    expect(report.harborJobIds).toEqual(["622b427f-0ddc-54db-b64b-90960667e6be"])
    expect(report.sourcePaths).toEqual([CANARY])
  })

  test("defects are surfaced and make the run incomplete without inventing trials", () => {
    const report = buildFrom(canaryTrials(), {
      defects: [{ sourcePath: "/tmp/x/result.json", reason: "unparseable JSON" }],
    })
    expect(report.defects.length).toBe(1)
    expect(report.admission.complete).toBe(false)
    expect(report.trials.length).toBe(15)
  })
})

/**
 * MEASURED aug-22, the first two live canaries — the SILENT ZERO.
 *
 * The first run's brain never launched (a shim bug). Harbor reported the trial
 * as completed with `exception_info: null` and `reward: 0.0`, and every token
 * counter `null`. Fed through this pipeline it came out as:
 *
 *     outcomes {graded_fail: 1}   accuracy 0.0%   defects []
 *
 * i.e. byte-identical to a model that attempted the task and failed. That is the
 * confound this repo has been bitten by before (jun-20 throttle/miss, jul-03
 * auth crash read as 0/89): a measurement hole scored as a capability result.
 *
 * The discriminator is on the receipt already and was simply never consulted.
 * The second, WORKING canary reported 51 175 input / 4 742 output tokens; the
 * dead one reported `null` for all three counters. An agent that issued no model
 * call did not attempt the task.
 *
 * The rule is deliberately narrow: only a NON-passing, exception-free trial with
 * NO token telemetry at all is reclassified. A pass is never demoted, and a
 * failure that shows real token spend stays a real failure.
 */
describe("no_agent_activity — a trial the agent never attempted is not a model miss", () => {
  const trialDir = (
    root: string,
    name: string,
    agentResult: Record<string, unknown>,
    reward: number,
  ) => {
    const dir = join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, "result.json"),
      JSON.stringify({
        id: `id-${name}`,
        trial_name: name,
        task_name: "terminal-bench/openssl-selfsigned-cert",
        task_id: { org: "terminal-bench", name: "openssl-selfsigned-cert", ref: "sha256:aa" },
        source: "terminal-bench/terminal-bench-2-1",
        config: { task: { ref: "sha256:aa" } },
        agent_info: { name: "quanta", version: "1.0.0+gabc.dirty" },
        agent_result: agentResult,
        verifier_result: { rewards: { reward } },
        exception_info: null,
        started_at: "2026-08-22T11:39:09.000000",
        finished_at: "2026-08-22T11:39:31.000000",
      }),
    )
    return dir
  }

  /** The dead canary's shape, verbatim: no exception, reward 0, no telemetry. */
  const DEAD_AGENT_RESULT = {
    n_input_tokens: null,
    n_cache_tokens: null,
    n_output_tokens: null,
    cost_usd: null,
  }
  /** The green canary's shape. */
  const LIVE_AGENT_RESULT = {
    n_input_tokens: 51175,
    n_cache_tokens: 0,
    n_output_tokens: 4742,
    cost_usd: 0,
  }

  const outcomeOf = (agentResult: Record<string, unknown>, reward: number) => {
    const root = mkdtempSync(join(tmpdir(), "tb-activity-"))
    try {
      trialDir(root, "openssl-selfsigned-cert__x", agentResult, reward)
      const parsed = scanHarborJobDir(root).map((f) => parseHarborTrialResult(f))
      const records = parsed.filter((p): p is TerminalTrialRecord => !isTrialDefect(p))
      expect(records.length).toBe(1)
      return records[0]?.outcome
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  test("a failing trial with NO token telemetry is not counted as a model failure", () => {
    expect(outcomeOf(DEAD_AGENT_RESULT, 0)).toBe("no_agent_activity")
  })

  test("PAIRED CONTROL — a failing trial WITH real token spend stays a model failure", () => {
    expect(outcomeOf(LIVE_AGENT_RESULT, 0)).toBe("graded_fail")
  })

  test("PAIRED CONTROL — a PASS is never demoted, telemetry or not", () => {
    expect(outcomeOf(LIVE_AGENT_RESULT, 1)).toBe("graded_pass")
    expect(outcomeOf(DEAD_AGENT_RESULT, 1)).toBe("graded_pass")
  })

  test("partial telemetry still counts as an attempt (only a TOTAL absence reclassifies)", () => {
    expect(outcomeOf({ ...DEAD_AGENT_RESULT, n_output_tokens: 12 }, 0)).toBe("graded_fail")
    expect(outcomeOf({ ...DEAD_AGENT_RESULT, n_input_tokens: 5 }, 0)).toBe("graded_fail")
  })

  test("the new outcome is part of the closed taxonomy the report tallies", () => {
    expect(TERMINAL_TRIAL_OUTCOMES).toContain("no_agent_activity")
  })
})

/**
 * A classification nobody acts on is decoration. `missing_reward` and
 * `malformed_result` both make a run INCOMPLETE and name themselves in the
 * admission reasons, because neither is a scoreable model result. A trial the
 * agent never attempted is the same class of thing — and is the one that can
 * silently pass for a full campaign, since Harbor reports it as a normal
 * completed trial.
 */
describe("admission — a run containing unattempted trials cannot be called complete", () => {
  const trialWith = (
    over: Partial<TerminalTrialRecord> & Pick<TerminalTrialRecord, "outcome">,
    i: number,
  ): TerminalTrialRecord => {
    const base = canaryTrials()[0]
    if (base === undefined) throw new Error("fixture has no trials")
    return {
      ...base,
      trialId: `synthetic-${i}`,
      trialName: `synthetic-${i}`,
      ...over,
    }
  }

  test("it names itself in the admission reasons and blocks `complete`", () => {
    const report = buildFrom([trialWith({ outcome: "no_agent_activity", reward: 0 }, 1)])
    expect(report.admission.reasons.some((r) => r.startsWith("no-agent-activity:"))).toBe(true)
    expect(report.admission.complete).toBe(false)
    expect(report.admission.promotable).toBe(false)
  })

  test("PAIRED CONTROL — a run with no such trial does not name the reason", () => {
    const report = buildFrom([trialWith({ outcome: "graded_fail", reward: 0 }, 2)])
    expect(report.admission.reasons.some((r) => r.startsWith("no-agent-activity:"))).toBe(false)
  })
})
