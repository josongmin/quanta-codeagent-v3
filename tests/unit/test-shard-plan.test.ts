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
  TEST_RESOURCE_CLASSES,
  usesSharedTestResource,
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
  harvestChunkTimings,
  loadTestTimings,
  mergeTestTimings,
  TEST_TIMING_MAX_AGE_MS,
} from "../../tools/dev/test-shard-timings"

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
      targetChunkCount: 4,
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
    expect(() => assertTestChunkPlan(files, mutilated)).toThrow("partition is not exact")
  })

  test("measured timings drive LPT balance instead of file counts", () => {
    const files = Array.from({ length: 12 }, (_, index) => `tests/unit/file-${index}.test.ts`)
    const slow = "tests/unit/file-0.test.ts"
    const timings = new Map(files.map((file) => [file, file === slow ? 60_000 : 1_000]))
    const chunks = planTestChunks(files, {
      targetChunkCount: 4,
      classify: () => "pure",
      predictMs: (file) => timings.get(file),
    })
    expect(() => assertTestChunkPlan(files, chunks)).not.toThrow()
    // The slow file dominates one chunk; the peers split the rest instead of
    // one chunk carrying the slow file plus a fourth of everything else.
    const slowChunk = chunks.find(({ files: chunkFiles }) => chunkFiles.includes(slow))
    expect(slowChunk).toBeDefined()
    expect(slowChunk?.files).toEqual([slow])
    // Deterministic: identical inputs replan identically (stable cache identity).
    expect(
      planTestChunks(files, {
        targetChunkCount: 4,
        classify: () => "pure",
        predictMs: (file) => timings.get(file),
      }),
    ).toEqual(chunks)
  })

  test("a cold timing store degrades to count balancing, never a crash", () => {
    const files = Array.from({ length: 100 }, (_, index) => `tests/unit/f-${index}.test.ts`)
    const chunks = planTestChunks(files, { targetChunkCount: 24, classify: () => "pure" })
    expect(() => assertTestChunkPlan(files, chunks)).not.toThrow()
    expect(chunks.length).toBe(24)
    const sizes = chunks.map(({ files: chunkFiles }) => chunkFiles.length)
    expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1)
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
    // The binary shim keeps its old meaning for any remaining caller.
    expect(usesSharedTestResource("tests/unit/plain.test.ts", "expect(1).toBe(1)")).toBe(false)
    expect(usesSharedTestResource("tests/integration/plain.test.ts", "")).toBe(true)
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
    writeScanReachReceiptAtomic({
      path: receiptPath,
      head: "a".repeat(40),
      suite: "full",
      manifestSha256: "b".repeat(64),
      sinks: [left, right],
    })
    const receipt = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>
    expect(receipt.schema).toBe("quanta.scan-reach-receipt.v1")
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
    )
    const right = testEnvironmentSha256(
      { HOME: "/tmp/two", TMPDIR: "/tmp/b", QUANTA_MODE: "strict" },
      120_000,
    )
    expect(left).toBe(right)
    expect(testEnvironmentSha256({ QUANTA_MODE: "relaxed" }, 120_000)).not.toBe(left)
    expect(testEnvironmentSha256({ QUANTA_MODE: "strict" }, 240_000)).not.toBe(left)

    // An unrelated terminal variable must NOT be a cache miss: hashing all
    // inherited env made every new ITERM_SESSION_ID/SSH socket a full re-run.
    expect(
      testEnvironmentSha256(
        { QUANTA_MODE: "strict", ITERM_SESSION_ID: "w0t1p0", SSH_AUTH_SOCK: "/tmp/agent.9" },
        120_000,
      ),
    ).toBe(left)
    // Verdict-relevant switches still key.
    expect(testEnvironmentSha256({ QUANTA_MODE: "strict", CI: "1" }, 120_000)).not.toBe(left)
    expect(
      testEnvironmentSha256({ QUANTA_MODE: "strict", REQUIRE_CONTRACT: "1" }, 120_000),
    ).not.toBe(left)
    // The campaign lease token never keys: it differs on every campaign.
    expect(
      testEnvironmentSha256(
        { QUANTA_MODE: "strict", QUANTA_VERIFICATION_LEASE_TOKEN: "a".repeat(64) },
        120_000,
      ),
    ).toBe(left)
    // Nested `bun run` PATH duplication is fingerprint-equivalent; order and
    // real entry changes still invalidate.
    const base = testEnvironmentSha256({ PATH: "/a:/b" }, 120_000)
    expect(testEnvironmentSha256({ PATH: "/a:/b:/a:/b" }, 120_000)).toBe(base)
    expect(testEnvironmentSha256({ PATH: "/b:/a" }, 120_000)).not.toBe(base)
    expect(testEnvironmentSha256({ PATH: "/a:/b:/c" }, 120_000)).not.toBe(base)
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
    for (const tool of ["git", "docker", "python3", "typescript-language-server", "pyright"]) {
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
      srcSha256: "a".repeat(64),
      suite: "full",
      manifestSha256: "b".repeat(64),
      shardIndex: 1,
      shardFileCount: 1,
      shardFilesSha256: shardFilesSha256(directory, [testFile]),
      toolchainSha256: "c".repeat(64),
      testEnvSha256: testEnvironmentSha256(
        { QUANTA_TEST_KNOB: "super-secret-cache-input" },
        120_000,
      ),
      junit: false,
      filesRunConcurrently: false,
    }
    const nowMs = 1_800_000_000_000
    writeSuccessfulTestShardReceiptAtomic({
      path: receiptPath,
      identity,
      executedFiles: 1,
      scanReachRecords: [{ id: "guard", walked: 4, matched: 2 }],
      nowMs,
    })

    expect(
      loadSuccessfulTestShardReceipt({ path: receiptPath, expected: identity, nowMs }).kind,
    ).toBe("hit")
    const identityMutations = [
      // The code under test — this REPLACED the git HEAD sha, which invalidated
      // every chunk on any commit including docs-only ones (2026-09-02).
      { ...identity, srcSha256: "d".repeat(64) },
      { ...identity, suite: "unit" },
      { ...identity, manifestSha256: "d".repeat(64) },
      { ...identity, shardFileCount: 2 },
      { ...identity, shardFilesSha256: "d".repeat(64) },
      { ...identity, toolchainSha256: "d".repeat(64) },
      { ...identity, testEnvSha256: "d".repeat(64) },
      { ...identity, junit: true },
    ]
    for (const expected of identityMutations) {
      expect(loadSuccessfulTestShardReceipt({ path: receiptPath, expected, nowMs })).toEqual({
        kind: "miss",
        reason: "input-mismatch",
      })
    }
    // A serial green does NOT answer for a concurrent plan: that was the
    // cache's blind spot — a loaded box banks serial receipts, an idle box
    // plans `pure` chunks concurrently and HITS them, so the interleaved
    // schedule is never actually exercised.
    expect(
      loadSuccessfulTestShardReceipt({
        path: receiptPath,
        expected: { ...identity, filesRunConcurrently: true },
        nowMs,
      }),
    ).toEqual({ kind: "miss", reason: "input-mismatch" })

    // The chunk ORDINAL is a presentation label, not identity: the same file
    // composition (path + content bound by shardFilesSha256) must hit even
    // when a neighbor chunk's change shifted this chunk's index.
    expect(
      loadSuccessfulTestShardReceipt({
        path: receiptPath,
        expected: { ...identity, shardIndex: 2 },
        nowMs,
      }).kind,
    ).toBe("hit")
    expect(
      loadSuccessfulTestShardReceipt({
        path: receiptPath,
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
    const hit = loadSuccessfulTestShardReceipt({ path: receiptPath, expected: identity, nowMs })
    expect(hit.kind === "hit" ? hit.receipt.scanReachRecords : []).toEqual([
      { id: "guard", walked: 4, matched: 2 },
    ])
  })

  test("treats corrupt, tampered, and incomplete receipts as misses", () => {
    const directory = mkdtempSync(join(tmpdir(), "shard-success-cache-test-"))
    temporaryDirectories.push(directory)
    const receiptPath = join(directory, "shard.json")
    const identity = {
      srcSha256: "a".repeat(64),
      suite: "full",
      manifestSha256: "b".repeat(64),
      shardIndex: 1,
      shardFileCount: 1,
      shardFilesSha256: "c".repeat(64),
      toolchainSha256: "d".repeat(64),
      testEnvSha256: "e".repeat(64),
      junit: false,
      filesRunConcurrently: false,
    }
    writeFileSync(receiptPath, "not-json")
    expect(loadSuccessfulTestShardReceipt({ path: receiptPath, expected: identity })).toEqual({
      kind: "miss",
      reason: "absent-or-corrupt",
    })
    expect(() =>
      writeSuccessfulTestShardReceiptAtomic({
        path: receiptPath,
        identity,
        executedFiles: 0,
        scanReachRecords: [],
      }),
    ).toThrow("refusing to cache")

    writeSuccessfulTestShardReceiptAtomic({
      path: receiptPath,
      identity,
      executedFiles: 1,
      scanReachRecords: [],
    })
    const tampered = JSON.parse(readFileSync(receiptPath, "utf8")) as Record<string, unknown>
    tampered.executedFiles = 2
    writeFileSync(receiptPath, JSON.stringify(tampered))
    expect(loadSuccessfulTestShardReceipt({ path: receiptPath, expected: identity })).toEqual({
      kind: "miss",
      reason: "integrity",
    })
  })
})
