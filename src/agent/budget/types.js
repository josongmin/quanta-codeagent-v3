/**
 * Budget slice — pure types (RFC may-22-unified-agent-runtime / Phase 1).
 *
 * `BudgetDials` declare the *requested* per-run quantitative ceilings; the
 * meter compares observed counts against them propositionally
 * (`dial !== undefined && observed > dial`). All fields are OPTIONAL — when a
 * dial is omitted, that dimension is uncapped (i.e. the corresponding
 * exhaustion check is skipped). There are NO numerical literals in this file:
 * downstream code only ever reads the user-supplied values.
 *
 * `BudgetCaps` is the same shape (subset by construction) and represents the
 * MAXIMUM a given run-mode preset will permit. `clampDials(dials, caps)` is
 * the propositional intersection, NOT a heuristic — see `../run-mode/clamp.ts`.
 *
 * `BudgetExhaustionPolicy` is a closed literal union — surfaces / loop choose
 * one of four well-typed verbs when a dial fires.
 */
export {};
