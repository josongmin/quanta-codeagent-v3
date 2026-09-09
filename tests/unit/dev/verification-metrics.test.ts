import { describe, expect, test } from "bun:test"
import { summarizeSamples } from "../../../tools/dev/verification-metrics"

describe("verification metrics", () => {
  test("rejects overlapping phases instead of summing them", () => {
    expect(() =>
      summarizeSamples([
        {
          outcome: "passed",
          intraParallel: 1,
          loadAverage1m: 0.2,
          phases: [
            { phase: "setup", startedMs: 0, endedMs: 10 },
            { phase: "run", startedMs: 5, endedMs: 20 },
          ],
        },
      ]),
    ).toThrow("overlapping")
  })

  test("failed samples do not disappear from the count", () => {
    const summary = summarizeSamples([
      {
        outcome: "failed",
        intraParallel: 1,
        loadAverage1m: null,
        phases: [{ phase: "run", startedMs: 0, endedMs: 40 }],
      },
      {
        outcome: "passed",
        intraParallel: 1,
        loadAverage1m: null,
        phases: [{ phase: "run", startedMs: 0, endedMs: 10 }],
      },
    ])
    expect(summary.count).toBe(2)
    expect(summary.medianMs).toBe(40)
  })
})
