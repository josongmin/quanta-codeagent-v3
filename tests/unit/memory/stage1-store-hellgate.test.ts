/**
 * ADR-0207 — `Stage1OutputsStore` hellgate (15 adversarial cases).
 *
 * Each case seals one contract clause from the port JSDoc. The
 * in-memory adapter is the contract reference; the jsonl-file adapter
 * is a faithful superset (adds persistence + chmod), so the persistence
 * + corruption + security cases run only against jsonl-file.
 */

import { describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  InMemoryStage1Store,
  JsonlFileStage1Store,
  type Stage1Entry,
} from "../../../src/memory/stage1-store"

// ─── Helpers ────────────────────────────────────────────────────────────

const baseEntry = (over: Partial<Stage1Entry> = {}): Stage1Entry => ({
  threadId: "thr-1",
  sourceUpdatedAt: 1_000_000,
  rawMemory: "- decided to use bun",
  rolloutSummary: "did some work",
  generatedAt: 1_000_000,
  rolloutSlug: "20260525-120000-feat-foo",
  usageCount: 0,
  lastUsage: 1_000_000,
  selectedForPhase2: false,
  ...over,
})

interface Clock {
  now(): number
  set(t: number): void
  advance(ms: number): void
}

const mkClock = (start = 2_000_000): Clock => {
  let t = start
  return {
    now: () => t,
    set: (v: number) => {
      t = v
    },
    advance: (ms: number) => {
      t += ms
    },
  }
}

const mkTmpDir = (): string => mkdtempSync(join(tmpdir(), "stage1-store-hell-"))

// ─── HELL-S1-01: put/get round-trip ─────────────────────────────────────

describe("HELL-S1-01: put + get round-trip is verbatim", () => {
  test("in-memory: stored entry equals input shape", () => {
    const clk = mkClock()
    const s = new InMemoryStage1Store({ now: clk.now })
    const e = baseEntry({ rolloutSummary: "alpha", usageCount: 3, lastUsage: 999 })
    s.put(e)
    const got = s.get("thr-1")
    expect(got).not.toBeNull()
    expect(got).toEqual(e)
  })
})

// ─── HELL-S1-02: get unknown threadId → null ────────────────────────────

describe("HELL-S1-02: get of unknown threadId returns null (not throw)", () => {
  test("empty store", () => {
    const s = new InMemoryStage1Store({ now: () => 0 })
    expect(s.get("nope")).toBeNull()
  })

  test("populated store, unknown id", () => {
    const s = new InMemoryStage1Store({ now: () => 0 })
    s.put(baseEntry({ threadId: "real" }))
    expect(s.get("ghost")).toBeNull()
  })
})

// ─── HELL-S1-03: touch increments usageCount + stamps lastUsage ─────────

describe("HELL-S1-03: touch bumps usageCount and stamps lastUsage", () => {
  test("single touch: usageCount += 1 and lastUsage = clock", () => {
    const clk = mkClock(5_000_000)
    const s = new InMemoryStage1Store({ now: clk.now })
    s.put(baseEntry({ usageCount: 7, lastUsage: 1_000 }))
    clk.set(5_500_000)
    s.touch("thr-1")
    const got = s.get("thr-1")
    expect(got?.usageCount).toBe(8)
    expect(got?.lastUsage).toBe(5_500_000)
  })

  test("multiple touches accumulate", () => {
    const clk = mkClock(100)
    const s = new InMemoryStage1Store({ now: clk.now })
    s.put(baseEntry({ usageCount: 0 }))
    s.touch("thr-1")
    clk.advance(10)
    s.touch("thr-1")
    clk.advance(10)
    s.touch("thr-1")
    const got = s.get("thr-1")
    expect(got?.usageCount).toBe(3)
    expect(got?.lastUsage).toBe(120)
  })

  test("touch on unknown threadId is a silent no-op", () => {
    const s = new InMemoryStage1Store({ now: () => 0 })
    expect(() => s.touch("ghost")).not.toThrow()
  })
})

// ─── HELL-S1-04: markSelectedForPhase2 ──────────────────────────────────

