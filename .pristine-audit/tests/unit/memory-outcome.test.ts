/**
 * ADR-0131 Phase D — outcome enum + SQLite migration + promotion-fail guard.
 *
 * Covers:
 *   - 4-state enum membership + frequency-ordered tuple
 *   - isMemoryOutcome guard at boundaries (string / non-string / random objects)
 *   - Stage1Output backward compat: legacy rows (no outcome columns) still round-trip
 *   - Migration idempotency (ensureConsolidateSchema called twice over the same DB)
 *   - outcome='fail' is rejected by selectForPhase2Promotion regardless of score
 */

import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import {
  ensureConsolidateSchema,
  isMemoryOutcome,
  MEMORY_OUTCOMES,
  Stage1Store,
  selectForPhase2Promotion,
} from "../../src/memory/consolidate"
import type { MemoryOutcome, Stage1Output } from "../../src/memory/consolidate/types"

const baseOutput = (over: Partial<Stage1Output> = {}): Stage1Output => ({
  threadId: "thr-base",
  rolloutSlug: "20260524-120000-test",
  rolloutSummary: "x",
  rawMemory: "y",
  preferenceSignals: [],
  sourceUpdatedAt: 1_000_000,
  selectedForPhase2: false,
  selectedForPhase2SourceUpdatedAt: null,
  lastUsage: null,
  usageCount: 0,
  ...over,
})

describe("ADR-0131 — MemoryOutcome enum membership", () => {
  test("MEMORY_OUTCOMES tuple is exactly the 4 expected values", () => {
    expect(MEMORY_OUTCOMES).toEqual(["partial", "success", "uncertain", "fail"])
  })

  test("MEMORY_OUTCOMES order is frequency-DESC (partial first, fail last)", () => {
    // Codex production distribution: partial 75% > success 15% > uncertain 10% > fail 1%
    expect(MEMORY_OUTCOMES[0]).toBe("partial")
    expect(MEMORY_OUTCOMES[MEMORY_OUTCOMES.length - 1]).toBe("fail")
  })

  test("isMemoryOutcome accepts every member of MEMORY_OUTCOMES", () => {
    for (const v of MEMORY_OUTCOMES) {
      expect(isMemoryOutcome(v)).toBe(true)
    }
  })

  test("isMemoryOutcome rejects unrelated strings", () => {
    expect(isMemoryOutcome("done")).toBe(false)
    expect(isMemoryOutcome("PARTIAL")).toBe(false) // case-sensitive
    expect(isMemoryOutcome("")).toBe(false)
    expect(isMemoryOutcome("success ")).toBe(false) // trailing whitespace
  })

  test("isMemoryOutcome rejects non-string types (object / null / undefined / number)", () => {
    expect(isMemoryOutcome(null)).toBe(false)
    expect(isMemoryOutcome(undefined)).toBe(false)
    expect(isMemoryOutcome(42)).toBe(false)
    expect(isMemoryOutcome({ kind: "partial" })).toBe(false)
    expect(isMemoryOutcome(["partial"])).toBe(false)
  })
})

