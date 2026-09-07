/**
 * ADR-0348 — GC hellgate.
 *
 * Coverage:
 *   A. expired session (lastTouched < now-ttl) ⇒ evicted        (1)
 *   B. non-expired ⇒ preserved                                  (1)
 *   C. oversize jsonl ⇒ truncated from front                    (1)
 *   D. missing storageDir ⇒ {0,0}, NO-THROW                     (1)
 *   E. malformed meta.json ⇒ skip TTL eviction (preserve)       (1)
 *   F. mixed (expired + oversize + healthy) handled in one pass (1)
 *   G. default TTL is 14 days; default size is 50MB             (1)
 *   H. permission error inside storageDir ⇒ swallow             (1)
 *
 *  Total = 8 cases.
 */

import { describe, expect, test } from "bun:test"
import { appendFile, mkdir, mkdtemp, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { countDiskRegistryCleanupCandidates, sweepDiskRegistry } from "../gc"
import { DEFAULT_MAX_SESSION_BYTES, DEFAULT_TTL_MS } from "../types"

const tempStorage = async (): Promise<string> => mkdtemp(join(tmpdir(), "adr0348-gc-"))

const writeSession = async (
  root: string,
  id: string,
  opts: { lastTouched: number; eventsBody?: string; cacheBody?: string },
): Promise<string> => {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, "meta.json"),
    JSON.stringify({ sessionId: id, lastTouched: opts.lastTouched }),
    "utf8",
  )
  if (opts.eventsBody !== undefined) {
    await writeFile(join(dir, "events.jsonl"), opts.eventsBody, "utf8")
  }
  if (opts.cacheBody !== undefined) {
    await writeFile(join(dir, "prompt-cache.jsonl"), opts.cacheBody, "utf8")
  }
  return dir
}

const dirExists = async (path: string): Promise<boolean> => {
  try {
    const st = await stat(path)
    return st.isDirectory()
  } catch {
    return false
  }
}

describe("ADR-0348-gc §A — expired session evicted", () => {
  test("ttlMs sweep removes old session dir", async () => {
    const root = await tempStorage()
    const now = 100_000_000
    // expired: lastTouched 1 hour before now, ttl 1 minute
    await writeSession(root, "old", { lastTouched: now - 60 * 60 * 1000 })
    const res = await sweepDiskRegistry({ storageDir: root, ttlMs: 60_000, now: () => now })
    expect(res.evicted).toBe(1)
    expect(await dirExists(join(root, "old"))).toBe(false)
  })
})

describe("ADR-0348-gc §B — non-expired preserved", () => {
  test("recent session is left alone", async () => {
    const root = await tempStorage()
    const now = 100_000_000
    await writeSession(root, "fresh", { lastTouched: now - 100 })
    const res = await sweepDiskRegistry({ storageDir: root, ttlMs: 60_000, now: () => now })
    expect(res.evicted).toBe(0)
    expect(await dirExists(join(root, "fresh"))).toBe(true)
  })
})

describe("ADR-0348-gc §C — oversize jsonl truncated from front", () => {
  test("events.jsonl shrinks below cap", async () => {
    const root = await tempStorage()
    const now = 100_000_000
    const big = Array.from({ length: 100 }, (_, i) =>
      JSON.stringify({ kind: "context_update", field: "cwd", prev: "a", next: "b", at: i }),
    ).join("\n")
    await writeSession(root, "big", {
      lastTouched: now,
      eventsBody: big,
    })
    const cap = 500
    const res = await sweepDiskRegistry({
      storageDir: root,
      ttlMs: DEFAULT_TTL_MS,
      maxSessionBytes: cap,
      now: () => now,
    })
    expect(res.truncated).toBe(1)
    const afterBody = await readFile(join(root, "big", "events.jsonl"), "utf8")
    expect(Buffer.byteLength(afterBody, "utf8")).toBeLessThanOrEqual(cap)
    // At least one record survives.
    expect(afterBody.length).toBeGreaterThan(0)
  })
})

describe("ADR-0348-gc §D — missing storageDir ⇒ {0,0}", () => {
  test("non-existent dir is no-op", async () => {
    const res = await sweepDiskRegistry({
      storageDir: "/no/such/path/for/adr0348/gc/test",
    })
    expect(res).toEqual({ evicted: 0, truncated: 0, backendAvailable: false })
  })
})

