/**
 * ADR-0216 — SQLite `Stage1StorePortV2` adapter — wraps `@/memory#Stage1Store`.
 *
 * Why a wrapper (not a port re-export):
 *   The canonical `Stage1Store` class returns either resolved promises or
 *   throws — fine for the consolidator's existing call sites, but the
 *   agent-side composition root wants a uniform `Stage1Result` discriminated
 *   union so loop code doesn't need a try/catch per call. This adapter
 *   converts throws → `{ok:false, code:"io-failed"}` so the agent layer's
 *   NO-THROW invariant holds end-to-end.
 *
 * Default-OFF: the caller supplies an open `Database`. Importing this
 * module does not open a handle / create tables.
 *
 * Single owner of the schema: `Stage1Store`'s constructor calls
 * `ensureConsolidateSchema` so the table layout stays canonicalized in
 * one place (the `@/memory/consolidate/schema.ts` SSOT).
 */

import type { Database } from "bun:sqlite"
import { type MemoryOutcome, type Stage1Output, Stage1Store } from "@/memory"
import { errMessage } from "@/shared"
import type {
  Stage1ErrorResult,
  Stage1Record,
  Stage1Result,
  Stage1StorePortV2,
  WriteInput,
} from "./port"

const ioFail = (message: string): Stage1ErrorResult => ({
  ok: false,
  code: "io-failed",
  message,
})
const notFound = (threadId: string): Stage1ErrorResult => ({
  ok: false,
  code: "not-found",
  message: `thread '${threadId}' not in store`,
})
const invalid = (message: string): Stage1ErrorResult => ({
  ok: false,
  code: "invalid-input",
  message,
})

const writeToOutput = (input: WriteInput): Stage1Output => {
  const base = {
    threadId: input.threadId,
    rolloutSlug: input.rolloutSlug,
    rolloutSummary: input.rolloutSummary,
    rawMemory: input.rawMemory,
    preferenceSignals: input.preferenceSignals,
    sourceUpdatedAt: input.generatedAt,
    selectedForPhase2: false,
    selectedForPhase2SourceUpdatedAt: null,
    lastUsage: null,
    usageCount: 0,
  } as const
  return {
    ...base,
    ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
    ...(input.outcomeEvidence !== undefined && input.outcomeEvidence !== null
      ? { outcomeEvidence: input.outcomeEvidence }
      : {}),
  }
}

/**
 * Build a SQLite-backed Stage1 store adapter on top of an open `Database`.
 * The schema is migrated lazily on first construction (idempotent — running
 * twice over the same DB is a no-op).
 */
export const sqliteStage1Store = (db: Database): Stage1StorePortV2 => {
  // Construction of Stage1Store calls ensureConsolidateSchema (idempotent).
  let inner: Stage1Store
  try {
    inner = new Stage1Store(db)
  } catch (e) {
    // Surfacing this as an exception is correct — host bootstrap must fail
    // loudly when the DB is unusable.
    throw new Error(`sqliteStage1Store: schema migration failed: ${errMessage(e)}`)
  }
  // Prepared statements used by the read paths (the canonical class doesn't
  // expose a `getByThreadId`).
  const getOneStmt = db.query("SELECT * FROM stage1_outputs WHERE thread_id = ?")
  const selectMarkStmt = db.query(`
    UPDATE stage1_outputs SET
      selected_for_phase2 = 1,
      selected_for_phase2_source_updated_at = source_updated_at,
      usage_count = usage_count + 1,
      last_usage = $now
    WHERE thread_id = $thread_id
  `)
  const incrementStmt = db.query(`
    UPDATE stage1_outputs SET
      usage_count = usage_count + 1,
      last_usage = $now
    WHERE thread_id = $thread_id
  `)

  const readRowAsRecord = (threadId: string): Stage1Record | null => {
    const raw = getOneStmt.get(threadId) as
      | (Record<string, unknown> & {
          thread_id: string
          rollout_slug: string
          rollout_summary: string
          raw_memory: string
          preference_signals: string
          source_updated_at: number
          selected_for_phase2: number
          last_usage: number | null
          usage_count: number
          outcome: string | null
          outcome_evidence: string | null
        })
      | null
    if (raw === null) return null
    let signals: ReadonlyArray<string> = []
    try {
      const parsed: unknown = JSON.parse(raw.preference_signals)
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === "string")) {
        signals = parsed as string[]
      }
    } catch {
      // Leave empty; the row is still readable.
    }
    const base = {
      threadId: raw.thread_id,
      rolloutSlug: raw.rollout_slug,
      rolloutSummary: raw.rollout_summary,
      rawMemory: raw.raw_memory,
      preferenceSignals: signals,
      generatedAt: raw.source_updated_at,
      usageCount: raw.usage_count,
      selectedForPhase2: raw.selected_for_phase2 === 1,
    } as const
    const outcome: MemoryOutcome | undefined =
      raw.outcome === "partial" ||
      raw.outcome === "success" ||
      raw.outcome === "uncertain" ||
      raw.outcome === "fail"
        ? raw.outcome
        : undefined
    return {
      ...base,
      ...(outcome !== undefined ? { outcome } : {}),
      ...(raw.outcome_evidence !== null ? { outcomeEvidence: raw.outcome_evidence } : {}),
    }
  }

  return {
    async write(input: WriteInput): Promise<Stage1Result<Stage1Record>> {
      if (input.threadId.length === 0) return invalid("threadId is empty")
      try {
        await inner.upsert(writeToOutput(input))
      } catch (e) {
        return ioFail(`write failed: ${errMessage(e)}`)
      }
      const rec = readRowAsRecord(input.threadId)
      if (rec === null) return ioFail("write: row vanished after upsert")
      return { ok: true, value: rec }
    },

    read(threadId: string): Promise<Stage1Result<Stage1Record | null>> {
      if (threadId.length === 0) return Promise.resolve(invalid("threadId is empty"))
      try {
        return Promise.resolve({ ok: true, value: readRowAsRecord(threadId) })
      } catch (e) {
        return Promise.resolve(ioFail(`read failed: ${errMessage(e)}`))
      }
    },

    incrementUsageCount(threadId: string): Promise<Stage1Result<Stage1Record>> {
      if (threadId.length === 0) return Promise.resolve(invalid("threadId is empty"))
      const before = readRowAsRecord(threadId)
      if (before === null) return Promise.resolve(notFound(threadId))
      try {
        incrementStmt.run({ $thread_id: threadId, $now: Date.now() })
      } catch (e) {
        return Promise.resolve(ioFail(`incrementUsageCount failed: ${errMessage(e)}`))
      }
      const after = readRowAsRecord(threadId)
      if (after === null) return Promise.resolve(ioFail("row vanished after increment"))
      return Promise.resolve({ ok: true, value: after })
    },

    async selectForPhase2(
      threadIds: ReadonlyArray<string>,
    ): Promise<Stage1Result<ReadonlyArray<Stage1Record>>> {
      const out: Stage1Record[] = []
      const now = Date.now()
      for (const tid of threadIds) {
        const before = readRowAsRecord(tid)
        if (before === null) continue
        try {
          selectMarkStmt.run({ $thread_id: tid, $now: now })
        } catch (e) {
          return ioFail(`selectForPhase2 failed for '${tid}': ${errMessage(e)}`)
        }
        const after = readRowAsRecord(tid)
        if (after !== null) out.push(after)
      }
      return { ok: true, value: Object.freeze(out) }
    },
  }
}
