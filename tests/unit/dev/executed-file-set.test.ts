/**
 * ★ The count that was standing in for a proof.
 *
 * `run-test-shards.ts` accepted a chunk when `result.executedFiles ===
 * plan.files.length`. Measured on this tree: chunk 36 plans 146 files. A worker
 * that ran 146 files belonging to some other chunk satisfied that check, exited
 * 0, and minted a timing observation plus a reusable cache receipt asserting the
 * PLANNED set had passed — because the receipt recorded the plan and never the
 * execution.
 *
 * The matrix worker compared the exact set already, in a sorted-join expression
 * nothing else could reach. Two rails, one right and one a count. These tests
 * pin the single owner both now use.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  executedFileSetDigest,
  executedFileSetVerdict,
  normalizeExecutedPath,
} from "../../../tools/dev/executed-file-set"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..")

const verdict = (planned: readonly string[], executed: readonly string[]) =>
  executedFileSetVerdict({ repoRoot: REPO_ROOT, plannedRaw: planned, executedRaw: executed })

const PLANNED = ["tests/unit/a.test.ts", "tests/unit/b.test.ts", "tests/unit/c.test.ts"] as const

describe("executed file set", () => {
  test("the exact planned set passes, and reports the ids it proved", () => {
    const ok = verdict(PLANNED, [...PLANNED])
    expect(ok.ok).toBe(true)
    expect(ok.reason).toBe("")
    expect(ok.executed).toEqual([...PLANNED])
    expect(ok.missing).toEqual([])
    expect(ok.unexpected).toEqual([])
    expect(ok.duplicate).toEqual([])
  })

  test("SUBSTITUTION — the same COUNT of the wrong files is RED", () => {
    // The exact defect. Three planned, three executed, none of them planned.
    const swapped = ["tests/unit/x.test.ts", "tests/unit/y.test.ts", "tests/unit/z.test.ts"]
    const bad = verdict(PLANNED, swapped)
    expect(swapped.length).toBe(PLANNED.length) // the count check would have passed
    expect(bad.ok).toBe(false)
    expect(bad.missing).toEqual([...PLANNED])
    expect(bad.unexpected).toEqual(swapped)
    expect(bad.reason).toContain("missing=3")
    expect(bad.reason).toContain("unexpected=3")
  })

  test("SUBSTITUTION of ONE file, count still equal, is RED and names it", () => {
    const bad = verdict(PLANNED, [
      "tests/unit/a.test.ts",
      "tests/unit/b.test.ts",
      "tests/unit/q.test.ts",
    ])
    expect(bad.ok).toBe(false)
    expect(bad.missing).toEqual(["tests/unit/c.test.ts"])
    expect(bad.unexpected).toEqual(["tests/unit/q.test.ts"])
  })

  test("MISSING — a planned file that never ran is RED and named", () => {
    const bad = verdict(PLANNED, ["tests/unit/a.test.ts", "tests/unit/b.test.ts"])
    expect(bad.ok).toBe(false)
    expect(bad.missing).toEqual(["tests/unit/c.test.ts"])
    expect(bad.unexpected).toEqual([])
  })

  test("EXTRA — a file that ran and was not planned is RED and named", () => {
    const bad = verdict(PLANNED, [...PLANNED, "tests/unit/extra.test.ts"])
    expect(bad.ok).toBe(false)
    expect(bad.missing).toEqual([])
    expect(bad.unexpected).toEqual(["tests/unit/extra.test.ts"])
  })

  test("DUPLICATE — two spellings collapsing onto one id is RED", () => {
    // This is how a substitution hides inside a matching count: the set sizes
    // agree after normalization because two raw paths became one.
    const bad = verdict(PLANNED, [
      "tests/unit/a.test.ts",
      "tests/unit/../unit/a.test.ts",
      "tests/unit/b.test.ts",
      "tests/unit/c.test.ts",
    ])
    expect(bad.ok).toBe(false)
    expect(bad.duplicate).toEqual(["tests/unit/a.test.ts"])
  })

  test("a plan that names the same file twice is RED", () => {
    const bad = verdict(["tests/unit/a.test.ts", "tests/unit/a.test.ts"], ["tests/unit/a.test.ts"])
    expect(bad.ok).toBe(false)
    expect(bad.duplicate).toEqual(["tests/unit/a.test.ts"])
  })

  test("Bun's repeated per-describe testsuite tags are NOT duplicates", () => {
    // MEASURED on Bun 1.3.14: the JUnit reporter emits one <testsuite file=…>
    // for the file and one more per `describe`. Two files produced four tags.
    // Treating the repeats as duplicates would fail every real chunk.
    const ok = verdict(PLANNED, [
      "tests/unit/a.test.ts",
      "tests/unit/a.test.ts",
      "tests/unit/b.test.ts",
      "tests/unit/b.test.ts",
      "tests/unit/b.test.ts",
      "tests/unit/c.test.ts",
    ])
    expect(ok.ok).toBe(true)
    expect(ok.duplicate).toEqual([])
  })

  test("absolute and relative spellings of the SAME file agree", () => {
    // The two rails normalized differently before this helper existed, which is
    // its own way to make a real mismatch look like agreement.
    const ok = verdict(
      PLANNED,
      PLANNED.map((file) => resolve(REPO_ROOT, file)),
    )
    expect(ok.ok).toBe(true)
    expect(normalizeExecutedPath(REPO_ROOT, resolve(REPO_ROOT, "tests/unit/a.test.ts"))).toBe(
      "tests/unit/a.test.ts",
    )
  })

  test("the digest is of the SET, and moves with it", () => {
    const base = executedFileSetDigest([...PLANNED])
    expect(executedFileSetDigest([...PLANNED].reverse())).toBe(base)
    expect(executedFileSetDigest([...PLANNED, ...PLANNED])).toBe(base)
    expect(executedFileSetDigest(["tests/unit/a.test.ts"])).not.toBe(base)
    expect(executedFileSetDigest([])).not.toBe(base)
    expect(verdict(PLANNED, [...PLANNED]).digestSha256).toBe(base)
    expect(base).toMatch(/^[0-9a-f]{64}$/)
  })

  test("an empty execution against a real plan is RED, not vacuously equal", () => {
    const bad = verdict(PLANNED, [])
    expect(bad.ok).toBe(false)
    expect(bad.missing).toEqual([...PLANNED])
  })
})

/**
 * WIRING PROOF — the count is gone from the production path.
 *
 * A pure helper that nothing calls proves nothing. The predecessor's exact
 * expression is what these assert is absent, and the replacement present.
 */
