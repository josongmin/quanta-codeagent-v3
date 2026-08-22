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
 * Discrete intent labels for a logical agent turn. The set is closed —
 * downstream consumers (steering, observability, trajectory replay) rely on
 * exhaustive switch coverage. Adding a member is a deliberate ADR-grade
 * change (must update `NON_STEERABLE_KINDS` and `steering.ts` rejection
 * reasons together).
 */
export type TurnKind = "main" | "review" | "compact" | "standalone"

/**
 * Kinds for which mid-turn user injection is forbidden. Encoded as an
 * explicit positive set (rather than the inverse) so a future kind without
 * an entry here defaults to *steerable* — that is the intended posture for
 * any new user-facing turn shape. Internal turns added later must opt IN to
 * this set by name.
 */
export const NON_STEERABLE_KINDS: ReadonlySet<TurnKind> = new Set<TurnKind>([
  "review",
  "compact",
  "standalone",
])

/** True iff the kind accepts mid-turn user injection. Sole authority for
 *  the steerability question — `steering.ts` consults this predicate. */
export const isSteerable = (kind: TurnKind): boolean => !NON_STEERABLE_KINDS.has(kind)

/**
 * Per-turn header. Built by `loop.ts` at the top of every turn and held
 * for the turn's lifetime. The steering module reads `turnId` for its
 * optimistic-concurrency check and `kind` for the steerability gate.
 *
 * Fields are minimal on purpose — anything turn-correlated that does not
 * affect a steering decision (recorder spans, hook ids, recovery counters)
 * lives elsewhere so this header stays a stable contract.
 */
export interface TurnHeader {
  /** Stable, unique-per-turn identifier (caller-assigned ULID/UUID). The
   *  steering module compares it to `SteerRequest.expectedTurnId`. */
  readonly turnId: string
  /** Discrete kind label — see {@link TurnKind}. */
  readonly kind: TurnKind
  /** Wall-clock milliseconds at turn start (caller-supplied; the module
   *  itself never calls `Date.now()` so trajectory replay is deterministic). */
  readonly startedAt: number
  /** Owning thread/session id — carried so multi-thread harnesses can
   *  attribute steer requests without re-deriving from caller state. */
  readonly threadId: string
}

/**
 * Named error for `makeTurnHeader` invariant violations. Throws on
 * malformed inputs rather than returning a sentinel — `loop.ts` (the
 * caller) controls the inputs, so a thrown invariant is a programming
 * error that must surface loudly. No silent normalization.
 */
export class TurnHeaderInvalidError extends Error {
  readonly field: string
  constructor(field: string, detail: string) {
    super(`TurnHeaderInvalidError: ${field} — ${detail}`)
    this.name = "TurnHeaderInvalidError"
    this.field = field
  }
}

/** Closed set of TurnKind literals — exposed for runtime exhaustiveness
 *  tests without `as const` gymnastics. */
export const ALL_TURN_KINDS = [
  "main",
  "review",
  "compact",
  "standalone",
] as const satisfies readonly TurnKind[]
// Drift guard: `as const satisfies` = array⊆union; Assert = union⊆array. New
// TurnKind missing from the tuple → build error (was: a widened annotation made
// any reverse check trivially true).
type _AssertTurn<T extends true> = T
export type _TurnKindsDriftGuard = _AssertTurn<
  TurnKind extends (typeof ALL_TURN_KINDS)[number] ? true : false
>

const isTurnKindLiteral = (value: string): value is TurnKind =>
  (ALL_TURN_KINDS as ReadonlyArray<string>).includes(value)

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
export const makeTurnHeader = (args: {
  turnId: string
  kind: TurnKind
  startedAt: number
  threadId: string
}): TurnHeader => {
  const { turnId, kind, startedAt, threadId } = args
  if (typeof turnId !== "string" || turnId.length === 0 || turnId.trim() !== turnId) {
    throw new TurnHeaderInvalidError(
      "turnId",
      "must be a non-empty string with no surrounding whitespace",
    )
  }
  if (typeof kind !== "string" || !isTurnKindLiteral(kind)) {
    throw new TurnHeaderInvalidError(
      "kind",
      `must be one of ${ALL_TURN_KINDS.join(" | ")} (got ${String(kind)})`,
    )
  }
  if (!Number.isFinite(startedAt) || !Number.isInteger(startedAt) || startedAt < 0) {
    throw new TurnHeaderInvalidError(
      "startedAt",
      `must be a finite non-negative integer (got ${String(startedAt)})`,
    )
  }
  if (typeof threadId !== "string" || threadId.length === 0) {
    throw new TurnHeaderInvalidError("threadId", "must be a non-empty string")
  }
  return { turnId, kind, startedAt, threadId }
}
