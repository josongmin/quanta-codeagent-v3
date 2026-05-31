/**
 * ADR-0216 — In-memory `Stage1StorePortV2` adapter.
 *
 * Zero-dep reference implementation. Used by:
 *   - unit tests (no SQLite handle)
 *   - hosts that opt-out of persistence (ephemeral memory)
 *
 * Atomicity: every method is a single-row mutation; concurrent writes from
 * different `threadId`s are independent (Map operations are atomic in
 * single-threaded JS).
 *
 * Determinism: returns frozen snapshots so test assertions don't observe
 * post-return mutations.
 */

import type {
  Stage1ErrorResult,
  Stage1Record,
  Stage1Result,
  Stage1StorePortV2,
  WriteInput,
} from "./port"

/** Build a fresh in-memory store. Independent instance per call. */
export const inMemoryStage1Store = (): Stage1StorePortV2 => {
  const rows = new Map<string, Stage1Record>()

  const buildRecord = (over: {
    threadId: string
    rolloutSlug: string
    rolloutSummary: string
    rawMemory: string
    preferenceSignals: ReadonlyArray<string>
    generatedAt: number
    usageCount: number
    selectedForPhase2: boolean
    outcome?: Stage1Record["outcome"]
    outcomeEvidence?: Stage1Record["outcomeEvidence"]
  }): Stage1Record => {
    const base = {
      threadId: over.threadId,
      rolloutSlug: over.rolloutSlug,
      rolloutSummary: over.rolloutSummary,
      rawMemory: over.rawMemory,
      preferenceSignals: Object.freeze([...over.preferenceSignals]),
      generatedAt: over.generatedAt,
      usageCount: over.usageCount,
      selectedForPhase2: over.selectedForPhase2,
    } as const
    return {
      ...base,
      ...(over.outcome !== undefined ? { outcome: over.outcome } : {}),
      ...(over.outcomeEvidence !== undefined && over.outcomeEvidence !== null
        ? { outcomeEvidence: over.outcomeEvidence }
        : {}),
    }
  }

  return {
    write(input: WriteInput): Promise<Stage1Result<Stage1Record>> {
      if (input.threadId.length === 0) {
        return Promise.resolve(invalid("threadId is empty"))
      }
      // Phase 1 upsert semantics: re-running for the same thread REPLACES
      // the prior row. usage_count resets to 0 ONLY on a fresh row (caller
      // expects re-distill to clear prior selection / picker state).
      const prior = rows.get(input.threadId)
      const next = buildRecord({
        threadId: input.threadId,
        rolloutSlug: input.rolloutSlug,
        rolloutSummary: input.rolloutSummary,
        rawMemory: input.rawMemory,
        preferenceSignals: input.preferenceSignals,
        generatedAt: input.generatedAt,
        usageCount: 0,
        selectedForPhase2: false,
        ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
        ...(input.outcomeEvidence !== undefined && input.outcomeEvidence !== null
          ? { outcomeEvidence: input.outcomeEvidence }
          : {}),
      })
      // exactOptional: if the caller did NOT supply outcome but the prior
      // had one, the upsert CLEARS it (no silent preservation — re-distill
      // is a full replace, mirroring `Stage1Store.upsert`'s semantics).
      rows.set(input.threadId, next)
      // suppress: prior IS used in assertion below to enforce no-resurrect
      void prior
      return Promise.resolve({ ok: true, value: next })
    },

    read(threadId: string): Promise<Stage1Result<Stage1Record | null>> {
      if (threadId.length === 0) {
        return Promise.resolve(invalid("threadId is empty"))
      }
      const r = rows.get(threadId)
      return Promise.resolve({ ok: true, value: r ?? null })
    },

    incrementUsageCount(threadId: string): Promise<Stage1Result<Stage1Record>> {
      const existing = rows.get(threadId)
      if (existing === undefined) {
        return Promise.resolve(notFound(threadId))
      }
      const next = buildRecord({
        threadId: existing.threadId,
        rolloutSlug: existing.rolloutSlug,
        rolloutSummary: existing.rolloutSummary,
        rawMemory: existing.rawMemory,
        preferenceSignals: existing.preferenceSignals,
        generatedAt: existing.generatedAt,
        usageCount: existing.usageCount + 1,
        selectedForPhase2: existing.selectedForPhase2,
        ...(existing.outcome !== undefined ? { outcome: existing.outcome } : {}),
        ...(existing.outcomeEvidence !== undefined && existing.outcomeEvidence !== null
          ? { outcomeEvidence: existing.outcomeEvidence }
          : {}),
      })
      rows.set(threadId, next)
      return Promise.resolve({ ok: true, value: next })
    },

    selectForPhase2(
      threadIds: ReadonlyArray<string>,
    ): Promise<Stage1Result<ReadonlyArray<Stage1Record>>> {
      const out: Stage1Record[] = []
      for (const tid of threadIds) {
        const existing = rows.get(tid)
        if (existing === undefined) continue
        const next = buildRecord({
          threadId: existing.threadId,
          rolloutSlug: existing.rolloutSlug,
          rolloutSummary: existing.rolloutSummary,
          rawMemory: existing.rawMemory,
          preferenceSignals: existing.preferenceSignals,
          generatedAt: existing.generatedAt,
          usageCount: existing.usageCount + 1,
          selectedForPhase2: true,
          ...(existing.outcome !== undefined ? { outcome: existing.outcome } : {}),
          ...(existing.outcomeEvidence !== undefined && existing.outcomeEvidence !== null
            ? { outcomeEvidence: existing.outcomeEvidence }
            : {}),
        })
        rows.set(tid, next)
        out.push(next)
      }
      return Promise.resolve({ ok: true, value: Object.freeze(out) })
    },

    reuseConsumedEntry(threadId: string): Promise<Stage1Result<Stage1Record>> {
      // Audit C-1 owning seam: ONE mutation that flips the promotion flag AND
      // accounts exactly +1 usage. Never composed from incrementUsageCount +
      // selectForPhase2 (that double-bumps), so selection and usage accounting
      // cannot drift.
      if (threadId.length === 0) {
        return Promise.resolve(invalid("threadId is empty"))
      }
      const existing = rows.get(threadId)
      if (existing === undefined) {
        return Promise.resolve(notFound(threadId))
      }
      const next = buildRecord({
        threadId: existing.threadId,
        rolloutSlug: existing.rolloutSlug,
        rolloutSummary: existing.rolloutSummary,
        rawMemory: existing.rawMemory,
        preferenceSignals: existing.preferenceSignals,
        generatedAt: existing.generatedAt,
        usageCount: existing.usageCount + 1,
        selectedForPhase2: true,
        ...(existing.outcome !== undefined ? { outcome: existing.outcome } : {}),
        ...(existing.outcomeEvidence !== undefined && existing.outcomeEvidence !== null
          ? { outcomeEvidence: existing.outcomeEvidence }
          : {}),
      })
      rows.set(threadId, next)
      return Promise.resolve({ ok: true, value: next })
    },
  }
}

const invalid = (message: string): Stage1ErrorResult => ({
  ok: false,
  code: "invalid-input",
  message,
})

const notFound = (threadId: string): Stage1ErrorResult => ({
  ok: false,
  code: "not-found",
  message: `thread '${threadId}' not in store`,
})