describe("HELL-S1-04: markSelectedForPhase2 sets flag + snapshots SUA", () => {
  test("flag true; snapshot equals passed value", () => {
    const s = new InMemoryStage1Store({ now: () => 0 })
    s.put(baseEntry({ selectedForPhase2: false }))
    s.markSelectedForPhase2("thr-1", 9_999)
    const got = s.get("thr-1")
    expect(got?.selectedForPhase2).toBe(true)
    expect(got?.selectedForPhase2SourceUpdatedAt).toBe(9_999)
  })

  test("re-marking overwrites the snapshot", () => {
    const s = new InMemoryStage1Store({ now: () => 0 })
    s.put(baseEntry())
    s.markSelectedForPhase2("thr-1", 100)
    s.markSelectedForPhase2("thr-1", 200)
    expect(s.get("thr-1")?.selectedForPhase2SourceUpdatedAt).toBe(200)
  })

  test("mark on unknown threadId is a silent no-op", () => {
    const s = new InMemoryStage1Store({ now: () => 0 })
    expect(() => s.markSelectedForPhase2("ghost", 1)).not.toThrow()
  })
})

// ─── HELL-S1-05: list filter selectedForPhase2 ──────────────────────────

describe("HELL-S1-05: list({selectedForPhase2:true}) returns marked subset", () => {
  test("3 entries, 1 marked → list returns the one", () => {
    const s = new InMemoryStage1Store({ now: () => 0 })
    s.put(baseEntry({ threadId: "a" }))
    s.put(baseEntry({ threadId: "b" }))
    s.put(baseEntry({ threadId: "c" }))
    s.markSelectedForPhase2("b", 42)
    const out = s.list({ selectedForPhase2: true })
    expect(out.length).toBe(1)
    expect(out[0]?.threadId).toBe("b")
  })

  test("list({selectedForPhase2:false}) returns unmarked subset", () => {
    const s = new InMemoryStage1Store({ now: () => 0 })
    s.put(baseEntry({ threadId: "a" }))
    s.put(baseEntry({ threadId: "b" }))
    s.markSelectedForPhase2("a", 1)
    const out = s.list({ selectedForPhase2: false })
    expect(out.length).toBe(1)
    expect(out[0]?.threadId).toBe("b")
  })
})

// ─── HELL-S1-06: list filter minUsage ───────────────────────────────────

describe("HELL-S1-06: list({minUsage:N}) returns entries with usageCount >= N", () => {
  test("threshold gating is >= (boundary case)", () => {
    const s = new InMemoryStage1Store({ now: () => 0 })
    s.put(baseEntry({ threadId: "a", usageCount: 4 }))
    s.put(baseEntry({ threadId: "b", usageCount: 5 }))
    s.put(baseEntry({ threadId: "c", usageCount: 6 }))
    const out = s.list({ minUsage: 5 })
    expect(out.map((e) => e.threadId).sort()).toEqual(["b", "c"])
  })
})

// ─── HELL-S1-07: prune olderThanMs ──────────────────────────────────────

describe("HELL-S1-07: prune({olderThanMs}) evicts old entries", () => {
  test("entries older than cutoff dropped, newer kept", () => {
    const clk = mkClock(10_000)
    const s = new InMemoryStage1Store({ now: clk.now })
    s.put(baseEntry({ threadId: "old", generatedAt: 1_000 }))
    s.put(baseEntry({ threadId: "mid", generatedAt: 8_500 }))
    s.put(baseEntry({ threadId: "new", generatedAt: 9_900 }))
    // cutoff = 10_000 - 2_000 = 8_000; "old" (gen 1000) is older.
    const evicted = s.prune({ olderThanMs: 2_000 })
    expect(evicted).toBe(1)
    expect(s.get("old")).toBeNull()
    expect(s.get("mid")).not.toBeNull()
    expect(s.get("new")).not.toBeNull()
  })

  test("neither olderThanMs nor maxEntries → 0 evictions", () => {
    const s = new InMemoryStage1Store({ now: () => 0 })
    s.put(baseEntry())
    expect(s.prune({})).toBe(0)
    expect(s.get("thr-1")).not.toBeNull()
  })
})

