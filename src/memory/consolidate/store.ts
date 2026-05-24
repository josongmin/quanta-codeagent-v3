/**
 * ADR-0068 Wave A — `Stage1Store` SQLite adapter.
 *
 * Implements {@link Stage1StorePort} on top of `bun:sqlite`. Owns the
 * `stage1_outputs` + `consolidate_watermark` tables created by
 * {@link ensureConsolidateSchema}; does NOT touch the legacy `memories`
 * table (recall/eviction is byte-identical — Wave A is additive).
 *
 * Patterns mirrored from `src/memory/adapters/sqlite.ts`:
 *   - prepared statements built once in the constructor and reused
 *     across calls (`bun:sqlite` caches plans per `Database.query()`).
 *   - rows shaped by raw `Row*` interfaces; mappers are pure functions
 *     so a JSON-roundtrip bug surfaces as a single test failure.
 *   - all writes propagate sqlite errors; no silent swallow.
 *
 * Concurrency: the underlying connection is `journal_mode = WAL`
 * (enabled by `SqliteStore` when both stores share one DB; standalone
 * test instances inherit `:memory:`'s in-process locking). Phase 1
 * upserts from disjoint `thread_id`s are independent rows and never
 * conflict.
 */
import type { Database } from "bun:sqlite"
import { ensureConsolidateSchema } from "./schema"
import {
  isMemoryOutcome,
  type MemoryOutcome,
  type Stage1Output,
  type Stage1StorePort,
  type WatermarkState,
} from "./types"

/** Raw row shape as stored on disk. INTEGER columns surface as `number`
 *  through `bun:sqlite`; NULL columns are `null`. */
interface Stage1Row {
  thread_id: string
  rollout_slug: string
  rollout_summary: string
  raw_memory: string
  preference_signals: string
  source_updated_at: number
  selected_for_phase2: number
  selected_for_phase2_source_updated_at: number | null
  last_usage: number | null
  usage_count: number
  /** ADR-0131 — NULL on legacy rows; one of {@link MEMORY_OUTCOMES} on new rows. */
  outcome: string | null
  /** ADR-0131 — NULL on legacy rows; free-form evidence anchor when present. */
  outcome_evidence: string | null
}

/** Minimal runtime shape-check for a `stage1_outputs` row before casting. Guards
 *  the critical columns `rowToStage1Output` dereferences: the string/number
 *  fields must be present + correctly typed, and the two nullable numerics must
 *  be `number | null`. Well-formed rows pass unchanged; malformed rows (corrupt
 *  / hand-edited DB) are rejected so callers can skip rather than emit garbage. */
const isStage1Row = (r: unknown): r is Stage1Row => {
  if (typeof r !== "object" || r === null) return false
  const o = r as Record<string, unknown>
  const isNumOrNull = (v: unknown): boolean => v === null || typeof v === "number"
  const isStrOrNull = (v: unknown): boolean => v === null || typeof v === "string"
  return (
    typeof o.thread_id === "string" &&
    typeof o.rollout_slug === "string" &&
    typeof o.rollout_summary === "string" &&
    typeof o.raw_memory === "string" &&
    typeof o.preference_signals === "string" &&
    typeof o.source_updated_at === "number" &&
    typeof o.selected_for_phase2 === "number" &&
    isNumOrNull(o.selected_for_phase2_source_updated_at) &&
    isNumOrNull(o.last_usage) &&
    typeof o.usage_count === "number" &&
    // ADR-0131 — outcome columns are nullable + string (additive migration).
    // `pragma_table_info` adds them on construction; rows written by older
    // code paths surface as NULL. Both NULL and any string pass the shape
    // check; semantic validation (string ∈ MEMORY_OUTCOMES) happens in the
    // row→domain mapper so a corrupt non-enum string raises loudly rather
    // than silently propagating an invalid `outcome` downstream.
    isStrOrNull(o.outcome) &&
    isStrOrNull(o.outcome_evidence)
  )
}

interface WatermarkRow {
  id: number
  last_success_at: number | null
  last_init_at: number | null
  last_consolidated_count: number
}

/** Safety cap on `fetchSince` to prevent an unbounded scan from
 *  exhausting memory on a large prod DB. Phase 2 caller passes its own
 *  smaller limit; this is the last-resort backstop when callers omit
 *  the param. Not in {@link constants.ts} because it is a Wave-A
 *  adapter-level concern, not a pipeline invariant. */
const DEFAULT_FETCH_LIMIT = 10_000

/** SQLite-backed {@link Stage1StorePort}. The same `Database` handle
 *  used for the `memories` table is reused here (single-connection
 *  per process — Codex parity). Schema is ensured idempotently in the
 *  constructor so first-run installs migrate transparently. */
