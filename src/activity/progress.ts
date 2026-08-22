/**
 * Activity progress — a CLOSED, typed progress value (RFC-04 R6 D1).
 *
 * The staged worktree-init surface (and any future long-running step) needs a
 * live completion ratio. This module is the SSOT for that value and its
 * validation policy. Two hard rules from the D1 stop-list drive the shape:
 *
 *  - **Closed union, no free-form meta.** Progress is `indeterminate | ratio`
 *    and nothing else — never a `Record<string,string>` "hint". A renderer reads
 *    a typed field, not a stringly-typed bag (RFC §D1: "Do not encode percentage
 *    only in free-form meta strings"; stop rule: "progress must use free-form
 *    meta").
 *  - **No fabricated numbers (no-heuristics).** A malformed / unavailable /
 *    regressing ratio collapses to `indeterminate` — we show git's OWN reported
 *    ratio or nothing, never a guessed/animated bar.
 *
 * Pure-of-I/O leaf: this file imports NOTHING (no `@/runtime`, no sibling that
 * would re-enter). `types.ts` imports the `Progress` type FROM here (one-way), so
 * this module must stay dependency-free to avoid an import cycle.
 */

/** A closed progress value. `ratio` carries git's own `(completed/total)`;
 *  `indeterminate` is the honest "running, ratio unknown" state (never a
 *  fabricated percentage). */
export type Progress =
  | { readonly kind: "indeterminate" }
  | { readonly kind: "ratio"; readonly completed: number; readonly total: number }

/** The shared indeterminate singleton (referentially stable — cheap to compare). */
export const INDETERMINATE: Progress = { kind: "indeterminate" }

/**
 * Build a {@link Progress} from a candidate `(completed, total)`. Validation +
 * clamping policy (never a heuristic guess):
 *  - non-finite (NaN / ±Infinity) either operand ⇒ `indeterminate`;
 *  - `total <= 0` (no denominator) ⇒ `indeterminate`;
 *  - `completed < 0` ⇒ `indeterminate`;
 *  - `completed > total` ⇒ clamp to `total` (git can momentarily over-report a
 *    delta; a ratio never exceeds 100%).
 */
export const toProgress = (completed: number, total: number): Progress => {
  if (!Number.isFinite(completed) || !Number.isFinite(total)) return INDETERMINATE
  if (total <= 0) return INDETERMINATE
  if (completed < 0) return INDETERMINATE
  return { kind: "ratio", completed: Math.min(completed, total), total }
}

/**
 * Fold an incoming progress value onto the node's existing one. Policy:
 *  - an incoming `indeterminate` always wins (an explicit "ratio unknown");
 *  - from `indeterminate`/absent, any `ratio` is accepted forward;
 *  - a `ratio` whose `total` DIFFERS from the previous is a new attempt/phase —
 *    accepted forward (a retry mints new totals; monotonicity is per attempt);
 *  - a `ratio` on the SAME `total` that REGRESSES (`completed` moves backward)
 *    collapses to `indeterminate` — we never rewind a completion bar to a smaller
 *    number (RFC §D1: "regressing … totals become indeterminate").
 */
export const mergeProgress = (prev: Progress | undefined, next: Progress): Progress => {
  if (next.kind === "indeterminate") return next
  if (prev === undefined || prev.kind === "indeterminate") return next
  if (prev.total === next.total && next.completed < prev.completed) return INDETERMINATE
  return next
}

/** Structural equality for progress values (used to drop no-op coalesced
 *  updates — a re-emit of the identical ratio is not a change). */
export const progressEquals = (a: Progress, b: Progress): boolean => {
  if (a.kind === "indeterminate" || b.kind === "indeterminate") return a.kind === b.kind
  return a.completed === b.completed && a.total === b.total
}
