import { ensureConsolidateSchema } from "./schema";
/** Minimal runtime shape-check for a `stage1_outputs` row before casting. Guards
 *  the critical columns `rowToStage1Output` dereferences: the string/number
 *  fields must be present + correctly typed, and the two nullable numerics must
 *  be `number | null`. Well-formed rows pass unchanged; malformed rows (corrupt
 *  / hand-edited DB) are rejected so callers can skip rather than emit garbage. */
const isStage1Row = (r) => {
    if (typeof r !== "object" || r === null)
        return false;
    const o = r;
    const isNumOrNull = (v) => v === null || typeof v === "number";
    return (typeof o.thread_id === "string" &&
        typeof o.rollout_slug === "string" &&
        typeof o.rollout_summary === "string" &&
        typeof o.raw_memory === "string" &&
        typeof o.preference_signals === "string" &&
        typeof o.source_updated_at === "number" &&
        typeof o.selected_for_phase2 === "number" &&
        isNumOrNull(o.selected_for_phase2_source_updated_at) &&
        isNumOrNull(o.last_usage) &&
        typeof o.usage_count === "number");
};
/** Safety cap on `fetchSince` to prevent an unbounded scan from
 *  exhausting memory on a large prod DB. Phase 2 caller passes its own
 *  smaller limit; this is the last-resort backstop when callers omit
 *  the param. Not in {@link constants.ts} because it is a Wave-A
 *  adapter-level concern, not a pipeline invariant. */
const DEFAULT_FETCH_LIMIT = 10_000;
/** SQLite-backed {@link Stage1StorePort}. The same `Database` handle
 *  used for the `memories` table is reused here (single-connection
 *  per process — Codex parity). Schema is ensured idempotently in the
 *  constructor so first-run installs migrate transparently. */
export class Stage1Store {
    db;
    upsertStmt;
    fetchAllStmt;
    fetchSinceStmt;
    countAllStmt;
    countSinceStmt;
    getWatermarkStmt;
    setWatermarkStmt;
    constructor(db) {
        this.db = db;
        ensureConsolidateSchema(this.db);
        this.upsertStmt = this.db.query(`
      INSERT INTO stage1_outputs (
        thread_id, rollout_slug, rollout_summary, raw_memory,
        preference_signals, source_updated_at, selected_for_phase2,
        selected_for_phase2_source_updated_at, last_usage, usage_count
      ) VALUES (
        $thread_id, $rollout_slug, $rollout_summary, $raw_memory,
        $preference_signals, $source_updated_at, $selected_for_phase2,
        $selected_for_phase2_source_updated_at, $last_usage, $usage_count
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
        usage_count = excluded.usage_count
    `);
        // ORDER BY mirrors the (source_updated_at DESC, thread_id DESC)
        // covering index from schema.ts so both "all rows" and "rows since
        // watermark" share the same plan shape.
        this.fetchAllStmt = this.db.query(`
      SELECT * FROM stage1_outputs
      ORDER BY source_updated_at DESC, thread_id DESC
      LIMIT ?
    `);
        this.fetchSinceStmt = this.db.query(`
      SELECT * FROM stage1_outputs
      WHERE source_updated_at > ?
      ORDER BY source_updated_at DESC, thread_id DESC
      LIMIT ?
    `);
        this.countAllStmt = this.db.query("SELECT COUNT(*) AS n FROM stage1_outputs");
        this.countSinceStmt = this.db.query("SELECT COUNT(*) AS n FROM stage1_outputs WHERE source_updated_at > ?");
        this.getWatermarkStmt = this.db.query("SELECT * FROM consolidate_watermark WHERE id = 1");
        // id=1 is the singleton (CHECK constraint enforces); UPDATE is the
        // only allowed mutation path — INSERT happens once in
        // ensureConsolidateSchema's seed.
        this.setWatermarkStmt = this.db.query(`
      UPDATE consolidate_watermark SET
        last_success_at = $last_success_at,
        last_init_at = $last_init_at,
        last_consolidated_count = $last_consolidated_count
      WHERE id = 1
    `);
    }
    upsert(out) {
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
        });
        return Promise.resolve();
    }
    fetchSince(watermark, limit) {
        const cap = limit ?? DEFAULT_FETCH_LIMIT;
        const rows = watermark === null
            ? this.fetchAllStmt.all(cap)
            : this.fetchSinceStmt.all(watermark, cap);
        // SQLite is dynamically typed: a hand-edited or partially-written DB can
        // yield rows whose columns are NULL or the wrong primitive. Validate the
        // shape before the cast and skip malformed rows with a warn (refuse/skip,
        // like rowToEntry's tolerant mapping) rather than emitting malformed
        // Stage1Output objects downstream.
        const out = [];
        for (const r of rows) {
            if (!isStage1Row(r)) {
                process.stderr.write("[quanta] consolidate: skipping malformed stage1_outputs row\n");
                continue;
            }
            out.push(rowToStage1Output(r));
        }
        return Promise.resolve(out);
    }
    countSince(watermark) {
        const row = watermark === null
            ? this.countAllStmt.get()
            : this.countSinceStmt.get(watermark);
        return Promise.resolve(row.n);
    }
    getWatermark() {
        const row = this.getWatermarkStmt.get();
        if (row === null) {
            // Schema seed inserts id=1 on ensureConsolidateSchema; if a caller
            // somehow DELETEs the row out-of-band, surface it loudly rather
            // than fabricate defaults (would mask a corrupted DB).
            return Promise.reject(new Error("consolidate_watermark singleton row (id=1) is missing"));
        }
        return Promise.resolve({
            lastSuccessAt: row.last_success_at,
            lastInitAt: row.last_init_at,
            lastConsolidatedCount: row.last_consolidated_count,
        });
    }
    setWatermark(next) {
        this.setWatermarkStmt.run({
            $last_success_at: next.lastSuccessAt,
            $last_init_at: next.lastInitAt,
            $last_consolidated_count: next.lastConsolidatedCount,
        });
        return Promise.resolve();
    }
}
/** Pure row → domain mapper. Parses the `preference_signals` JSON TEXT
 *  back to a string array; a structurally bad value would have been
 *  rejected by {@link Stage1Store.upsert}, so a parse throw here is a
 *  loud signal of out-of-band corruption (propagate, do not swallow). */
const rowToStage1Output = (row) => {
    const parsed = JSON.parse(row.preference_signals);
    if (!Array.isArray(parsed)) {
        throw new Error(`stage1_outputs.preference_signals for thread '${row.thread_id}' is not a JSON array`);
    }
    const signals = [];
    for (const v of parsed) {
        if (typeof v !== "string") {
            throw new Error(`stage1_outputs.preference_signals for thread '${row.thread_id}' contains non-string element`);
        }
        signals.push(v);
    }
    return {
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
    };
};