export class Stage1Store implements Stage1StorePort {
  private readonly db: Database
  private readonly upsertStmt: ReturnType<Database["query"]>
  private readonly fetchAllStmt: ReturnType<Database["query"]>
  private readonly fetchSinceStmt: ReturnType<Database["query"]>
  private readonly countAllStmt: ReturnType<Database["query"]>
  private readonly countSinceStmt: ReturnType<Database["query"]>
  private readonly getWatermarkStmt: ReturnType<Database["query"]>
  private readonly setWatermarkStmt: ReturnType<Database["query"]>

  constructor(db: Database) {
    this.db = db
    ensureConsolidateSchema(this.db)

    this.upsertStmt = this.db.query(`
      INSERT INTO stage1_outputs (
        thread_id, rollout_slug, rollout_summary, raw_memory,
        preference_signals, source_updated_at, selected_for_phase2,
        selected_for_phase2_source_updated_at, last_usage, usage_count,
        outcome, outcome_evidence
      ) VALUES (
        $thread_id, $rollout_slug, $rollout_summary, $raw_memory,
        $preference_signals, $source_updated_at, $selected_for_phase2,
        $selected_for_phase2_source_updated_at, $last_usage, $usage_count,
        $outcome, $outcome_evidence
      )
      ON CONFLICT(thread_id) DO UPDATE SET
        rollout_slug = excluded.rollout_slug,
        rollout_summary = excluded.rollout_summary,
        raw_memory = excluded.raw_memory,
        preference_signals = excluded.preference_signals,
        source_updated_at = excluded.source_updated_at,
        selected_for_phase2 = excluded.selected_for_phase2,
        selected_for_phase2_source_updated_at = excluded.selected_for_phase2_source_updated_at,
        last_usage = excluded.last_usage,
        usage_count = excluded.usage_count,
        outcome = excluded.outcome,
        outcome_evidence = excluded.outcome_evidence
    `)

    // ORDER BY mirrors the (source_updated_at DESC, thread_id DESC)
    // covering index from schema.ts so both "all rows" and "rows since
    // watermark" share the same plan shape.
    this.fetchAllStmt = this.db.query(`
      SELECT * FROM stage1_outputs
      ORDER BY source_updated_at DESC, thread_id DESC
      LIMIT ?
    `)
    this.fetchSinceStmt = this.db.query(`
      SELECT * FROM stage1_outputs
      WHERE source_updated_at > ?
      ORDER BY source_updated_at DESC, thread_id DESC
      LIMIT ?
    `)
    this.countAllStmt = this.db.query("SELECT COUNT(*) AS n FROM stage1_outputs")
    this.countSinceStmt = this.db.query(
      "SELECT COUNT(*) AS n FROM stage1_outputs WHERE source_updated_at > ?",
    )
    this.getWatermarkStmt = this.db.query("SELECT * FROM consolidate_watermark WHERE id = 1")
    // id=1 is the singleton (CHECK constraint enforces); UPDATE is the
    // only allowed mutation path — INSERT happens once in
    // ensureConsolidateSchema's seed.
    this.setWatermarkStmt = this.db.query(`
      UPDATE consolidate_watermark SET
        last_success_at = $last_success_at,
        last_init_at = $last_init_at,
        last_consolidated_count = $last_consolidated_count
      WHERE id = 1
    `)
  }

  upsert(out: Stage1Output): Promise<void> {
    // ADR-0131 — outcome / outcomeEvidence are optional on the domain type
    // (Wave-W1 additive). Coerce `undefined` to `null` here so the SQLite
    // bind never sees an absent key (bun:sqlite throws BindError on missing
    // named params). The semantic "not declared" sentinel is NULL on disk;
    // the row→domain mapper restores it to `undefined` to match the type.
    const outcomeBind: string | null =
      out.outcome === undefined || out.outcome === null ? null : out.outcome
    const outcomeEvidenceBind: string | null =
      out.outcomeEvidence === undefined || out.outcomeEvidence === null ? null : out.outcomeEvidence
    this.upsertStmt.run({
      $thread_id: out.threadId,
      $rollout_slug: out.rolloutSlug,
      $rollout_summary: out.rolloutSummary,
      $raw_memory: out.rawMemory,
      // JSON-array TEXT — `preference_signals` is `ReadonlyArray<string>`
      // at the type level; `JSON.stringify` of a string-only array is
      // round-trip safe (no Date/undefined edge cases).
      $preference_signals: JSON.stringify(out.preferenceSignals),
      $source_updated_at: out.sourceUpdatedAt,
      $selected_for_phase2: out.selectedForPhase2 ? 1 : 0,
      $selected_for_phase2_source_updated_at: out.selectedForPhase2SourceUpdatedAt,
      $last_usage: out.lastUsage,
      $usage_count: out.usageCount,
      $outcome: outcomeBind,
      $outcome_evidence: outcomeEvidenceBind,
    })
    return Promise.resolve()
  }

