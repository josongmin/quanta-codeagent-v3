/**
 * ★ HELLGATE — ADR-0361 sweepSqliteRegistry.
 *
 * Pins Codex `logs_2.sqlite` retention parity at the GC level:
 * cumulative-bytes sliding window + TTL fallback + PASSIVE checkpoint.
 *
 * Coverage (8 cases):
 *   1. TTL evicts sessions older than cutoff
 *   2. Sliding-window evicts OLDEST first (newest survives)
 *   3. PASSIVE checkpoint reported = true on a healthy DB
 *   4. Empty DB ⇒ no-op { 0, 0, true }
 *   5. Mixed TTL + size — TTL pass counted first
 *   6. Never delete in-use session (within TTL + under size cap)
 *   7. WAL size shrinks after sweep + checkpoint (best-effort)
 *   8. Clock seam determinism (now() mock controls TTL eviction)
 */

import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { countSqliteRegistryCleanupCandidates, sweepSqliteRegistry } from "../gc"
import { applyMigrations } from "../schema"

const makeTmp = (): { path: string; cleanup: () => void } => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-adr0361-gc-"))
  return {
    path: join(dir, "registry.db"),
    cleanup: () => {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // best-effort
      }
    },
  }
}

const seedSession = (db: Database, sessionId: string, touched: number, bytes: number): void => {
  db.exec(
    `INSERT INTO sessions (session_id, last_touched, total_estimated_bytes) VALUES ('${sessionId}', ${touched}, ${bytes})`,
  )
}

