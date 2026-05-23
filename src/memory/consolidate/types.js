/**
 * ADR-0068 — Codex 2-Phase memory consolidator types (SOTA++ v2).
 *
 * SSOT for Phase 1 (per-thread distill) + Phase 2 (global consolidator).
 * No I/O, no clock, no LLM — just types + named errors. Ports are
 * dependency-injected so the consolidator pipeline is exercisable with
 * deterministic mocks in unit tests.
 *
 * Negative invariants (ADR-0068 §Negative-invariants):
 *   1. memory_mode defaults to 'disabled' — opt-in distill only.
 *   2. MEMORY.md size is bounded by `MEMORY_MAX_BYTES`; Phase 2 prompt is
 *      instructed to rolling-distill older entries on overflow.
 *   3. 3-file write is atomic via temp-dir + dir-rename OR `.git` commit.
 *   4. Prior MEMORY.md content is fed back to Phase 2 (user manual edits
 *      are preserved unless contradicted by new evidence).
 *   5. Rollout content is data, not instructions — Phase 2 prompt has the
 *      verbatim Codex defense; inject channel adds an untrusted wrapper.
 *   6. Threads below `MIN_TURN_THRESHOLD` turns are skipped.
 */
// ─── Named errors ──────────────────────────────────────────────────────────
// Every Phase 1/2 failure surface is a named class so callers can
// distinguish distill failures from write failures from tainted rollouts.
// No silent catch anywhere in the pipeline — these propagate.
export class Phase1DistillError extends Error {
    threadId;
    constructor(message, threadId) {
        super(`Phase 1 distill failed for thread '${threadId}': ${message}`);
        this.name = "Phase1DistillError";
        this.threadId = threadId;
    }
}
export class Phase2ConsolidateError extends Error {
    mode;
    constructor(message, mode) {
        super(`Phase 2 consolidate failed (${mode} mode): ${message}`);
        this.name = "Phase2ConsolidateError";
        this.mode = mode;
    }
}
export class MemoryWriteError extends Error {
    path;
    constructor(message, path) {
        super(`Memory write failed at '${path}': ${message}`);
        this.name = "MemoryWriteError";
        this.path = path;
    }
}
export class RolloutTaintedError extends Error {
    threadId;
    constructor(message, threadId) {
        super(`Rollout content tainted (skipped distill) for thread '${threadId}': ${message}`);
        this.name = "RolloutTaintedError";
        this.threadId = threadId;
    }
}
export class WatermarkConflictError extends Error {
    constructor(message) {
        super(`Watermark conflict: ${message}`);
        this.name = "WatermarkConflictError";
    }
}
