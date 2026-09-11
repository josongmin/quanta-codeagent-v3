import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { externalToolchainFingerprint } from "../../tools/dev/external-toolchain"
import { runResourceAwareSchedule } from "../../tools/dev/test-shard-lifecycle"
import {
  assertTestChunkPlan,
  chooseIntraWorkerParallelism,
  chooseShardConcurrency,
  chooseShardTestTimeoutMs,
  classifyTestResource,
  MAX_INTRA_WORKER_PARALLELISM,
  nextOverloadDelayMs,
  parseExecutedFileCount,
  planTestChunks,
  resourceClassesOverlap,
  spoolTail,
  TEST_RESOURCE_CLASSES,
  watchdogAction,
} from "../../tools/dev/test-shard-plan"
import {
  loadSuccessfulTestShardReceipt,
  mergeScanReachSinks,
  shardFilesSha256,
  TEST_SHARD_CACHE_TTL_MS,
  testEnvironmentSha256,
  testToolchainSha256,
  writeScanReachReceiptAtomic,
  writeSuccessfulTestShardReceiptAtomic,
} from "../../tools/dev/test-shard-receipt"
import {
  harvestChunkTimingObservations,
  harvestChunkTimings,
  loadTestTimings,
  mergeTestTimingObservations,
  mergeTestTimings,
  TEST_TIMING_MAX_AGE_MS,
  TEST_TIMING_SCHEMA,
} from "../../tools/dev/test-shard-timings"

/** A root with no dotenv files, so the dotenv half of the fingerprint is a
 *  constant and these comparisons stay about the ENV half. */
