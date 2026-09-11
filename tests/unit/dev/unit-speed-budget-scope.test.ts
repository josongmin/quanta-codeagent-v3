import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { writeSuccessfulTestShardReceiptAtomic } from "../../../tools/dev/test-shard-receipt"

/**
 * The unit speed budget stopped executing the unit suite for itself and now
 * consumes the FULL-suite junit scoped to `tests/unit/`. That scoping had
 * never run against a real merged receipt: the full-suite gate has to finish
 * before the consumer is even reached, so a scope that silently matched
 * nothing would surface as a red gate at the END of a 25-minute campaign, and
 * would read as "the budget broke" rather than "the filter missed".
 *
 * The fixture is the exact shape Bun's junit reporter emits (measured on
 * 1.3.14: `file` is written RELATIVE to the worker cwd even when the command
 * line carried absolute paths) merged the way the runner merges chunks.
 */

const REPO_ROOT = join(import.meta.dir, "..", "..", "..")
const SCRIPT = join(REPO_ROOT, "tools", "dev", "unit-speed-budget.ts")
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const suite = (file: string, cases: readonly { name: string; seconds: number }[]): string =>
  `<testsuite name="${file}" file="${file}" tests="${cases.length}" assertions="${cases.length}" failures="0" skipped="0" time="0.1" hostname="test">\n` +
  cases
    .map(
      (one) =>
        `  <testcase name="${one.name}" classname="" time="${one.seconds}" file="${file}" line="1" assertions="1" />`,
    )
    .join("\n") +
  "\n</testsuite>"

const mergedJunit = (bodies: readonly string[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-speed-scope-"))
  roots.push(dir)
  const path = join(dir, "full-junit.xml")
  writeFileSync(
    path,
    `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="bun test sharded">\n${bodies.join("\n")}\n</testsuites>\n`,
  )
  return path
}

/** 1,200 fast cases: comfortably over the script's anti-vacuity floor. The
 *  prefix is a parameter because one case scopes to a gitignored directory,
 *  and the floor applies AFTER the scope filter. */
const fastUnitSuites = (prefix = "tests/unit/"): string[] =>
  Array.from({ length: 12 }, (_, index) =>
    suite(
      `${prefix}fixture-${index}.test.ts`,
      Array.from({ length: 100 }, (_, caseIndex) => ({
        name: `case ${caseIndex}`,
        seconds: 0.001,
      })),
    ),
  )

const run = (
  xmlPath: string,
  args: readonly string[],
  timingOverrides: Readonly<Record<string, number>> = {},
): { readonly code: number; readonly out: string; readonly err: string } => {
  const xml = readFileSync(xmlPath, "utf8")
  const files = [
    ...new Set(
      [...xml.matchAll(/<testcase\b[^>]*\bfile="([^"]+)"/g)].flatMap((match) =>
        match[1] === undefined ? [] : [match[1]],
      ),
    ),
  ]
  const timingsPath = `${xmlPath}.timings.json`
  // The CURRENT store schema. This fixture used to write `quanta.test-timings.v1`
  // with `{ ms, sampledAtMs }` entries — a shape `loadTestTimings` has never
  // accepted — so every assertion below about runner-timed file cost was
  // measuring the empty-store path instead of the store.
  writeFileSync(
    timingsPath,
    `${JSON.stringify({
      schema: "quanta.test-timings.v2",
      entries: Object.fromEntries(
        files.map((file) => [
          file,
          {
            samples: [
              {
                schedulingWeightMs: timingOverrides[file] ?? 1,
                suiteMs: timingOverrides[file] ?? 1,
                chunkOverheadShareMs: 0,
                observedChunkWallMs: timingOverrides[file] ?? 1,
                sampledAtMs: Date.now(),
                runnerClass: "pure",
                policyDigest: "fixture",
                intraParallel: 1,
                loadPerCore: 0,
              },
            ],
          },
        ]),
      ),
    })}\n`,
  )
  const proc = Bun.spawnSync(
    [process.execPath, SCRIPT, xmlPath, ...args, `--timings=${timingsPath}`],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  )
  return {
    code: proc.exitCode ?? 1,
    out: proc.stdout.toString(),
    err: proc.stderr.toString(),
  }
}

