/**
 * Turn type enum + invariants (ADR-0030 — Mid-turn steering).
 *
 * A `TurnKind` labels the *intent shape* of one logical agent turn. The
 * default `main` kind is the ordinary ReAct turn (user-facing, accepts
 * mid-turn steering injection). The other three kinds are *internal* turns
 * the loop runs on its own behalf (review pass, compaction summarization,
 * standalone subagent task); each carries its own conversation slot and
 * MUST NOT accept arbitrary user injection mid-flight — doing so would
 * corrupt the contract that the kind establishes (review verdict purity,
 * summarizer determinism, subagent isolation).
 *
 * This module is pure: it owns the enum + the `isSteerable` truth table +
 * the `TurnHeader` constructor with deterministic invariant checks. It has
 * no IO, no LLM, no Date.now() — clocks are passed in by callers so the
 * decision is replay-safe.
 *
 * The header itself is the seam loop.ts will hold on every turn so the
 * steering module can decide acceptance optimistically against the active
 * turn id (see `src/agent/steering.ts`). The integration is deferred to a
 * follow-up PR per ADR-0030's "Integration seam" section; this slice ships
 * the pure module + unit tests only.
 */
/**
 * Kinds for which mid-turn user injection is forbidden. Encoded as an
 * explicit positive set (rather than the inverse) so a future kind without
 * an entry here defaults to *steerable* — that is the intended posture for
 * any new user-facing turn shape. Internal turns added later must opt IN to
 * this set by name.
 */
export const NON_STEERABLE_KINDS = new Set([
    "review",
    "compact",
    "standalone",
]);
/** True iff the kind accepts mid-turn user injection. Sole authority for
 *  the steerability question — `steering.ts` consults this predicate. */
export const isSteerable = (kind) => !NON_STEERABLE_KINDS.has(kind);
/**
 * Named error for `makeTurnHeader` invariant violations. Throws on
 * malformed inputs rather than returning a sentinel — `loop.ts` (the
 * caller) controls the inputs, so a thrown invariant is a programming
 * error that must surface loudly. No silent normalization.
 */
export class TurnHeaderInvalidError extends Error {
    field;
    constructor(field, detail) {
        super(`TurnHeaderInvalidError: ${field} — ${detail}`);
        this.name = "TurnHeaderInvalidError";
        this.field = field;
    }
}
/** Closed set of TurnKind literals — exposed for runtime exhaustiveness
 *  tests without `as const` gymnastics. */
export const ALL_TURN_KINDS = ["main", "review", "compact", "standalone"];
const isTurnKindLiteral = (value) => ALL_TURN_KINDS.includes(value);
/**
 * Construct a {@link TurnHeader}. Enforces:
 *   1. `turnId` is a non-empty string with no surrounding whitespace.
 *   2. `kind` is one of the four enum literals.
 *   3. `startedAt` is a finite non-negative integer (deterministic clock).
 *   4. `threadId` is a non-empty string.
 *
 * Any violation throws {@link TurnHeaderInvalidError}. The constructor
 * returns a fresh frozen-shape object so accidental mutation by callers is
 * a TypeScript error (the fields are `readonly` on the interface).
 */
export const makeTurnHeader = (args) => {
    const { turnId, kind, startedAt, threadId } = args;
    if (typeof turnId !== "string" || turnId.length === 0 || turnId.trim() !== turnId) {
        throw new TurnHeaderInvalidError("turnId", "must be a non-empty string with no surrounding whitespace");
    }
    if (typeof kind !== "string" || !isTurnKindLiteral(kind)) {
        throw new TurnHeaderInvalidError("kind", `must be one of ${ALL_TURN_KINDS.join(" | ")} (got ${String(kind)})`);
    }
    if (!Number.isFinite(startedAt) || !Number.isInteger(startedAt) || startedAt < 0) {
        throw new TurnHeaderInvalidError("startedAt", `must be a finite non-negative integer (got ${String(startedAt)})`);
    }
    if (typeof threadId !== "string" || threadId.length === 0) {
        throw new TurnHeaderInvalidError("threadId", "must be a non-empty string");
    }
    return { turnId, kind, startedAt, threadId };
};
