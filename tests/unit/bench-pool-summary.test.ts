import { describe, expect, test } from "bun:test"
import { summarizePoolRunLines } from "../../src/apps/bench/commands/pool"
import type { PoolChunkResult } from "../../src/apps/bench/remote/pool"

describe("pool summary lines", () => {
  test("partial chunk is surfaced as PARTIAL with missing instance ids", () => {
    const out: PoolChunkResult[] = [
      {
        chunk: { runId: "partial", datasetPath: "/tmp/partial.jsonl", instanceIds: ["a", "b"] },
        result: { resolved: ["a"] },
        attempts: 2,
        lost: false,
        missing: ["b"],
      },
    ]
    expect(summarizePoolRunLines(out, 1)).toEqual([
      "[pool] chunk partial: ⚠️ PARTIAL — resolved 1 | unresolved 0 | missing 1 | attempts 2",
      "[pool]   ❓ MISSING b",
      "[pool] DONE — total resolved 1 across 1 chunks; 0 lost; 1 partial",
    ])
  })
})
