// Observability contract for the memory pipeline (locked seam).
//
// recallContext / persistSession stay side-effect-shaped (string|null / void)
// for caller compatibility; they additionally invoke an OPTIONAL `onStats`
// observer (see RecallDeps / PersistDeps) with one of these structs. The agent
// loop wires that observer to the AgentRecorder. Both the producer (memory
// orchestration) and the consumer (metrics recorder) code against THIS file
// independently — it is the disjoint contract, do not change it lightly.
/** Zeroed {@link PersistStats}; producers start here and increment. */
export const emptyPersistStats = () => ({
    distilled: 0,
    inserted: 0,
    merged: 0,
    superseded: 0,
    skipped: 0,
    decayed: 0,
    deleted: 0,
});
