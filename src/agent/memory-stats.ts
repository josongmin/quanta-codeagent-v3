// Observability contract for the memory pipeline (locked seam).
//
// recallContext / persistSession stay side-effect-shaped (string|null / void)
// for caller compatibility; they additionally invoke an OPTIONAL `onStats`
// observer (see RecallDeps / PersistDeps) with one of these structs. The agent
// loop wires that observer to the AgentRecorder. Both the producer (memory
// orchestration) and the consumer (metrics recorder) code against THIS file
// independently — it is the disjoint contract, do not change it lightly.

/** One recall outcome, emitted once per {@link recallContext} call. */
export interface RecallStats {
  /** Entries actually folded into the "## Relevant memory" block. */
  recalled: number
  /** The query was embedded (semantic/hybrid) rather than lexical-only. */
  embedded: boolean
  /** The primary recall was empty and the SESSION_TAG fallback was used. */
  fellBack: boolean
}

/** One persist outcome, emitted once per {@link persistSession} call. */
export interface PersistStats {
  /** Distilled candidate records derived from the transcript. */
  distilled: number
  /** Consolidation: candidates saved as new entries. */
  inserted: number
  /** Consolidation: candidates merged into an existing entry. */
  merged: number
  /** Consolidation: candidates that superseded an outdated entry. */
  superseded: number
  /** Consolidation: candidates dropped as exact/near duplicates. */
  skipped: number
  /** Eviction sweep: entries whose importance was decayed. */
  decayed: number
  /** Eviction sweep: entries hard-deleted (over-cap / ancient-superseded). */
  deleted: number
}

/** Zeroed {@link PersistStats}; producers start here and increment. */
export const emptyPersistStats = (): PersistStats => ({
  distilled: 0,
  inserted: 0,
  merged: 0,
  superseded: 0,
  skipped: 0,
  decayed: 0,
  deleted: 0,
})
