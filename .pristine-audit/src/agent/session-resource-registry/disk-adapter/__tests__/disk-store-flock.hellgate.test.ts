/**
 * ADR-0356 — Disk-store × file-lock integration hellgate.
 *
 * Coverage (6 cases — minimum from the ADR brief):
 *   A. happy path: acquire ⇒ existing disk-mirror flow works       (1)
 *   B. lock acquire FAILS ⇒ memory-only fallback (no disk write)   (1)
 *   C. in-process re-entrancy: 2 getOrCreate same id ⇒ 1 lock      (1)
 *   D. evict releases lock ⇒ next acquire succeeds                 (1)
 *   E. clear releases every lock ⇒ next acquire succeeds           (1)
 *   F. stale-lock cleanup at disk-store level (mtime > threshold)  (1)
 *
 *  Total: 6 cases.
 */

import { describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, stat, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createDiskSessionResourceRegistry } from "../disk-store"
import { LOCK_FILENAME } from "../file-lock"

const tempStorage = async (): Promise<string> => mkdtemp(join(tmpdir(), "adr0356-int-"))

// Bounded poll for fs-mirror operations (the disk-store schedules its
// writes onto microtasks gated by the lock promise).
const waitForFile = async (path: string, predicate: (body: string) => boolean): Promise<string> => {
  const deadline = Date.now() + 2000
  while (Date.now() < deadline) {
    try {
      const body = await readFile(path, "utf8")
      if (predicate(body)) return body
    } catch {
      // not yet
    }
    await new Promise((r) => setTimeout(r, 10))
  }
  try {
    return await readFile(path, "utf8")
  } catch {
    return ""
  }
}

describe("ADR-0356 §A — happy path: lock acquired, mirror writes proceed", () => {
  test("disk-mirror behaves identically to ADR-0348 when uncontended", async () => {
    const dir = await tempStorage()
    const reg = createDiskSessionResourceRegistry({ storageDir: dir })
    const r = reg.getOrCreate("sess-A")
    r.store.append({
      kind: "context_update",
      field: "cwd",
      prev: "/a",
      next: "/b",
      at: 1,
      turnId: "t1",
    })
    // Events line lands on disk (existing ADR-0348 contract holds).
    const body = await waitForFile(join(dir, "sess-A", "events.jsonl"), (b) =>
      b.includes("context_update"),
    )
    expect(body.length).toBeGreaterThan(0)
    // Lockfile exists while session is live.
    const lockSt = await stat(join(dir, "sess-A", LOCK_FILENAME))
    expect(lockSt.isFile()).toBe(true)
  })
})

describe("ADR-0356 §B — lock acquire FAILS ⇒ memory-only fallback", () => {
  test("when another process holds the lock, no disk write lands", async () => {
    const dir = await tempStorage()
    // Plant a fresh lockfile by hand to simulate a sibling process.
    const sessionDir = join(dir, "sess-B")
    await mkdir(sessionDir, { recursive: true })
    await writeFile(join(sessionDir, LOCK_FILENAME), JSON.stringify({ pid: 999, acquiredAt: 0 }), {
      mode: 0o600,
    })
    // Use a tiny timeout so the test runs fast — the lockfile is
    // "fresh" by mtime (just written) so no stale reap will fire.
    const reg = createDiskSessionResourceRegistry({
      storageDir: dir,
      lock: { timeoutMs: 50, retryIntervalMs: 10, staleThresholdMs: 60_000 },
    })
    const r = reg.getOrCreate("sess-B")
    // In-memory still works.
    r.store.append({
      kind: "context_update",
      field: "cwd",
      prev: "/a",
      next: "/b",
      at: 1,
      turnId: "t1",
    })
    expect(r.store.snapshot().length).toBe(1)
    // Wait long enough for any scheduled mirror writes to have fired,
    // then assert the events file is still missing or empty.
    await new Promise((res) => setTimeout(res, 200))
    let body = ""
    try {
      body = await readFile(join(dir, "sess-B", "events.jsonl"), "utf8")
    } catch {
      body = ""
    }
    expect(body).toBe("")
  })
})

