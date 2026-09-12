/**
 * ★ The diagnostic tool's input had no producer.
 *
 * TVH item 19. `tools/test-resilience/failure-artifact.ts` states the contract
 * in its own header: "The runner that actually holds the lease writes this
 * artifact; the diagnostic tool consumes it and never runs a broad suite of its
 * own. With no artifact the tool FAILS CLOSED (exit 2)."
 *
 * The consumer was built. The fail-closed was built. The schema, the
 * fingerprint and the replay-context vocabulary were built. The PRODUCER was
 * not — so the only path that was supposed to feed it, a real chunk failing
 * under the lease, fed it nothing, and the tool could be driven only by a
 * hand-authored file.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import {
  buildFailureAttemptArtifact,
  failureRecordsFromJunit,
  writeFailureAttemptArtifact,
} from "../../../tools/dev/failure-attempt-producer"
import { parseFailureArtifact } from "../../../tools/test-resilience/failure-artifact"

const REPO_ROOT = resolve(import.meta.dir, "..", "..", "..")

/**
 * VERBATIM from Bun 1.3.14, captured by running a failing test.
 *
 * A hand-written fixture got this wrong in a way worth recording: it put a raw
 * `>` inside `classname="a.test.ts > widget"`. Bun does not — it nests
 * `<testsuite>` per describe and the classname is the describe LEAF — and the
 * parser's `<testcase\b([^>]*?)` stops at that raw `>`, so the whole failing
 * case vanished and the producer looked broken. The fixture was the broken
 * thing. Measured, not imagined.
 */
const JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="3" failures="1" skipped="1" time="0.087">
  <testsuite name="tests/unit/a.test.ts" file="tests/unit/a.test.ts" tests="2" failures="1">
    <testcase name="works" classname="a.test.ts" time="0.012" file="tests/unit/a.test.ts"/>
    <testsuite name="widget" file="tests/unit/a.test.ts" line="2" tests="1" failures="1">
      <testcase name="breaks" classname="widget" time="0.034" file="tests/unit/a.test.ts" line="2">
        <failure type="AssertionError" />
      </testcase>
    </testsuite>
  </testsuite>
  <testsuite name="tests/unit/b.test.ts" file="tests/unit/b.test.ts" tests="1" skipped="1">
    <testcase name="skipped one" classname="b.test.ts" time="0" file="tests/unit/b.test.ts">
      <skipped/>
    </testcase>
  </testsuite>