const NO_DOTENV = join(import.meta.dir, "__fixture-root-without-dotenv__")

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("resource-classed chunk plan", () => {
  test("partitions one manifest exactly into single-class chunks", () => {
    const files = Array.from({ length: 17 }, (_, index) => `tests/unit/file-${index}.test.ts`)
    const shared = new Set(["tests/unit/file-3.test.ts", "tests/unit/file-11.test.ts"])
    const chunks = planTestChunks(files, {
      classify: (file) => (shared.has(file) ? "port" : "pure"),
    })

    expect(() => assertTestChunkPlan(files, chunks)).not.toThrow()
    expect(chunks.flatMap(({ files: chunkFiles }) => chunkFiles).sort()).toEqual([...files].sort())
    // No chunk mixes classes, and the shared files live only in "port" chunks.
    const portFiles = chunks
      .filter(({ resourceClass }) => resourceClass === "port")
      .flatMap(({ files: chunkFiles }) => chunkFiles)
    expect(portFiles.sort()).toEqual([...shared].sort())

    // Red-on-injection: losing one explicit path must invalidate the verdict.
    const mutilated = chunks.map((chunk, offset) =>
      offset === 0 ? { ...chunk, files: chunk.files.slice(1) } : chunk,
    )
    expect(() => assertTestChunkPlan(files, mutilated)).toThrow(
      /partition is not exact|partition missing/,
    )
  })

  test("measured timings do not move files between membership buckets", () => {
    const files = Array.from({ length: 12 }, (_, index) => `tests/unit/file-${index}.test.ts`)
    const slow = "tests/unit/file-0.test.ts"
    const timings = new Map(files.map((file) => [file, file === slow ? 60_000 : 1_000]))
    const chunks = planTestChunks(files, {
      classify: () => "pure",
      predictMs: (file) => timings.get(file),
    })
    expect(() => assertTestChunkPlan(files, chunks)).not.toThrow()
    const cold = planTestChunks(files, {
      classify: () => "pure",
    })
    expect(cold.map((chunk) => [...chunk.files])).toEqual(chunks.map((chunk) => [...chunk.files]))
    expect(
      planTestChunks(files, {
        classify: () => "pure",
        predictMs: (file) => timings.get(file),
      }),
    ).toEqual(chunks)
  })

  test("absolute discovery paths hash by canonical repo-relative membership", () => {
    const roots = ["/Users/alice/repo", "/home/runner/work/repo/repo"]
    const relativeFiles = Array.from(
      { length: 24 },
      (_, index) => `tests/unit/file-${index}.test.ts`,
    )
    const plans = roots.map((root) =>
      planTestChunks(
        relativeFiles.map((file) => `${root}/${file}`),
        {
          classify: () => "pure",
          membershipFile: (file) => file.slice(root.length + 1),
        },
      ).map((chunk) => ({
        resourceClass: chunk.resourceClass,
        files: chunk.files.map((file) => file.slice(root.length + 1)),
      })),
    )
    expect(plans[1]).toEqual(plans[0])
  })

  test("a cold timing store still partitions exactly", () => {
    const files = Array.from({ length: 100 }, (_, index) => `tests/unit/f-${index}.test.ts`)
    const chunks = planTestChunks(files, { classify: () => "pure" })
    expect(() => assertTestChunkPlan(files, chunks)).not.toThrow()
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.every((chunk) => chunk.files.length > 0)).toBe(true)
  })

  test("count-matched missing plus duplicate is not an exact partition", () => {
    const files = ["a.test.ts", "b.test.ts"]
    const chunks = [
      {
        index: 1,
        files: ["a.test.ts", "a.test.ts"],
        resourceClass: "pure" as const,
        predictedMs: 1,
        claims: [],
      },
    ]
    expect(() => assertTestChunkPlan(files, chunks)).toThrow("partition is not exact")
  })

  test("classifier names the owned resource; path fallback stays serialized", () => {
    // ★ A real browser must not share the box with ANYTHING, `pure` included.
    //
    // MEASURED DEFECT (2026-09-02 gate audit, second pass): classifying the
    // real-Chrome files correctly was necessary and NOT sufficient. The overlap
    // rule lets `pure` run beside every class unconditionally and the validated
    // non-pure pair set is empty, so the 12-file `browser` chunk is always
    // scheduled against a `pure` chunk of ~137 files. Chrome then lost an
    // HONORED, pressure-scaled 60,000ms CDP budget by 1.88ms
    // (`browser-real-chrome-adversarial-e2e.test.ts` declares
    // `pressureScaledTimeoutMs(30_000)`, the run had scale 2) — while the same
    // file passes 3/3 in isolation. The peer's CPU appetite is what breaks a
    // browser, not its resource KIND, which is the one case `pure` cannot model.
    //
    // Raising the multiplier again would record contention as a code property.
    expect(resourceClassesOverlap("browser", "pure")).toBe(false)
    expect(resourceClassesOverlap("pure", "browser")).toBe(false)
    expect(resourceClassesOverlap("browser", "browser")).toBe(false)
    // PAIRED CONTROL — the design's parallelism win is a carve-out, not a
    // reversal: `pure` still overlaps every OTHER class.
    expect(resourceClassesOverlap("pure", "port")).toBe(true)
    expect(resourceClassesOverlap("pure", "integration-path")).toBe(true)
    expect(resourceClassesOverlap("pure", "pure")).toBe(true)
    // PAIRED CONTROL — unrelated non-pure pairs are unchanged (still serial).
    expect(resourceClassesOverlap("port", "lsp")).toBe(false)
  })

  test("an exclusive class still runs — it waits for an empty box, it does not deadlock", async () => {
    // `browser` overlapping NOTHING is only safe because the scheduler starts a
    // task unconditionally when nothing is running. Without that this change
    // would hang the suite instead of serializing it.
    const started: string[] = []
    const release = new Map<string, () => void>()
    const gate = (key: string) =>
      new Promise<void>((resolve) => {
        release.set(key, resolve)
      })
    const task = (key: number, name: string, resourceClass: string) => ({
      key,
      resourceClass,
      run: async (): Promise<string> => {
        started.push(name)
        await gate(name)
        return name
      },
    })
    const done = runResourceAwareSchedule({
      tasks: [task(1, "browser-chunk", "browser"), task(2, "pure-chunk", "pure")],
      overlap: (a, b) => resourceClassesOverlap(a as never, b as never),
      desiredConcurrency: async () => 2,
      cancelAll: async () => undefined,
    })
    // Only the browser chunk may hold the box; the pure peer must WAIT.
    while (started.length === 0) await new Promise((r) => setTimeout(r, 1))
    expect(started).toEqual(["browser-chunk"])
    release.get("browser-chunk")?.()
    // Once it frees the box the peer runs — so nothing is starved.
    while (started.length < 2) await new Promise((r) => setTimeout(r, 1))
    expect(started).toEqual(["browser-chunk", "pure-chunk"])
    release.get("pure-chunk")?.()
    await done
  })

  test("classifier names the owned resource (real browser edition)", () => {
    // ★ A test that SPAWNS A REAL BROWSER must be classed `browser` so the
    // scheduler serializes it against browser-owning peers.
    //
    // MEASURED DEFECT (2026-09-02 gate audit): the browser detector matched
    // `puppeteer|playwright|chromium|--headless` — none of which this repo's own
    // CDP adapter uses. `tests/integration/browser-agent-loop-e2e.test.ts`
    // spawns real Chrome at module load and scored ZERO matches, so it fell
    // through to `integration-path` and was overlapped with 135 integration
    // files. It then failed the full suite on a 60s CDP navigate timeout
    // (2 x DEFAULT_CDP_COMMAND_MS) that reproduces 0/4 in isolation.
    //
    // The token is the real-spawn gate, not the word "chrome": matching
    // `cdp`/`chrome` broadly would reclassify 56 files — mostly pure unit tests
    // with no browser at all — and serialize the suite for nothing.
    expect(
      classifyTestResource(
        "tests/integration/browser-agent-loop-e2e.test.ts",
        "const REAL_CHROME_RAN = await probe.spawn()",
      ),
    ).toBe("browser")
    // PAIRED CONTROL — a CDP UNIT test owns no browser and must stay cheap.
    expect(
      classifyTestResource(
        "tests/unit/browser-cdp-session-hellgate.test.ts",
        "const session = new CdpSession(fakeTransport)",
      ),
    ).toBe("pure")
    expect(classifyTestResource("tests/unit/plain.test.ts", "expect(1).toBe(1)")).toBe("pure")
    expect(classifyTestResource("tests/integration/plain.test.ts", "")).toBe("integration-path")
    expect(classifyTestResource("tests/unit/plain.test.ts", "Bun.listen({ port: 0 })")).toBe("port")
    expect(
      classifyTestResource("tests/unit/plain.test.ts", 'const endpoint = "127.0.0.1:14318"'),
    ).toBe("port")
    expect(
      classifyTestResource(
        "tests/unit/plain.test.ts",
        "writeFileSync(join(REPO_ROOT, 'fixture'), 'x')",
      ),
    ).toBe("repo-write")
    expect(
      classifyTestResource("tests/unit/plain.test.ts", 'spawn("git", ["worktree", "add"])'),
    ).toBe("worktree")
    expect(classifyTestResource("tests/unit/plain.test.ts", 'import "puppeteer"')).toBe("browser")
    expect(
      classifyTestResource("tests/unit/plain.test.ts", 'spawn("typescript-language-server")'),
    ).toBe("lsp")
    expect(classifyTestResource("tests/unit/plain.test.ts", "process.kill(pid, 0)")).toBe(
      "process-global",
    )
  })

  test("pure overlaps everything EXCEPT the exclusive classes; non-pure serialize until validated", () => {
    // The carve-out is named here rather than removing the rule: `pure` still
    // overlaps every class whose hazard is its KIND. A real browser's hazard is
    // the peer's CPU appetite, which `pure` cannot model (2026-09-02 audit).
    const exclusive = new Set(["browser"])
    for (const resourceClass of TEST_RESOURCE_CLASSES) {
      expect(resourceClassesOverlap("pure", resourceClass)).toBe(!exclusive.has(resourceClass))
      // Symmetric: the rule is order-independent, carve-out included.
      expect(resourceClassesOverlap(resourceClass, "pure")).toBe(!exclusive.has(resourceClass))
    }
    const nonPure = TEST_RESOURCE_CLASSES.filter((resourceClass) => resourceClass !== "pure")
    for (const left of nonPure) {
      for (const right of nonPure) {
        expect(resourceClassesOverlap(left, right)).toBe(false)
      }
    }
  })

  test("only pure chunks may overlap files inside one worker", () => {
    const idle = { cpuCount: 16, workers: 1, pressure: 1 } as const
    // MEASURED (24-file pure sample): identical verdicts at 1 and at 8 — 295
    // pass / 0 fail / exit 0, repeated — with wall time 27s -> 11s.
    expect(chooseIntraWorkerParallelism({ resourceClass: "pure", ...idle })).toBe(8)

    // THE SAFETY PROPERTY: every class that names a process-global or
    // checkout-global resource stays strictly serial, however idle the box.
    // Overlapping two of those inside one process is exactly what the class
    // system exists to prevent.
    for (const resourceClass of TEST_RESOURCE_CLASSES) {
      if (resourceClass === "pure") continue
      expect(chooseIntraWorkerParallelism({ resourceClass, ...idle })).toBe(1)
      expect(
        chooseIntraWorkerParallelism({ resourceClass, cpuCount: 64, workers: 1, pressure: 1 }),
      ).toBe(1)
    }
  })

  test("the intra-worker budget is CPU headroom shared by the live workers", () => {
    // Two overlapping workers split the same box.
    expect(
      chooseIntraWorkerParallelism({
        resourceClass: "pure",
        cpuCount: 16,
        workers: 2,
        pressure: 1,
      }),
    ).toBe(4)
    // An oversubscribed host is not piled on further.
    expect(
      chooseIntraWorkerParallelism({
        resourceClass: "pure",
        cpuCount: 16,
        workers: 1,
        pressure: 4,
      }),
    ).toBe(2)
    // Small boxes fall back to serial rather than thrash.
    expect(
      chooseIntraWorkerParallelism({ resourceClass: "pure", cpuCount: 2, workers: 2, pressure: 1 }),
    ).toBe(1)
    // Capped however large the box is: these tests spawn real subprocesses.
    expect(
      chooseIntraWorkerParallelism({
        resourceClass: "pure",
        cpuCount: 256,
        workers: 1,
        pressure: 1,
      }),
    ).toBe(MAX_INTRA_WORKER_PARALLELISM)
    // Nonsense input fails closed to serial.
    expect(
      chooseIntraWorkerParallelism({
        resourceClass: "pure",
        cpuCount: Number.NaN,
        workers: 1,
        pressure: 1,
      }),
    ).toBe(1)
  })

  test("yielding to a loaded host is a campaign budget, not a per-start one", () => {
    const pollMs = 30_000
    const thresholdPressure = 4
    // Below the threshold the runner never sleeps.
    expect(
      nextOverloadDelayMs({ pressure: 3, budgetLeftMs: 600_000, pollMs, thresholdPressure }),
    ).toBe(0)
    // At or above it, one poll interval at a time.
    expect(
      nextOverloadDelayMs({ pressure: 4, budgetLeftMs: 600_000, pollMs, thresholdPressure }),
    ).toBe(pollMs)
    // The last slice is clipped to what is left, and an exhausted budget stops
    // the yielding entirely.
    expect(
      nextOverloadDelayMs({ pressure: 9, budgetLeftMs: 5_000, pollMs, thresholdPressure }),
    ).toBe(5_000)
    expect(nextOverloadDelayMs({ pressure: 9, budgetLeftMs: 0, pollMs, thresholdPressure })).toBe(0)
    expect(
      nextOverloadDelayMs({
        pressure: Number.NaN,
        budgetLeftMs: 600_000,
        pollMs,
        thresholdPressure,
      }),
    ).toBe(0)

    // THE PROPERTY: however many starts a serial campaign makes, the TOTAL
    // yielded time cannot exceed the budget. The per-start version granted a
    // fresh 10 minutes to each of 30 chunks — five hours of sleeping.
    let budgetLeftMs = 600_000
    let totalSlept = 0
    for (let start = 0; start < 30; start += 1) {
      let slice = nextOverloadDelayMs({ pressure: 9, budgetLeftMs, pollMs, thresholdPressure })
      while (slice > 0) {
        totalSlept += slice
        budgetLeftMs -= slice
        slice = nextOverloadDelayMs({ pressure: 9, budgetLeftMs, pollMs, thresholdPressure })
      }
    }
    expect(totalSlept).toBe(600_000)
  })

  test("bounds concurrency at two and falls back when reclaimable memory is insufficient", () => {
    expect(
      chooseShardConcurrency({ totalBytes: 48 * 1024 ** 3, availableBytes: 20 * 1024 ** 3 }),
    ).toBe(2)
    expect(
      chooseShardConcurrency({ totalBytes: 48 * 1024 ** 3, availableBytes: 8 * 1024 ** 3 }),
    ).toBe(1)
    expect(
      chooseShardConcurrency({ totalBytes: 16 * 1024 ** 3, availableBytes: 16 * 1024 ** 3 }),
    ).toBe(1)
  })

  test("bounds per-test timeout scaling under external CPU pressure", () => {
    // Low load still retains enough late-campaign headroom for a 60s internal
    // process deadline plus teardown; the former 60s outer ceiling raced it.
    expect(chooseShardTestTimeoutMs({ loadAverage1m: 12, cpuCount: 12 })).toBe(120_000)
    expect(chooseShardTestTimeoutMs({ loadAverage1m: 48, cpuCount: 12 })).toBe(240_000)
    expect(chooseShardTestTimeoutMs({ loadAverage1m: 300, cpuCount: 12 })).toBe(300_000)
    expect(chooseShardTestTimeoutMs({ loadAverage1m: Number.NaN, cpuCount: 12 })).toBe(120_000)
  })

  test("requires Bun's final executed-file receipt and ignores nested earlier footers", () => {
    const output = [
      "Ran 1 test across 1 file. [1ms]",
      "child output",
      "Ran 99 tests across 8 files. [20ms]",
    ].join("\n")
    expect(parseExecutedFileCount(output)).toBe(8)
    expect(parseExecutedFileCount("1 pass\n0 fail\n")).toBeUndefined()
  })
})