describe("unit speed budget over the full-suite receipt", () => {
  test("scoping counts the unit tier and ignores the rest", () => {
    const xml = mergedJunit([
      ...fastUnitSuites(),
      suite("tests/integration/slow-e2e.test.ts", [{ name: "slow rail", seconds: 30 }]),
      suite("tests/meta/whatever.test.ts", [{ name: "meta", seconds: 5 }]),
    ])
    const scoped = run(xml, ["--scope=tests/unit/"])
    expect(scoped.code, `${scoped.out}\n${scoped.err}`).toBe(0)
    // Only the 1,200 unit cases are counted — not the 2 outside the scope.
    expect(scoped.out).toContain("unit-speed-budget: 1200 tests")
  })

  test("a slow INTEGRATION test cannot trip the unit ceiling", () => {
    // This is the reason the budget is scoped rather than fed the unit suite:
    // integration owns the cases that are legitimately slow, and before the
    // scope existed they were simply not in the file it read.
    const xml = mergedJunit([
      ...fastUnitSuites(),
      suite("tests/integration/very-slow-e2e.test.ts", [{ name: "60s rail", seconds: 60 }]),
    ])
    expect(run(xml, ["--scope=tests/unit/"]).code).toBe(0)

    // Paired control: the SAME receipt without the scope sees the 60s case and
    // the gate goes red. The filter is doing the work, not the fixture.
    const unscoped = run(xml, [])
    expect(unscoped.code).toBe(1)
    expect(unscoped.err).toContain("REGRESSION")
  })

  test("a FAILING standalone re-run cannot downgrade a regression", () => {
    // The re-run's exit code was captured and used only inside a message
    // string, so a re-run that died at module load came back fast and the gate
    // reported "[screen only] … Contention, not a slow test" over a genuine
    // 60s case. A red re-run measures nothing.
    const dir = mkdtempSync(join(tmpdir(), "quanta-speed-red-"))
    roots.push(dir)
    // A real file that EXISTS (so the confirm path is taken) and always fails.
    // It lives under .cache/ — gitignored — because the authoritative runner
    // demands a CLEAN checkout and re-snapshots `git status` after every
    // chunk: writing a probe into the test tree raced that invariant and could
    // invalidate a whole campaign from another chunk.
    const failing = join(".cache", "__speed-probe-that-fails.test.ts")
    mkdirSync(join(REPO_ROOT, ".cache"), { recursive: true })
    writeFileSync(
      join(REPO_ROOT, failing),
      'import { test } from "bun:test"\ntest("boom", () => { throw new Error("boom") })\n',
    )
    try {
      const xml = mergedJunit([
        ...fastUnitSuites(".cache/"),
        suite(failing, [{ name: "slow and red", seconds: 60 }]),
      ])
      const result = run(xml, ["--scope=.cache/"])
      // Assert the INVARIANT, not which fail-closed branch fired. Both "the
      // re-run exited non-zero" and "the re-run wrote no junit" are correct
      // refusals; binding the assertion to one message made it depend on how
      // early the child died, which differs between a bare shell and the
      // runner's worker env.
      expect(result.code).toBe(1)
      expect(result.err).toContain("REGRESSION")
      expect(result.err).toContain("screen number stands")
    } finally {
      rmSync(join(REPO_ROOT, failing), { force: true })
    }
  })

  test("a scope that matches nothing fails closed instead of passing empty", () => {
    const xml = mergedJunit(fastUnitSuites())
    const missed = run(xml, ["--scope=tests/does-not-exist/"])
    expect(missed.code).toBe(1)
    expect(missed.err).toContain("only 0 testcases parsed")
  })

  test("100 individually-fast 100ms cases are governed as a 10s file aggregate", () => {
    const aggregateFile = "tests/unit/aggregate-only-probe.test.ts"
    const xml = mergedJunit([
      ...fastUnitSuites(),
      suite(
        aggregateFile,
        Array.from({ length: 100 }, (_, index) => ({ name: `aggregate ${index}`, seconds: 0.1 })),
      ),
    ])
    const result = run(xml, ["--scope=tests/unit/"])
    expect(result.code, `${result.out}\n${result.err}`).toBe(0)
    expect(result.out).toContain("slowest file 10000ms/43517ms")
  })

  test("runner receipt makes module/startup cost visible when testcase times are tiny", () => {
    const moduleFile = "tests/unit/fixture-0.test.ts"
    const xml = mergedJunit(fastUnitSuites())
    const result = run(xml, ["--scope=tests/unit/"], { [moduleFile]: 60_000 })
    expect(result.code).toBe(1)
    expect(result.err).toContain("slowest unit file")
    expect(result.err).toContain("runner/module-aware screen=60000ms")
  })
})