describe("ADR-0348-gc §E — malformed meta.json skipped on TTL", () => {
  test("session with bad meta is NOT evicted (no signal to evict on)", async () => {
    const root = await tempStorage()
    const dir = join(root, "no-meta")
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, "meta.json"), "{garbage", "utf8")
    const res = await sweepDiskRegistry({
      storageDir: root,
      ttlMs: 1,
      now: () => Number.MAX_SAFE_INTEGER,
    })
    expect(res.evicted).toBe(0)
    expect(await dirExists(dir)).toBe(true)
  })
})

describe("ADR-0348-gc §F — mixed pass handles all axes", () => {
  test("expired + oversize + healthy in one sweep", async () => {
    const root = await tempStorage()
    const now = 100_000_000
    await writeSession(root, "expired", { lastTouched: now - 10_000_000 })
    const big = Array.from({ length: 200 }, (_, i) =>
      JSON.stringify({ kind: "context_update", field: "cwd", prev: "a", next: "b", at: i }),
    ).join("\n")
    await writeSession(root, "oversize", { lastTouched: now, eventsBody: big })
    await writeSession(root, "healthy", { lastTouched: now })
    const res = await sweepDiskRegistry({
      storageDir: root,
      ttlMs: 60_000,
      maxSessionBytes: 500,
      now: () => now,
    })
    expect(res.evicted).toBe(1)
    expect(res.truncated).toBeGreaterThanOrEqual(1)
    expect(await dirExists(join(root, "expired"))).toBe(false)
    expect(await dirExists(join(root, "healthy"))).toBe(true)
    expect(await dirExists(join(root, "oversize"))).toBe(true)
  })
})

describe("ADR-0348-gc §G — default TTL + size constants", () => {
  test("defaults align with ADR-0348 §Tradeoffs", () => {
    expect(DEFAULT_TTL_MS).toBe(14 * 24 * 60 * 60 * 1000)
    expect(DEFAULT_MAX_SESSION_BYTES).toBe(50_000_000)
  })
})

describe("ADR-0348-gc §H — permission / corrupt subentry swallowed", () => {
  test("file-not-a-directory entry inside storageDir is skipped", async () => {
    const root = await tempStorage()
    // Place a regular file at the top level of storageDir. The sweeper
    // must skip it (not a directory) without throwing.
    await writeFile(join(root, "stray-file.txt"), "hello", "utf8")
    await writeSession(root, "alive", { lastTouched: Date.now() })
    const res = await sweepDiskRegistry({ storageDir: root, ttlMs: DEFAULT_TTL_MS })
    expect(res.evicted).toBe(0)
    expect(res.truncated).toBe(0)
    // The healthy session remains
    expect(await dirExists(join(root, "alive"))).toBe(true)
    // The stray file remains too
    const stray = await readFile(join(root, "stray-file.txt"), "utf8")
    expect(stray).toBe("hello")
  })
})

// ─── jun-10 silent-failure audit #3 — locked + atomic truncation ──────────
//
// truncateSession used to rewrite a LIVE session's events.jsonl with no
// per-session lock and no temp+rename: a concurrent O_APPEND landing between
// the read and the truncating write was silently dropped (newest events
// lost), and a crash mid-rewrite tore the crash-recovery log the disk
// backend exists to provide. The fix gates the rewrite on the ADR-0356
// per-session file-lock (try-once acquire — a held lock means a LIVE owner,
// so the truncation is deferred to a later sweep) and rewrites via
// tmp+rename in the same directory with a lost-update tail merge (mirrors
// src/stream/adapters/jsonl-retention.ts §LOST-UPDATE GUARD).

const fixedRow = (i: number): string =>
  JSON.stringify({ kind: "context_update", field: "cwd", prev: "a", next: "b", at: 1000 + i })

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

