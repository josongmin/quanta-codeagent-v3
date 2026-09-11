import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { executedFileSetDigest } from "../../../tools/dev/executed-file-set"
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
  /**
   * A plan must now cover a real population: `MATRIX_PLAN_FILE_FLOOR` refuses
   * the two-file fixture this suite used to build, because a plan over two
   * files is shaped exactly like a real one, aggregates to a green, and proves
   * nothing.
   */
  const manyFiles = (prefix: string, count: number): readonly string[] =>
    Array.from({ length: count }, (_, index) => `${prefix}-${index}.test.ts`)
  const POPULATION = {
    tier: "pr",
    universe: 300,
    membershipSha256: "1".repeat(64),
    policySha256: "2".repeat(64),
    capabilitySha256: "3".repeat(64),
  } as const
  const planFor = (population = POPULATION) =>
    planVerificationMatrix(HEAD, population, [
      chunk("pure-0", manyFiles("a", 60)),
      chunk("pure-1", manyFiles("b", 60)),
    ])
  const plan = planFor()
  const receipt = (input: {
    readonly chunkId: string
    readonly files: readonly string[]
    readonly outcome: "passed" | "failed" | "cancelled"
    readonly junitSha256?: string
    readonly headSha?: string
    readonly planSha256?: string
    readonly snapshotStable?: boolean
    readonly executedFiles?: readonly string[]
    readonly executedDigestSha256?: string
    readonly testTimeoutMs?: number
    readonly intraParallel?: number
  }) =>
    workerReceipt({
      headSha: input.headSha ?? plan.headSha,
      planSha256: input.planSha256 ?? plan.planSha256,
      chunkId: input.chunkId,
      plannedFiles: input.files,
      executedFiles: input.executedFiles ?? input.files,
      // Default to the digest OF the executed list, so a fixture that does not
      // care about the digest still produces a self-consistent receipt and the
      // forged-digest arm below is the only place the two disagree.
      executedDigestSha256:
        input.executedDigestSha256 ?? executedFileSetDigest(input.executedFiles ?? input.files),
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
    const reordered = planVerificationMatrix(HEAD, POPULATION, [
      chunk("pure-1", manyFiles("b", 60)),
      chunk("pure-0", manyFiles("a", 60)),
    ])
    expect(reordered).toEqual(plan)
    expect(plan.planSha256).toHaveLength(64)
    expect(
      planVerificationMatrix(HEAD, POPULATION, [
        { ...chunk("pure-0", manyFiles("a", 60)), intraParallel: 1 },
        chunk("pure-1", manyFiles("b", 60)),
      ]).planSha256,
    ).not.toBe(plan.planSha256)
    expect(() => parseVerificationMatrixPlan({ ...plan, headSha: "b".repeat(40) })).toThrow(
      /digest mismatch/,
    )
  })

  test("plan rejects empty, duplicate, absolute, and escaping populations", () => {
    expect(() => planVerificationMatrix(HEAD, POPULATION, [])).toThrow(/empty matrix plan/)
    expect(() =>
      planVerificationMatrix(HEAD, POPULATION, [
        chunk("a", ["one.test.ts"]),
        chunk("a", ["two.test.ts"]),
      ]),
    ).toThrow(/duplicate matrix chunk id/)
    expect(() =>
      planVerificationMatrix(HEAD, POPULATION, [
        chunk("a", ["one.test.ts"]),
        chunk("b", ["one.test.ts"]),
      ]),
    ).toThrow(/duplicate matrix file/)
    expect(() =>
      planVerificationMatrix(HEAD, POPULATION, [chunk("a", ["/tmp/x.test.ts"])]),
    ).toThrow(/unsafe matrix file/)
    expect(() => planVerificationMatrix(HEAD, POPULATION, [chunk("a", ["../x.test.ts"])])).toThrow(
      /unsafe matrix file/,
    )
    expect(() =>
      planVerificationMatrix(HEAD, POPULATION, [chunk("a", ["tests/../x.test.ts"])]),
    ).toThrow(/unsafe matrix file/)
    expect(() =>
      planVerificationMatrix(HEAD, POPULATION, [chunk("bad:id", ["x.test.ts"])]),
    ).toThrow(/unsafe matrix chunk id/)
  })

  test("count match alone is not PASS", () => {
    const verdict = aggregateMatrixReceipts({
      plan,
      receipts: [
        receipt({ chunkId: "pure-0", files: manyFiles("a", 60), outcome: "passed" }),
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
            files: manyFiles("a", 60),
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
            files: manyFiles("a", 60),
            outcome: "cancelled",
            junitSha256: "x",
          }),
          receipt({
            chunkId: "pure-1",
            files: manyFiles("b", 60),
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
          files: manyFiles("a", 60),
          outcome: "passed",
          junitSha256: "x",
          headSha: "b".repeat(40),
        }),
        receipt({
          chunkId: "pure-1",
          files: manyFiles("b", 60),
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
            files: manyFiles("a", 60),
            outcome: "passed",
            junitSha256: "x",
          }),
          receipt({
            chunkId: "pure-1",
            files: manyFiles("b", 60),
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
          files: manyFiles("a", 60),
          executedFiles: ["other.test.ts"],
          outcome: "passed",
          junitSha256: "x",
          testTimeoutMs: 60_000,
          intraParallel: 1,
        }),
        receipt({
          chunkId: "pure-1",
          files: manyFiles("b", 60),
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

/**
 * TVH item 9 — the two sides of the equality claim ran different tiers.
 *
 * The shadow matrix exists to be compared against the monolith. The planner
 * hardcoded the literal `"full"`; the monolith runs with
 * `QUANTA_VERIFICATION_TIER: pr`. Measured on this tree that is 3,951 files
 * against 3,941, so "the matrix agrees with the monolith" was never a statement
 * that could be true — and the plan carried a HEAD and a chunk list and nothing
 * that would have revealed it.
 */
describe("a plan says which population it covers", () => {
  const HEAD40 = "b".repeat(40)
  const files = (prefix: string, count: number): readonly string[] =>
    Array.from({ length: count }, (_, index) => `${prefix}-${index}.test.ts`)
  const chunkOf = (id: string, list: readonly string[]) => ({
    id,
    files: list,
    resourceClass: "pure" as const,
    predictedMs: 1_000,
    testTimeoutMs: 120_000,
    intraParallel: 8,
  })
  const pop = (overrides: Record<string, unknown> = {}) => ({
    tier: "pr",
    universe: 300,
    membershipSha256: "1".repeat(64),
    policySha256: "2".repeat(64),
    capabilitySha256: "3".repeat(64),
    ...overrides,
  })
  const build = (overrides: Record<string, unknown> = {}, count = 150) =>
    planVerificationMatrix(HEAD40, pop(overrides) as never, [chunkOf("pure-0", files("a", count))])

  test("the tier travels WITH the plan and is part of its identity", () => {
    const asPr = build()
    const asFull = build({ tier: "full" })
    expect(asPr.population.tier).toBe("pr")
    expect(asFull.population.tier).toBe("full")
    // Same HEAD, same chunks, different tier — different plan.
    expect(asPr.planSha256).not.toBe(asFull.planSha256)
  })

  test("every population digest is part of the identity too", () => {
    const base = build().planSha256
    for (const field of ["membershipSha256", "policySha256", "capabilitySha256"]) {
      expect(build({ [field]: "9".repeat(64) }).planSha256).not.toBe(base)
    }
    // ANTI-VACUITY: rebuilding the SAME population reproduces the digest.
    expect(build().planSha256).toBe(base)
  })

  test("a population digest that is not a digest is refused", () => {
    for (const field of ["membershipSha256", "policySha256", "capabilitySha256"]) {
      expect(() => build({ [field]: "not-a-sha" })).toThrow(new RegExp(`${field} must be a sha256`))
      expect(() => build({ [field]: "Z".repeat(64) })).toThrow(/must be a sha256/)
    }
    expect(() => build({ tier: "" })).toThrow(/requires a tier/)
  })

  test("a one-file plan is refused — it aggregates green and proves nothing", () => {
    expect(() => build({}, 1)).toThrow(/covers 1 file\(s\); floor is 100/)
    expect(() => build({}, 99)).toThrow(/floor is 100/)
    // ANTI-VACUITY: at the floor it is accepted, so this is a floor and not a ban.
    expect(build({}, 100).chunks[0]?.files).toHaveLength(100)
  })

  test("a universe smaller than the selection is a fiction, not a plan", () => {
    expect(() => build({ universe: 10 }, 150)).toThrow(/universe 10 is smaller than the 150/)
    expect(build({ universe: 150 }, 150).population.universe).toBe(150)
  })

  test("a v3 plan cannot be read as a v4 one", () => {
    const v4 = build()
    expect(() =>
      parseVerificationMatrixPlan({ ...v4, schema: "quanta.verification-matrix.v3" }),
    ).toThrow(/invalid matrix plan schema/)
    // ...and a v4 plan with its population stripped is not silently accepted.
    const { population: _dropped, ...withoutPopulation } = v4
    expect(() => parseVerificationMatrixPlan(withoutPopulation)).toThrow(/population/)
    // ANTI-VACUITY: the intact plan round-trips.
    expect(parseVerificationMatrixPlan(v4).planSha256).toBe(v4.planSha256)
  })

  test("tampering with the population is caught by the plan digest", () => {
    const v4 = build()
    expect(() =>
      parseVerificationMatrixPlan({ ...v4, population: { ...v4.population, tier: "full" } }),
    ).toThrow(/digest mismatch/)
  })
})

/**
 * WIRING PROOF — both sides of the comparison name the same tier.
 */
describe("matrix tier wiring", () => {
  const read = (rel: string): string =>
    readFileSync(resolve(import.meta.dir, "..", "..", "..", rel), "utf8")

  test("the planner takes a tier and no longer hardcodes one", () => {
    const cli = read("tools/dev/verification-matrix-cli.ts")
    expect(cli).toContain('assertKnownTier(requiredArg("--tier"))')
    expect(cli).toContain("selectTestPoliciesForTier(policies, tier)")
    expect(cli).not.toContain(
      'selectTestPoliciesForTier(\n        policies,\n        "full",\n      )',
    )
    expect(cli).toContain("--expect-tier")
  })

  test("the workflow plans and aggregates the SAME tier the monolith runs", () => {
    const ci = read(".github/workflows/ci.yml")
    expect(ci).toContain("--tier=pr")
    expect(ci).toContain("--expect-tier=pr")
    // The monolith's own tier, unchanged: this is the value the other two match.
    expect(ci).toContain("QUANTA_VERIFICATION_TIER: pr")
  })
})