// ─── HELL-S1-08: prune maxEntries LRU ───────────────────────────────────

describe("HELL-S1-08: prune({maxEntries:N}) evicts LRU by ascending lastUsage", () => {
  test("3 entries, max=2, drops the one with smallest lastUsage", () => {
    const s = new InMemoryStage1Store({ now: () => 0 })
    s.put(baseEntry({ threadId: "a", lastUsage: 100 }))
    s.put(baseEntry({ threadId: "b", lastUsage: 50 })) // LRU
    s.put(baseEntry({ threadId: "c", lastUsage: 200 }))
    const evicted = s.prune({ maxEntries: 2 })
    expect(evicted).toBe(1)
    expect(s.get("b")).toBeNull()
    expect(s.get("a")).not.toBeNull()
    expect(s.get("c")).not.toBeNull()
  })

  test("max=0 evicts everything", () => {
    const s = new InMemoryStage1Store({ now: () => 0 })
    s.put(baseEntry({ threadId: "a" }))
    s.put(baseEntry({ threadId: "b" }))
    expect(s.prune({ maxEntries: 0 })).toBe(2)
    expect(s.list().length).toBe(0)
  })
})

// ─── HELL-S1-09: put duplicate threadId overwrites ──────────────────────

describe("HELL-S1-09: put of duplicate threadId replaces prior entry", () => {
  test("second put wins; list size remains 1", () => {
    const s = new InMemoryStage1Store({ now: () => 0 })
    s.put(baseEntry({ rolloutSummary: "first" }))
    s.put(baseEntry({ rolloutSummary: "second" }))
    expect(s.list().length).toBe(1)
    expect(s.get("thr-1")?.rolloutSummary).toBe("second")
  })
})

// ─── HELL-S1-10: jsonl persistence round-trip ───────────────────────────

