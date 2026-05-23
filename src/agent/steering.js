/**
 * Mid-turn steering decision module (ADR-0030).
 *
 * Models Codex's `core-skills/src/injection.rs` shape: the host receives a
 * user message *while a turn is in flight* and decides whether to inject it
 * into the conversation (so the model sees it on the NEXT step within the
 * same turn) or to reject it with a closed-set reason. The injection itself
 * is performed by `loop.ts` — this module is the pure decision boundary.
 *
 * Properties enforced here (no fallbacks, no silent normalization):
 *
 *   1. **Optimistic concurrency** — `request.expectedTurnId` must equal the
 *      active turn's id. A mismatch yields the explicit
 *      `expected_turn_mismatch` rejection (Codex's race-protection contract).
 *   2. **Steerability** — `review` / `compact` / `standalone` turns are
 *      non-steerable per ADR-0030. Each maps to a distinct rejection reason
 *      so observability can tell the surface "which internal turn refused
 *      you" without inferring it.
 *   3. **Input invariants** — empty and oversized inputs are rejected with
 *      `empty_input` and `input_too_large`; non-string / control-character
 *      inputs throw `SteerInputInvalidError` so the caller (CLI/Web/Tauri)
 *      learns about a *programming* bug (vs. a *policy* rejection).
 *   4. **Interrupted state** — once the turn is interrupted (user cancel /
 *      provider abort), steer becomes a no-op with reason `interrupted`.
 *   5. **No active turn** — between turns there is nothing to steer into;
 *      reject with `no_active_turn`.
 *
 * The module is pure: it does not write into the conversation; it returns a
 * `SteerOutcome` discriminated union that the caller pushes onto the
 * working-memory user-message slot when accepted. Clocks are caller-supplied
 * (deterministic, replay-safe).
 */
import { ALL_REJECTION_REASONS } from "./steer-reasons";
import { isSteerable, NON_STEERABLE_KINDS } from "./turn-kind";
// Re-exported so the historical `@/agent/steering` surface is unchanged; the
// definitions live in `./steer-reasons` to avoid an evaluation-time import
// cycle with `./conversation-action` (which reuses the reason set).
export { ALL_REJECTION_REASONS };
/**
 * Named error for programming-level invariant violations. Used when the
 * SURFACE has handed us a clearly malformed `request`/`config` (non-string
 * input, NaN timestamp, etc.) — that is a bug in the caller's wiring, not a
 * user-facing rejection.
 *
 * Per project rule (no silent catch, no sentinels), the steer entry point
 * THROWS this rather than synthesizing a fake `rejected` outcome.
 */
export class SteerInputInvalidError extends Error {
    field;
    constructor(field, detail) {
        super(`SteerInputInvalidError: ${field} — ${detail}`);
        this.name = "SteerInputInvalidError";
        this.field = field;
    }
}
/** Lazily-constructed encoder; module-scope so we don't allocate per call. */
const UTF8_ENCODER = new TextEncoder();
/**
 * UTF-8 byte length of a string. Deterministic (no estimation, no per-char
 * heuristic). Used both for the `input_too_large` check and for tests that
 * want to encode boundary-of-acceptance fixtures.
 */
export const utf8ByteLength = (s) => {
    if (typeof s !== "string") {
        throw new SteerInputInvalidError("input", `expected string (got ${typeof s})`);
    }
    return UTF8_ENCODER.encode(s).byteLength;
};
/** Map a non-steerable TurnKind to its rejection reason. Internal — the
 *  enum-level exhaustiveness guard catches any future kind added without
 *  an explicit reason mapping. */
const reasonForNonSteerable = (kind) => {
    switch (kind) {
        case "review":
            return "non_steerable_review";
        case "compact":
            return "non_steerable_compact";
        case "standalone":
            return "non_steerable_standalone";
        case "main": {
            // Programming error — `main` is steerable; reasonForNonSteerable
            // must never be called on it. Surface loudly rather than silently
            // emit a wrong rejection reason.
            throw new SteerInputInvalidError("kind", `reasonForNonSteerable invoked for steerable kind "main"`);
        }
        default: {
            const _exhaustive = kind;
            throw new SteerInputInvalidError("kind", `unhandled TurnKind: ${String(_exhaustive)}`);
        }
    }
};
/** Validate `request` shape up-front. Programming-level failures throw
 *  {@link SteerInputInvalidError}; policy-level failures are reported via
 *  the outcome (handled inside {@link steer}). */