describe("gc-truncate hellgate §I — foreign lock ⇒ truncation deferred", () => {
  test("fresh .lock held by another process ⇒ events.jsonl byte-identical", async () => {
    const root = await tempStorage()
    const now = 100_000_000
    const body = `${Array.from({ length: 100 }, (_, i) => fixedRow(i)).join("\n")}\n`
    const dir = await writeSession(root, "live-locked", { lastTouched: now, eventsBody: body })
    // Simulate ANOTHER process holding the per-session lock: plant a fresh
    // `.lock` file. This test process never registered the path in its own
    // holder map, so same-process re-entrancy does not apply — exactly the
    // cross-process live-writer shape.
    await writeFile(
      join(dir, ".lock"),
      JSON.stringify({ pid: 999_999, acquiredAt: Date.now() }),
      "utf8",
    )
    const res = await sweepDiskRegistry({
      storageDir: root,
      ttlMs: DEFAULT_TTL_MS,
      maxSessionBytes: 500,
      now: () => now,
    })
    expect(res.truncated).toBe(0)
    // Fresh readback: the live session's log is untouched, byte-identical.
    const after = await readFile(join(dir, "events.jsonl"), "utf8")
    expect(after).toBe(body)
    // The foreign (fresh, non-stale) lock is NOT stolen.
    expect(await fileExists(join(dir, ".lock"))).toBe(true)
  })
})

// NOTE (D11): this proves only the read→tail-read window — a row appended
// in that window is carried forward. It does NOT prove the tail-read→rename
// residual (gc.ts:26-28: an append landing after readAppendedTail but before
// the rename is still lost). §M below covers the related fail-CLOSED guard for
// an UNREADABLE tail re-read.
describe("gc-truncate hellgate §J — append in read→tail-read window carried forward", () => {
  test("row appended between read and rewrite survives the truncation", async () => {
    const root = await tempStorage()
    const now = 100_000_000
    const rows = Array.from({ length: 100 }, (_, i) => fixedRow(i))
    const body = `${rows.join("\n")}\n`
    const dir = await writeSession(root, "live-append", { lastTouched: now, eventsBody: body })
    const eventsPath = join(dir, "events.jsonl")
    const injected = JSON.stringify({
      kind: "context_update",
      field: "cwd",
      prev: "x",
      next: "y",
      at: 999_999,
    })
    let fired = 0
    const res = await sweepDiskRegistry(
      { storageDir: root, ttlMs: DEFAULT_TTL_MS, maxSessionBytes: 500, now: () => now },
      {
        afterReadForTest: async () => {
          fired += 1
          // The injection point: AFTER the truncation snapshot read, BEFORE
          // the rewrite — exactly the window where the old code dropped the
          // newest row.
          await appendFile(eventsPath, `${injected}\n`, "utf8")
        },
      },
    )
    expect(fired).toBe(1)
    expect(res.truncated).toBe(1)
    // Fresh readback — exact content assertion.
    const after = await readFile(eventsPath, "utf8")
    expect(after.endsWith("\n")).toBe(true)
    const linesAll = after.split("\n")
    expect(linesAll[linesAll.length - 1]).toBe("")
    const lines = linesAll.slice(0, -1)
    // No spliced / torn lines: every retained line parses as JSON.
    for (const line of lines) {
      expect(() => JSON.parse(line)).not.toThrow()
    }
    // The concurrently-appended row survives, exactly once, as the newest row.
    expect(lines.filter((l) => l === injected).length).toBe(1)
    expect(lines[lines.length - 1]).toBe(injected)
    // The retained pre-existing rows are a contiguous NEWEST suffix of the
    // original — zero loss of any row newer than the truncation cut.
    const keptOriginal = lines.slice(0, -1)
    expect(keptOriginal.length).toBeGreaterThan(0)
    expect(keptOriginal).toEqual(rows.slice(rows.length - keptOriginal.length))
    // Retained pre-existing rows respect the events budget (half of 500).
    expect(Buffer.byteLength(`${keptOriginal.join("\n")}\n`, "utf8")).toBeLessThanOrEqual(250)
    // The gc released its lock — no `.lock` leak in the session dir.
    expect(await fileExists(join(dir, ".lock"))).toBe(false)
  })
})

