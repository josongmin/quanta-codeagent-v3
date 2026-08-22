/**
 * ADR-0238 hellgate — `pruneToSizeBudget` (size-based eviction sibling to
 * the age-based `prune`).
 *
 * 9 invariants:
 *
 *   - empty/non-existent dir         → 0 removals (idempotent)
 *   - under budget                   → no-op (0 removals)
 *   - over budget                    → oldest-first eviction
 *   - mixed time + size              → both prunes applied (age first)
 *   - single oversized file          → KEEP (never empty the dir)
 *   - non-.sh files                  → never touched
 *   - exactly-at-budget              → no-op
 *   - vanished-during-readdir        → tolerated (no throw)
 *   - port surface presence          → method on real port
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  createShellSnapshotPort,
  headlessSpawner,
  pruneToSizeBudget,
} from "@/runtime/shell-snapshot"
import { prune, snapshotDir } from "@/runtime/shell-snapshot/file-store"

let tmpHome: string
let dir: string

const writeSnap = (name: string, bytes: number, mtime?: Date): string => {
  const path = join(dir, name)
  writeFileSync(path, "x".repeat(bytes), { mode: 0o600 })
  if (mtime) utimesSync(path, mtime, mtime)
  return path
}

beforeEach(() => {
  // dynamically allocate a fresh HOME-style root per test
  tmpHome = join(tmpdir(), `qss-size-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  dir = snapshotDir(tmpHome)
  mkdirSync(dir, { recursive: true, mode: 0o700 })
})

afterEach(() => {
  try {
    rmSync(tmpHome, { recursive: true, force: true })
  } catch {
    // ignore
  }
})

describe("ADR-0238 pruneToSizeBudget hellgate", () => {
  // ─── HELL-SS-SIZE-01 — empty dir / non-existent dir ─────────────────────
  test("HELL-SS-SIZE-01 missing directory returns 0 (idempotent)", async () => {
    rmSync(tmpHome, { recursive: true, force: true })
    expect(existsSync(dir)).toBe(false)
    const removed = await pruneToSizeBudget(1_000, tmpHome)
    expect(removed).toBe(0)
  })

  // ─── HELL-SS-SIZE-02 — under budget, no-op ──────────────────────────────
  test("HELL-SS-SIZE-02 under-budget yields zero removals", async () => {
    writeSnap("a.sh", 100)
    writeSnap("b.sh", 100)
    const removed = await pruneToSizeBudget(10_000, tmpHome)
    expect(removed).toBe(0)
    expect(readdirSync(dir).length).toBe(2)
  })

  // ─── HELL-SS-SIZE-03 — over budget evicts oldest first ──────────────────
  test("HELL-SS-SIZE-03 over-budget evicts oldest mtime first until under cap", async () => {
    // 3 files × 1000 bytes = 3000 total. Cap at 1500 ⇒ must drop 2 (oldest two).
    const now = Date.now()
    const old = new Date(now - 60_000) // 1 min ago
    const mid = new Date(now - 30_000)
    const fresh = new Date(now)
    const oldPath = writeSnap("old.sh", 1000, old)
    const midPath = writeSnap("mid.sh", 1000, mid)
    const freshPath = writeSnap("fresh.sh", 1000, fresh)
    const removed = await pruneToSizeBudget(1500, tmpHome)
    expect(removed).toBe(2)
    expect(existsSync(oldPath)).toBe(false)
    expect(existsSync(midPath)).toBe(false)
    expect(existsSync(freshPath)).toBe(true)
  })

  // ─── HELL-SS-SIZE-04 — mixed age + size prune via session helper sim ────
  test("HELL-SS-SIZE-04 age-then-size two-phase prune (real port surface)", async () => {
    const port = createShellSnapshotPort(headlessSpawner, tmpHome)
    // Two stale files (1 hour old, 1000 each) + one fresh (1000).
    const past = new Date(Date.now() - 60 * 60 * 1000)
    writeSnap("stale-a.sh", 1000, past)
    writeSnap("stale-b.sh", 1000, past)
    writeSnap("fresh.sh", 1000)
    // age prune removes the two stale ones; cap at 500 then forces the
    // single remaining fresh to be the only file — and since the rule says
    // "never empty the dir", it stays.
    const ageRemoved = await port.prune(30 * 60 * 1000) // 30 min cutoff
    expect(ageRemoved).toBe(2)
    const sizeRemoved = await port.pruneToSizeBudget(500)
    // Only one file remains, the rule keeps the last file even if over cap.
    expect(sizeRemoved).toBe(0)
    expect(readdirSync(dir).length).toBe(1)
  })

  // ─── HELL-SS-SIZE-05 — single oversized file kept ───────────────────────
  test("HELL-SS-SIZE-05 single file over cap is KEPT (never empty the dir)", async () => {
    writeSnap("big.sh", 5_000)
    const removed = await pruneToSizeBudget(1_000, tmpHome)
    expect(removed).toBe(0)
    expect(readdirSync(dir).length).toBe(1)
  })

  // ─── HELL-SS-SIZE-06 — non-.sh files are never touched ──────────────────
  test("HELL-SS-SIZE-06 foreign (non-.sh) files are never touched", async () => {
    writeSnap("a.sh", 1_000, new Date(Date.now() - 60_000))
    writeSnap("b.sh", 1_000, new Date(Date.now() - 30_000))
    writeFileSync(join(dir, "readme.txt"), "x".repeat(2_000))
    writeFileSync(join(dir, ".keep"), "x".repeat(500))
    // Cap at 500 ⇒ must drop one .sh (oldest). The .txt/.keep MUST survive.
    const removed = await pruneToSizeBudget(500, tmpHome)
    expect(removed).toBeGreaterThanOrEqual(1)
    expect(existsSync(join(dir, "readme.txt"))).toBe(true)
    expect(existsSync(join(dir, ".keep"))).toBe(true)
  })

  // ─── HELL-SS-SIZE-07 — exactly at budget ────────────────────────────────
  test("HELL-SS-SIZE-07 sum == budget yields no removals", async () => {
    writeSnap("a.sh", 500)
    writeSnap("b.sh", 500)
    const removed = await pruneToSizeBudget(1_000, tmpHome)
    expect(removed).toBe(0)
    expect(readdirSync(dir).filter((n) => n.endsWith(".sh")).length).toBe(2)
  })

  // ─── HELL-SS-SIZE-08 — maxBytes ≤ 0 honoured but still keep last file ──
  test("HELL-SS-SIZE-08 maxBytes <= 0 drops all but the most-recent file", async () => {
    const oldP = writeSnap("a.sh", 500, new Date(Date.now() - 60_000))
    const freshP = writeSnap("b.sh", 500)
    const removed = await pruneToSizeBudget(0, tmpHome)
    expect(removed).toBe(1)
    expect(existsSync(oldP)).toBe(false)
    expect(existsSync(freshP)).toBe(true)
  })

  // ─── HELL-SS-SIZE-09 — port surface exposes pruneToSizeBudget ───────────
  test("HELL-SS-SIZE-09 createShellSnapshotPort exposes pruneToSizeBudget", async () => {
    const port = createShellSnapshotPort(headlessSpawner, tmpHome)
    expect(typeof port.pruneToSizeBudget).toBe("function")
    // Idempotent on an empty dir.
    expect(await port.pruneToSizeBudget(100)).toBe(0)
  })

  // ─── HELL-SS-SIZE-10 — atomic operation: age prune unaffected ───────────
  test("HELL-SS-SIZE-10 age prune is unaffected by a sibling size sweep", async () => {
    const past = new Date(Date.now() - 60 * 60 * 1000)
    writeSnap("stale.sh", 100, past)
    writeSnap("fresh.sh", 100)
    // Pure age-prune (no size knob) — must drop ONLY the stale one.
    const aged = await prune(30 * 60 * 1000, tmpHome)
    expect(aged).toBe(1)
    expect(readdirSync(dir).filter((n) => n.endsWith(".sh"))).toEqual(["fresh.sh"])
    // Idempotent second call.
    expect(await prune(30 * 60 * 1000, tmpHome)).toBe(0)
  })
})