</testsuites>`

const REPLAY = {
  seed: "<unseeded>",
  permutation: "a".repeat(64),
  cores: 16,
  loadAverage1m: 2.5,
  workerParallel: 2,
  intraParallel: 8,
  testTimeoutMs: 120_000,
  resourceClaims: ["port:4317:exclusive"],
  retryCount: 0,
} as const

describe("failure attempt producer", () => {
  test("only FAILED cases become records — a pass or a skip is not a failure", () => {
    const records = failureRecordsFromJunit(JUNIT, 7)
    expect(records).toHaveLength(1)
    expect(records[0]?.testId).toBe("widget > breaks")
    expect(records[0]?.leaf).toBe("breaks")
    expect(records[0]?.file).toBe("tests/unit/a.test.ts")
    expect(records[0]?.chunkIndex).toBe(7)
    expect(records[0]?.fingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  test("the message reaches the fingerprint, so two different failures do not dedupe", () => {
    // `expect(3).toBe(4)` and `expect(3).toBe(5)` must stay distinct:
    // isolating one says nothing about the other.
    const four = failureRecordsFromJunit(JUNIT, 1, () => "expected 3 to be 4")
    const five = failureRecordsFromJunit(JUNIT, 1, () => "expected 3 to be 5")
    expect(four[0]?.fingerprint).not.toBe(five[0]?.fingerprint)
    expect(four[0]?.message).toBe("expected 3 to be 4")
  })

  test("what the runner writes is what the diagnostic tool accepts", () => {
    // The whole point: not a shape that looks right, but one the CONSUMER
    // parses. Anything less and the producer is a second vocabulary.
    const artifact = buildFailureAttemptArtifact({
      head: "b".repeat(40),
      dirty: false,
      suite: "full",
      replay: REPLAY,
      failures: failureRecordsFromJunit(JUNIT, 3, () => "expected 3 to be 4"),
      nowMs: 1_700_000_000_000,
    })
    const load = parseFailureArtifact(artifact)
    expect(load.kind).toBe("ok")
    if (load.kind !== "ok") throw new Error(load.reason)
    expect(load.artifact.failures).toHaveLength(1)
    expect(load.artifact.replay.retryCount).toBe(0)
  })

  test("a round trip through the FILE is what the tool actually reads", () => {
    const dir = mkdtempSync(join(tmpdir(), "failure-attempt-"))
    try {
      const path = join(dir, "nested", "failure-attempt.json")
      const artifact = buildFailureAttemptArtifact({
        head: "c".repeat(40),
        dirty: true,
        suite: "full",
        replay: REPLAY,
        failures: failureRecordsFromJunit(JUNIT, 2, () => "boom"),
      })
      expect(writeFailureAttemptArtifact(path, artifact)).toBe(true)
      const reloaded = parseFailureArtifact(JSON.parse(readFileSync(path, "utf8")))
      expect(reloaded.kind).toBe("ok")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("an EMPTY failure set writes nothing at all", () => {
    // A chunk can exit non-zero with no failed case — a crash before the
    // reporter flushed, a killed worker. An artifact that parses and describes
    // nothing is worse than the fail-closed the tool already has for an absent
    // one, because it looks like evidence.
    const dir = mkdtempSync(join(tmpdir(), "failure-attempt-empty-"))
    try {
      const path = join(dir, "failure-attempt.json")
      const empty = buildFailureAttemptArtifact({
        head: "d".repeat(40),
        dirty: false,
        suite: "full",
        replay: REPLAY,
        failures: [],
      })
      expect(writeFailureAttemptArtifact(path, empty)).toBe(false)
      expect(() => readFileSync(path, "utf8")).toThrow()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the seed is honest about being unseeded", () => {
    // A fabricated seed would make a replay look reproducible when it is not.
    // TVH-15 owns closing this; until then the artifact says so.
    const runner = readFileSync(resolve(REPO_ROOT, "tools/dev/run-test-shards.ts"), "utf8")
    expect(runner).toContain('seed: "<unseeded>"')
  })
})

/**
 * WIRING PROOF — the runner publishes on the path that actually fails.
 */
describe("the runner publishes the attempt", () => {
  const runner = (): string =>
    readFileSync(resolve(REPO_ROOT, "tools/dev/run-test-shards.ts"), "utf8")

  test("the failure branch emits an artifact before it aborts", () => {
    const body = runner()
    expect(body).toContain("emitFailureAttempt(plan, result, snapshot, completed)")
    expect(body).toContain("failure artifact:")
    // Emitted BEFORE the throw, or the campaign aborts with nothing written.
    const emit = body.indexOf("const artifactPath = emitFailureAttempt(")
    const thrown = body.indexOf("aborting remaining shards", emit)
    expect(emit).toBeGreaterThan(0)
    expect(thrown).toBeGreaterThan(emit)
  })

  test("publishing can never turn a test failure into a runner crash", () => {
    // The campaign has already failed; it must report THAT, not an error from
    // writing a diagnostic aid.
    const body = runner()
    const start = body.indexOf("const emitFailureAttempt =")
    const region = body.slice(start, body.indexOf("\n}\n", start))
    expect(region).toContain("try {")
    expect(region).toContain("no failure artifact for chunk")
    // A deadline kill never flushed a JUnit, so there is nothing to publish and
    // that is expected — the message must distinguish it from a publishing
    // failure, or it sends the reader to the wrong file.
    expect(region).toContain("killed on a deadline before its JUnit was written")
  })
})

/**
 * The other half of item 19: the diagnostic children were unbounded in two
 * ways the tool's own budget claimed to cover.
 */
describe("diagnosis stays inside the budget it declares", () => {
  const cli = (): string => readFileSync(resolve(REPO_ROOT, "tools/test-resilience/cli.ts"), "utf8")

  test("each child's JUnit is removed, not leaked into TMPDIR", () => {
    // One file per batch, per run, forever. This repository already has a scar
    // from that shape: leaked temp files took `ls /tmp` from 6.6s to a timeout.
    const body = cli()
    expect(body).toContain("rmSync(junitPath, { force: true })")
    expect(body).toContain("} finally {")
  })

  test("the last child is CLAMPED to what is left of the global budget", () => {
    // The global deadline was checked only BEFORE a child started, so the last
    // one could begin with a millisecond left and run a further 120 seconds —
    // a 10-minute budget finishing at twelve.
    const body = cli()
    expect(body).toContain("DEFAULT_BUDGET.maxTotalMs - (Date.now() - startedAt)")
    expect(body).toContain("Math.min(DEFAULT_BUDGET.perChildMs, remainingMs)")
    // ...and a child with no usable time is reported, not spawned to be killed.
    expect(body).toContain("childMs < 1_000")
  })
})

/**
 * A test file that contains no tests is a planned file that can never produce
 * execution evidence.
 *
 * FOUND BY A REAL CAMPAIGN, not by reading. `tests/unit/apps/cli/
 * cli-sdk-parity.test.ts` held a comment and `export {}` — its tests were
 * removed as duplicates on 2026-06-08 — and the corpus selects by NAME, so it
 * was planned into a chunk on every run since. `bun test` on it alone exits 1
 * with `Ran 0 tests across 1 file` and writes no JUnit at all.
 *
 * The count check could never have seen it: 158 of 159 files reporting is
 * `executedFiles === plan.files.length` only if you count the wrong thing. The
 * exact-set check caught it on its first real campaign.
 */
describe("no test file is a tombstone", () => {
  const TEST_ROOTS = ["tests", "src", "tools"] as const

  /**
   * Three registration shapes, all of them real in this tree and all found by
   * running the corpus rather than by guessing:
   *
   *   1. `test(` / `describe(` directly.
   *   2. a helper that registers them — `registerSliceBoundarySuite(config)`,
   *      used by twenty slice-boundary files.
   *   3. a bare `import "…test"` of another test module, which is how
   *      `colocated-source-test-coverage.test.ts` executes 149 cases while
   *      containing no `test(` of its own.
   *
   * A first version knew only the first two and called that file a tombstone.
   */
  const REGISTERS_CASES =
    /^\s*(?:test|it|describe)\s*[.(]|register[A-Za-z]*(?:Suite|Tests|Cases)\s*\(|^\s*import\s+"[^"]*\.?test"/m

  const walkable = (name: string): boolean => name !== "node_modules" && !name.startsWith(".")

  const testFilesUnder = (dir: string): readonly string[] =>
    readdirSync(resolve(REPO_ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) return walkable(entry.name) ? testFilesUnder(rel) : []
      return entry.name.endsWith(".test.ts") ? [rel] : []
    })

  const testFiles = (): readonly string[] => TEST_ROOTS.flatMap(testFilesUnder)

  test("every `.test.ts` in the corpus registers at least one case", () => {
    const files = testFiles()
    // ANTI-VACUITY: the walk must find the real corpus, not an empty list.
    expect(files.length).toBeGreaterThan(3_000)
    const tombstones = files.filter(
      (file) => !REGISTERS_CASES.test(readFileSync(resolve(REPO_ROOT, file), "utf8")),
    )
    expect(
      tombstones,
      "a `.test.ts` with no cases is planned into a chunk and can never report execution:\n  " +
        `${tombstones.join("\n  ")}`,
    ).toEqual([])
  })

  test("the detector is not vacuous — it fires on the shape it is named for", () => {
    // The exact content of the file this found, minus its prose.
    expect(REGISTERS_CASES.test("// a note about removed tests\nexport {}\n")).toBe(false)
    // ...and accepts both real shapes.
    expect(REGISTERS_CASES.test('describe("x", () => {})')).toBe(true)
    expect(REGISTERS_CASES.test('test("x", () => {})')).toBe(true)
    expect(REGISTERS_CASES.test("registerSliceBoundarySuite(config)")).toBe(true)
    expect(REGISTERS_CASES.test('import "../../src/llm/empty-stream-breaker.test"')).toBe(true)
    // ...and an ordinary import of a NON-test module is not a registration.
    expect(REGISTERS_CASES.test('import { helper } from "./helper"')).toBe(false)
  })
})