describe("ADR-0131 — Stage1Output backward compatibility", () => {
  test("Stage1Output without outcome roundtrips unchanged", async () => {
    const store = new Stage1Store(new Database(":memory:"))
    const out = baseOutput({ threadId: "thr-legacy" })
    expect(out.outcome).toBeUndefined()
    expect(out.outcomeEvidence).toBeUndefined()
    await store.upsert(out)
    const rows = await store.fetchSince(null)
    expect(rows).toHaveLength(1)
    const r = rows[0]!
    expect(r.threadId).toBe("thr-legacy")
    // The optional keys MUST be absent (not `undefined`) to match
    // exactOptionalPropertyTypes — Object.hasOwn is the precise check.
    expect(Object.hasOwn(r, "outcome")).toBe(false)
    expect(Object.hasOwn(r, "outcomeEvidence")).toBe(false)
  })

  test("Stage1Output with outcome='partial' + evidence roundtrips", async () => {
    const store = new Stage1Store(new Database(":memory:"))
    await store.upsert(
      baseOutput({
        threadId: "thr-partial",
        outcome: "partial",
        outcomeEvidence: "src/foo.ts:42",
      }),
    )
    const r = (await store.fetchSince(null))[0]!
    expect(r.outcome).toBe("partial")
    expect(r.outcomeEvidence).toBe("src/foo.ts:42")
  })

  test("Stage1Output with outcome='success' (no evidence) roundtrips with null evidence", async () => {
    const store = new Stage1Store(new Database(":memory:"))
    await store.upsert(
      baseOutput({
        threadId: "thr-success",
        outcome: "success",
        outcomeEvidence: null,
      }),
    )
    const r = (await store.fetchSince(null))[0]!
    expect(r.outcome).toBe("success")
    // null evidence column → absent key on the domain object (mapper drops nulls).
    expect(Object.hasOwn(r, "outcomeEvidence")).toBe(false)
  })

  test("Stage1Output with all 4 outcomes round-trip independently", async () => {
    const store = new Stage1Store(new Database(":memory:"))
    for (const oc of MEMORY_OUTCOMES) {
      await store.upsert(
        baseOutput({
          threadId: `thr-${oc}`,
          outcome: oc,
          outcomeEvidence: `evidence-${oc}`,
        }),
      )
    }
    const rows = await store.fetchSince(null)
    // 4 unique threadIds → 4 rows
    expect(rows).toHaveLength(4)
    const byOutcome = new Map(rows.map((r) => [r.outcome, r]))
    for (const oc of MEMORY_OUTCOMES) {
      const got = byOutcome.get(oc)
      expect(got).toBeDefined()
      expect(got!.outcomeEvidence).toBe(`evidence-${oc}`)
    }
  })

  test("upsert REPLACE preserves outcome change across re-distill", async () => {
    const store = new Stage1Store(new Database(":memory:"))
    await store.upsert(
      baseOutput({ threadId: "thr-upd", outcome: "partial", outcomeEvidence: null }),
    )
    await store.upsert(
      baseOutput({ threadId: "thr-upd", outcome: "success", outcomeEvidence: "src/a.ts:1" }),
    )
    const r = (await store.fetchSince(null))[0]!
    expect(r.outcome).toBe("success")
    expect(r.outcomeEvidence).toBe("src/a.ts:1")
  })

  test("upsert REPLACE can clear a previously-set outcome (undefined → NULL)", async () => {
    const store = new Stage1Store(new Database(":memory:"))
    await store.upsert(
      baseOutput({ threadId: "thr-clr", outcome: "success", outcomeEvidence: "src/a.ts:1" }),
    )
    // Re-upsert without outcome (legacy-shape path).
    await store.upsert(baseOutput({ threadId: "thr-clr" }))
    const r = (await store.fetchSince(null))[0]!
    expect(Object.hasOwn(r, "outcome")).toBe(false)
    expect(Object.hasOwn(r, "outcomeEvidence")).toBe(false)
  })
})

