/**
 * HELLGATE — the flake-diagnosis contract (TVH-15 items 6 and 7).
 *
 * Four claims, each with a paired control that fails if the mechanism is removed:
 *
 *  1. **Amplification is gone.** 20 failures in ONE file plan ONE child. The
 *     control is the count itself: before this change the same input MEASURED
 *     40 diagnostic children (20 `-t` attempts that matched nothing because the
 *     names carry regex metacharacters, plus 20 whole-file fallbacks).
 *  2. **Dedupe is by `(file, testId, fingerprint)`, not by test id.** Two
 *     DIFFERENT failures of the same test must both be diagnosed; the control
 *     is the same pair with an identical fingerprint, which collapses to one.
 *  3. **A `-t` zero-match never escalates.** It is `inconclusive`, and a
 *     control asserts the selector is escaped so a zero-match is rare in the
 *     first place.
 *  4. **No path produces a PASS.** The end-to-end case runs a REAL child over a
 *     test that PASSES in isolation — the exact input a retry-promotion bug
 *     needs — and asserts the required verdict is still `failed` and the exit
 *     code is not 0.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  batchSelector,
  type ChildEvidence,
  classifyRecord,
  type DiagnosisReport,
  planDiagnosis,
} from "../../../tools/test-resilience/diagnose"
import {
  DIAGNOSIS_KEY_SEPARATOR,
  diagnosisKey,
  escapeTestSelector,
  type FailureAttemptArtifact,
  type FailureRecord,
  failureFingerprint,
  parseFailureArtifact,
  replayCommand,
} from "../../../tools/test-resilience/failure-artifact"
import { describeChain, parseJunitCases } from "../../../tools/test-resilience/junit"

const ROOT = mkdtempSync(join(tmpdir(), "tvh15-diagnose-"))
afterAll(() => {
  rmSync(ROOT, { recursive: true, force: true })
})

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")

const record = (over: Partial<FailureRecord> = {}): FailureRecord => ({
  file: "tests/unit/a.test.ts",
  testId: "group > leaf",
  leaf: "leaf",
  kind: "assertion",
  fingerprint: failureFingerprint("group > leaf", "expect(1).toBe(2)"),
  elapsedMs: 12,
  chunkIndex: 3,
  message: "expect(1).toBe(2)",
  ...over,
})

const artifact = (failures: readonly FailureRecord[]): FailureAttemptArtifact => ({
  schema: "quanta.test-failure-attempt.v1",
  head: "0".repeat(40),
  dirty: false,
  suite: "unit",
  createdAtMs: 1_700_000_000_000,
  replay: {
    seed: "abc123:tests/unit/a.test.ts",
    permutation: "lpt-v2:chunk3",
    cores: 12,
    loadAverage1m: 101.4,
    workerParallel: 4,
    intraParallel: 8,
    testTimeoutMs: 60_000,
    resourceClaims: ["class:pure"],
    retryCount: 0,
  },
  failures,
})

// The metacharacter shapes this repository's real test names actually contain.
const AWKWARD = (index: number): string => `case (${index}) [amp] needs *escaping* a+b`

describe("amplification: N failures in one file are ONE child", () => {
  const twenty = Array.from({ length: 20 }, (_, index) =>
    record({
      leaf: AWKWARD(index),
      testId: `amp group > ${AWKWARD(index)}`,
      fingerprint: failureFingerprint(`amp group > ${AWKWARD(index)}`, `Received: ${index}`),
    }),
  )

  test("20 distinct failures in one file plan exactly 1 diagnostic child", () => {
    const plan = planDiagnosis(twenty)
    expect(plan.batches).toHaveLength(1)
    // ANTI-VACUUM FLOOR: the single batch really covers all twenty. A planner
    // that dropped 19 of them would also report one batch.
    expect(plan.batches[0]?.records).toHaveLength(20)
    expect(plan.deduped).toHaveLength(0)
    expect(plan.overBudget).toHaveLength(0)
  })

  test("failures in DIFFERENT files still get one child each — batching is per file", () => {
    const across = Array.from({ length: 5 }, (_, index) =>
      record({ file: `tests/unit/f${index}.test.ts` }),
    )
    const plan = planDiagnosis(across)
    expect(plan.batches).toHaveLength(5)
    expect(plan.batches.map((batch) => batch.file)).toEqual([
      "tests/unit/f0.test.ts",
      "tests/unit/f1.test.ts",
      "tests/unit/f2.test.ts",
      "tests/unit/f3.test.ts",
      "tests/unit/f4.test.ts",
    ])
  })

  test("the global child budget caps children and REPORTS the remainder", () => {
    const across = Array.from({ length: 20 }, (_, index) =>
      record({ file: `tests/unit/g${index}.test.ts` }),
    )
    const plan = planDiagnosis(across, { maxChildren: 3, maxTotalMs: 1_000, perChildMs: 100 })
    expect(plan.batches).toHaveLength(3)
    // Not silently dropped: every unplanned record is accounted for.
    expect(plan.overBudget).toHaveLength(17)
    expect(plan.batches.length + plan.overBudget.length).toBe(20)
  })
})

describe("dedupe key is (file, testId, fingerprint)", () => {
  test("the SAME failure twice is diagnosed once", () => {
    const same = record()
    const plan = planDiagnosis([same, { ...same }])
    expect(plan.batches[0]?.records).toHaveLength(1)
    expect(plan.deduped).toHaveLength(1)
  })

  test("PAIRED CONTROL: the same test failing two DIFFERENT ways is diagnosed twice", () => {
    const first = record({ fingerprint: failureFingerprint("group > leaf", "Expected: 4") })
    const second = record({ fingerprint: failureFingerprint("group > leaf", "Expected: 5") })
    expect(first.fingerprint).not.toBe(second.fingerprint)
    const plan = planDiagnosis([first, second])
    expect(plan.batches[0]?.records).toHaveLength(2)
    expect(plan.deduped).toHaveLength(0)
  })

  test("the key names all three parts, NUL-separated so no name can forge one", () => {
    const base = record()
    expect(diagnosisKey(base)).toBe(
      [base.file, base.testId, base.fingerprint].join(DIAGNOSIS_KEY_SEPARATOR),
    )
    // A separator a test NAME could contain would let two distinct failures
    // collide; NUL cannot appear in a JS source string literal by accident.
    expect(DIAGNOSIS_KEY_SEPARATOR).toBe("\u0000")
  })

  test("the fingerprint normalises run-to-run noise but not the assertion", () => {
    const withPath = failureFingerprint("t", "at /tmp/worker-7/x/a.test.ts:3 took 12.5ms pid=991")
    const otherRun = failureFingerprint("t", "at /tmp/worker-2/y/a.test.ts:3 took 0.4ms pid=17")
    expect(withPath).toBe(otherRun)
    expect(failureFingerprint("t", "Expected: 4")).not.toBe(failureFingerprint("t", "Expected: 5"))
  })
})

describe("the `-t` selector is a LITERAL match, so a zero-match is rare and never escalates", () => {
  test("a batch selector matches every awkward name it was built from", () => {
    const names = [AWKWARD(1), AWKWARD(2), "plain name"]
    const selector = batchSelector(names.map((leaf) => record({ leaf })))
    const compiled = new RegExp(selector)
    for (const name of names) expect(compiled.test(name)).toBe(true)
  })

  test("PAIRED CONTROL: unescaped, the same pattern matches the WRONG things", () => {
    const name = "case (1) [amp] needs *escaping* a+b"
    // Escaped: matches itself and nothing that merely looks like it.
    expect(new RegExp(escapeTestSelector(name)).test(name)).toBe(true)
    expect(new RegExp(escapeTestSelector(name)).test("case 1 a needs escaping ab")).toBe(false)
    // Unescaped: `[amp]` is a character class and `*`/`+` are quantifiers, so it
    // does NOT match the literal name — the measured cause of the zero-matches
    // that used to escalate into whole-file re-runs.
    expect(new RegExp(name).test(name)).toBe(false)
  })

  test("selector terms are de-duplicated", () => {
    const selector = batchSelector([record({ leaf: "same" }), record({ leaf: "same" })])
    expect(selector).toBe("same")
  })
})

describe("diagnostic outcomes are typed, and a pass is one OBSERVATION", () => {
  const evidence = (over: Partial<ChildEvidence> = {}): ChildEvidence => ({
    completed: true,
    selectorMatchedNothing: false,
    statusByTestId: new Map(),
    ...over,
  })

  test("still failing alone ⇒ confirmed-real", () => {
    const row = record()
    expect(classifyRecord(row, evidence({ statusByTestId: new Map([[row.testId, "fail"]]) }))).toBe(
      "confirmed-real",
    )
  })

  test("passing alone ⇒ observed-isolation-pass, NOT 'flake'", () => {
    const row = record()
    expect(classifyRecord(row, evidence({ statusByTestId: new Map([[row.testId, "pass"]]) }))).toBe(
      "observed-isolation-pass",
    )
  })

  test("a zero-match ⇒ inconclusive (no whole-file escalation)", () => {
    expect(classifyRecord(record(), evidence({ selectorMatchedNothing: true }))).toBe(
      "inconclusive",
    )
  })

  test("a child that never completed ⇒ infra-failed, never a test verdict", () => {
    expect(classifyRecord(record(), evidence({ completed: false }))).toBe("infra-failed")
  })

  test("no <testcase> for this exact id ⇒ inconclusive, never a pass", () => {
    const row = record()
    // A neighbour passed; this test produced nothing. Counting the neighbour is
    // exactly the inference the JUnit reader exists to prevent.
    expect(
      classifyRecord(row, evidence({ statusByTestId: new Map([["other > leaf", "pass"]]) })),
    ).toBe("inconclusive")
  })

  test("a skipped test is not a pass", () => {
    const row = record()
    expect(classifyRecord(row, evidence({ statusByTestId: new Map([[row.testId, "skip"]]) }))).toBe(
      "inconclusive",
    )
  })
})

describe("JUnit gives per-test identity, which the summary counts cannot", () => {
  test("the describe chain is reconstructed from the REVERSED, double-escaped classname", () => {
    // `describeChain` receives the value AFTER one XML unescape, which is where
    // the double-escaped `&amp;gt;` Bun writes lands. Both spellings are handled
    // so a future fix to the double escape does not silently drop the chain.
    expect(describeChain("inner &gt; outer")).toEqual(["outer", "inner"])
    expect(describeChain("inner > outer")).toEqual(["outer", "inner"])
    expect(describeChain("")).toEqual([])
  })

  test("self-closing is a pass, a <failure> child is a fail, <skipped> is neither", () => {
    const xml = `<testsuites><testsuite name="a.test.ts">
      <testcase name="green" classname="inner &amp;gt; outer" time="0.001" file="a.test.ts" />
      <testcase name="red" classname="inner &amp;gt; outer" time="0.002" file="a.test.ts">
        <failure type="AssertionError" />
      </testcase>
      <testcase name="skipped one" classname="" time="0" file="a.test.ts">
        <skipped />
      </testcase>
    </testsuite></testsuites>`
    const cases = parseJunitCases(xml)
    expect(cases).toHaveLength(3)
    expect(cases[0]).toMatchObject({ testId: "outer > inner > green", status: "pass" })
    expect(cases[1]).toMatchObject({ testId: "outer > inner > red", status: "fail" })
    expect(cases[2]).toMatchObject({ testId: "skipped one", status: "skip" })
  })
})

describe("the failure artifact is the immutable INPUT, validated strictly", () => {
  test("a well-formed artifact parses", () => {
    const load = parseFailureArtifact(artifact([record()]))
    expect(load.kind).toBe("ok")
  })

  test('the old adapter\'s `sha: ""` is REJECTED', () => {
    const load = parseFailureArtifact({ ...artifact([record()]), head: "" })
    expect(load.kind).toBe("invalid")
    expect(load.kind === "invalid" && load.reason).toContain("head")
  })

  test("an artifact with no failures is rejected — a clean attempt writes none", () => {
    const load = parseFailureArtifact(artifact([]))
    expect(load.kind).toBe("invalid")
    expect(load.kind === "invalid" && load.reason).toContain("empty")
  })

  test("EVERY replay field is required — dropping any one is rejected", () => {
    const fields = [
      "seed",
      "permutation",
      "cores",
      "loadAverage1m",
      "workerParallel",
      "intraParallel",
      "testTimeoutMs",
      "resourceClaims",
      "retryCount",
    ] as const
    // ANTI-VACUUM FLOOR: the loop really covers the whole replay contract.
    expect(Object.keys(artifact([record()]).replay)).toHaveLength(fields.length)
    for (const field of fields) {
      const base = artifact([record()])
      const replay: Record<string, unknown> = { ...base.replay }
      delete replay[field]
      const load = parseFailureArtifact({ ...base, replay })
      expect(load.kind, `dropping replay.${field} must be rejected`).toBe("invalid")
    }
  })

  test("one command replays the exact input", () => {
    const base = artifact([record({ leaf: AWKWARD(3) })])
    const command = replayCommand(base, base.failures[0] as FailureRecord)
    expect(command).toContain("QUANTA_TEST_SEED=abc123:tests/unit/a.test.ts")
    expect(command).toContain("QUANTA_TEST_PERMUTATION=lpt-v2:chunk3")
    expect(command).toContain("--timeout=60000")
    expect(command).toContain("--parallel=8")
    expect(command).toContain(escapeTestSelector(AWKWARD(3)))
  })
})

describe("END TO END: a retry pass cannot become a required PASS", () => {
  test("an isolation-PASS reports observed-isolation-pass, required 'failed', and a non-zero exit", async () => {
    // A test that PASSES when run alone — the exact input a retry-promotion
    // bug needs in order to turn a red attempt green.
    const file = join(ROOT, "greenish.test.ts")
    writeFileSync(
      file,
      `import { expect, test } from "bun:test"
test("case (1) [amp] passes alone", () => { expect(1).toBe(1) })
`,
    )
    const testId = "case (1) [amp] passes alone"
    const input = {
      ...artifact([
        record({
          file,
          testId,
          leaf: testId,
          fingerprint: failureFingerprint(testId, "Expected: 1 Received: 2"),
        }),
      ]),
    }
    const artifactPath = join(ROOT, "attempt.json")
    const reportPath = join(ROOT, "report.json")
    writeFileSync(artifactPath, JSON.stringify(input))

    const child = Bun.spawnSync(
      [
        "bun",
        join(REPO_ROOT, "tools", "test-resilience", "cli.ts"),
        "diagnose",
        "--from-artifact",
        artifactPath,
        "--out",
        reportPath,
      ],
      { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe", env: process.env },
    )
    const report = JSON.parse(readFileSync(reportPath, "utf8")) as DiagnosisReport

    // The claim under test: a green isolation run changes NOTHING required.
    expect(report.required).toBe("failed")
    expect(report.advisory).toBe(true)
    expect(report.schema).toBe("quanta.flake-diagnosis.v1")
    expect(report.counts["observed-isolation-pass"]).toBe(1)
    expect(report.counts["confirmed-real"]).toBe(0)
    // ANTI-VACUUM FLOOR: one real child actually ran.
    expect(report.childrenSpawned).toBe(1)
    // 0 is the universal success code, so `diagnose` must never return it.
    expect(child.exitCode).not.toBe(0)
    expect(child.exitCode).toBe(3)
  }, 120_000)

  /**
   * WHY THIS CASE SETS THE ENV EXPLICITLY.
   *
   * It used to pass no env at all and assert exit 2 plus the "no longer runs a
   * suite of its own" line. Two defects, both measured:
   *
   *  1. NOT HERMETIC. `diagnose` resolves its default artifact from the SHARED
   *     verification cache (`sharedVerificationCacheRoot`, deliberately — an
   *     earlier audit found the script reading a path the runner never wrote).
   *     That root is shared across every worktree, so a leftover artifact from
   *     ANY run makes this case run a REAL diagnosis: measured exit 3 with
   *     `children=1 observed-isolation-pass=1`, not the fail-closed path.
   *  2. THE ASSERTED MESSAGE BELONGS TO A BRANCH THIS CALL CANNOT REACH. There
   *     are three fail-closed branches, and only the first prints "no longer runs
   *     a suite of its own". Reaching it needs an EMPTY artifact path, which
   *     `failureAttemptPath()` never returns. With the shared artifact merely
   *     absent the call lands in the second branch ("cannot read <path>"), which
   *     is exit 2 but a different message.
   *
   * So both branches are now exercised on purpose, each with its own message.
   */
  test("with no artifact the tool FAILS CLOSED rather than running a suite", () => {
    const child = Bun.spawnSync(
      ["bun", join(REPO_ROOT, "tools", "test-resilience", "cli.ts"), "diagnose"],
      {
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
        // Empty, not absent: an absent var falls back to the SHARED cache path.
        env: { ...process.env, PATH: process.env.PATH ?? "", QUANTA_TEST_FAILURE_ARTIFACT: "" },
      },
    )
    expect(child.exitCode).toBe(2)
    expect(child.stderr.toString()).toContain("FAIL CLOSED")
    // The old behaviour, named so a regression is unmistakable.
    expect(child.stderr.toString()).toContain("no longer runs a suite of its own")
    // …and it must NOT have run anything.
    expect(child.stdout.toString()).not.toContain("children=")
  })

  test("with an artifact path that does not exist the tool FAILS CLOSED naming the path", () => {
    const absent = join(REPO_ROOT, ".cache", `absent-artifact-${process.pid}-${Date.now()}.json`)
    const child = Bun.spawnSync(
      ["bun", join(REPO_ROOT, "tools", "test-resilience", "cli.ts"), "diagnose"],
      {
        cwd: REPO_ROOT,
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, PATH: process.env.PATH ?? "", QUANTA_TEST_FAILURE_ARTIFACT: absent },
      },
    )
    expect(child.exitCode).toBe(2)
    expect(child.stderr.toString()).toContain("FAIL CLOSED")
    expect(child.stderr.toString()).toContain(absent)
    expect(child.stdout.toString()).not.toContain("children=")
  })
})