describe("measured per-file timing store", () => {
  test("harvest attributes suite time plus an even share of chunk overhead", () => {
    const junit = [
      '<testsuites name="bun test">',
      '  <testsuite name="/r/a.test.ts" file="/r/a.test.ts" time="2.0"><testcase name="t" time="2.0" /></testsuite>',
      '  <testsuite name="/r/b.test.ts" file="/r/b.test.ts" time="1.0"><testcase name="t" time="1.0" /></testsuite>',
      "</testsuites>",
    ].join("\n")
    // Chunk wall = 9s, attributed suite time = 3s → 6s overhead over 3 files.
    const estimates = harvestChunkTimings(
      junit,
      ["/r/a.test.ts", "/r/b.test.ts", "/r/c.test.ts"],
      9_000,
    )
    expect(estimates.get("/r/a.test.ts")).toBe(4_000)
    expect(estimates.get("/r/b.test.ts")).toBe(3_000)
    // A file Bun gave no suite entry still carries its overhead share — module
    // load cost is real wall time the planner must see.
    expect(estimates.get("/r/c.test.ts")).toBe(2_000)
  })

  test("JUnit harvest keys attributes by name, not order", () => {
    const estimates = harvestChunkTimings(
      '<testsuite time="1.5" name="n" file="a.test.ts"></testsuite>',
      ["a.test.ts"],
      1_500,
    )
    expect(estimates.get("a.test.ts")).toBe(1_500)
  })

  test("v2 preserves suite and chunk-overhead components", () => {
    const observations = harvestChunkTimingObservations(
      '<testsuite time="1.5" name="n" file="a.test.ts"></testsuite>',
      ["a.test.ts", "b.test.ts"],
      3_500,
      {
        runnerClass: "integration-path",
        policyDigest: "policy-a",
        intraParallel: 1,
        loadPerCore: 0.5,
      },
    )
    expect(observations.get("a.test.ts")).toEqual({
      schedulingWeightMs: 2_500,
      suiteMs: 1_500,
      chunkOverheadShareMs: 1_000,
      observedChunkWallMs: 3_500,
      runnerClass: "integration-path",
      policyDigest: "policy-a",
      intraParallel: 1,
      loadPerCore: 0.5,
    })
    expect(observations.get("b.test.ts")?.suiteMs).toBe(0)
    expect(observations.get("b.test.ts")?.schedulingWeightMs).toBe(1_000)
  })

  test("store round-trips, expires stale entries, and survives corruption", () => {
    const directory = mkdtempSync(join(tmpdir(), "shard-timings-test-"))
    temporaryDirectories.push(directory)
    const path = join(directory, "timings.json")
    const nowMs = 1_800_000_000_000
    mergeTestTimings(path, new Map([["a.test.ts", 1234.6]]), nowMs)
    expect(loadTestTimings(path, nowMs).get("a.test.ts")).toBe(1235)

    // Merge keeps fresh entries and drops the ones past the max age.
    mergeTestTimings(path, new Map([["b.test.ts", 50]]), nowMs + TEST_TIMING_MAX_AGE_MS + 1)
    const later = loadTestTimings(path, nowMs + TEST_TIMING_MAX_AGE_MS + 1)
    expect(later.get("a.test.ts")).toBeUndefined()
    expect(later.get("b.test.ts")).toBe(50)

    // Corrupt or foreign content is an empty store, never a crash.
    writeFileSync(path, "not-json")
    expect(loadTestTimings(path, nowMs).size).toBe(0)
    writeFileSync(
      path,
      JSON.stringify({ schema: "other", entries: { x: { ms: 5, sampledAtMs: nowMs } } }),
    )
    expect(loadTestTimings(path, nowMs).size).toBe(0)

    // A legacy v1 store cannot silently become current scheduling evidence.
    writeFileSync(
      path,
      JSON.stringify({
        schema: "quanta.test-timings.v1",
        entries: { x: { ms: 5, sampledAtMs: nowMs } },
      }),
    )
    expect(loadTestTimings(path, nowMs).size).toBe(0)
  })

  test("v2 uses the newest execution cohort and retains component samples", () => {
    const directory = mkdtempSync(join(tmpdir(), "shard-timings-cohort-test-"))
    temporaryDirectories.push(directory)
    const path = join(directory, "timings.json")
    const observation = (weight: number, policyDigest: string) => ({
      schedulingWeightMs: weight,
      suiteMs: weight - 10,
      chunkOverheadShareMs: 10,
      observedChunkWallMs: weight + 100,
      runnerClass: "pure",
      policyDigest,
      intraParallel: 4,
      loadPerCore: 0.5,
    })
    mergeTestTimingObservations(path, new Map([["a.test.ts", observation(100, "old")]]), 100)
    mergeTestTimingObservations(path, new Map([["a.test.ts", observation(900, "old")]]), 200)
    mergeTestTimingObservations(path, new Map([["a.test.ts", observation(300, "new")]]), 300)
    expect(loadTestTimings(path, 300).get("a.test.ts")).toBe(300)
    const stored = JSON.parse(readFileSync(path, "utf8")) as {
      schema: string
      entries: Record<string, { samples: readonly unknown[] }>
    }
    expect(stored.schema).toBe(TEST_TIMING_SCHEMA)
    expect(stored.entries["a.test.ts"]?.samples).toHaveLength(3)
  })
})