/** Run with an explicitly-supplied timings file (or none at all). */
const runRaw = (
  xmlPath: string,
  args: readonly string[],
): { readonly code: number; readonly out: string; readonly err: string } => {
  const proc = Bun.spawnSync([process.execPath, SCRIPT, xmlPath, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  })
  return { code: proc.exitCode ?? 1, out: proc.stdout.toString(), err: proc.stderr.toString() }
}

describe("missing runner timings are a bounded coverage miss, never an unclearable red", () => {
  test("an absent store REPORTS why and does not fail the gate — twice running", () => {
    const xml = mergedJunit(fastUnitSuites())
    const absent = `${xml}.no-such-store.json`

    // MEASURED at HEAD: three consecutive invocations all exited 1 with
    // `is missing 12/12 executed file(s)`, and nothing in that path ever
    // created the store — an unclearable gate.
    const first = runRaw(xml, ["--scope=tests/unit/", `--timings=${absent}`])
    const second = runRaw(xml, ["--scope=tests/unit/", `--timings=${absent}`])

    expect(first.code, `${first.out}\n${first.err}`).toBe(0)
    expect(second.code).toBe(0)
    expect(first.err).toContain("INCOHERENT timing evidence")
    expect(first.err).toContain("cold (absent)")
    expect(first.err).toContain("bounded coverage miss, not a gate failure")
    // The degradation is COUNTED in the summary, never silent.
    expect(first.out).toContain("timing-coverage=0/12")
  })

  test("ANTI-VACUITY — a real per-test regression still fails with no timings at all", () => {
    // Same missing-store condition, one genuinely slow case. If the branch
    // above had simply stopped asserting, this would pass too.
    const xml = mergedJunit([
      ...fastUnitSuites(),
      suite("tests/unit/slow.test.ts", [{ name: "very slow unit case", seconds: 90 }]),
    ])
    const result = runRaw(xml, ["--scope=tests/unit/", `--timings=${xml}.absent.json`])

    expect(result.code).toBe(1)
    expect(result.err).toContain("REGRESSION")
  })

  test("`--receipts` rehydrates the missing files from green shard receipts", () => {
    const xml = mergedJunit(fastUnitSuites())
    const receiptsRoot = join(dirname(xml), "shard-receipts")
    const namespace = join(receiptsRoot, "full:pr")
    mkdirSync(namespace, { recursive: true })
    const files = Array.from({ length: 12 }, (_, index) => `tests/unit/fixture-${index}.test.ts`)
    writeSuccessfulTestShardReceiptAtomic({
      path: join(namespace, "chunk.json"),
      identity: {
        scopeKind: "whole-tree",
        treeSha256: "a".repeat(64),
        suite: "full:pr",
        manifestSha256: "b".repeat(64),
        shardIndex: 1,
        shardFileCount: files.length,
        shardFilesSha256: "c".repeat(64),
        runtimeSha256: "d".repeat(64),
        toolScopeSha256: "e".repeat(64),
        testEnvSha256: "f".repeat(64),
        junit: true,
        intraParallel: 1,
        executionPolicySha256: "0".repeat(64),
        timeoutPolicySha256: "1".repeat(64),
        inputScopeSha256: "2".repeat(64),
        producerReceiptsSha256: "3".repeat(64),
      },
      executedFileIds: files,
      scanReachRecords: [],
      testTimeoutMs: 120_000,
      timingObservations: files.map((file) => ({
        file,
        schedulingWeightMs: 7,
        suiteMs: 7,
        chunkOverheadShareMs: 0,
        observedChunkWallMs: 7,
        runnerClass: "pure",
        policyDigest: "policy",
        intraParallel: 1,
        loadPerCore: 0,
      })),
      scopeReason: "fixture",
      junitXml: readFileSync(xml, "utf8"),
    })

    const result = runRaw(xml, [
      "--scope=tests/unit/",
      `--timings=${xml}.absent.json`,
      `--receipts=${receiptsRoot}`,
    ])

    expect(result.code, `${result.out}\n${result.err}`).toBe(0)
    // Full coverage restored from the receipts, so no incoherence is reported.
    expect(result.out).toContain("timing-coverage=12/12")
    expect(result.err).not.toContain("INCOHERENT")
  })
})