describe("HELL-S1-10: jsonl-file: write → reload yields identical entry", () => {
  test("fresh adapter over same file hydrates the prior put", () => {
    const dir = mkTmpDir()
    try {
      const fp = join(dir, "stage1.jsonl")
      const e1 = baseEntry({ rolloutSummary: "persisted alpha", usageCount: 4 })
      const w = new JsonlFileStage1Store({ filePath: fp, now: () => 1234 })
      w.put(e1)

      const r = new JsonlFileStage1Store({ filePath: fp, now: () => 5678 })
      const got = r.get("thr-1")
      expect(got).toEqual(e1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("jsonl replays touch + mark ops in order", () => {
    const dir = mkTmpDir()
    try {
      const fp = join(dir, "stage1.jsonl")
      let t = 1_000
      const w = new JsonlFileStage1Store({ filePath: fp, now: () => t })
      w.put(baseEntry({ usageCount: 0 }))
      t = 1_100
      w.touch("thr-1")
      t = 1_200
      w.markSelectedForPhase2("thr-1", 9_999)

      const r = new JsonlFileStage1Store({ filePath: fp, now: () => 0 })
      const got = r.get("thr-1")
      expect(got?.usageCount).toBe(1)
      expect(got?.lastUsage).toBe(1_100)
      expect(got?.selectedForPhase2).toBe(true)
      expect(got?.selectedForPhase2SourceUpdatedAt).toBe(9_999)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── HELL-S1-11: jsonl corrupted line → skip + warn ─────────────────────

describe("HELL-S1-11: jsonl: corrupted lines are skipped + warned, never thrown", () => {
  test("inject 2 bad lines + 1 good; load yields 1 entry + 2 warnings", () => {
    const dir = mkTmpDir()
    try {
      const fp = join(dir, "stage1.jsonl")
      const good = baseEntry({ threadId: "good", usageCount: 1 })
      const lines = [
        "{not-json", // parse fail
        JSON.stringify({ op: "put", entry: { threadId: 123 } }), // shape fail
        JSON.stringify({ op: "put", entry: good }),
      ].join("\n")
      writeFileSync(fp, `${lines}\n`, { mode: 0o600 })

      const warnings: string[] = []
      const r = new JsonlFileStage1Store({
        filePath: fp,
        now: () => 0,
        onWarn: (m) => warnings.push(m),
      })
      expect(warnings.length).toBe(2)
      expect(r.get("good")).toEqual(good)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── HELL-S1-12: jsonl file is 0600 ─────────────────────────────────────

describe("HELL-S1-12: jsonl backing file is owner-only RW (mode 0600)", () => {
  test("first put creates file at 0600", () => {
    const dir = mkTmpDir()
    try {
      const fp = join(dir, "stage1.jsonl")
      const w = new JsonlFileStage1Store({ filePath: fp, now: () => 0 })
      w.put(baseEntry())
      expect(existsSync(fp)).toBe(true)
      const mode = statSync(fp).mode & 0o777
      expect(mode).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("existing 0644 file is tightened to 0600 on construction", () => {
    const dir = mkTmpDir()
    try {
      const fp = join(dir, "stage1.jsonl")
      writeFileSync(fp, "", { mode: 0o644 })
      chmodSync(fp, 0o644) // belt-and-braces (umask)
      const before = statSync(fp).mode & 0o777
      expect(before).toBe(0o644)
      const _w = new JsonlFileStage1Store({ filePath: fp, now: () => 0 })
      const after = statSync(fp).mode & 0o777
      expect(after).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

// ─── HELL-S1-13: returned entries are frozen ────────────────────────────

describe("HELL-S1-13: entries returned from get/list are frozen", () => {
  test("get(): mutation throws in strict mode", () => {
    const s = new InMemoryStage1Store({ now: () => 0 })
    s.put(baseEntry())
    const got = s.get("thr-1")
    expect(got).not.toBeNull()
    expect(Object.isFrozen(got)).toBe(true)
    expect(() => {
      // @ts-expect-error — runtime guard
      got.usageCount = 999
    }).toThrow()
  })

  test("list(): returned array is frozen too", () => {
    const s = new InMemoryStage1Store({ now: () => 0 })
    s.put(baseEntry())
    const arr = s.list()
    expect(Object.isFrozen(arr)).toBe(true)
  })
})

// ─── HELL-S1-14: prune over 1000 entries — performance sanity ──────────

describe("HELL-S1-14: prune over 1000 entries completes within a generous budget", () => {
  test("populate 1000 + prune to 100 finishes < 500ms", () => {
    const clk = mkClock(0)
    const s = new InMemoryStage1Store({ now: clk.now })
    for (let i = 0; i < 1000; i++) {
      s.put(
        baseEntry({
          threadId: `t-${i}`,
          generatedAt: i,
          lastUsage: i,
        }),
      )
    }
    const start = Date.now()
    const evicted = s.prune({ maxEntries: 100 })
    const elapsed = Date.now() - start
    expect(evicted).toBe(900)
    expect(s.list().length).toBe(100)
    // Generous order-of-magnitude budget (sanity, not micro-bench).
    expect(elapsed).toBeLessThan(500)
  })
})

// ─── HELL-S1-15: exactOptionalPropertyTypes — OMIT semantics ───────────

describe("HELL-S1-15: selectedForPhase2SourceUpdatedAt is OMITTED when absent", () => {
  test("unmarked entry has no `selectedForPhase2SourceUpdatedAt` own-property", () => {
    const s = new InMemoryStage1Store({ now: () => 0 })
    s.put(baseEntry({ selectedForPhase2: false }))
    const got = s.get("thr-1")
    expect(got).not.toBeNull()
    if (got === null) throw new Error("unreachable") // tsc narrowing
    expect(Object.hasOwn(got, "selectedForPhase2SourceUpdatedAt")).toBe(false)
  })

  test("marked entry HAS the property with a numeric value", () => {
    const s = new InMemoryStage1Store({ now: () => 0 })
    s.put(baseEntry())
    s.markSelectedForPhase2("thr-1", 4242)
    const got = s.get("thr-1")
    if (got === null) throw new Error("unreachable") // tsc narrowing
    expect(Object.hasOwn(got, "selectedForPhase2SourceUpdatedAt")).toBe(true)
    expect(got.selectedForPhase2SourceUpdatedAt).toBe(4242)
  })
})