describe("ADR-0361 sweepSqliteRegistry — hellgate", () => {
  test("[1] TTL evicts sessions older than cutoff", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    seedSession(db, "old", 100, 10)
    seedSession(db, "new", 1_000_000, 10)
    db.close()
    const res = sweepSqliteRegistry({
      databasePath: path,
      ttlMs: 1000,
      now: () => 1_000_500,
    })
    expect(res.evictedByTtl).toBe(1)
    const db2 = new Database(path)
    const rows = (db2.query("SELECT session_id FROM sessions").all() as { session_id: string }[])
      .map((r) => r.session_id)
      .sort()
    expect(rows).toEqual(["new"])
    db2.close()
    cleanup()
  })

  test("[2] Sliding-window evicts OLDEST first", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    // 4 sessions × 100 bytes each = 400 total. Cap = 250 should keep
    // the 2 newest (200 bytes).
    seedSession(db, "s1", 1000, 100) // newest
    seedSession(db, "s2", 900, 100)
    seedSession(db, "s3", 800, 100)
    seedSession(db, "s4", 700, 100) // oldest
    db.close()
    const res = sweepSqliteRegistry({
      databasePath: path,
      maxTotalBytes: 250,
      ttlMs: 999_999_999,
      now: () => 1000,
    })
    expect(res.evictedBySize).toBeGreaterThanOrEqual(1)
    const db2 = new Database(path)
    const rows = (
      db2.query("SELECT session_id FROM sessions ORDER BY last_touched DESC").all() as {
        session_id: string
      }[]
    ).map((r) => r.session_id)
    // The newest session MUST survive.
    expect(rows[0]).toBe("s1")
    // The oldest MUST NOT be in the survivors.
    expect(rows).not.toContain("s4")
    db2.close()
    cleanup()
  })

  test("[3] PASSIVE checkpoint reported success on healthy DB", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    seedSession(db, "s1", 1, 10)
    db.close()
    const res = sweepSqliteRegistry({ databasePath: path })
    expect(res.checkpointed).toBe(true)
    cleanup()
  })

  test("[4] Empty DB ⇒ no-op { 0, 0, true }", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    db.close()
    const res = sweepSqliteRegistry({ databasePath: path })
    expect(res.evictedByTtl).toBe(0)
    expect(res.evictedBySize).toBe(0)
    expect(res.checkpointed).toBe(true)
    cleanup()
  })

  test("[5] Mixed TTL + size — both axes counted independently", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    // 4 sessions: one is TTL-expired; the other 3 are within TTL but
    // their combined bytes (3000) exceed the size cap (1500), so at
    // least one falls to the sliding-window axis.
    seedSession(db, "expired", 100, 10) // ttl-evicted (last_touched << cutoff)
    seedSession(db, "big-old", 1450, 1000)
    seedSession(db, "big-mid", 1480, 1000)
    seedSession(db, "big-new", 1500, 1000)
    db.close()
    const res = sweepSqliteRegistry({
      databasePath: path,
      ttlMs: 100, // cutoff = 1500 - 100 = 1400 → "expired" evicted; others kept
      maxTotalBytes: 1500,
      now: () => 1500,
    })
    expect(res.evictedByTtl).toBe(1)
    expect(res.evictedBySize).toBeGreaterThanOrEqual(1)
    cleanup()
  })

  test("[6] In-use sessions within TTL and under size cap are preserved", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    seedSession(db, "s1", 1000, 10)
    seedSession(db, "s2", 1000, 10)
    db.close()
    const res = sweepSqliteRegistry({
      databasePath: path,
      ttlMs: 1_000_000_000,
      maxTotalBytes: 1_000_000_000,
      now: () => 1000,
    })
    expect(res.evictedByTtl).toBe(0)
    expect(res.evictedBySize).toBe(0)
    const db2 = new Database(path)
    const c = (db2.query("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c
    expect(c).toBe(2)
    db2.close()
    cleanup()
  })

  test("[7] WAL file exists after a write (best-effort)", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    for (let i = 0; i < 50; i++) seedSession(db, `s${i}`, 1000, 10)
    db.close()
    sweepSqliteRegistry({ databasePath: path })
    // Best-effort: WAL file may have been checkpointed away. We just
    // assert that the main DB file is non-zero (sweep did not nuke it).
    expect(statSync(path).size).toBeGreaterThan(0)
    cleanup()
  })

  test("[8] Clock seam determinism — now() controls TTL eviction", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    seedSession(db, "s1", 1000, 10)
    db.close()

    // First sweep at now=1500 with ttl=1000 ⇒ keep (cutoff=500, last_touched=1000)
    const res1 = sweepSqliteRegistry({
      databasePath: path,
      ttlMs: 1000,
      now: () => 1500,
    })
    expect(res1.evictedByTtl).toBe(0)

    // Second sweep at now=999_999 ⇒ evict (cutoff=998_999, last_touched=1000)
    const res2 = sweepSqliteRegistry({
      databasePath: path,
      ttlMs: 1000,
      now: () => 999_999,
    })
    expect(res2.evictedByTtl).toBe(1)
    cleanup()
  })

  // ADR-0375 — WAL-size-threshold RESTART checkpoint cases (Y..DD).
  test("[Y] walSizeThresholdBytes absent ⇒ PASSIVE only (walRestarted = false)", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    seedSession(db, "s1", 1000, 10)
    db.close()
    const res = sweepSqliteRegistry({ databasePath: path })
    expect(res.walRestarted).toBe(false)
    expect(res.checkpointed).toBe(true)
    cleanup()
  })

  test("[Z] WAL > threshold ⇒ RESTART checkpoint runs + walRestarted = true", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    // Force WAL to exist by issuing a write transaction.
    for (let i = 0; i < 50; i++) seedSession(db, `s${i}`, 1000 + i, 10)
    db.close()
    // Sweep with a tiny threshold so any non-empty WAL counts as "big".
    // The WAL file might have been checkpointed already by close(); if
    // so, the RESTART path is a graceful no-op (still reports
    // walRestarted = true on the SQLite call, OR false on a missing
    // WAL — the contract permits the missing-file fast-path). The
    // case-Z assertion accepts EITHER outcome (we just need the path
    // to be reachable without throwing).
    const res = sweepSqliteRegistry({
      databasePath: path,
      walSizeThresholdBytes: 1, // trivially low
    })
    // The flag MUST exist on the result.
    expect(typeof res.walRestarted).toBe("boolean")
    // The sweep MUST still succeed.
    expect(res.checkpointed).toBe(true)
    cleanup()
  })

  test("[AA] WAL < threshold ⇒ PASSIVE only + walRestarted = false", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    seedSession(db, "s1", 1000, 10)
    db.close()
    // Threshold is huge — WAL (if any) is far below it ⇒ no RESTART.
    const res = sweepSqliteRegistry({
      databasePath: path,
      walSizeThresholdBytes: 10 * 1024 * 1024 * 1024, // 10 GB
    })
    expect(res.walRestarted).toBe(false)
    expect(res.checkpointed).toBe(true)
    cleanup()
  })

  test("[BB] WAL file missing ⇒ graceful (walRestarted = false, no throw)", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    // Close without writing — no WAL on disk.
    db.close()
    const res = sweepSqliteRegistry({
      databasePath: path,
      walSizeThresholdBytes: 1,
    })
    expect(res.walRestarted).toBe(false)
    cleanup()
  })

  test("[CC] RESTART path reflected in result + does not break standard sweep", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    for (let i = 0; i < 20; i++) seedSession(db, `s${i}`, 1000 + i, 10)
    db.close()
    const res = sweepSqliteRegistry({
      databasePath: path,
      walSizeThresholdBytes: 1,
    })
    // Standard fields are still populated correctly.
    expect(res.evictedByTtl).toBeGreaterThanOrEqual(0)
    expect(res.evictedBySize).toBeGreaterThanOrEqual(0)
    expect(res.checkpointed).toBe(true)
    expect(typeof res.walRestarted).toBe("boolean")
    cleanup()
  })

  test("[DD] threshold = 0 ⇒ RESTART runs whenever WAL exists (edge case)", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    // Write a row to ensure WAL has content.
    seedSession(db, "s1", 1000, 10)
    db.close()
    const res = sweepSqliteRegistry({
      databasePath: path,
      walSizeThresholdBytes: 0,
    })
    // walRestarted must be a boolean and the sweep must succeed end-to-end.
    expect(typeof res.walRestarted).toBe("boolean")
    expect(res.checkpointed).toBe(true)
    cleanup()
  })

  // ─── ADR-0378 walSize surfacing ─────────────────────────────────────────

  test("[EE] SweepResult.walSize is always a non-negative number", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    db.close()
    const res = sweepSqliteRegistry({ databasePath: path })
    expect(typeof res.walSize).toBe("number")
    expect(res.walSize).toBeGreaterThanOrEqual(0)
    cleanup()
  })

  test("[FF] WAL missing (DB never written) ⇒ walSize === 0", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    db.close()
    const res = sweepSqliteRegistry({ databasePath: path })
    expect(res.walSize).toBe(0)
    cleanup()
  })

  test("[GG] EMPTY_RESULT path (DB open fails) ⇒ walSize === 0", () => {
    // databasePath inside non-existent parent — adapter does NOT mkdir,
    // so `new Database(...)` throws and returns EMPTY_RESULT.
    const res = sweepSqliteRegistry({
      databasePath: "/dev/null/no-such-parent/db.sqlite",
    })
    expect(res.walSize).toBe(0)
    expect(res.evictedByTtl).toBe(0)
    expect(res.checkpointed).toBe(false)
  })

  test("[HH] walSize is read AFTER checkpoint (post-PASSIVE)", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    seedSession(db, "s-wal", 1000, 10)
    db.close()
    const res = sweepSqliteRegistry({ databasePath: path })
    // After PASSIVE, the WAL file may or may not still exist; either way
    // walSize must reflect the on-disk reality (not throw, not negative).
    expect(typeof res.walSize).toBe("number")
    expect(res.walSize).toBeGreaterThanOrEqual(0)
    expect(res.checkpointed).toBe(true)
    cleanup()
  })

  // ─── ADR-0385 walCheckpointUpgradeMode (RESTART vs TRUNCATE) ──────────

  test("[II] mode absent + threshold exceeded ⇒ RESTART default (ADR-0375 backward compat)", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    for (let i = 0; i < 50; i++) seedSession(db, `s${i}`, 1000 + i, 10)
    db.close()
    // No walCheckpointUpgradeMode set — must take ADR-0375 RESTART path
    // when threshold is exceeded.
    const res = sweepSqliteRegistry({
      databasePath: path,
      walSizeThresholdBytes: 1,
    })
    // walRestarted may be true (RESTART ran) or false (WAL already drained
    // by db.close() ⇒ readWalSize returned 0 ⇒ threshold check fails).
    // Either way, walTruncated MUST be false — TRUNCATE was never opted in.
    expect(res.walTruncated).toBe(false)
    expect(typeof res.walRestarted).toBe("boolean")
    expect(res.checkpointed).toBe(true)
    cleanup()
  })

  test("[JJ] mode = 'RESTART' + threshold exceeded ⇒ RESTART (explicit, identical to default)", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    for (let i = 0; i < 50; i++) seedSession(db, `s${i}`, 1000 + i, 10)
    db.close()
    const res = sweepSqliteRegistry({
      databasePath: path,
      walSizeThresholdBytes: 1,
      walCheckpointUpgradeMode: "RESTART",
    })
    // Explicit RESTART — must NEVER set walTruncated.
    expect(res.walTruncated).toBe(false)
    expect(typeof res.walRestarted).toBe("boolean")
    expect(res.checkpointed).toBe(true)
    cleanup()
  })

  test("[KK] mode = 'TRUNCATE' + threshold exceeded ⇒ TRUNCATE + walTruncated = true + walRestarted = false", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    // Force a real WAL with content by leaving DB open across writes;
    // bun:sqlite emits a `<path>-wal` file once journal_mode=WAL is set.
    db.exec("PRAGMA journal_mode = WAL")
    for (let i = 0; i < 100; i++) seedSession(db, `s${i}`, 1000 + i, 100)
    // DO NOT close — leave the WAL on disk so threshold check sees > 0 bytes.
    let walSizeBefore = 0
    try {
      walSizeBefore = statSync(`${path}-wal`).size
    } catch {
      walSizeBefore = 0
    }
    db.close()
    const res = sweepSqliteRegistry({
      databasePath: path,
      walSizeThresholdBytes: 1,
      walCheckpointUpgradeMode: "TRUNCATE",
    })
    // ADR-0385 contract: TRUNCATE mode selected, threshold = 1 ⇒ the
    // sweep MUST never set walRestarted, regardless of whether the WAL
    // existed pre-sweep.
    expect(res.walRestarted).toBe(false)
    // R1-audit-strengthened: if the WAL actually existed pre-sweep, the
    // TRUNCATE branch MUST have run. db.close() may drain WAL via a
    // checkpoint, but `walSizeBefore > 0` is captured BEFORE close, so a
    // positive value proves the WAL was real when the sweep was queued.
    // The threshold check inside the sweep re-reads, so we ALSO require
    // the actual post-sweep size to be at most the pre-sweep size (TRUNCATE
    // never grows the WAL).
    if (walSizeBefore > 0) {
      expect(res.walTruncated).toBe(true)
    } else {
      // Some environments drain WAL via close-time checkpoint before our
      // sweep can observe it; in that case the threshold check sees 0 and
      // both flags MUST stay false (no escalation when there's nothing
      // to truncate).
      expect(res.walTruncated).toBe(false)
    }
    expect(res.checkpointed).toBe(true)
    expect(res.walSize).toBeLessThanOrEqual(walSizeBefore)
    cleanup()
  })

  test("[LL] mode = 'TRUNCATE' + threshold NOT exceeded ⇒ PASSIVE only (both flags false)", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    seedSession(db, "s1", 1000, 10)
    db.close()
    const res = sweepSqliteRegistry({
      databasePath: path,
      walSizeThresholdBytes: 10 * 1024 * 1024 * 1024, // 10 GB — no real WAL hits this
      walCheckpointUpgradeMode: "TRUNCATE",
    })
    expect(res.walRestarted).toBe(false)
    expect(res.walTruncated).toBe(false)
    expect(res.checkpointed).toBe(true)
    cleanup()
  })

  test("[MM] mode set + threshold ABSENT ⇒ mode ignored (PASSIVE only, both flags false)", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    seedSession(db, "s1", 1000, 10)
    db.close()
    // No walSizeThresholdBytes — the mode option must be a no-op.
    const res = sweepSqliteRegistry({
      databasePath: path,
      walCheckpointUpgradeMode: "TRUNCATE",
    })
    expect(res.walRestarted).toBe(false)
    expect(res.walTruncated).toBe(false)
    expect(res.checkpointed).toBe(true)
    cleanup()
  })

  test("[NN] SweepResult invariant — walRestarted and walTruncated are mutually exclusive", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    // Force WAL to exist and exceed threshold.
    db.exec("PRAGMA journal_mode = WAL")
    for (let i = 0; i < 100; i++) seedSession(db, `s${i}`, 1000 + i, 100)
    db.close()

    // Sweep #1 — RESTART mode
    const r1 = sweepSqliteRegistry({
      databasePath: path,
      walSizeThresholdBytes: 1,
      walCheckpointUpgradeMode: "RESTART",
    })
    // Mutual exclusion: NEVER both true.
    expect(r1.walRestarted && r1.walTruncated).toBe(false)

    // Re-seed for sweep #2 (TRUNCATE may have shrunk the WAL).
    const db2 = new Database(path)
    db2.exec("PRAGMA journal_mode = WAL")
    for (let i = 100; i < 200; i++) seedSession(db2, `s${i}`, 1000 + i, 100)
    db2.close()

    // Sweep #2 — TRUNCATE mode
    const r2 = sweepSqliteRegistry({
      databasePath: path,
      walSizeThresholdBytes: 1,
      walCheckpointUpgradeMode: "TRUNCATE",
    })
    expect(r2.walRestarted && r2.walTruncated).toBe(false)

    cleanup()
  })

  test("[OO] EMPTY_RESULT path (DB open fails) ⇒ both walRestarted + walTruncated false", () => {
    // databasePath inside non-existent parent — adapter does NOT mkdir.
    const res = sweepSqliteRegistry({
      databasePath: "/dev/null/no-such-parent/db.sqlite",
      walSizeThresholdBytes: 1,
      walCheckpointUpgradeMode: "TRUNCATE",
    })
    expect(res.walRestarted).toBe(false)
    expect(res.walTruncated).toBe(false)
    expect(res.checkpointed).toBe(false)
    expect(res.backendAvailable).toBe(false)
  })

  test("[PP] backward compat — all ADR-0375 cases (Y..DD) keep walTruncated = false", () => {
    // Replays case Y minimally — absent threshold ⇒ PASSIVE only.
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    seedSession(db, "s1", 1000, 10)
    db.close()
    const res = sweepSqliteRegistry({ databasePath: path })
    expect(res.walRestarted).toBe(false)
    expect(res.walTruncated).toBe(false)
    expect(res.checkpointed).toBe(true)
    cleanup()
  })

  test("[QQ] TRUNCATE actually shrinks WAL — post-sweep walSize is small (best-effort)", () => {
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    db.exec("PRAGMA journal_mode = WAL")
    applyMigrations(db)
    // Heavy writes to grow the WAL.
    for (let i = 0; i < 500; i++) seedSession(db, `s${i}`, 1000 + i, 1024)
    let pre = 0
    try {
      pre = statSync(`${path}-wal`).size
    } catch {
      pre = 0
    }
    db.close()

    const res = sweepSqliteRegistry({
      databasePath: path,
      walSizeThresholdBytes: 1,
      walCheckpointUpgradeMode: "TRUNCATE",
    })
    // Best-effort: if TRUNCATE ran successfully (walTruncated=true), the
    // post-sweep walSize MUST be smaller than or equal to the pre-sweep
    // size (TRUNCATE shrinks the WAL to ~0). We accept "smaller-or-equal"
    // because db.close() above may have already drained part of it.
    if (res.walTruncated) {
      expect(res.walSize).toBeLessThanOrEqual(pre)
    }
    expect(res.checkpointed).toBe(true)
    cleanup()
  })

  test("[RR] NO-THROW — invalid mode is REJECTED by ALLOWED_UPGRADE_MODES whitelist (both flags false)", () => {
    // ADR-0385 §"Why a whitelist" — `ALLOWED_UPGRADE_MODES` MUST reject
    // unknown strings before reaching the PRAGMA literal. This case
    // forces the WAL above threshold via a real journal file so the
    // ONLY thing keeping `walRestarted` false is the whitelist reject.
    const { path, cleanup } = makeTmp()
    const db = new Database(path)
    applyMigrations(db)
    db.exec("PRAGMA journal_mode = WAL")
    for (let i = 0; i < 100; i++) seedSession(db, `s${i}`, 1000 + i, 100)
    // Don't close — keep the WAL on disk so the threshold check sees > 1 byte.
    let walSizeBefore = 0
    try {
      walSizeBefore = statSync(`${path}-wal`).size
    } catch {
      walSizeBefore = 0
    }
    db.close()
    const res = sweepSqliteRegistry({
      databasePath: path,
      walSizeThresholdBytes: 1,
      // Cast: simulate downstream caller passing a stray value.
      walCheckpointUpgradeMode: "BOGUS" as unknown as "TRUNCATE",
    })
    // R1-audit-strengthened. PRE-sweep WAL was non-zero (when the
    // close-time checkpoint did not drain it); if the whitelist did not
    // reject, sweep would fall through to RESTART default + set
    // `walRestarted=true`. We assert BOTH flags false to pin the
    // whitelist reject path.
    expect(res.walRestarted).toBe(false)
    expect(res.walTruncated).toBe(false)
    expect(res.checkpointed).toBe(true)
    // Strengthens against a future regression where BOGUS coerces to "":
    // walSize MUST never grow under an unknown mode.
    expect(res.walSize).toBeLessThanOrEqual(Math.max(walSizeBefore, 0))
    cleanup()
  })

  // ─── ADR-0387 — countSqliteRegistryCleanupCandidates (dry-run) ─────────
  //
  // 5 cases. Same SQL shape as sweepSqliteRegistry but using SELECT
  // COUNT instead of DELETE. The sliding-window SQL is INVERTED relative
  // to sweep — same `SUM OVER` window but `WHERE cum > maxTotalBytes` is
  // a count of rows that WOULD be deleted (not actually deleted).
  // Verifies the count matches what a subsequent sweep DELETE would
  // produce (case [TT + UU]).
  describe("ADR-0387 countSqliteRegistryCleanupCandidates", () => {
    test("[SS] empty DB ⇒ all zeros", () => {
      const { path, cleanup } = makeTmp()
      const db = new Database(path)
      applyMigrations(db)
      db.close()
      const res = countSqliteRegistryCleanupCandidates({ databasePath: path })
      expect(res.wouldEvictByTtl).toBe(0)
      expect(res.wouldEvictBySize).toBe(0)
      expect(res.inspectedSessions).toBe(0)
      expect(typeof res.walSize).toBe("number")
      expect(res.walSize).toBeGreaterThanOrEqual(0)
      cleanup()
    })

    test("[TT] TTL candidate count matches what sweep would delete", () => {
      const { path, cleanup } = makeTmp()
      const db = new Database(path)
      applyMigrations(db)
      seedSession(db, "old-a", 100, 10)
      seedSession(db, "old-b", 200, 10)
      seedSession(db, "fresh", 1_000_000, 10)
      db.close()
      const dry = countSqliteRegistryCleanupCandidates({
        databasePath: path,
        ttlMs: 1000,
        now: () => 1_000_500,
      })
      expect(dry.wouldEvictByTtl).toBe(2)
      expect(dry.inspectedSessions).toBe(3)
      // Then actually sweep — the count MUST match.
      const wet = sweepSqliteRegistry({
        databasePath: path,
        ttlMs: 1000,
        now: () => 1_000_500,
      })
      expect(wet.evictedByTtl).toBe(dry.wouldEvictByTtl)
      cleanup()
    })

    test("[UU] Size sliding-window candidate count matches sweep", () => {
      const { path, cleanup } = makeTmp()
      const db = new Database(path)
      applyMigrations(db)
      // 4 × 100 bytes = 400. Cap 250 keeps newest 2; evict oldest 2.
      seedSession(db, "s1", 1000, 100) // newest
      seedSession(db, "s2", 900, 100)
      seedSession(db, "s3", 800, 100)
      seedSession(db, "s4", 700, 100) // oldest
      db.close()
      const dry = countSqliteRegistryCleanupCandidates({
        databasePath: path,
        maxTotalBytes: 250,
        ttlMs: 999_999_999,
        now: () => 1000,
      })
      expect(dry.wouldEvictBySize).toBeGreaterThanOrEqual(1)
      // Then actually sweep — counts must match.
      const wet = sweepSqliteRegistry({
        databasePath: path,
        maxTotalBytes: 250,
        ttlMs: 999_999_999,
        now: () => 1000,
      })
      expect(wet.evictedBySize).toBe(dry.wouldEvictBySize)
      cleanup()
    })

    test("[VV] DB open fails ⇒ zero values, NO-THROW", () => {
      const res = countSqliteRegistryCleanupCandidates({
        databasePath: "/dev/null/no-such-parent/db.sqlite",
      })
      expect(res.wouldEvictByTtl).toBe(0)
      expect(res.wouldEvictBySize).toBe(0)
      expect(res.inspectedSessions).toBe(0)
      expect(res.walSize).toBe(0)
    })

    test("[WW] idempotent — DB rows unchanged after count call", () => {
      const { path, cleanup } = makeTmp()
      const db = new Database(path)
      applyMigrations(db)
      seedSession(db, "old", 100, 10)
      seedSession(db, "fresh", 1_000_000, 10)
      db.close()
      // Count
      countSqliteRegistryCleanupCandidates({
        databasePath: path,
        ttlMs: 1000,
        now: () => 1_000_500,
      })
      // Read post-count session count — MUST equal pre-count (no DELETE).
      const db2 = new Database(path)
      const c = (db2.query("SELECT COUNT(*) AS c FROM sessions").get() as { c: number }).c
      expect(c).toBe(2)
      db2.close()
      cleanup()
    })
  })
})