describe("gc-truncate hellgate §M — unreadable tail re-read ⇒ FAIL CLOSED (zero row loss)", () => {
  test("transient fs failure on the tail re-read aborts the truncate, file byte-identical", async () => {
    const root = await tempStorage()
    const now = 100_000_000
    // Over the per-file budget (forces a truncation attempt) but UNDER the
    // fail-closed escape valve's hard cap (budget × 4 = 1000B for maxBytes 500),
    // so a TRANSIENT read blip defers cleanly instead of tripping the
    // force-truncate (§M2 covers the egregiously-oversize force path).
    const rows = Array.from({ length: 10 }, (_, i) => fixedRow(i))
    const body = `${rows.join("\n")}\n`
    const dir = await writeSession(root, "tail-unreadable", { lastTouched: now, eventsBody: body })
    const eventsPath = join(dir, "events.jsonl")
    const injected = JSON.stringify({
      kind: "context_update",
      field: "cwd",
      prev: "x",
      next: "y",
      at: 888_888,
    })
    // Land a REAL concurrently-appended row past the snapshot bytes so the
    // tail re-read genuinely has rows to recover...
    let appended = 0
    let tailFailed = 0
    const res = await sweepDiskRegistry(
      { storageDir: root, ttlMs: DEFAULT_TTL_MS, maxSessionBytes: 500, now: () => now },
      {
        afterReadForTest: async () => {
          appended += 1
          await appendFile(eventsPath, `${injected}\n`, "utf8")
        },
        // ...then make the tail re-read throw (stat sees the growth, the
        // open/read fails). The OLD fail-open code returned "" here and let
        // the rename proceed, DROPPING the injected row. The fail-closed fix
        // must ABORT instead.
        failTailReadForTest: async () => {
          tailFailed += 1
          throw new Error("simulated transient fs failure on tail re-read")
        },
      },
    )
    expect(appended).toBe(1)
    expect(tailFailed).toBe(1)
    // The truncate ABORTED — nothing reported truncated.
    expect(res.truncated).toBe(0)
    // Fresh readback: the file is byte-identical to the post-append on-disk
    // state — the rename was skipped, so the injected (newest) row survives
    // and the oversize body is left intact for the next sweep to retry.
    const after = await readFile(eventsPath, "utf8")
    expect(after).toBe(`${body}${injected}\n`)
    // The injected row is present exactly once.
    const lines = after.split("\n").slice(0, -1)
    expect(lines.filter((l) => l === injected).length).toBe(1)
    expect(lines[lines.length - 1]).toBe(injected)
    // No torn rewrite: no orphaned temp litter, lock released.
    const entries = await readdir(dir)
    expect(entries.filter((e) => e.includes(".tmp-"))).toEqual([])
    expect(entries.includes(".lock")).toBe(false)
  })
})

describe("gc-truncate hellgate §M2 — PERSISTENT unreadable tail ⇒ BOUNDED escape (no unbounded growth)", () => {
  // Rounds-2/3 adversarial audit: an unconditional fail-closed abort, under a
  // PERSISTENT tail-read failure + a live appender, would defer EVERY sweep and
  // grow the file without bound — silently defeating the size cap. The escape
  // valve force-truncates from the snapshot once the file blows past
  // budget × HARD_CAP_MULTIPLE, dropping ONLY the tail it could not read (the
  // lesser evil vs unbounded growth) and surfacing it via SweepResult.truncated.
  test("egregiously-oversize file + unreadable tail ⇒ force-truncate, bounded, observable", async () => {
    const root = await tempStorage()
    const now = 100_000_000
    // ~7KB events file ≫ the escape hard cap (budget 250 × 4 = 1000B).
    const rows = Array.from({ length: 100 }, (_, i) => fixedRow(i))
    const body = `${rows.join("\n")}\n`
    const dir = await writeSession(root, "tail-persistent-fail", {
      lastTouched: now,
      eventsBody: body,
    })
    const eventsPath = join(dir, "events.jsonl")
    const before = Buffer.byteLength(await readFile(eventsPath, "utf8"), "utf8")
    const injected = JSON.stringify({
      kind: "context_update",
      field: "cwd",
      prev: "x",
      next: "y",
      at: 777_777,
    })
    let tailFailed = 0
    const res = await sweepDiskRegistry(
      { storageDir: root, ttlMs: DEFAULT_TTL_MS, maxSessionBytes: 500, now: () => now },
      {
        // Land a row past the snapshot so the tail re-read is actually attempted...
        afterReadForTest: async () => {
          await appendFile(eventsPath, `${injected}\n`, "utf8")
        },
        // ...then fail it (persistent). The file is ≫ the hard cap, so instead of
        // deferring forever the escape valve force-truncates (dropping this
        // unreadable row — the lesser evil vs unbounded growth).
        failTailReadForTest: async () => {
          tailFailed += 1
          throw new Error("simulated PERSISTENT fs failure on tail re-read")
        },
      },
    )
    expect(tailFailed).toBe(1)
    // The unreadable tail row was dropped (documented bounded degradation).
    expect((await readFile(eventsPath, "utf8")).includes(injected)).toBe(false)
    // BOUNDED + OBSERVABLE: the force-truncate landed (not a silent no-op defer).
    expect(res.truncated).toBe(1)
    const after = await readFile(eventsPath, "utf8")
    const afterBytes = Buffer.byteLength(after, "utf8")
    // The cap is enforced — the file shrank well below its pre-sweep size and
    // within the events budget (half of 500), not left to grow unbounded.
    expect(afterBytes).toBeLessThan(before)
    expect(afterBytes).toBeLessThanOrEqual(250)
    // No torn rewrite: every retained line still parses, no temp litter, lock freed.
    for (const line of after.split("\n").slice(0, -1)) expect(() => JSON.parse(line)).not.toThrow()
    const entries = await readdir(dir)
    expect(entries.filter((e) => e.includes(".tmp-"))).toEqual([])
    expect(entries.includes(".lock")).toBe(false)
  })
})