describe("scan-reach shard receipt", () => {
  test("merges unique worker sinks by minimum reach and writes the v1 receipt atomically", () => {
    const directory = mkdtempSync(join(tmpdir(), "shard-receipt-test-"))
    temporaryDirectories.push(directory)
    const left = join(directory, "left.jsonl")
    const right = join(directory, "right.jsonl")
    const receiptPath = join(directory, "cache", "receipt.json")
    writeFileSync(left, '{"id":"b","walked":12,"matched":4}\n{"id":"a","walked":8}\n')
    writeFileSync(right, '{"id":"b","walked":10,"matched":3}\n')

    expect(mergeScanReachSinks([left, right])).toEqual([
      { id: "a", walked: 8 },
      { id: "b", walked: 10, matched: 3 },
    ])
    const authority = {
      suite: "full",
      tier: "full",
      membershipSha256: "c".repeat(64),
      policySha256: "d".repeat(64),
      capabilitySha256: "e".repeat(64),
    } as const
    writeScanReachReceiptAtomic({
      path: receiptPath,
      head: "a".repeat(40),
      manifestSha256: "b".repeat(64),
      sinks: [left, right],
      authority,
    })
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>
    expect(receipt.schema).toBe("quanta.scan-reach-receipt.v2")
    // The authority travels WITH the receipt, so a consumer can recompute and
    // compare rather than take the digest's word for it.
    expect(receipt.tier).toBe("full")
    expect(receipt.membershipSha256).toBe("c".repeat(64))
    expect(receipt.policySha256).toBe("d".repeat(64))
    expect(receipt.capabilitySha256).toBe("e".repeat(64))

    // A narrowed tier is refused at the SOURCE, not merely distrusted later.
    for (const tier of ["pr", "prepush", "unit", ""]) {
      expect(() =>
        writeScanReachReceiptAtomic({
          path: receiptPath,
          head: "a".repeat(40),
          manifestSha256: "b".repeat(64),
          sinks: [left, right],
          authority: { ...authority, tier },
        }),
      ).toThrow(/refusing to mint a scan-reach receipt from tier/)
    }
    expect(() =>
      writeScanReachReceiptAtomic({
        path: receiptPath,
        head: "a".repeat(40),
        manifestSha256: "b".repeat(64),
        sinks: [left, right],
        authority: { ...authority, suite: "unit" },
      }),
    ).toThrow(/refusing to mint a scan-reach receipt from suite/)
    expect(receipt.childExit).toBe(0)
    expect(receipt.records).toEqual([
      { id: "a", walked: 8 },
      { id: "b", walked: 10, matched: 3 },
    ])
  })

  test("refuses malformed worker evidence instead of blessing a partial receipt", () => {
    const directory = mkdtempSync(join(tmpdir(), "shard-receipt-test-"))
    temporaryDirectories.push(directory)
    const sink = join(directory, "bad.jsonl")
    writeFileSync(sink, '{"id":"scan","walked":-1}\n')
    expect(() => mergeScanReachSinks([sink])).toThrow("invalid scan-reach record")
  })
})