describe("executed-set wiring", () => {
  const source = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), "utf8")

  test("the local shard runner compares the SET, not the length", () => {
    const runner = source("tools/dev/run-test-shards.ts")
    expect(runner).not.toContain("result.executedFiles === plan.files.length")
    expect(runner).toContain("executedFileSetVerdict(")
    expect(runner).toContain("EXECUTED-SET MISMATCH")
    // And it reads the JUnit the worker wrote rather than trusting the runner's
    // own tally of what it launched.
    expect(runner).toMatch(/executedRaw: junitExecutedFiles\(junitXml\)/)
  })

  test("the receipt is minted from the PROVEN set, not from the runner's tally", () => {
    // A survivor found this: deleting the guard inside `cacheSuccessfulShard`
    // left every behavioural test green, because the validator that runs first
    // is a different call site. Caching is the step that makes an unproven
    // claim durable and reusable, so it re-derives rather than trusting a
    // value threaded down from elsewhere.
    const runner = source("tools/dev/run-test-shards.ts")
    const mint = runner.slice(runner.indexOf("const cacheSuccessfulShard"))
    expect(mint).not.toBe("")
    const body = mint.slice(0, mint.indexOf("\n}\n"))
    expect(body).toContain("executedFileSetVerdict(")
    expect(body).toContain("refusing to cache chunk")
    expect(body).toContain("executedFileIds: executedSet.executed")
    // ...and never re-introduces the count it replaced.
    expect(body).not.toContain("result.executedFiles")
  })

  test("the matrix worker uses the same owner, not its own sorted join", () => {
    const matrix = source("tools/dev/verification-matrix-cli.ts")
    expect(matrix).toContain("executedFileSetVerdict(")
    expect(matrix).not.toContain('[...executedFiles].sort().join("\\n") === ')
    expect(matrix).toContain("executedDigestSha256: executedSet.digestSha256")
  })

  test("the aggregator refuses a receipt whose digest is not of its own list", () => {
    const aggregate = source("tools/dev/verification-matrix.ts")
    expect(aggregate).toContain("executed-digest-mismatch")
    expect(aggregate).toContain("executedFileSetDigest(receipt.executedFiles)")
  })
})
