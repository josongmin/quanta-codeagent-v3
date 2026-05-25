/**
 * Focus Chain port (ADR-0219).
 *
 * Cline absorption: Cline's Focus Chain re-injects the current todo list
 * into the model context every N turns (Cline default: 6) so a long-running
 * session doesn't lose track of the multi-step plan. Without this, todos
 * decided early in a session get pushed out of context and silently dropped.
 *
 * Distinct from ADR-0045 (progress-audit skill): progress-audit is
 * user-invocable — the operator calls `/progress-audit` and the model
 * re-reads its todos. Focus Chain is AUTOMATIC — every N turns the system
 * splices the todo list into the prompt without operator action. They are
 * complementary, not redundant.
 *
 * Plane-clean: types-only. NO imports from `@/agent/loop`, `@/agent/dispatch`,
 * `@/llm`, `@/tool`. Caller threads the resulting injection string into
 * `buildTurnContext` (or any other prompt-assembly seam) at its discretion.
 *
 * Default-OFF: the loop never constructs a tracker. Callers opt in via
 * AgentConfig; when absent the prompt assembly is byte-identical and no
 * turn counter advances.
 *
 * Contracts (5):
 *   1. NO-THROW on every public method — bad input (empty todo, negative
 *      tick) is a no-op or returns null. The tracker is observability-grade
 *      infra; it MUST NOT take down the loop.
 *   2. PURE STATE — in-memory; the tracker holds the todo list + a
 *      monotonic turn counter. No persistence (Phase 2 if needed).
 *   3. DRIFT DETECTION — when N consecutive turns pass with zero todo
 *      progress (no `markDone` / no `setTodos`), `getDriftWarning()` returns
 *      a one-line warning the host may surface as a `system-reminder`
 *      addendum.
 *   4. exactOptionalPropertyTypes — optional fields are OMITTED, never
 *      `undefined`-set.
 *   5. BYTE-IDENTICAL WHEN OFF — host code that does NOT wire a tracker
 *      sees no behaviour change. The host wires the tracker by reading
 *      `getInjection()` and splicing it into its prompt; absent tracker ⇒
 *      absent splice ⇒ identical prompt bytes.
 */

/** One todo entry — minimal shape. `done` is a 3-state arm to surface
 *  in-progress items distinctly from queued ones. */
export interface FocusTodo {
  /** Free-form short label (≤200 chars). Caller-controlled identity. */
  readonly text: string
  /** 3-state lifecycle. `pending` ⇒ queued; `in-progress` ⇒ active right
   *  now; `done` ⇒ completed. The injection renders all three with
   *  distinct prefixes so the model sees "what's left" clearly. */
  readonly state: "pending" | "in-progress" | "done"
}

export interface FocusChainPort {
  /** Replace the entire todo list. Empty array ⇒ tracker is "armed but
   *  empty" — subsequent `tickTurn()` calls advance the counter but
   *  `getInjection()` returns null until a non-empty list is set. */
  setTodos(todos: readonly FocusTodo[]): void
  /** Advance the per-session turn counter by 1. Idempotent against
   *  negative or NaN values (those are no-op). The counter is the trigger
   *  for both injection scheduling AND drift detection. */
  tickTurn(): void
  /** Returns the string to splice into the next turn's prompt — when
   *  scheduling allows (every Nth turn) AND a non-empty todo list exists.
   *  Returns `null` otherwise. Side-effect: marks "injected at turn X"
   *  so a follow-up `getInjection()` in the same turn returns null
   *  (prevents double-inject within one turn). */
  getInjection(): string | null
  /** Pure read of the current injection without marking it consumed.
   *  Useful for tests and for hosts that want to peek before deciding to
   *  splice. */
  peekInjection(): string | null
  /** When N consecutive turns have passed with zero todo state change
   *  (no `markDone`, no `setTodos`), returns a one-line drift warning.
   *  Returns null otherwise. The host may surface this as a
   *  `<system-reminder>` addendum. */
  getDriftWarning(): string | null
  /** Mark a todo done by index. Out-of-range / negative ⇒ no-op (no throw).
   *  Bumps the "last activity" counter so drift detection resets. */
  markDone(index: number): void
  /** Read-only snapshot of the current todo list. Mutating the array does
   *  NOT affect the tracker's state — a fresh frozen copy is returned. */
  snapshotTodos(): readonly FocusTodo[]
  /** Current turn counter — pure read, useful for tests. */
  currentTurn(): number
}