  fetchSince(watermark: number | null, limit?: number): Promise<Stage1Output[]> {
    const cap = limit ?? DEFAULT_FETCH_LIMIT
    const rows =
      watermark === null
        ? (this.fetchAllStmt.all(cap) as unknown[])
        : (this.fetchSinceStmt.all(watermark, cap) as unknown[])
    // SQLite is dynamically typed: a hand-edited or partially-written DB can
    // yield rows whose columns are NULL or the wrong primitive. Validate the
    // shape before the cast and skip malformed rows with a warn (refuse/skip,
    // like rowToEntry's tolerant mapping) rather than emitting malformed
    // Stage1Output objects downstream.
    const out: Stage1Output[] = []
    for (const r of rows) {
      if (!isStage1Row(r)) {
        process.stderr.write("[quanta] consolidate: skipping malformed stage1_outputs row\n")
        continue
      }
      out.push(rowToStage1Output(r))
    }
    return Promise.resolve(out)
  }

  countSince(watermark: number | null): Promise<number> {
    const row =
      watermark === null
        ? (this.countAllStmt.get() as { n: number })
        : (this.countSinceStmt.get(watermark) as { n: number })
    return Promise.resolve(row.n)
  }

  getWatermark(): Promise<WatermarkState> {
    const row = this.getWatermarkStmt.get() as WatermarkRow | null
    if (row === null) {
      // Schema seed inserts id=1 on ensureConsolidateSchema; if a caller
      // somehow DELETEs the row out-of-band, surface it loudly rather
      // than fabricate defaults (would mask a corrupted DB).
      return Promise.reject(new Error("consolidate_watermark singleton row (id=1) is missing"))
    }
    return Promise.resolve({
      lastSuccessAt: row.last_success_at,
      lastInitAt: row.last_init_at,
      lastConsolidatedCount: row.last_consolidated_count,
    })
  }

  setWatermark(next: WatermarkState): Promise<void> {
    this.setWatermarkStmt.run({
      $last_success_at: next.lastSuccessAt,
      $last_init_at: next.lastInitAt,
      $last_consolidated_count: next.lastConsolidatedCount,
    })
    return Promise.resolve()
  }
}

/** Pure row → domain mapper. Parses the `preference_signals` JSON TEXT
 *  back to a string array; a structurally bad value would have been
 *  rejected by {@link Stage1Store.upsert}, so a parse throw here is a
 *  loud signal of out-of-band corruption (propagate, do not swallow). */
const rowToStage1Output = (row: Stage1Row): Stage1Output => {
  const parsed: unknown = JSON.parse(row.preference_signals)
  if (!Array.isArray(parsed)) {
    throw new Error(
      `stage1_outputs.preference_signals for thread '${row.thread_id}' is not a JSON array`,
    )
  }
  const signals: string[] = []
  for (const v of parsed) {
    if (typeof v !== "string") {
      throw new Error(
        `stage1_outputs.preference_signals for thread '${row.thread_id}' contains non-string element`,
      )
    }
    signals.push(v)
  }
  // ADR-0131 — semantically validate the outcome column. NULL = legacy row
  // (omit the field entirely so consumers see `undefined` and treat it as
  // "not declared", per the JSDoc contract on Stage1Output.outcome). A non-
  // NULL string MUST be a member of MEMORY_OUTCOMES; anything else is a
  // hand-edited / corrupt DB and we propagate loudly rather than silently
  // emit garbage (same "loud signal" principle as preference_signals JSON
  // parse below).
  const base: Stage1Output = {
    threadId: row.thread_id,
    rolloutSlug: row.rollout_slug,
    rolloutSummary: row.rollout_summary,
    rawMemory: row.raw_memory,
    preferenceSignals: signals,
    sourceUpdatedAt: row.source_updated_at,
    selectedForPhase2: row.selected_for_phase2 === 1,
    selectedForPhase2SourceUpdatedAt: row.selected_for_phase2_source_updated_at,
    lastUsage: row.last_usage,
    usageCount: row.usage_count,
  }
  if (row.outcome === null && row.outcome_evidence === null) return base
  // exactOptionalPropertyTypes: build a fresh object with the optional keys
  // ONLY when they were materially present on disk. `undefined` would be a
  // type error (and a semantic lie — the column was NULL, not "explicitly
  // undefined").
  let outcome: MemoryOutcome | undefined
  if (row.outcome !== null) {
    if (!isMemoryOutcome(row.outcome)) {
      throw new Error(
        `stage1_outputs.outcome for thread '${row.thread_id}' is not a valid MemoryOutcome: ${JSON.stringify(
          row.outcome,
        )}`,
      )
    }
    outcome = row.outcome
  }
  return {
    ...base,
    ...(outcome !== undefined ? { outcome } : {}),
    ...(row.outcome_evidence !== null ? { outcomeEvidence: row.outcome_evidence } : {}),
  }
}