describe("same-INPUTS successful shard cache", () => {
  test("keys only verdict-relevant environment; runner-owned paths normalize", () => {
    const left = testEnvironmentSha256(
      { HOME: "/tmp/one", TMPDIR: "/tmp/a", QUANTA_MODE: "strict" },
      120_000,
      NO_DOTENV,
    )
    const right = testEnvironmentSha256(
      { HOME: "/tmp/two", TMPDIR: "/tmp/b", QUANTA_MODE: "strict" },
      120_000,
      NO_DOTENV,
    )
    expect(left).toBe(right)
    expect(
      testEnvironmentSha256(
        { QUANTA_MODE: "strict", QUANTA_TEST_SOURCE_JS_CLEANED_ROOT: "/checkout-a/src" },
        120_000,
        NO_DOTENV,
      ),
    ).toBe(
      testEnvironmentSha256(
        { QUANTA_MODE: "strict", QUANTA_TEST_SOURCE_JS_CLEANED_ROOT: "/checkout-b/src" },
        120_000,
        NO_DOTENV,
      ),
    )
    expect(testEnvironmentSha256({ QUANTA_MODE: "relaxed" }, 120_000, NO_DOTENV)).not.toBe(left)
    expect(testEnvironmentSha256({ QUANTA_MODE: "strict" }, 240_000, NO_DOTENV)).not.toBe(left)

    // An unrelated terminal variable must NOT be a cache miss: hashing all
    // inherited env made every new ITERM_SESSION_ID/SSH socket a full re-run.
    expect(
      testEnvironmentSha256(
        { QUANTA_MODE: "strict", ITERM_SESSION_ID: "w0t1p0", SSH_AUTH_SOCK: "/tmp/agent.9" },
        120_000,
        NO_DOTENV,
      ),
    ).toBe(left)
    // Verdict-relevant switches still key.
    expect(testEnvironmentSha256({ QUANTA_MODE: "strict", CI: "1" }, 120_000, NO_DOTENV)).not.toBe(
      left,
    )
    expect(
      testEnvironmentSha256({ QUANTA_MODE: "strict", REQUIRE_CONTRACT: "1" }, 120_000, NO_DOTENV),
    ).not.toBe(left)
    // The campaign lease token never keys: it differs on every campaign.
    expect(
      testEnvironmentSha256(
        { QUANTA_MODE: "strict", QUANTA_VERIFICATION_LEASE_TOKEN: "a".repeat(64) },
        120_000,
        NO_DOTENV,
      ),
    ).toBe(left)
    // Nested `bun run` PATH duplication is fingerprint-equivalent; order and
    // real entry changes still invalidate.
    const base = testEnvironmentSha256({ PATH: "/a:/b" }, 120_000, NO_DOTENV)
    expect(testEnvironmentSha256({ PATH: "/a:/b:/a:/b" }, 120_000, NO_DOTENV)).toBe(base)
    expect(testEnvironmentSha256({ PATH: "/b:/a" }, 120_000, NO_DOTENV)).not.toBe(base)
    expect(testEnvironmentSha256({ PATH: "/a:/b:/c" }, 120_000, NO_DOTENV)).not.toBe(base)
  })

  test("external tool capability changes invalidate the toolchain fingerprint", () => {
    const present = testToolchainSha256({ git: "/usr/bin/git git version 2.39.0" })
    expect(testToolchainSha256({ git: "/usr/bin/git git version 2.39.0" })).toBe(present)
    // Same PATH location, replaced executable — the receipt must not survive.
    expect(testToolchainSha256({ git: "/usr/bin/git git version 2.44.0" })).not.toBe(present)
    // A capability disappearing (or appearing) also invalidates.
    expect(testToolchainSha256({ git: "<missing>" })).not.toBe(present)
    // The live probe covers the tools the suites shell out to.
    const fingerprint = externalToolchainFingerprint()
    // `pyright` was the wrong binary — the tests resolve `pyright-langserver`;
    // the coverage drift guard now keeps this list honest against the corpus.
    for (const tool of ["git", "docker", "python3", "typescript-language-server", "cargo"]) {
      expect(typeof fingerprint[tool]).toBe("string")
      expect(fingerprint[tool]?.length).toBeGreaterThan(0)
    }
    // Injectable probe: fingerprints reflect exactly what the probe reports.
    const fake = externalToolchainFingerprint(() => "<missing>")
    expect(new Set(Object.values(fake))).toEqual(new Set(["<missing>"]))
  })

  test("hits only for an intact bounded exact-input receipt", () => {
    const directory = mkdtempSync(join(tmpdir(), "shard-success-cache-test-"))
    temporaryDirectories.push(directory)
    const testFile = join(directory, "a.test.ts")
    const receiptPath = join(directory, "cache", "shard-1.json")
    writeFileSync(testFile, "test('a', () => expect(1).toBe(1))\n")
    const identity = {
      scopeKind: "whole-tree" as const,
      treeSha256: "a".repeat(64),
      suite: "full",
      manifestSha256: "b".repeat(64),
      shardIndex: 1,
      shardFileCount: 1,
      shardFilesSha256: shardFilesSha256(directory, [testFile]),
      runtimeSha256: "9".repeat(64),
      toolScopeSha256: "c".repeat(64),
      testEnvSha256: testEnvironmentSha256(
        { QUANTA_TEST_KNOB: "super-secret-cache-input" },
        120_000,
        NO_DOTENV,
      ),
      junit: false,
      intraParallel: 1,
      executionPolicySha256: "f".repeat(64),
      inputScopeSha256: "1".repeat(64),
      timeoutPolicySha256: "2".repeat(64),
      producerReceiptsSha256: "3".repeat(64),
    }
    const nowMs = 1_800_000_000_000
    writeSuccessfulTestShardReceiptAtomic({
      path: receiptPath,
      identity,
      executedFileIds: ["tests/unit/a.test.ts"],
      scanReachRecords: [{ id: "guard", walked: 4, matched: 2 }],
      testTimeoutMs: 120_000,
      timingObservations: [],
      scopeReason: "test",
      nowMs,
    })

    expect(
      loadSuccessfulTestShardReceipt({
        path: receiptPath,
        expected: identity,
        expectedTestTimeoutMs: 120_000,
        nowMs,
      }).kind,
    ).toBe("hit")
    const identityMutations = [
      // The code under test — this REPLACED the git HEAD sha, which invalidated
      // every chunk on any commit including docs-only ones (2026-09-02).
      { ...identity, treeSha256: "d".repeat(64) },
      { ...identity, suite: "unit" },
      { ...identity, manifestSha256: "d".repeat(64) },
      { ...identity, shardFileCount: 2 },
      { ...identity, shardFilesSha256: "d".repeat(64) },
      { ...identity, runtimeSha256: "8".repeat(64) },
      { ...identity, toolScopeSha256: "d".repeat(64) },
      { ...identity, timeoutPolicySha256: "8".repeat(64) },
      { ...identity, producerReceiptsSha256: "8".repeat(64) },
      { ...identity, testEnvSha256: "d".repeat(64) },
      { ...identity, junit: true },
      { ...identity, inputScopeSha256: "d".repeat(64) },
    ]
    for (const expected of identityMutations) {
      expect(
        loadSuccessfulTestShardReceipt({
          path: receiptPath,
          expected,
          expectedTestTimeoutMs: 120_000,
          nowMs,
        }),
      ).toEqual({
        kind: "miss",
        reason: "input-mismatch",
      })
    }
    // A width-1 green does NOT answer for a width-8 plan.
    expect(
      loadSuccessfulTestShardReceipt({
        path: receiptPath,
        expectedTestTimeoutMs: 120_000,
        expected: { ...identity, intraParallel: 8 },
        nowMs,
      }),
    ).toEqual({ kind: "miss", reason: "input-mismatch" })

    // The chunk ORDINAL is a presentation label, not identity: the same file
    // composition (path + content bound by shardFilesSha256) must hit even
    // when a neighbor chunk's change shifted this chunk's index.
    expect(
      loadSuccessfulTestShardReceipt({
        path: receiptPath,
        expectedTestTimeoutMs: 120_000,
        expected: { ...identity, shardIndex: 2 },
        nowMs,
      }).kind,
    ).toBe("hit")
    expect(
      loadSuccessfulTestShardReceipt({
        path: receiptPath,
        expectedTestTimeoutMs: 120_000,
        expected: identity,
        nowMs: nowMs + TEST_SHARD_CACHE_TTL_MS,
      }),
    ).toEqual({ kind: "miss", reason: "expired" })

    // Red-on-injection: changing a file changes the content identity even when
    // the path and overall manifest path digest stay fixed.
    writeFileSync(testFile, "test('a', () => expect(2).toBe(2))\n")
    expect(shardFilesSha256(directory, [testFile])).not.toBe(identity.shardFilesSha256)
    const raw = readFileSync(receiptPath, "utf8")
    expect(raw).not.toContain("super-secret-cache-input")
    const hit = loadSuccessfulTestShardReceipt({
      path: receiptPath,
      expected: identity,
      expectedTestTimeoutMs: 120_000,
      nowMs,
    })
    expect(hit.kind === "hit" ? hit.receipt.scanReachRecords : []).toEqual([
      { id: "guard", walked: 4, matched: 2 },
    ])
  })

  test("treats corrupt, tampered, and incomplete receipts as misses", () => {
    const directory = mkdtempSync(join(tmpdir(), "shard-success-cache-test-"))
    temporaryDirectories.push(directory)
    const receiptPath = join(directory, "shard.json")
    const identity = {
      scopeKind: "whole-tree" as const,
      treeSha256: "a".repeat(64),
      suite: "full",
      manifestSha256: "b".repeat(64),
      shardIndex: 1,
      shardFileCount: 1,
      shardFilesSha256: "c".repeat(64),
      runtimeSha256: "9".repeat(64),
      toolScopeSha256: "d".repeat(64),
      testEnvSha256: "e".repeat(64),
      junit: false,
      intraParallel: 1,
      executionPolicySha256: "f".repeat(64),
      inputScopeSha256: "1".repeat(64),
      timeoutPolicySha256: "2".repeat(64),
      producerReceiptsSha256: "3".repeat(64),
    }
    writeFileSync(receiptPath, "not-json")
    expect(
      loadSuccessfulTestShardReceipt({
        path: receiptPath,
        expected: identity,
        expectedTestTimeoutMs: 120_000,
      }),
    ).toEqual({
      kind: "miss",
      reason: "absent-or-corrupt",
    })
    expect(() =>
      writeSuccessfulTestShardReceiptAtomic({
        path: receiptPath,
        identity,
        executedFileIds: [],
        scanReachRecords: [],
        testTimeoutMs: 120_000,
        timingObservations: [],
        scopeReason: "test",
      }),
    ).toThrow("refusing to cache")

    writeSuccessfulTestShardReceiptAtomic({
      path: receiptPath,
      identity,
      executedFileIds: ["tests/unit/a.test.ts"],
      scanReachRecords: [],
      testTimeoutMs: 120_000,
      timingObservations: [],
      scopeReason: "test",
    })
    const tampered = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>
    tampered.executedFileIds = ["tests/unit/a.test.ts", "tests/unit/b.test.ts"]
    writeFileSync(receiptPath, JSON.stringify(tampered))
    expect(
      loadSuccessfulTestShardReceipt({
        path: receiptPath,
        expected: identity,
        expectedTestTimeoutMs: 120_000,
      }),
    ).toEqual({
      kind: "miss",
      reason: "integrity",
    })
  })
})

