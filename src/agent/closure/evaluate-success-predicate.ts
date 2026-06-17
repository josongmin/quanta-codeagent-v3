/**
 * Closure engine — SuccessPredicate evaluator (jun-17 T-1). PURE.
 *
 * Judges a {@link SuccessPredicate} against an {@link ExecObservation}. The whole
 * point of the closure runner: a NON-primary green (exit 0 on some unrelated
 * command) must not clear the rail, and a typed proof obligation must actually be
 * checked instead of trusting exit codes.
 *
 * 🔴 FAIL-OPEN contract: predicates we cannot CONFIDENTLY judge from the
 * observation return `{ evaluable: false }`. The caller degrades to the legacy
 * exit-code decision — NEVER hard-fails. A correct patch rejected by a fragile
 * issue-derived predicate (false-RED) is worse than today's false-green. So in
 * v1 only EXECUTION-GROUNDED predicates are evaluable; issue-derived
 * exact-string / symbolic / structural predicates are advisory (evaluable:false)
 * until their observed-side extraction is proven safe.
 */

import type { ExecObservation, PredicateResult, SuccessPredicate } from "./types"

const matched = (m: boolean, reason?: string): PredicateResult =>
  m
    ? { evaluable: true, matched: true }
    : { evaluable: true, matched: false, ...(reason !== undefined ? { mismatchReason: reason } : {}) }

/** Advisory (cannot confidently evaluate from the observation) ⇒ fail-open. */
const advisory = (why: string): PredicateResult => ({
  evaluable: false,
  matched: false,
  mismatchReason: why,
})

export const evaluateSuccessPredicate = (
  observed: ExecObservation,
  predicate: SuccessPredicate,
): PredicateResult => {
  // Top guard: the FAIL-OPEN / never-throws contract must hold for ANY input,
  // including a malformed predicate (e.g. one built from JSON/LLM output that lost
  // its required fields). A throw here would be a hard-fail = the false-RED the
  // whole design forbids. Non-object / missing discriminant ⇒ advisory.
  if (predicate === null || typeof predicate !== "object" || typeof predicate.type !== "string") {
    return advisory("malformed predicate (no discriminant)")
  }
  switch (predicate.type) {
    // ── execution-grounded: confidently judged from exit / stdout ──────────
    case "test_exit_zero":
      return matched(observed.exitCode === 0, `exit ${observed.exitCode} != 0`)
    case "selected_test_passes":
      // the selector already narrowed the cmd upstream; a zero exit is the proof.
      return matched(observed.exitCode === 0, `selected test exit ${observed.exitCode} != 0`)
    case "stdout_contains": {
      // Defensive: a malformed predicate missing `substring` must NOT throw (the
      // reason string would eagerly `.slice` undefined) — fail-open to advisory.
      if (typeof predicate.substring !== "string") return advisory("stdout_contains missing substring")
      return matched(
        observed.stdout.includes(predicate.substring),
        `stdout missing substring ${JSON.stringify(predicate.substring.slice(0, 80))}`,
      )
    }
    case "stdout_exact_empty":
      return matched(observed.stdout.trim() === "", "stdout is not empty")

    // ── advisory in v1 (observed-side extraction not yet proven safe) ──────
    // Hard-gating these on a fuzzy issue-derived expected value risks false-RED
    // (rejecting a correct patch). They feed repair-seed pressure only, never the
    // finish gate, until T-3 measurement proves their evaluability.
    case "latex_or_string_exact":
      return advisory("latex_or_string_exact is advisory in v1 (no reliable observed repr)")
    case "symbolic_repr_equals":
      return advisory("symbolic_repr_equals is advisory in v1 (no reliable observed repr)")
    case "ast_or_dom_shape":
      return advisory("ast_or_dom_shape is advisory in v1 (no observed AST/DOM extractor)")
    case "stderr_absent":
      // stderr emptiness is noisy across runners (warnings, deprecations) — keep
      // advisory rather than hard-gate.
      return advisory("stderr_absent is advisory in v1 (stderr noise across runners)")

    default:
      // Unknown / future discriminant ⇒ fail-open (never throw, never hard-fail).
      return advisory(`unknown predicate type ${(predicate as { type?: string }).type ?? "?"}`)
  }
}