describe("gc-truncate hellgate §K — crash mid-rewrite ⇒ original intact", () => {
  test("throwing beforeRename leaves events.jsonl byte-identical, no tmp litter", async () => {
    const root = await tempStorage()
    const now = 100_000_000
    const body = `${Array.from({ length: 100 }, (_, i) => fixedRow(i)).join("\n")}\n`
    const dir = await writeSession(root, "crashy", { lastTouched: now, eventsBody: body })
    const res = await sweepDiskRegistry(
      { storageDir: root, ttlMs: DEFAULT_TTL_MS, maxSessionBytes: 500, now: () => now },
      {
        beforeRenameForTest: async () => {
          throw new Error("simulated crash between tmp write and rename")
        },
      },
    )
    expect(res.truncated).toBe(0)
    // Fresh readback: the rename never happened, so the original log is
    // byte-identical — NOT a torn half-written file.
    const after = await readFile(join(dir, "events.jsonl"), "utf8")
    expect(after).toBe(body)
    const entries = await readdir(dir)
    // No orphaned temp file litter, and the lock was released on the way out.
    expect(entries.filter((e) => e.includes(".tmp-"))).toEqual([])
    expect(entries.includes(".lock")).toBe(false)
  })
})

describe("gc-truncate hellgate §L — unsanitizable entry skipped", () => {
  test("dir name outside [A-Za-z0-9_-] is never rewritten (lock path would diverge)", async () => {
    const root = await tempStorage()
    const now = 100_000_000
    const body = `${Array.from({ length: 100 }, (_, i) => fixedRow(i)).join("\n")}\n`
    // The registry only ever creates sanitized dir names; "weird.name" is a
    // foreign dir whose lock path (safeId ⇒ "weird_name") would NOT cover it.
    const dir = await writeSession(root, "weird.name", { lastTouched: now, eventsBody: body })
    const res = await sweepDiskRegistry({
      storageDir: root,
      ttlMs: DEFAULT_TTL_MS,
      maxSessionBytes: 500,
      now: () => now,
    })
    expect(res.truncated).toBe(0)
    const after = await readFile(join(dir, "events.jsonl"), "utf8")
    expect(after).toBe(body)
    // No sanitized side-directory was minted by a misdirected lock acquire.
    expect(await dirExists(join(root, "weird_name"))).toBe(false)
  })
})