describe("what a watchdog kill reports", () => {
  test("the tail is the last non-empty output, stripped of colour", () => {
    // The kill notice used to carry only `idle=600000ms` over a chunk of ~100
    // files, which names no suspect. This is the evidence that is always
    // present — unlike a `path.test.ts:` header, which Bun 1.3.14 prints ONLY
    // for files that fail, i.e. never in the case a hang produces.
    const output = [
      "bun test v1.3.14",
      "",
      "\u001b[32m✓\u001b[0m connected to the language server",
      "   ",
      "[info] lsp: waiting for initialize response",
    ].join("\n")
    expect(spoolTail(output, 2)).toBe(
      "✓ connected to the language server\n[info] lsp: waiting for initialize response",
    )
  })

  test("a worker that produced nothing says so, rather than an empty line", () => {
    expect(spoolTail("", 20)).toBe("<no output>")
    expect(spoolTail("\n  \n\n", 20)).toBe("<no output>")
  })

  test("short output is returned whole, not padded or truncated", () => {
    expect(spoolTail("only line", 20)).toBe("only line")
  })

  test("a hung worker is reported and killed exactly once", () => {
    // MEASURED: the first real hang this watchdog caught — a worker spinning in
    // its event loop at 100% CPU with an unreaped child, 12 minutes without a
    // byte of output — printed its 20-line diagnostic tail TWICE, a second
    // apart. A hung worker keeps its spool still by definition, so every tick
    // after the first met the kill condition too, and it would have kept
    // printing until the tree died.
    const base = { spoolBytes: 3282, lastSpoolBytes: 3282, inactivityTimeoutMs: 720_000 }
    expect(watchdogAction({ ...base, idleMs: 719_999, alreadyKilling: false })).toBe("waiting")
    expect(watchdogAction({ ...base, idleMs: 720_000, alreadyKilling: false })).toBe("kill")
    expect(watchdogAction({ ...base, idleMs: 721_434, alreadyKilling: true })).toBe(
      "already-killing",
    )
  })

  test("any new output resets the clock, even mid-kill", () => {
    const base = { lastSpoolBytes: 3282, inactivityTimeoutMs: 720_000, idleMs: 900_000 }
    expect(watchdogAction({ ...base, spoolBytes: 3283, alreadyKilling: false })).toBe("progressed")
    // A worker that starts talking again while being killed is still making
    // progress; the caller resets the clock rather than counting it as idle.
    expect(watchdogAction({ ...base, spoolBytes: 3283, alreadyKilling: true })).toBe("progressed")
  })
})

