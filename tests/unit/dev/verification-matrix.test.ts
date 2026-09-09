import { describe, expect, test } from "bun:test"
import {
  aggregateMatrixReceipts,
  planVerificationMatrix,
  workerReceipt,
} from "../../../tools/dev/verification-matrix"

describe("verification matrix aggregate", () => {
  const expected = planVerificationMatrix([
    { id: "pure:0", files: ["a.test.ts"] },
    { id: "pure:1", files: ["b.test.ts"] },
  ]).chunks

  test("count match alone is not PASS", () => {
    const verdict = aggregateMatrixReceipts({
      expected,
      receipts: [
        workerReceipt({ chunkId: "pure:0", files: ["a.test.ts"], outcome: "passed" }),
        workerReceipt({
          chunkId: "pure:1",
          files: ["other.test.ts"],
          outcome: "passed",
          junitSha256: "abc",
        }),
      ],
    })
    expect(verdict.verdict).toBe("failed")
    expect(verdict.reasons.some((reason) => reason.startsWith("stale:"))).toBe(true)
  })

  test("missing, cancelled, and corrupt receipts fail", () => {
    expect(
      aggregateMatrixReceipts({
        expected,
        receipts: [
          workerReceipt({
            chunkId: "pure:0",
            files: ["a.test.ts"],
            outcome: "passed",
            junitSha256: "x",
          }),
        ],
      }).reasons,
    ).toContain("missing:pure:1")
    expect(
      aggregateMatrixReceipts({
        expected,
        receipts: [
          workerReceipt({
            chunkId: "pure:0",
            files: ["a.test.ts"],
            outcome: "cancelled",
            junitSha256: "x",
          }),
          workerReceipt({
            chunkId: "pure:1",
            files: ["b.test.ts"],
            outcome: "passed",
            junitSha256: "x",
          }),
        ],
      }).reasons,
    ).toContain("cancelled:pure:0")
  })
})
