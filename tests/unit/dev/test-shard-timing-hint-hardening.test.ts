/**
 * ★ HELLGATE — a damaged SCHEDULING HINT must never decide a verdict.
 *
 * Timing samples are advisory: they order chunks and weight the plan. Three
 * measured defects made them authoritative anyway.
 *
 * 1. `typeof null === "object"` let `{"schema":…,"entries":null}` past
 *    validation and `Object.entries(null)` then THREW out of `loadTestTimings`,
 *    which the campaign calls while planning. Reproduced at HEAD:
 *    `TypeError: Object.entries requires that input parameter not be null or
 *    undefined`. One corrupt advisory file, one dead campaign.
 * 2. `now - sampledAt <= maxAge` has no upper bound, so a sample dated in the
 *    future never expires AND is always the newest — i.e. it chooses the cohort
 *    the median is taken over. Reproduced at HEAD: a file whose only honest
 *    sample was 50ms planned at 500,025ms, and at `now + 99 years` the future
 *    sample was the sole surviving authority at 999,999ms.
 * 3. Every chunk completion rewrote the whole store — up to 44 times per full
 *    campaign — while an interrupted campaign still lost everything it had
 *    measured.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadTestTimings,
  openTimingJournal,
  readTestTimingStore,
  recoverAbandonedTimingJournals,
  TEST_TIMING_MAX_AGE_MS,
  type TimingSample,
} from "../../../tools/dev/test-shard-timings"

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "tvh05-timings-"))
  roots.push(dir)
  return dir
}

const sample = (ms: number, over: Partial<TimingSample> = {}): TimingSample => ({
  schedulingWeightMs: ms,
  suiteMs: ms,
  chunkOverheadShareMs: 0,
  observedChunkWallMs: ms,
  runnerClass: "pure",
  policyDigest: "policy",
  intraParallel: 1,
  loadPerCore: 0,
  ...over,
})

const storeWith = (dir: string, entries: unknown): string => {
  const path = join(dir, "test-timings-v2.json")
  writeFileSync(path, JSON.stringify({ schema: "quanta.test-timings.v2", entries }))
  return path
}

const NOW = 1_800_000_000_000
const YEAR_MS = 365 * 24 * 60 * 60_000

describe("hostile scheduling hints are quarantined, never fatal and never a measurement", () => {
  // The exact HEAD crash, and its siblings. Each must be a TYPED cold result.
  const shapes: readonly (readonly [string, unknown, string])[] = [
    ["entries:null", null, "invalid-entries"],
    ["entries:[]", [], "invalid-entries"],
    ["entries:number", 7, "invalid-entries"],
    ["entries:string", "entries", "invalid-entries"],
  ]
  for (const [label, entries, reason] of shapes) {
    test(`${label} is a cold fallback with reason=${reason}, not a throw`, () => {
      const dir = scratch()
      const path = storeWith(dir, entries)

      const read = readTestTimingStore(path, { nowMs: NOW })

      expect(read.kind).toBe("cold")
      expect(String(read.reason)).toBe(reason)
      expect(read.timings.size).toBe(0)
      // The planner's own entry point must not throw either — that is the
      // call the campaign makes.
      expect(() => loadTestTimings(path, NOW)).not.toThrow()
      expect(loadTestTimings(path, NOW).size).toBe(0)
      // Quarantined: the damaged hint is moved aside so the next campaign does
      // not re-read it, and the original path is free for a fresh store.
      expect(read.quarantinedTo).toBeDefined()
      expect(existsSync(read.quarantinedTo as string)).toBe(true)
      expect(existsSync(path)).toBe(false)
    })
  }

  test("ANTI-VACUITY — a WELL-FORMED store in the same harness is `measured`", () => {
    const dir = scratch()
    const path = storeWith(dir, {
      "tests/unit/a.test.ts": { samples: [{ ...sample(1234), sampledAtMs: NOW - 1000 }] },
    })

    const read = readTestTimingStore(path, { nowMs: NOW })

    expect(read.kind).toBe("measured")
    expect(read.reason).toBe("fresh-samples")
    expect(read.timings.get("tests/unit/a.test.ts")).toBe(1234)
    expect(read.quarantinedTo).toBeUndefined()
    expect(existsSync(path)).toBe(true)
  })

  test("a foreign schema and unparseable bytes are distinguishable cold reasons", () => {
    const dir = scratch()
    const v1 = join(dir, "v1.json")
    writeFileSync(v1, JSON.stringify({ schema: "quanta.test-timings.v1", entries: {} }))
    const garbage = join(dir, "garbage.json")
    writeFileSync(garbage, "{ not json")

    expect(readTestTimingStore(v1, { nowMs: NOW }).reason).toBe("foreign-schema")
    expect(readTestTimingStore(garbage, { nowMs: NOW }).reason).toBe("corrupt-json")
    expect(readTestTimingStore(join(dir, "absent.json"), { nowMs: NOW })).toMatchObject({
      kind: "cold",
      reason: "absent",
    })
  })

  test("non-finite and wrong-typed sample fields are counted and dropped", () => {
    const dir = scratch()
    const path = storeWith(dir, {
      "tests/unit/a.test.ts": {
        samples: [
          { ...sample(10), sampledAtMs: NOW - 1, schedulingWeightMs: Number.POSITIVE_INFINITY },
          { ...sample(10), sampledAtMs: NOW - 1, suiteMs: Number.NaN },
          { ...sample(10), sampledAtMs: NOW - 1, observedChunkWallMs: "12" },
          { ...sample(10), sampledAtMs: Number.NaN },
          { ...sample(10), sampledAtMs: NOW - 1, intraParallel: 0 },
          { ...sample(10), sampledAtMs: NOW - 1, runnerClass: "" },
        ],
      },
    })

    const read = readTestTimingStore(path, { nowMs: NOW })

    expect(read.invalidSamples).toBe(6)
    expect(read.kind).toBe("cold")
    expect(read.reason).toBe("no-fresh-samples")
  })

  test("the quarantine path is derived from CONTENT, so repeated damage is bounded", () => {
    const dir = scratch()
    const first = readTestTimingStore(storeWith(dir, null), { nowMs: NOW }).quarantinedTo
    const second = readTestTimingStore(storeWith(dir, null), { nowMs: NOW }).quarantinedTo

    expect(first).toBeDefined()
    expect(second).toBe(first as string)
  })
})

describe("a future-dated sample is rejected, not immortal", () => {
  test("it never becomes the cohort authority, and the honest sample survives", () => {
    const dir = scratch()
    const path = storeWith(dir, {
      "tests/unit/a.test.ts": {
        samples: [
          { ...sample(50), sampledAtMs: NOW - 1000 },
          { ...sample(999_999), sampledAtMs: NOW + 100 * YEAR_MS },
        ],
      },
    })

    // At HEAD this answered 500,025 — the median of the honest sample and the
    // forgery, because the forgery was "newest" and so picked the cohort.
    expect(readTestTimingStore(path, { nowMs: NOW }).timings.get("tests/unit/a.test.ts")).toBe(50)
    expect(readTestTimingStore(path, { nowMs: NOW }).futureSkewSamples).toBe(1)

    // At HEAD the forgery was still the ONLY authority 99 years later. TTL now
    // applies in both directions, so there is nothing left.
    const later = readTestTimingStore(path, { nowMs: NOW + 99 * YEAR_MS })
    expect(later.kind).toBe("cold")
    expect(later.timings.has("tests/unit/a.test.ts")).toBe(false)
  })

  test("PAIRED CONTROL — the identical weight dated in the PAST is authority", () => {
    const dir = scratch()
    const path = storeWith(dir, {
      "tests/unit/a.test.ts": {
        samples: [
          { ...sample(50), sampledAtMs: NOW - 2000 },
          { ...sample(999_999), sampledAtMs: NOW - 1000 },
        ],
      },
    })

    // Same two numbers, same cohort, only the timestamp moved from the future
    // into the past: the value is now used. So the rejection above is about
    // the TIMESTAMP, not about the magnitude.
    expect(readTestTimingStore(path, { nowMs: NOW }).timings.get("tests/unit/a.test.ts")).toBe(
      500_025,
    )
  })

  test("the past TTL edge is unchanged — expiry still works in the old direction", () => {
    const dir = scratch()
    const path = storeWith(dir, {
      "tests/unit/a.test.ts": { samples: [{ ...sample(50), sampledAtMs: NOW }] },
    })

    expect(readTestTimingStore(path, { nowMs: NOW + TEST_TIMING_MAX_AGE_MS }).timings.size).toBe(1)
    expect(
      readTestTimingStore(path, { nowMs: NOW + TEST_TIMING_MAX_AGE_MS + 1 }).timings.size,
    ).toBe(0)
  })
})

describe("timing writes are O(1) per campaign and survive an interrupt", () => {
  test("N chunk completions write the store exactly ONCE, at commit", () => {
    const dir = scratch()
    const storePath = join(dir, "test-timings-v2.json")
    const journal = openTimingJournal({ storePath })

    const chunks = 44
    for (let index = 0; index < chunks; index += 1) {
      journal.record(new Map([[`tests/unit/f${index}.test.ts`, sample(index + 1)]]), NOW)
      // THE INVARIANT: no matter how many chunks have completed, the store has
      // not been read, sorted or rewritten even once.
      expect(existsSync(storePath)).toBe(false)
    }
    expect(journal.appends).toBe(chunks)
    expect(journal.recordedFiles).toBe(chunks)

    const result = journal.commit(NOW)

    expect(result.storeWrites).toBe(1)
    expect(result.files).toBe(chunks)
    expect(existsSync(storePath)).toBe(true)
    // Every chunk's measurement is present, not just the last one.
    const timings = loadTestTimings(storePath, NOW)
    expect(timings.size).toBe(chunks)
    expect(timings.get("tests/unit/f0.test.ts")).toBe(1)
    expect(timings.get(`tests/unit/f${chunks - 1}.test.ts`)).toBe(chunks)
    // The journal is collected, not left behind.
    expect(existsSync(journal.path)).toBe(false)
  })

  test("an INTERRUPTED campaign's completed chunks are recovered", () => {
    const dir = scratch()
    const storePath = join(dir, "test-timings-v2.json")
    const dead = openTimingJournal({ storePath })
    dead.record(new Map([["tests/unit/done-1.test.ts", sample(111)]]), NOW)
    dead.record(new Map([["tests/unit/done-2.test.ts", sample(222)]]), NOW)
    // …and the process dies here: no commit, no store.
    expect(existsSync(storePath)).toBe(false)
    expect(existsSync(dead.path)).toBe(true)

    const recovery = recoverAbandonedTimingJournals(storePath, {
      nowMs: NOW,
      isAlive: () => false,
    })

    expect(recovery.journals).toBe(1)
    expect(recovery.files).toBe(2)
    const timings = loadTestTimings(storePath, NOW)
    expect(timings.get("tests/unit/done-1.test.ts")).toBe(111)
    expect(timings.get("tests/unit/done-2.test.ts")).toBe(222)
    expect(existsSync(dead.path)).toBe(false)
  })

  test("PAIRED CONTROL — a LIVE sibling campaign's journal is left alone", () => {
    const dir = scratch()
    const storePath = join(dir, "test-timings-v2.json")
    const live = openTimingJournal({
      storePath,
      journalPath: join(dir, "t.json.journal-4242-x.ndjson"),
    })
    live.record(new Map([["tests/unit/running.test.ts", sample(333)]]), NOW)

    const recovery = recoverAbandonedTimingJournals(join(dir, "t.json"), {
      nowMs: NOW,
      isAlive: () => true,
    })

    expect(recovery.journals).toBe(0)
    expect(recovery.skippedLive).toBe(1)
    // Its in-flight measurements are still on disk for its own commit.
    expect(existsSync(live.path)).toBe(true)
    expect(readFileSync(live.path, "utf8")).toContain("tests/unit/running.test.ts")
  })

  test("a journal line that is not a valid observation cannot poison the store", () => {
    const dir = scratch()
    const storePath = join(dir, "test-timings-v2.json")
    const journalPath = join(dir, "test-timings-v2.json.journal-4243-y.ndjson")
    writeFileSync(
      journalPath,
      [
        "{ not json",
        JSON.stringify({ schema: "someone-elses.v9", observations: { "x.test.ts": sample(1) } }),
        JSON.stringify({
          schema: "quanta.test-timings-journal.v1",
          observations: { "bad.test.ts": { ...sample(5), sampledAtMs: "yesterday" } },
        }),
        JSON.stringify({
          schema: "quanta.test-timings-journal.v1",
          observations: { "good.test.ts": { ...sample(7), sampledAtMs: NOW - 5 } },
        }),
      ].join("\n"),
    )

    recoverAbandonedTimingJournals(storePath, { nowMs: NOW, isAlive: () => false })

    const timings = loadTestTimings(storePath, NOW)
    expect(timings.get("good.test.ts")).toBe(7)
    expect(timings.has("bad.test.ts")).toBe(false)
    expect(timings.has("x.test.ts")).toBe(false)
  })
})

/**
 * ★ Recovery was not idempotent, and the crash window that replays it is the
 * one the recovery exists for.
 *
 * `recoverAbandonedTimingJournals` writes the store and THEN removes the
 * journals it folded. A process that dies between those two statements leaves a
 * journal whose observations are already in the store, so the next campaign
 * folds it again. Nothing deduplicated and the window is only
 * `TEST_TIMING_MAX_SAMPLES`, so one replayed observation does not merely repeat
 * — it EVICTS the honest history one slot at a time.
 *
 * MEASURED before the fix, a single 2,000ms observation replayed against three
 * honest samples of 100, 900 and 500ms:
 *
 *   after replay  1   [100, 900, 500, 2000]
 *   after replay  3   [100, 900, 500, 2000, 2000, 2000]
 *   after replay 12   [2000 x 12]   — 0 of 3 honest samples left
 *
 * The scheduler plans chunk membership from these weights, so a crash loop
 * manufactures a weight the corpus never produced and balances every later
 * campaign against it.
 */