/**
 * MEMBERSHIP CAPACITY — a growing corpus must not stop the runner planning.
 *
 * `MAX_CHUNK_FILES` is a CHECKPOINT bound: "a failed campaign forfeits at most
 * this many files of green coverage per chunk". Exceeding it is a scheduling
 * fact, not corruption — but it was a `throw`, so the only repair available was
 * raising the ceiling, i.e. deleting the bound the error message is about.
 *
 * Measured on the real tree at this HEAD: bucket `pure:4` held 159 of 160.
 * Two more files hashing into it and EVERY shard command would have died with
 * `membership bucket pure exceeds 160 files`.
 *
 *     pure:4  159    pure:13 147    pure:22 146    pure:23 142
 *
 * Splitting is local and content-derived: the current corpus plans to the
 * byte-identical 44 chunks it did before (verified against the previous
 * implementation), so no cache receipt is invalidated by the change itself.
 */
describe("membership bucket capacity", () => {
  const MAX_CHUNK_FILES = 160

  const syntheticPure = (count: number): readonly string[] =>
    Array.from(
      { length: count },
      (_, index) => `tests/unit/cap-${String(index).padStart(5, "0")}.test.ts`,
    )

  /**
   * Force every file into ONE membership bucket.
   *
   * `bucketForFile` hashes the membership name into 24 `pure` buckets, so a few
   * hundred synthetic files spread ~20 per bucket and never reach the ceiling —
   * a first version of this test used plain synthetic files and passed with the
   * split REMOVED, i.e. it asserted nothing. A constant membership name is the
   * honest way to exercise the over-capacity path through the real planner.
   */
  const oneBucket = { classify: () => "pure" as const, membershipFile: () => "fixed" }

  test("an over-capacity bucket splits instead of stopping the plan", () => {
    const files = syntheticPure(MAX_CHUNK_FILES * 3 + 7)
    const chunks = planTestChunks(files, oneBucket)

    // ANTI-VACUITY: the fixture must actually overflow, or the assertions below
    // are about a bucket that never filled.
    expect(chunks.length).toBeGreaterThan(1)
    expect(files.length).toBeGreaterThan(MAX_CHUNK_FILES)

    const oversized = chunks.filter((chunk) => chunk.files.length > MAX_CHUNK_FILES)
    expect(oversized.map((chunk) => chunk.files.length)).toEqual([])

    const seen = chunks.flatMap((chunk) => chunk.files)
    expect(seen.length).toBe(files.length)
    expect(new Set(seen).size).toBe(files.length)
  })

  test("the split is deterministic regardless of input order", () => {
    const files = syntheticPure(MAX_CHUNK_FILES * 2 + 3)
    const shape = (input: readonly string[]): string =>
      planTestChunks(input, oneBucket)
        .map((chunk) => chunk.files.join(","))
        .sort()
        .join("|")
    expect(shape(files)).toBe(shape([...files].reverse()))
    expect(shape(files).split("|").length).toBeGreaterThan(1)
  })

  test("appending a file re-composes at most one sub-chunk", () => {
    // The split strategy was chosen by MEASUREMENT, not preference. Files that
    // change sub-chunk (i.e. lose a cache receipt) when the bucket grows by one:
    //
    //     161->162   round-robin 80    contiguous 1    hash 87
    //     320->321   round-robin 320   contiguous 0    hash 320
    //
    // and hashing into ceil(n/MAX) parts was disqualified outright — at 320
    // files its largest part held 161, breaking the ceiling itself.
    // Sized at exactly 2x the ceiling so the append CROSSES a part boundary
    // (parts 2 -> 3). That is the discriminating case: below a crossing, both
    // strategies happen to preserve the same shapes, and an earlier version of
    // this test could not tell them apart.
    const base = syntheticPure(MAX_CHUNK_FILES * 2)
    const grown = [...base, "tests/unit/cap-zzzzz.test.ts"]
    const composition = (files: readonly string[]): ReadonlySet<string> =>
      new Set(planTestChunks(files, oneBucket).map((chunk) => chunk.files.join(",")))
    const before = composition(base)
    const after = composition(grown)
    // ANTI-VACUITY: the fixture must have split, or nothing could be preserved.
    expect(before.size).toBeGreaterThan(1)
    expect(composition(grown).size).toBe(before.size + 1)
    const preserved = [...before].filter((shape) => after.has(shape))
    expect(preserved.length).toBeGreaterThanOrEqual(before.size - 1)
  })

  test("a bucket at exactly the ceiling stays one chunk", () => {
    const chunks = planTestChunks(syntheticPure(MAX_CHUNK_FILES), oneBucket)
    expect(chunks.length).toBe(1)
    expect(chunks[0]?.files.length).toBe(MAX_CHUNK_FILES)
  })

  test("one file past the ceiling splits into two, not more", () => {
    const chunks = planTestChunks(syntheticPure(MAX_CHUNK_FILES + 1), oneBucket)
    expect(chunks.length).toBe(2)
    expect(chunks.reduce((sum, chunk) => sum + chunk.files.length, 0)).toBe(MAX_CHUNK_FILES + 1)
  })
})