describe("ADR-0131 — schema migration idempotency", () => {
  test("ensureConsolidateSchema run twice over same DB does not throw", () => {
    const db = new Database(":memory:")
    ensureConsolidateSchema(db)
    expect(() => ensureConsolidateSchema(db)).not.toThrow()
  })

  test("ensureConsolidateSchema migrates a pre-existing legacy table (no outcome columns)", () => {
    const db = new Database(":memory:")
    // Simulate a pre-ADR-0131 DB: create the table WITHOUT outcome columns.
    db.exec(`
      CREATE TABLE stage1_outputs (
        thread_id                                   TEXT    PRIMARY KEY,
        rollout_slug                                TEXT    NOT NULL,
        rollout_summary                             TEXT    NOT NULL,
        raw_memory                                  TEXT    NOT NULL,
        preference_signals                          TEXT    NOT NULL,
        source_updated_at                           INTEGER NOT NULL,
        selected_for_phase2                         INTEGER NOT NULL DEFAULT 0,
        selected_for_phase2_source_updated_at       INTEGER,
        last_usage                                  INTEGER,
        usage_count                                 INTEGER NOT NULL DEFAULT 0
      )
    `)
    db.exec(`
      CREATE TABLE consolidate_watermark (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        last_success_at INTEGER, last_init_at INTEGER, last_consolidated_count INTEGER NOT NULL DEFAULT 0
      )
    `)
    db.exec(
      "INSERT OR IGNORE INTO consolidate_watermark (id, last_success_at, last_init_at, last_consolidated_count) VALUES (1, NULL, NULL, 0)",
    )
    // Migration should add the two columns without complaint.
    expect(() => ensureConsolidateSchema(db)).not.toThrow()
    // And the columns are now present (table_info reports them).
    const cols = db.query("SELECT name FROM pragma_table_info('stage1_outputs')").all() as {
      name: string
    }[]
    const names = cols.map((c) => c.name)
    expect(names).toContain("outcome")
    expect(names).toContain("outcome_evidence")
  })

  test("ensureConsolidateSchema creates the outcome index", () => {
    const db = new Database(":memory:")
    ensureConsolidateSchema(db)
    const idx = db
      .query("SELECT name FROM sqlite_master WHERE type='index' AND name=?")
      .get("idx_stage1_outputs_outcome") as { name: string } | null
    expect(idx).not.toBeNull()
    expect(idx!.name).toBe("idx_stage1_outputs_outcome")
  })

  test("migration on already-migrated DB does not duplicate the index or columns", () => {
    const db = new Database(":memory:")
    ensureConsolidateSchema(db)
    ensureConsolidateSchema(db)
    ensureConsolidateSchema(db)
    const cols = db
      .query(
        "SELECT COUNT(*) AS n FROM pragma_table_info('stage1_outputs') WHERE name IN ('outcome','outcome_evidence')",
      )
      .get() as { n: number }
    expect(cols.n).toBe(2)
  })
})

describe("ADR-0131 — outcome='fail' is never promoted to Phase 2", () => {
  test("a single 'fail' entry produces zero promotions even with sampleRate=1", () => {
    const entries: Stage1Output[] = [
      baseOutput({
        threadId: "thr-fail",
        outcome: "fail",
        outcomeEvidence: "src/x.ts:1",
        preferenceSignals: ["pref"],
        sourceUpdatedAt: 9_999_999,
      }),
    ]
    expect(selectForPhase2Promotion(entries, { sampleRate: 1 })).toEqual([])
  })

  test("mixed pool: a high-score 'fail' is excluded even when other outcomes are promoted", () => {
    const entries: Stage1Output[] = [
      // Strongest-possible 'fail' (would score 3) — must be excluded.
      baseOutput({
        threadId: "thr-strong-fail",
        outcome: "fail",
        outcomeEvidence: "src/x.ts:1",
        preferenceSignals: ["pref"],
        sourceUpdatedAt: 10_000_000,
      }),
      // Lower-score 'partial' — score 1.
      baseOutput({
        threadId: "thr-partial",
        outcome: "partial",
        preferenceSignals: ["pref"],
        sourceUpdatedAt: 9_000_000,
      }),
    ]
    const out = selectForPhase2Promotion(entries, { sampleRate: 1 })
    const ids = out.map((e) => e.threadId)
    expect(ids).not.toContain("thr-strong-fail")
    expect(ids).toContain("thr-partial")
  })

  test("a pool of ONLY 'fail' entries promotes nothing regardless of sampleRate", () => {
    const entries: Stage1Output[] = []
    for (let i = 0; i < 20; i++) {
      entries.push(
        baseOutput({
          threadId: `thr-${i}`,
          outcome: "fail" as MemoryOutcome,
          outcomeEvidence: "src/x.ts:1",
          preferenceSignals: ["pref"],
          sourceUpdatedAt: i,
        }),
      )
    }
    expect(selectForPhase2Promotion(entries, { sampleRate: 1 })).toEqual([])
    expect(selectForPhase2Promotion(entries, { sampleRate: 0.1 })).toEqual([])
    expect(selectForPhase2Promotion(entries)).toEqual([])
  })
})
