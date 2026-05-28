import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ResultStore } from "@/../src/apps/eval/storage"
import { resolveGroundingBaseline } from "@/../src/apps/eval/grounding"

describe("grounding baseline resolver", () => {
  test("resolves the latest prior finished comparable run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "grounding-baseline-"))
    const store = new ResultStore({ dir, now: () => 100 })
    await store.finish({
      runId: "older",
      tier: "grounding",
      argv: [],
      counts: { pass: 1, partial: 0, fail: 0, error: 0, skipped: 0 },
      durationMs: 1,
      status: "finished",
      params: {
        suite: "canary",
        harnessFingerprint: "h1",
        routeFingerprint: "r1",
        caseSetFingerprint: "c1",
      },
    })
    const store2 = new ResultStore({ dir, now: () => 200 })
    await store2.finish({
      runId: "newer",
      tier: "grounding",
      argv: [],
      counts: { pass: 1, partial: 0, fail: 0, error: 0, skipped: 0 },
      durationMs: 1,
      status: "finished",
      params: {
        suite: "canary",
        harnessFingerprint: "h1",
        routeFingerprint: "r1",
        caseSetFingerprint: "c1",
      },
    })
    const store3 = new ResultStore({ dir, now: () => 300 })
    await store3.finish({
      runId: "candidate",
      tier: "grounding",
      argv: [],
      counts: { pass: 1, partial: 0, fail: 0, error: 0, skipped: 0 },
      durationMs: 1,
      status: "finished",
      params: {
        suite: "canary",
        harnessFingerprint: "h1",
        routeFingerprint: "r1",
        caseSetFingerprint: "c1",
      },
    })
    await store3.drain()

    const summaries = new ResultStore({ dir }).readRunSummaries("grounding")
    expect(summaries.map((summary) => summary.runId)).toEqual(["candidate", "newer", "older"])
    expect(resolveGroundingBaseline("candidate", summaries)).toEqual({
      status: "resolved",
      candidateRunId: "candidate",
      baselineRunId: "newer",
      reason: "resolved latest prior finished comparable grounding run",
      suite: "canary",
      harnessFingerprint: "h1",
      routeFingerprint: "r1",
      caseSetFingerprint: "c1",
    })
  })

  test("fails closed when candidate summary is missing or unverified", () => {
    expect(resolveGroundingBaseline("missing", [])).toEqual({
      status: "candidate_missing",
      candidateRunId: "missing",
      reason: "candidate run summary not found",
    })

    expect(
      resolveGroundingBaseline("candidate", [
        {
          ts: 1,
          schema: 1,
          runId: "candidate",
          tier: "grounding",
          argv: [],
          counts: { pass: 1, partial: 0, fail: 0, error: 0, skipped: 0 },
          durationMs: 1,
          status: "finished",
          params: { suite: "canary" },
        },
      ]),
    ).toEqual({
      status: "candidate_unverified",
      candidateRunId: "candidate",
      reason: "candidate run summary is missing suite or fingerprint fields",
      suite: "canary",
    })
  })

  test("returns not_found when no prior comparable finished run exists", () => {
    expect(
      resolveGroundingBaseline("candidate", [
        {
          ts: 20,
          schema: 1,
          runId: "candidate",
          tier: "grounding",
          argv: [],
          counts: { pass: 1, partial: 0, fail: 0, error: 0, skipped: 0 },
          durationMs: 1,
          status: "finished",
          params: {
            suite: "canary",
            harnessFingerprint: "h1",
            routeFingerprint: "r1",
            caseSetFingerprint: "c1",
          },
        },
        {
          ts: 10,
          schema: 1,
          runId: "other",
          tier: "grounding",
          argv: [],
          counts: { pass: 1, partial: 0, fail: 0, error: 0, skipped: 0 },
          durationMs: 1,
          status: "finished",
          params: {
            suite: "canary",
            harnessFingerprint: "h1",
            routeFingerprint: "r2",
            caseSetFingerprint: "c1",
          },
        },
      ]),
    ).toEqual({
      status: "not_found",
      candidateRunId: "candidate",
      reason: "no prior finished grounding run matched suite and fingerprints",
      suite: "canary",
      harnessFingerprint: "h1",
      routeFingerprint: "r1",
      caseSetFingerprint: "c1",
    })
  })
})