describe("targetChunkCount is refused, not ignored", () => {
  test("passing it is an error naming the real control", () => {
    // It was accepted, range-checked, threaded through `chunkOneGroup` as
    // `_targetChunkCount`, and never read. A caller could write
    // `targetChunkCount: 4`, see 44 chunks, and have no way to tell the option
    // from a bug in their own code.
    expect(() =>
      planTestChunks(["tests/unit/a.test.ts"], { targetChunkCount: 4, classify: () => "pure" }),
    ).toThrow(/targetChunkCount is not supported/)
    expect(() =>
      planTestChunks(["tests/unit/a.test.ts"], { targetChunkCount: 24, classify: () => "pure" }),
    ).toThrow(/bucketsByClass/)
  })

  test("omitting it still plans", () => {
    const chunks = planTestChunks(["tests/unit/a.test.ts"], { classify: () => "pure" })
    expect(chunks.length).toBe(1)
  })
})

describe("over-capacity split is locale-independent", () => {
  const MAX_CHUNK_FILES = 160
  const oneBucket = { classify: () => "pure" as const, membershipFile: () => "fixed" }

  /** 200 names whose code-unit order and ICU order differ ACROSS the ceiling. */
  const collationCorpus = (): readonly string[] => [
    ...Array.from({ length: 100 }, (_, i) => `tests/unit/a_${String(i).padStart(3, "0")}.test.ts`),
    ...Array.from({ length: 100 }, (_, i) => `tests/unit/A-${String(i).padStart(3, "0")}.test.ts`),
  ]

  test("partitioning uses code-unit order, matching the manifest and the digest", () => {
    // `shardFilesSha256` is computed from the chunk's `files`, which are sorted
    // with the DEFAULT comparator, as is the manifest. Partitioning the bucket
    // with `localeCompare` makes an over-capacity bucket's membership — and
    // therefore its cache receipt — depend on the host's ICU collation data.
    const corpus = collationCorpus()
    const byCodeUnit = [...corpus].sort()
    const byLocale = [...corpus].sort((left, right) => left.localeCompare(right))

    // ANTI-VACUITY, and the reason this fixture and not a simpler one: the two
    // comparators must disagree ACROSS the 160-file boundary, or both strategies
    // produce the same partition and the assertion below proves nothing.
    expect(byCodeUnit).not.toEqual(byLocale)
    expect(new Set(byCodeUnit.slice(0, MAX_CHUNK_FILES))).not.toEqual(
      new Set(byLocale.slice(0, MAX_CHUNK_FILES)),
    )

    const chunks = planTestChunks(corpus, oneBucket)
    expect(chunks.length).toBe(2)
    // Compared as a SET of partitions: `planTestChunks` orders the returned
    // chunks by their first file, which is itself a locale comparison, so
    // indexing into the array would assert the wrong thing for the right reason.
    const partitions = chunks.map((chunk) => [...chunk.files].sort().join("\n")).sort()
    expect(partitions).toEqual(
      [
        byCodeUnit.slice(0, MAX_CHUNK_FILES).join("\n"),
        byCodeUnit.slice(MAX_CHUNK_FILES).join("\n"),
      ].sort(),
    )
  })
})
