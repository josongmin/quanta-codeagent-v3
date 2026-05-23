/**
 * Deterministic `LLMPort` that replays a recorded trajectory keyed by
 * `(run, turn)`. Used by the tier-0 smoke runner to drive `runAgent` without
 * touching a real provider.
 *
 *   - `run`  index = which user message (0-indexed). Caller advances it
 *            BETWEEN `runAgent` invocations via {@link nextRun}.
 *   - `turn` index = which LLM call within the current run (0-indexed).
 *            Advances automatically each time `stream()` is invoked.
 *
 * Exhausting the trajectory mid-run throws — a stale fixture must FAIL loud,
 * not silently truncate, so the operator goes and re-records.
 */
export class TrajectoryReplayLLM {
    model = "replay";
    /** Inputs captured per stream call — useful for invariants (e.g. system
     *  prompt stability across compaction). */
    inputs = [];
    byRunTurn;
    scenarioHint;
    run = 0;
    turn = 0;
    constructor(entries, scenarioHint = "<unknown>") {
        this.scenarioHint = scenarioHint;
        const buckets = new Map();
        for (const e of entries) {
            const key = `${e.run}:${e.turn}`;
            let bucket = buckets.get(key);
            if (bucket === undefined) {
                bucket = [];
                buckets.set(key, bucket);
            }
            bucket.push(e.event);
        }
        this.byRunTurn = buckets;
    }
    /** Advance to the next user-message bucket. Called by the runner after each
     *  `runAgent` returns and BEFORE feeding the next prompt. */
    nextRun() {
        this.run += 1;
        this.turn = 0;
    }
    async *stream(input) {
        this.inputs.push(input);
        const key = `${this.run}:${this.turn}`;
        const bucket = this.byRunTurn.get(key);
        if (bucket === undefined) {
            throw new Error(`smoke trajectory exhausted at run=${this.run} turn=${this.turn} ` +
                `for scenario "${this.scenarioHint}" ` +
                `(no events recorded for this bucket — re-record the fixture)`);
        }
        this.turn += 1;
        for (const ev of bucket)
            yield ev;
    }
}
