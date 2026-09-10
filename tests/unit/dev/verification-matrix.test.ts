import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { junitExecutedFiles } from "../../../tools/dev/test-shard-timings"
import {
  aggregateMatrixReceipts,
  parseVerificationMatrixPlan,
  planVerificationMatrix,
  workerReceipt,
} from "../../../tools/dev/verification-matrix"

describe("verification matrix aggregate", () => {
  const HEAD = "a".repeat(40)
  const chunk = (id: string, files: readonly string[]) => ({
    id,
    files,
    resourceClass: "pure" as const,
    predictedMs: 1_000,
    testTimeoutMs: 120_000,
    intraParallel: 8,
  })
  const plan = planVerificationMatrix(HEAD, [
    chunk("pure-0", ["a.test.ts"]),
    chunk("pure-1", ["b.test.ts"]),
  ])
  const receipt = (input: {
    readonly chunkId: string
    readonly files: readonly string[]
    readonly outcome: "passed" | "failed" | "cancelled"
    readonly junitSha256?: string
    readonly headSha?: string
    readonly planSha256?: string
    readonly snapshotStable?: boolean
    readonly executedFiles?: readonly string[]
    readonly testTimeoutMs?: number
    readonly intraParallel?: number
  }) =>
    workerReceipt({
      headSha: input.headSha ?? plan.headSha,
      planSha256: input.planSha256 ?? plan.planSha256,
      chunkId: input.chunkId,
      plannedFiles: input.files,
      executedFiles: input.executedFiles ?? input.files,
      testTimeoutMs: input.testTimeoutMs ?? 120_000,
      intraParallel: input.intraParallel ?? 8,
      outcome: input.outcome,
      snapshotStable: input.snapshotStable ?? true,
      junitFile: `${input.chunkId}.junit.xml`,
      ...(input.junitSha256 === undefined ? {} : { junitSha256: input.junitSha256 }),
    })
  const junitDigests = new Map([
    ["pure-0.junit.xml", "x"],
    ["pure-1.junit.xml", "x"],
  ])

  test("plan identity binds exact HEAD and canonical chunk membership", () => {
    const reordered = planVerificationMatrix(HEAD, [
      chunk("pure-1", ["b.test.ts"]),
      chunk("pure-0", ["a.test.ts"]),
    ])
    expect(reordered).toEqual(plan)
    expect(plan.planSha256).toHaveLength(64)
    expect(
      planVerificationMatrix(HEAD, [
        { ...chunk("pure-0", ["a.test.ts"]), intraParallel: 1 },
        chunk("pure-1", ["b.test.ts"]),
      ]).planSha256,
    ).not.toBe(plan.planSha256)
    expect(() => parseVerificationMatrixPlan({ ...plan, headSha: "b".repeat(40) })).toThrow(
      /digest mismatch/,
    )
  })

  test("plan rejects empty, duplicate, absolute, and escaping populations", () => {
    expect(() => planVerificationMatrix(HEAD, [])).toThrow(/empty matrix plan/)
    expect(() =>
      planVerificationMatrix(HEAD, [chunk("a", ["one.test.ts"]), chunk("a", ["two.test.ts"])]),
    ).toThrow(/duplicate matrix chunk id/)
    expect(() =>
      planVerificationMatrix(HEAD, [chunk("a", ["one.test.ts"]), chunk("b", ["one.test.ts"])]),
    ).toThrow(/duplicate matrix file/)
    expect(() => planVerificationMatrix(HEAD, [chunk("a", ["/tmp/x.test.ts"])])).toThrow(
      /unsafe matrix file/,
    )
    expect(() => planVerificationMatrix(HEAD, [chunk("a", ["../x.test.ts"])])).toThrow(
      /unsafe matrix file/,
    )
    expect(() => planVerificationMatrix(HEAD, [chunk("a", ["tests/../x.test.ts"])])).toThrow(
      /unsafe matrix file/,
    )
    expect(() => planVerificationMatrix(HEAD, [chunk("bad:id", ["x.test.ts"])])).toThrow(
      /unsafe matrix chunk id/,
    )
  })

  test("count match alone is not PASS", () => {
    const verdict = aggregateMatrixReceipts({
      plan,
      receipts: [
        receipt({ chunkId: "pure-0", files: ["a.test.ts"], outcome: "passed" }),
        receipt({
          chunkId: "pure-1",
          files: ["other.test.ts"],
          outcome: "passed",
          junitSha256: "abc",
        }),
      ],
      junitDigests,
    })
    expect(verdict.verdict).toBe("failed")
    expect(verdict.reasons.some((reason) => reason.startsWith("stale-plan:"))).toBe(true)
  })

  test("missing, cancelled, and corrupt receipts fail", () => {
    expect(
      aggregateMatrixReceipts({
        plan,
        receipts: [
          receipt({
            chunkId: "pure-0",
            files: ["a.test.ts"],
            outcome: "passed",
            junitSha256: "x",
          }),
        ],
        junitDigests,
      }).reasons,
    ).toContain("missing:pure-1")
    expect(
      aggregateMatrixReceipts({
        plan,
        receipts: [
          receipt({
            chunkId: "pure-0",
            files: ["a.test.ts"],
            outcome: "cancelled",
            junitSha256: "x",
          }),
          receipt({
            chunkId: "pure-1",
            files: ["b.test.ts"],
            outcome: "passed",
            junitSha256: "x",
          }),
        ],
        junitDigests,
      }).reasons,
    ).toContain("cancelled:pure-0")
  })

  test("wrong HEAD, wrong plan, and mismatched JUnit fail closed", () => {
    const verdict = aggregateMatrixReceipts({
      plan,
      receipts: [
        receipt({
          chunkId: "pure-0",
          files: ["a.test.ts"],
          outcome: "passed",
          junitSha256: "x",
          headSha: "b".repeat(40),
        }),
        receipt({
          chunkId: "pure-1",
          files: ["b.test.ts"],
          outcome: "passed",
          junitSha256: "wrong",
          planSha256: "c".repeat(64),
          snapshotStable: false,
        }),
      ],
      junitDigests,
    })
    expect(verdict.reasons).toContain("wrong-head:pure-0")
    expect(verdict.reasons).toContain("wrong-plan:pure-1")
    expect(verdict.reasons).toContain("junit-mismatch:pure-1")
    expect(verdict.reasons).toContain("snapshot-drift:pure-1")
  })

  test("only exact receipts plus exact JUnit bytes pass", () => {
    expect(
      aggregateMatrixReceipts({
        plan,
        receipts: [
          receipt({
            chunkId: "pure-0",
            files: ["a.test.ts"],
            outcome: "passed",
            junitSha256: "x",
          }),
          receipt({
            chunkId: "pure-1",
            files: ["b.test.ts"],
            outcome: "passed",
            junitSha256: "x",
          }),
        ],
        junitDigests,
      }),
    ).toEqual({ verdict: "passed", reasons: [] })
  })

  test("JUnit, not the plan copy, proves the exact executed file set and policy", () => {
    const xml = [
      '<testsuites name="bun test">',
      '<testsuite name="a" file="a.test.ts"><testcase name="a" file="a.test.ts" /></testsuite>',
      '<testsuite name="b" file="b&amp;c.test.ts"><testcase name="b" /></testsuite>',
      "</testsuites>",
    ].join("")
    expect(junitExecutedFiles(xml)).toEqual(["a.test.ts", "b&c.test.ts"])

    const verdict = aggregateMatrixReceipts({
      plan,
      receipts: [
        receipt({
          chunkId: "pure-0",
          files: ["a.test.ts"],
          executedFiles: ["other.test.ts"],
          outcome: "passed",
          junitSha256: "x",
          testTimeoutMs: 60_000,
          intraParallel: 1,
        }),
        receipt({
          chunkId: "pure-1",
          files: ["b.test.ts"],
          outcome: "passed",
          junitSha256: "x",
        }),
      ],
      junitDigests,
    })
    expect(verdict.reasons).toContain("stale-executed:pure-0")
    expect(verdict.reasons).toContain("wrong-timeout:pure-0")
    expect(verdict.reasons).toContain("wrong-parallel:pure-0")
  })

  test("shadow workflow transports the frozen plan and real worker artifacts", () => {
    const workflow = readFileSync(
      join(import.meta.dir, "../../../.github/workflows/ci.yml"),
      "utf8",
    )
    expect(workflow).toContain("fromJSON(needs.full-plan.outputs.chunks)")
    expect(workflow).toContain("fail-fast: false")
    expect(workflow).toContain("max-parallel: 4")
    expect(workflow).toContain("verification-matrix-cli.ts worker")
    expect(workflow).toContain("--chunk=$" + "{{ matrix.chunk }}")
    expect(workflow).toContain("actions/upload-artifact@v4")
    expect(workflow).toContain("actions/download-artifact@v4")
    expect(workflow).toContain("merge-multiple: true")
    expect(workflow).toContain("include-hidden-files: true")
    expect(workflow).not.toContain("QUANTA_MATRIX_CHUNK_FILES")
    expect(workflow).toContain("test-timings-v2.json")
    const matrixCli = readFileSync(
      join(import.meta.dir, "../../../tools/dev/verification-matrix-cli.ts"),
      "utf8",
    )
    expect(matrixCli).toMatch(/selectTestPoliciesForTier\s*\(/)
    expect(matrixCli).toContain('"full"')
  })
})