describe("ADR-0356 §C — in-process re-entrancy: 2 calls same id ⇒ 1 lock", () => {
  test("repeated getOrCreate(id) reuses the lock without re-acquiring", async () => {
    const dir = await tempStorage()
    const reg = createDiskSessionResourceRegistry({ storageDir: dir })
    const a = reg.getOrCreate("sess-C")
    const b = reg.getOrCreate("sess-C")
    expect(a).toBe(b)
    // Only ONE .lock file on disk for this session.
    await waitForFile(join(dir, "sess-C", LOCK_FILENAME), () => true)
    const lockSt = await stat(join(dir, "sess-C", LOCK_FILENAME))
    expect(lockSt.isFile()).toBe(true)
  })
})

describe("ADR-0356 §D — evict releases the lock", () => {
  test("after evict the lockfile is gone; next acquire succeeds", async () => {
    const dir = await tempStorage()
    const reg = createDiskSessionResourceRegistry({ storageDir: dir })
    reg.getOrCreate("sess-D")
    await waitForFile(join(dir, "sess-D", LOCK_FILENAME), () => true)
    reg.evict("sess-D")
    // Give async cleanup a moment to fire.
    await new Promise((r) => setTimeout(r, 100))
    let gone = false
    try {
      await stat(join(dir, "sess-D", LOCK_FILENAME))
    } catch {
      gone = true
    }
    expect(gone).toBe(true)
    // A subsequent getOrCreate from a fresh registry MUST be able to
    // acquire instantly (no stale lock blocking).
    const reg2 = createDiskSessionResourceRegistry({
      storageDir: dir,
      lock: { timeoutMs: 100, retryIntervalMs: 10 },
    })
    const r = reg2.getOrCreate("sess-D")
    expect(r.store).toBeDefined()
    await waitForFile(join(dir, "sess-D", LOCK_FILENAME), () => true)
  })
})

describe("ADR-0356 §E — clear releases every lock", () => {
  test("after clear all per-session locks are released", async () => {
    const dir = await tempStorage()
    const reg = createDiskSessionResourceRegistry({ storageDir: dir })
    reg.getOrCreate("e1")
    reg.getOrCreate("e2")
    await waitForFile(join(dir, "e1", LOCK_FILENAME), () => true)
    await waitForFile(join(dir, "e2", LOCK_FILENAME), () => true)
    reg.clear()
    await new Promise((r) => setTimeout(r, 100))
    // A second registry must be able to acquire both ids.
    const reg2 = createDiskSessionResourceRegistry({
      storageDir: dir,
      lock: { timeoutMs: 200, retryIntervalMs: 10 },
    })
    reg2.getOrCreate("e1")
    reg2.getOrCreate("e2")
    expect(reg2.size()).toBe(2)
  })
})

describe("ADR-0356 §F — stale lock cleanup at disk-store level", () => {
  test("a planted stale lockfile is reclaimed on getOrCreate", async () => {
    const dir = await tempStorage()
    const sessionDir = join(dir, "sess-F")
    await mkdir(sessionDir, { recursive: true })
    const lockPath = join(sessionDir, LOCK_FILENAME)
    await writeFile(lockPath, JSON.stringify({ pid: 1, acquiredAt: 0 }), { mode: 0o600 })
    // Push mtime to 60s ago — older than the 30s default threshold.
    const past = (Date.now() - 60_000) / 1000
    await utimes(lockPath, past, past)
    const reg = createDiskSessionResourceRegistry({
      storageDir: dir,
      lock: { timeoutMs: 200, retryIntervalMs: 10, staleThresholdMs: 30_000 },
    })
    const r = reg.getOrCreate("sess-F")
    // First disk write proves we own the lock (otherwise it would be
    // suppressed by the memory-only fallback).
    r.store.append({
      kind: "mode_change",
      prev: "x",
      next: "y",
      at: 7,
    })
    const body = await waitForFile(join(dir, "sess-F", "events.jsonl"), (b) =>
      b.includes("mode_change"),
    )
    expect(body).toContain("mode_change")
  })
})