const assertRequestShape = (request) => {
    if (typeof request.expectedTurnId !== "string" || request.expectedTurnId.length === 0) {
        throw new SteerInputInvalidError("expectedTurnId", "must be a non-empty string");
    }
    if (typeof request.input !== "string") {
        throw new SteerInputInvalidError("input", `must be a string (got ${typeof request.input})`);
    }
    if (!Number.isFinite(request.submittedAt) ||
        !Number.isInteger(request.submittedAt) ||
        request.submittedAt < 0) {
        throw new SteerInputInvalidError("submittedAt", `must be a finite non-negative integer (got ${String(request.submittedAt)})`);
    }
};
/** Validate `config` shape. Same throwing semantics as `assertRequestShape`. */
const assertConfigShape = (config) => {
    if (!Number.isFinite(config.maxInputBytes) ||
        !Number.isInteger(config.maxInputBytes) ||
        config.maxInputBytes <= 0) {
        throw new SteerInputInvalidError("maxInputBytes", `must be a finite positive integer (got ${String(config.maxInputBytes)})`);
    }
};
/** Build a `rejected` outcome with the caller's clock. */
const rejected = (reason, rejectedAt) => ({
    kind: "rejected",
    reason,
    rejectedAt,
});
/**
 * Decide whether to inject `request` into the active turn. Pure function;
 * the caller is responsible for the side effects (working-memory push,
 * trajectory emit, etc.).
 *
 * Decision order (each step short-circuits):
 *   1. interrupted state          ⇒ `interrupted`
 *   2. no active turn             ⇒ `no_active_turn`
 *   3. expectedTurnId mismatch    ⇒ `expected_turn_mismatch`
 *   4. non-steerable kind         ⇒ `non_steerable_{review,compact,standalone}`
 *   5. empty input (after trim)   ⇒ `empty_input`
 *   6. oversized input            ⇒ `input_too_large`
 *   7. otherwise                  ⇒ `accepted` with a fresh
 *                                   {@link SteerInjection}.
 *
 * The ordering is deterministic and documented: a request that violates
 * multiple invariants returns the FIRST violation in the list above, so the
 * trajectory is reproducible across replays.
 */
export const steer = (request, state, config) => {
    assertRequestShape(request);
    assertConfigShape(config);
    if (state.isInterrupted) {
        return rejected("interrupted", request.submittedAt);
    }
    const active = state.currentTurn;
    if (active === null) {
        return rejected("no_active_turn", request.submittedAt);
    }
    if (active.turnId !== request.expectedTurnId) {
        return rejected("expected_turn_mismatch", request.submittedAt);
    }
    if (NON_STEERABLE_KINDS.has(active.kind)) {
        return rejected(reasonForNonSteerable(active.kind), request.submittedAt);
    }
    // Defensive: if a future kind is added to the enum without being added
    // to `NON_STEERABLE_KINDS` it falls through here as steerable — the
    // intended default per ADR-0030.
    if (!isSteerable(active.kind)) {
        // Unreachable today (only `main` is steerable) but kept as a guard
        // against the enum/predicate drifting silently in a future refactor.
        return rejected(reasonForNonSteerable(active.kind), request.submittedAt);
    }
    if (request.input.trim().length === 0) {
        return rejected("empty_input", request.submittedAt);
    }
    const bytes = utf8ByteLength(request.input);
    if (bytes > config.maxInputBytes) {
        return rejected("input_too_large", request.submittedAt);
    }
    const injection = {
        role: "user",
        content: request.input,
        injectedAt: request.submittedAt,
        injectedDuringTurnId: active.turnId,
    };
    return { kind: "accepted", injection };
};
// ─────────────────────────────────────────────────────────────────────────
// Typed ConversationAction layer (ADR-0071) — re-exported from its own module.
//
// The conversation-action decision engine (`decideAction()` + its types) was
// split into `./conversation-action.ts` (#7): it is a disjoint subsystem that
// only DEPENDS on the steering primitives above. These re-exports preserve the
// historical `@/agent/steering` import surface so existing consumers (tests,
// the loop) import the SAME symbols from the SAME path unchanged.
// ─────────────────────────────────────────────────────────────────────────
export { ACTION_PREPEND_SEPARATOR, ALL_ACTION_KINDS, ALL_ACTION_REJECTION_REASONS, decideAction, } from "./conversation-action";