describe("folding the same abandoned journal twice changes nothing", () => {
  const FILE = "tests/unit/replayed.test.ts"

  const weightsOf = (storePath: string): readonly number[] => {
    const parsed = JSON.parse(readFileSync(storePath, "utf8")) as {
      entries: Record<string, { samples: { schedulingWeightMs: number }[] }>
    }
    return (parsed.entries[FILE]?.samples ?? []).map((one) => one.schedulingWeightMs)
  }

  test("twelve replays of one journal leave one sample, not twelve", () => {
    const dir = scratch()
    const storePath = join(dir, "test-timings-v2.json")

    // Three honest observations, committed the way a campaign commits them.
    for (const [ms, at] of [
      [100, NOW - 3_000],
      [900, NOW - 2_000],
      [500, NOW - 1_000],
    ] as const) {
      const journal = openTimingJournal({ storePath })
      journal.record(new Map([[FILE, { ...sample(ms), sampledAtMs: at }]]), at)
      journal.commit(NOW)
    }
    expect(weightsOf(storePath)).toEqual([100, 900, 500])

    // An abandoned journal from a dead pid, in the real on-disk shape.
    const orphan = `${storePath}.journal-999901-deadbeef.ndjson`
    const line = JSON.stringify({
      schema: "quanta.test-timings-journal.v1",
      observations: { [FILE]: { ...sample(2_000), sampledAtMs: NOW } },
    })

    // Restored before each round, which is exactly what a crash between
    // `writeStoreAtomic` and the `rmSync` that removes it produces.
    for (let round = 1; round <= 12; round += 1) {
      writeFileSync(orphan, `${line}\n`)
      recoverAbandonedTimingJournals(storePath, { nowMs: NOW, isAlive: () => false })
    }

    // Folded ONCE. And every honest sample is still there: the window is 12, so
    // twelve replays used to fill it completely.
    expect(weightsOf(storePath)).toEqual([100, 900, 500, 2_000])
  })

  test("PAIRED CONTROL — two genuinely different observations both survive", () => {
    // The dedupe keys on `(file, sampledAtMs)`. If it keyed on the file alone,
    // or dropped anything already present for that file, a second real campaign
    // would silently stop contributing history.
    const dir = scratch()
    const storePath = join(dir, "test-timings-v2.json")
    for (const [ms, at] of [
      [100, NOW - 2_000],
      [400, NOW - 1_000],
    ] as const) {
      const journal = openTimingJournal({ storePath })
      journal.record(new Map([[FILE, { ...sample(ms), sampledAtMs: at }]]), at)
      journal.commit(NOW)
    }
    expect(weightsOf(storePath)).toEqual([100, 400])

    // ...and the same millisecond with a DIFFERENT weight is still one
    // observation, because one file is measured once per campaign.
    const journal = openTimingJournal({ storePath })
    journal.record(new Map([[FILE, { ...sample(9_999), sampledAtMs: NOW - 1_000 }]]), NOW - 1_000)
    journal.commit(NOW)
    expect(weightsOf(storePath)).toEqual([100, 400])
  })
})