// ─── ADR-0387 — countDiskRegistryCleanupCandidates (dry-run) ──────────────
//
// 5 cases. Same axes as sweepDiskRegistry (TTL + size cap) but using
// SELECT/scan-only semantics: NO fs mutation (no unlink, no writeFile).
// The function returns the candidate count so an operator can preview
// `cleanup --dry-run` output without committing the sweep.
describe("ADR-0387 countDiskRegistryCleanupCandidates — hellgate", () => {
  test("[1] empty dir ⇒ wouldEvict 0 / inspectedSessions 0", async () => {
    const root = await tempStorage()
    const res = await countDiskRegistryCleanupCandidates({ storageDir: root })
    expect(res.wouldEvictByTtl).toBe(0)
    expect(res.wouldEvictBySize).toBe(0)
    expect(res.inspectedSessions).toBe(0)
    expect(res.storageDir).toBe(root)
  })

  test("[2] TTL candidates counted correctly", async () => {
    const root = await tempStorage()
    const now = 100_000_000
    // 2 expired, 1 fresh
    await writeSession(root, "old-a", { lastTouched: now - 60 * 60 * 1000 })
    await writeSession(root, "old-b", { lastTouched: now - 60 * 60 * 1000 })
    await writeSession(root, "fresh", { lastTouched: now - 100 })
    const res = await countDiskRegistryCleanupCandidates({
      storageDir: root,
      ttlMs: 60_000,
      now: () => now,
    })
    expect(res.wouldEvictByTtl).toBe(2)
    expect(res.inspectedSessions).toBe(3)
    // No fs changes: all three dirs still exist
    expect(await dirExists(join(root, "old-a"))).toBe(true)
    expect(await dirExists(join(root, "old-b"))).toBe(true)
    expect(await dirExists(join(root, "fresh"))).toBe(true)
  })

  test("[3] size-cap candidates counted (oversize ⇒ wouldEvictBySize >= 1)", async () => {
    const root = await tempStorage()
    const now = 100_000_000
    const big = Array.from({ length: 100 }, (_, i) =>
      JSON.stringify({ kind: "context_update", field: "cwd", prev: "a", next: "b", at: i }),
    ).join("\n")
    await writeSession(root, "big", { lastTouched: now, eventsBody: big })
    await writeSession(root, "small", { lastTouched: now, eventsBody: "{}" })
    const res = await countDiskRegistryCleanupCandidates({
      storageDir: root,
      ttlMs: DEFAULT_TTL_MS,
      maxSessionBytes: 500,
      now: () => now,
    })
    expect(res.wouldEvictBySize).toBe(1)
    expect(res.wouldEvictByTtl).toBe(0)
    expect(res.inspectedSessions).toBe(2)
    // Idempotent: bytes on disk unchanged
    const stillBig = await readFile(join(root, "big", "events.jsonl"), "utf8")
    expect(Buffer.byteLength(stillBig, "utf8")).toBe(Buffer.byteLength(big, "utf8"))
  })

  test("[4] missing storageDir ⇒ zero values, NO-THROW", async () => {
    const res = await countDiskRegistryCleanupCandidates({
      storageDir: "/no/such/dir/for/adr0387/dry-run",
    })
    expect(res.wouldEvictByTtl).toBe(0)
    expect(res.wouldEvictBySize).toBe(0)
    expect(res.inspectedSessions).toBe(0)
    expect(res.storageDir).toBe("/no/such/dir/for/adr0387/dry-run")
  })

  test("[5] idempotent — second call sees identical state (no fs mutation)", async () => {
    const root = await tempStorage()
    const now = 100_000_000
    await writeSession(root, "expired", { lastTouched: now - 10_000_000 })
    await writeSession(root, "fresh", { lastTouched: now })
    const res1 = await countDiskRegistryCleanupCandidates({
      storageDir: root,
      ttlMs: 60_000,
      now: () => now,
    })
    const res2 = await countDiskRegistryCleanupCandidates({
      storageDir: root,
      ttlMs: 60_000,
      now: () => now,
    })
    // The two calls return identical results (no mutation between them).
    expect(res2.wouldEvictByTtl).toBe(res1.wouldEvictByTtl)
    expect(res2.inspectedSessions).toBe(res1.inspectedSessions)
    // And the expired session is STILL on disk (count, not sweep).
    expect(await dirExists(join(root, "expired"))).toBe(true)
    expect(await dirExists(join(root, "fresh"))).toBe(true)
  })
})
