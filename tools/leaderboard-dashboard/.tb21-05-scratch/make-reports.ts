import { mkdirSync, writeFileSync } from "node:fs"
import {
  CANONICAL_TASK_IDS, canonicalTaskRef, TERMINAL_BENCH_DATASET, TERMINAL_BENCH_DATASET_REF,
} from "@/apps/bench/terminal/dataset"
import { buildTerminalRunReport, type TerminalTrialRecord } from "@/apps/bench/terminal/report"
import { encodeCanonicalReport } from "@/runner/batch/report-envelope"

const OUT = process.argv[2]!
mkdirSync(OUT, { recursive: true })

const trial = (taskIdx: number, n: number, outcome: any, reward: number | null): TerminalTrialRecord => {
  const taskId = CANONICAL_TASK_IDS[taskIdx] as string
  return {
    trialId: `t-${taskIdx}-${n}`, taskId, taskName: taskId.split("/")[1] as string,
    taskRef: canonicalTaskRef(taskId) as string, datasetSource: TERMINAL_BENCH_DATASET,
    reward, outcome, startedAt: "2026-08-22T01:00:00.000Z", finishedAt: "2026-08-22T01:05:00.000Z",
    durationSec: 300, uncachedInputTokens: 1000, cachedInputTokens: 100, outputTokens: 50,
    costUsd: 0.5, configOverrides: [], sourcePath: `/jobs/${taskIdx}-${n}/result.json`,
    harborJobId: "job-abc", trajectoryPath: `/jobs/${taskIdx}-${n}/trajectory.json`,
  }
}
const manifest = (profile: string, over: Record<string, unknown> = {}) => ({
  schemaVersion: "terminal-bench-run/v2", benchmarkSuite: "terminal-bench", benchmarkVersion: "2.1",
  dataset: TERMINAL_BENCH_DATASET, datasetRef: TERMINAL_BENCH_DATASET_REF, harborVersion: "0.21.0",
  quantaSha: "8e9ec7a9dd32", dirty: true, agentVersion: "1.0.025+g8e9ec7a9dd32.dirty",
  profile, model: "gpt-5.5", provider: "openai", reasoningEffort: "xhigh", sandbox: "docker",
  k: 5, concurrency: 4, timestamp: "2026-08-22T01:00:00.000Z", arm: profile,
  preset: `terminal-bench-2.1/${profile}`, promotable: false, taskSelection: "full", ...over,
})
const write = (name: string, body: unknown) =>
  writeFileSync(`${OUT}/${name}.report.json`, `${JSON.stringify(body, null, 2)}\n`)

// (2) a "canary"-shaped COMPLETE-ish run: 4 tasks × k=5, one crash, mixed rewards.
const canary: TerminalTrialRecord[] = []
for (let t = 0; t < 4; t++)
  for (let n = 0; n < 5; n++) {
    const passes = t < 2 ? (n < 3 ? 1 : 0) : 0
    canary.push(t === 3 && n === 0 ? trial(t, n, "agent_crash", null) : trial(t, n, passes ? "graded_pass" : "graded_fail", passes))
  }
write("tb-canary-quanta-full", {
  ...encodeCanonicalReport(buildTerminalRunReport({
    datasetRef: TERMINAL_BENCH_DATASET_REF, timestamp: "2026-08-22T01:00:00.000Z",
    arm: "quanta-full", k: 5, harborJobIds: ["job-abc"], sourcePaths: ["/jobs"],
    model: "gpt-5.5", preset: "terminal-bench-2.1/quanta-full", trials: canary, defects: [],
  })), manifest: manifest("quanta-full"),
})

// (5) a SECOND profile — same dataset, different profile ⇒ a second scored row.
const control = canary.slice(0, 10).map((t, i) => ({ ...t, trialId: `c-${i}`, reward: 0, outcome: "graded_fail" as const }))
write("tb-canary-control", {
  ...encodeCanonicalReport(buildTerminalRunReport({
    datasetRef: TERMINAL_BENCH_DATASET_REF, timestamp: "2026-08-22T02:00:00.000Z",
    arm: "control", k: 5, harborJobIds: ["job-def"], sourcePaths: ["/jobs"],
    model: "gpt-5.5", preset: "terminal-bench-2.1/control", trials: control, defects: [],
  })), manifest: manifest("control"),
})

// (3) an INCOMPLETE run: one task, one trial, k=5.
write("tb-incomplete", {
  ...encodeCanonicalReport(buildTerminalRunReport({
    datasetRef: TERMINAL_BENCH_DATASET_REF, timestamp: "2026-08-22T03:00:00.000Z",
    arm: "quanta-full", k: 5, harborJobIds: ["job-ghi"], sourcePaths: ["/jobs"],
    model: "gpt-5.5", preset: "terminal-bench-2.1/quanta-full",
    trials: [trial(7, 0, "graded_pass", 1)], defects: [],
  })), manifest: manifest("quanta-full", { reasoningEffort: "high" }),
})

// (4) the LEGACY versionless TB2.0 encoding.
write("tb-legacy-2-0", {
  timestamp: "2026-07-03T00:00:00.000Z", model: "gpt-5.5", datasetFamily: "terminal-bench",
  source: "terminal-bench-harbor", arm: "levers",
  knobs: { preset: "TB +levers", resolved: {}, inactive: [] },
  perInstance: [{ id: "task-a", passed: true, turns: 0, durationMs: 100 }],
})

// a SWE report, so the mixed root is realistic.
write("swe-verified", {
  timestamp: "2026-08-22T00:00:00.000Z", model: "gpt-5.5",
  knobs: { preset: "agentless-v2", resolved: {}, inactive: [] },
  totals: { total: 2, resolved: 1 },
  perInstance: [
    { id: "django__django-1", passed: true, turns: 3, durationMs: 10 },
    { id: "django__django-2", passed: false, turns: 4, durationMs: 20 },
  ],
})
process.stdout.write(`wrote reports to ${OUT}\n`)
