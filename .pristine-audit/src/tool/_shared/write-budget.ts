/**
 * jun-6 exfil-rail (a) — per-turn write/edit-count budget (pure, turn-keyed).
 *
 * WHAT: a deterministic, non-LLM rail that, in an UNTRUSTED-INPUT turn, requires
 *       confirmation / denies after N writes — defeating "drip-exfil via many
 *       small writes" after a prompt-injection. The cap is keyed on the turn
 *       ordinal the dispatch seam already threads (`config.run?.turn`), so the
 *       counter RESETS automatically at each turn boundary without a hook.
 * RFC: docs/plans/jun-6-exfil-egress-rails.md §4.1
 * SLICES IMPORTED: none (pure, no clock, no random, no I/O).
 * NO-THROW: total.
 *
 * GATING (the single most important false-positive control — §7): the cap fires
 * ONLY when `untrustedContext === true` (the turn ingested web/MCP/file output,
 * the existing untrusted-envelope signal). A normal trusted codegen turn has
 * `untrustedContext === false` ⇒ the cap NEVER fires ⇒ unlimited writes. The cap
 * targets the drip-exfil-after-injection shape, not legit bulk authoring.
 *
 * The cap N is a CONFIGURABLE KNOB value (`QUANTA_WRITE_BUDGET_MAX`), never a
 * hardcoded magic number — the host resolves it from runtime config and passes
 * it in. There is NO default constant inside this leaf.
 */

/** The closed verdict the budget returns for the Nth write of a turn. `ok` ⇒
 *  proceed; `confirm` ⇒ require HITL confirmation (or route to deny in
 *  headless/auto); `deny` ⇒ typed `rejected` failure. Adding an arm requires a
 *  compile-error update at every exhaustive consumer. */
export type WriteBudgetVerdict = "ok" | "confirm" | "deny"

/** The stable typed `rejected` reason tag for a write-budget denial. */
export const WRITE_BUDGET_REASON = "write_budget_exceeded"

/** Build the model-facing message for a budget `confirm`/`deny`. SSOT so write +
 *  edit emit BYTE-IDENTICAL text. */
export const writeBudgetMessage = (max: number): string =>
  `Write budget exceeded: more than ${max} write/edit operations in a single ` +
  "untrusted-input turn. This is the drip-exfiltration guard — confirm to " +
  "continue, or split the work across turns."

/** The ToolContext-facing seam the `write`/`edit` tools consume. The dispatch
 *  seam binds the CURRENT turn before threading this, so the tool calls
 *  `recordWrite()` with no arguments. `undefined` (unwired) ⇒ the tool proceeds
 *  byte-identically (no counter touched). */
export interface WriteBudgetPort {
  /** The per-turn cap (the configured KNOB value). Surfaced so the tool can
   *  render an accurate model-facing message; READ-ONLY. */
  readonly maxWritesPerTurn: number
  /** Bump the per-turn write counter and report the verdict for THIS write. */
  recordWrite(): WriteBudgetVerdict
}

/** The session-long, turn-keyed counter the host constructs ONCE per session.
 *  `recordWrite(turn)` resets the internal counter whenever `turn` advances, so
 *  the cap is per-turn without any external reset hook. The dispatch seam adapts
 *  this into the turn-bound {@link WriteBudgetPort} above. */
export interface SessionWriteBudget {
  /** Bump-and-check for the given turn ordinal. Resets the counter when `turn`
   *  differs from the last-seen turn (per-turn reset). */
  recordWrite(turn: number): WriteBudgetVerdict
}

/** Construction options for {@link createSessionWriteBudget}. */
export interface WriteBudgetOptions {
  /** True when the CURRENT session/turn is processing untrusted input (resolved
   *  by the host from the untrusted-envelope gate). When false the budget is
   *  INERT — every `recordWrite` returns `"ok"` regardless of count. */
  readonly untrustedContext: boolean
  /** Per-turn cap (the configurable KNOB value, NOT a magic number). The
   *  (cap+1)-th write in an untrusted turn returns the `overVerdict`. Must be a
   *  positive integer; a non-positive/NaN value makes the budget inert. */
  readonly maxWritesPerTurn: number
  /** The verdict to return once the cap is exceeded — `"confirm"` (the
   *  recommended narrow default, lets the user wave it through) or `"deny"`. */
  readonly overVerdict: Exclude<WriteBudgetVerdict, "ok">
}

/**
 * Build the session-long, turn-keyed write budget. Pure-by-state (no clock, no
 * random): the verdict for a write depends only on `untrustedContext`, the cap,
 * and how many writes already occurred IN THE SAME turn ordinal. NO-THROW.
 *
 * Semantics: in an untrusted turn, the first `maxWritesPerTurn` writes return
 * `"ok"`; every write AFTER that returns `overVerdict`. When `untrustedContext`
 * is false, or the cap is not a positive integer, EVERY write returns `"ok"`
 * (inert — byte-identical to no budget).
 */
export const createSessionWriteBudget = (opts: WriteBudgetOptions): SessionWriteBudget => {
  const { untrustedContext, maxWritesPerTurn, overVerdict } = opts
  const capValid = Number.isInteger(maxWritesPerTurn) && maxWritesPerTurn > 0
  const inert = !untrustedContext || !capValid
  let lastTurn: number | undefined
  let countThisTurn = 0
  return {
    recordWrite(turn: number): WriteBudgetVerdict {
      if (inert) return "ok"
      // Per-turn reset: a new turn ordinal restarts the count.
      if (turn !== lastTurn) {
        lastTurn = turn
        countThisTurn = 0
      }
      countThisTurn += 1
      return countThisTurn > maxWritesPerTurn ? overVerdict : "ok"
    },
  }
}

/** Adapt a {@link SessionWriteBudget} + a fixed turn ordinal into the
 *  turn-bound {@link WriteBudgetPort} the tools consume. The dispatch seam calls
 *  this once per ToolContext build with the current `config.run?.turn`. */
export const bindWriteBudgetTurn = (
  budget: SessionWriteBudget,
  turn: number,
  maxWritesPerTurn: number,
): WriteBudgetPort => ({
  maxWritesPerTurn,
  recordWrite: (): WriteBudgetVerdict => budget.recordWrite(turn),
})
