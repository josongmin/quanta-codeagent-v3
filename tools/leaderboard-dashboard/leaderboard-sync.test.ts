/**
 * MED-C — the legacy-normalization boundary must be SINGLE.
 *
 * `leaderboard-sync` reads the SAME `*.report.json` trove the dashboard reads and
 * folds it into the SWE leaderboard SSOT. Before this rail it re-derived its own
 * reading of that trove: raw `JSON.parse` → `d.perInstance ?? d.results` → rows,
 * with NO suite identity involved. Any artifact from another benchmark whose task
 * ids happened to match the SWE instance-id shape therefore became a SWE "solve"
 * in the leaderboard.
 *
 * Every assertion here observes the REAL fold function the IO shell calls.
 */
import { describe, expect, test } from "bun:test"
import {
  CANONICAL_TASK_IDS,
  canonicalTaskRef,
  TERMINAL_BENCH_DATASET_REF,
} from "@/apps/bench/terminal/dataset"
import { buildTerminalRunReport, type TerminalTrialRecord } from "@/apps/bench/terminal/report"
import { encodeCanonicalReport } from "@/runner/batch/report-envelope"
import { solvedFromReports, sweRowsFromArtifact } from "./leaderboard-sync"

const TS = 1_700_000_000_000

/** A legacy SWE artifact exactly as the batch writer lands it (no suite key). */
const sweArtifact = (ids: readonly string[]): Record<string, unknown> => ({
  timestamp: "2026-08-22T00:00:00.000Z",
  model: "gpt-5.5",
  provider: "openai",
  knobs: { preset: "agentless-v2", resolved: {}, inactive: [] },
  perInstance: ids.map((id) => ({ id, passed: true, turns: 7, patchBytes: 100 })),
})

/** A canonical Terminal artifact whose TRIAL ids collide with the SWE id shape.
 *  Terminal task names are free-form, so this is a shape a real Harbor dataset
 *  can produce — it is not a contrived impossibility. */
const terminalArtifact = (ids: readonly string[]): Record<string, unknown> =>
  JSON.parse(
    JSON.stringify(
      encodeCanonicalReport(
        buildTerminalRunReport({
          datasetRef: TERMINAL_BENCH_DATASET_REF,
          timestamp: "2026-08-22T01:00:00.000Z",
          arm: "levers",
          k: 1,
          harborJobIds: ["job-1"],
          sourcePaths: ["/jobs"],
          model: "gpt-5.5",
          preset: "TB +levers",
          // The SWE-shaped id rides on the TRIAL id; the task keeps a canonical
          // 2.1 identity so the artifact is admissible in the first place (an
          // inadmissible fixture would prove nothing about the read boundary).
          trials: ids.map((id, index): TerminalTrialRecord => {
            const taskId = CANONICAL_TASK_IDS[index] as string
            return {
              trialId: id,
              taskId,
              taskName: taskId.split("/")[1] as string,
              taskRef: canonicalTaskRef(taskId) as string,
              reward: 1,
              outcome: "graded_pass",
              startedAt: null,
              finishedAt: null,
              durationSec: 1,
              uncachedInputTokens: null,
              cachedInputTokens: null,
              outputTokens: null,
              costUsd: null,
              configOverrides: [],
              sourcePath: `/jobs/${id}/result.json`,
            }
          }),
          defects: [],
        }),
      ),
    ),
  ) as Record<string, unknown>

/** The PRE-BFND-02 Terminal encoding: no suite key, Terminal rode the family axis. */
const legacyTerminalArtifact = (ids: readonly string[]): Record<string, unknown> => ({
  timestamp: "2026-07-03T00:00:00.000Z",
  model: "gpt-5.5",
  datasetFamily: "terminal-bench",
  source: "terminal-bench-harbor",
  knobs: { preset: "TB +levers", resolved: {}, inactive: [] },
  perInstance: ids.map((id) => ({ id, passed: true, turns: 0, durationMs: 1000 })),
})

describe("MED-C — leaderboard-sync enters the trove through the ONE read boundary", () => {
  test("a legacy SWE artifact still folds (control: the gate is not refusing everything)", () => {
    const rows = sweRowsFromArtifact(sweArtifact(["django__django-11149"]), TS)
    expect(rows).toEqual([
      {
        id: "django__django-11149",
        passed: true,
        preset: "agentless-v2",
        model: "gpt-5.5",
        turns: 7,
        ts: TS,
      },
    ])
    expect([...solvedFromReports(rows).keys()]).toEqual(["django__django-11149"])
  })

  test("a CANONICAL Terminal artifact contributes NOTHING to the SWE leaderboard", () => {
    expect(sweRowsFromArtifact(terminalArtifact(["kv-store-grpc"]), TS)).toEqual([])
  })

  test("TEETH: a Terminal trial whose id matches the SWE shape is STILL excluded", () => {
    // This is the defect the single boundary closes. The old reader's only defence
    // was `SWE_ID`, a shape regex — so a Terminal trial named like a SWE instance
    // was folded as a SWE solve. Identity, not id shape, must decide.
    const colliding = "astropy__astropy-13033"
    expect(sweRowsFromArtifact(terminalArtifact([colliding]), TS)).toEqual([])
    expect(sweRowsFromArtifact(legacyTerminalArtifact([colliding]), TS)).toEqual([])
    // PAIRED CONTROL: the identical id inside a SWE artifact IS folded, proving the
    // exclusion is driven by the artifact's suite and not by the id itself.
    expect(sweRowsFromArtifact(sweArtifact([colliding]), TS).map((r) => r.id)).toEqual([colliding])
  })

  test("an unidentifiable artifact is dropped, never guessed into the SWE set", () => {
    expect(sweRowsFromArtifact({ benchmarkSuite: "swt-bench", perInstance: [] }, TS)).toEqual([])
    expect(sweRowsFromArtifact({ datasetFamily: "promax", perInstance: [] }, TS)).toEqual([])
    expect(sweRowsFromArtifact(null, TS)).toEqual([])
    expect(sweRowsFromArtifact([sweArtifact(["a__b-1"])], TS)).toEqual([])
  })

  test("the legacy `results` alias is still read (byte-compatible with the old reader)", () => {
    const legacy = {
      timestamp: "t",
      model: "m",
      knobs: { preset: "p" },
      results: [{ instance_id: "sphinx-doc__sphinx-10323", passed: true, turns: 4 }],
    }
    expect(sweRowsFromArtifact(legacy, TS).map((r) => r.id)).toEqual(["sphinx-doc__sphinx-10323"])
  })
})
