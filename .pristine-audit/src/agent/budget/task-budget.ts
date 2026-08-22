/**
 * jun-02 — Soft task-budget (model self-moderation).
 *
 * Claude's `task_budget: { type: "tokens", total: N }` surfaces a budget TO
 * THE MODEL so it can self-moderate — prioritize, then wrap up cleanly as the
 * remaining budget nears zero. This slice is the quanta mirror.
 *
 * Design contract (load-bearing):
 *
 *   1. ORTHOGONAL TO THE HARD BREAKER. This has NOTHING to do with the
 *      enforcement `BudgetMeter` (`./meter.ts`, ADR-0138), which is never
 *      surfaced to the model and STOPS the run on a tripped dial. The soft
 *      task-budget only renders a guidance LINE into the per-turn
 *      `<system-reminder>` tail; it NEVER returns a stop signal, never throws,
 *      never mutates enforcement state. Phrasing escalates near/over budget to
 *      "wrap up", but the line is explicitly labelled "guidance, not a hard
 *      limit".
 *
 *   2. DEFAULT-OFF. `TaskBudget` absent (or `tokens <= 0`) ⇒
 *      {@link renderTaskBudgetBlock} returns `undefined` and
 *      buildDynamicContext emits ZERO new bytes — the rendered reminder is
 *      BYTE-IDENTICAL to the pre-slice path. The byte-identical hellgate pins
 *      this.
 *
 *   3. PURE / REPLAY DETERMINISTIC. The renderer is a pure function of its
 *      input — no clock, no `process.*`, no I/O. Same input ⇒ same output.
 *
 *   4. POISON-PROOF. A non-finite or negative `spent` (e.g. a provider that
 *      reported `NaN` usage) is coerced to `0` so the remaining calculation
 *      can never go non-finite. `remaining` is clamped to `[0, tokens]` so it
 *      never renders a negative number when the model has overspent — it shows
 *      `~0 tokens` and the "wrap up" escalation instead.
 */

/**
 * Soft, model-facing token budget for the current task. `tokens` is the total
 * advisory ceiling the caller grants; `spent` is the cumulative usage so far
 * (accumulated by the caller across turns — typically the running input +
 * output token total). Both are advisory: nothing here enforces them.
 */
export interface TaskBudget {
  /** Total advisory token budget for the task. `<= 0` ⇒ no meaningful budget
   *  (renderer returns `undefined`, byte-identical default-OFF). */
  tokens: number
  /** Cumulative tokens spent so far. Absent / non-finite / negative ⇒ treated
   *  as `0`. The caller accumulates this across turns so `remaining` shrinks. */
  spent?: number
}

/** Escalation band — propositional, derived purely from the spent fraction.
 *  Closed set; the thresholds are the ONLY numeric literals in this slice and
 *  are escalation phrasing boundaries, NOT enforcement gates. */
type BudgetBand = "low" | "near" | "over"

/** Fraction of the budget at/above which the phrasing escalates to "wrap up"
 *  while still remaining (the model should start landing the task). */
const NEAR_FRACTION = 0.9

const bandFor = (spent: number, tokens: number): BudgetBand => {
  if (spent >= tokens) return "over"
  if (spent >= tokens * NEAR_FRACTION) return "near"
  return "low"
}

/** Coerce a possibly-absent / poisoned spent value to a finite non-negative
 *  number. A `NaN` or negative report cannot push `remaining` non-finite or
 *  above the total. */
const safeSpent = (spent: number | undefined): number =>
  typeof spent === "number" && Number.isFinite(spent) && spent > 0 ? spent : 0

/**
 * Render the soft task-budget guidance line, or `undefined` when there is no
 * meaningful budget to surface (absent budget, or non-positive total).
 *
 * Output shape (single block, joined into the dynamic-context tail):
 *
 *   low:  "Soft budget: ~70000 tokens of your 100000-token task budget remain
 *          — prioritize and wrap up cleanly as it nears zero. This is
 *          guidance, not a hard limit."
 *   near: "...remain — you are near your task budget; wrap up cleanly now and
 *          land the task. This is guidance, not a hard limit."
 *   over: "...~0 tokens ... — you are over your task budget; wrap up now and
 *          deliver what you have. This is guidance, not a hard limit."
 *
 * The block is harness-authored text, but rides the same `embedUntrusted`
 * boundary-escape path as every other dynamic fragment (see prompt.ts) so the
 * forgery invariant holds uniformly.
 */
export const renderTaskBudgetBlock = (budget: TaskBudget | undefined): string | undefined => {
  if (budget === undefined) return undefined
  const { tokens } = budget
  if (!Number.isFinite(tokens) || tokens <= 0) return undefined

  const spent = safeSpent(budget.spent)
  // Clamp remaining to [0, tokens] — never negative, never above the total.
  const remaining = Math.max(0, tokens - spent)
  const band = bandFor(spent, tokens)

  const head = `Soft budget: ~${remaining} tokens of your ${tokens}-token task budget remain`
  const hint =
    band === "over"
      ? "you are over your task budget; wrap up now and deliver what you have"
      : band === "near"
        ? "you are near your task budget; wrap up cleanly now and land the task"
        : "prioritize and wrap up cleanly as it nears zero"
  return `${head} — ${hint}. This is guidance, not a hard limit.`
}
