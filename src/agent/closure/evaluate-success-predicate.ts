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
 * v1 only EXIT-CODE predicates (`test_exit_zero` / `selected_test_passes`) are
 * evaluable; ALL issue-PROSE-derived predicates — exact-string / symbolic /
 * structural AND the stdout-shape ones (`stdout_contains` / `stdout_exact_empty`,
 * whose sole source is the issue-prose regex `extractIssueDeclaredExpected`) —
 * are advisory (evaluable:false) until their observed-side extraction is proven
 * safe. The declared value still reaches the model as a spec-fidelity steer, so
 * demoting them loses no information; it only removes the regex's authority to
 * hard-fail the rail.
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

    // ── advisory in v1 (observed-side extraction not yet proven safe) ──────
    // Hard-gating these on a fuzzy issue-derived expected value risks false-RED
    // (rejecting a correct patch). They feed repair-seed pressure only, never the
    // finish gate, until T-3 measurement proves their evaluability.
    //
    // 🔴 `stdout_contains` / `stdout_exact_empty` are ALSO issue-PROSE-derived:
    // their SOLE producer is build.ts, fed exclusively by
    // `extractIssueDeclaredExpected` (a regex over the public problem statement).
    // A prose mis-extraction (wrong/current value captured, negation/contrast
    // blindness like "should print `False` but returns `True`", or the
    // "stop X from checking" inversion) would mark a CORRECT patch matched:false
    // and hard-veto the primary rail (false-RED) — the very failure this design
    // forbids. So they are advisory in v1, exactly like latex/symbolic: the
    // declared value still reaches the model as a spec-fidelity steer
    // (driver.buildSpecSteer, gated on the same extractor), so NO information is
    // lost — we only strip the regex's authority to hard-fail. The rail falls
    // back to the genuine execution oracle (`test_exit_zero`) as the hard signal.
    case "stdout_contains":
      return advisory("stdout_contains is advisory in v1 (issue-prose-derived; no reliable observed match)")
    case "stdout_exact_empty":
      return advisory("stdout_exact_empty is advisory in v1 (issue-prose-derived; no reliable observed match)")
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
