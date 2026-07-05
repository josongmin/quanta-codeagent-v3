/**
 * Verify-strategy pack — the THIRD prompt axis (jul-4 2→3 slot).
 *
 * The prompt composes three orthogonal axes: env POSTURE (frozen/owned) × TASK
 * pack (batch/headless/ci-bot) × VERIFY strategy (this file). A verify strategy
 * is the surface's answer to "how does the agent confirm its own work?" — a
 * per-target habit, distinct from the env it runs in and the task shape:
 *
 *   - `reproduce-first` (SWE/bench) — reproduce the reported failure, fix, rerun.
 *   - `verify-after-edit` (general/CLI) — run the narrowest check after each edit.
 *   - self-test (TB) — authored spec-derived self-test loop; already its own TB
 *     knob + converge machinery (`QUANTA_TB_SELF_TEST`), so it is NOT re-rendered
 *     here. This slot is the same CONCEPT for the other surfaces.
 *
 * MEASURE-FIRST: every strategy rides a default-OFF knob at its entry point, so an
 * absent `verifyStrategy` renders NOTHING and the prompt is byte-identical. The
 * content is competitor-validated (Agentless / SWE-agent reproduce-first; the
 * verify-after-edit habit is universal), landing inert until box A/B proves it.
 *
 * NO-LEAK by construction: `reproduce-first` reproduces from the PUBLIC issue text
 * only and the rule says so explicitly — it never points the model at a hidden or
 * grader test. These are pure text-data rules (no `@/llm`, no `@/tool`).
 */

import type { PromptRule } from "./core"

/** The verify-strategy axis value. Absent ⇒ no verify rule (byte-identical).
 *  `grader-only` is the OPPOSITE posture to `reproduce-first` (do NOT reproduce / run
 *  local tests) — they are mutually exclusive by being one axis value. */
export type VerifyStrategy = "reproduce-first" | "verify-after-edit" | "grader-only"

/** SWE/bench: reproduce the reported failure BEFORE fixing, then rerun the same
 *  reproduction after. Grounds the fix in an observed before→after instead of a
 *  guess. Works from the public issue text only (no-leak). */
export const REPRODUCE_FIRST_RULE: PromptRule = {
  id: "R-REPRODUCE-FIRST",
  lines: [
    "- [R-REPRODUCE-FIRST] Reproduce before you fix. From the issue / task",
    "  description, write the minimal script or command that triggers the reported",
    "  failure and confirm it fails for the stated reason. Make your fix, then RERUN",
    "  that same reproduction and confirm it now passes. Ground the change in an",
    "  observed before→after, not a guess about what the code does. Use only the",
    "  public issue text — do NOT seek any hidden, grader, or reference test.",
  ],
}

/** General/CLI: run the narrowest check that exercises the change, after each edit,
 *  and read the result before moving on. The universal verify-your-work habit. */
export const VERIFY_AFTER_EDIT_RULE: PromptRule = {
  id: "R-VERIFY-AFTER-EDIT",
  lines: [
    "- [R-VERIFY-AFTER-EDIT] Verify each change before reporting it done. Run the",
    "  narrowest check that exercises what you changed — the affected file's tests, a",
    "  type-check, or the exact command the user runs — and READ the result. Do not",
    "  claim a change works until you have observed it behave.",
  ],
}

/** SWE hidden-grader: local verification is DISABLED (the checkout lacks test deps; an
 *  automated grader runs hidden tests against the final source diff). Command-order form
 *  (Do-not / Do / Stop / Final) — an execution prompt wobbles less with prohibitions +
 *  route than with prose. NO-LEAK: the grader is named ONLY inside a forbid clause; there
 *  is never a "read the hidden test" directive. Active ⇒ `buildSystemPrompt` also
 *  suppresses the body's reproduce-required + completion-bar rules (which would contradict
 *  this). */
export const GRADER_ONLY_RULE: PromptRule = {
  id: "R-GRADER-ONLY",
  lines: [
    "- [R-GRADER-ONLY] SWE hidden-grader mode. An automated grader runs hidden tests",
    "  against ONLY your final source diff; local verification is intentionally disabled.",
    "  Do NOT: run the test suite / pytest / tox / any broad or dependency-install command",
    "  (this checkout lacks test deps — they fail spuriously and only waste turns); create,",
    "  edit, or delete tests, docs, lockfiles, or fixtures; use destructive git (checkout /",
    "  reset / clean / stash / restore); claim \"verified / passing / green / done\" when no",
    "  permitted check ran; seek any hidden, grader, or reference test.",
    "  Do: read the source before editing; confirm the owning code path by the strongest",
    "  available evidence (lsp_definition / references when reliable, else source reads +",
    "  narrow grep — do not block a small patch just because LSP is unavailable); infer the",
    "  EXACT required behavior (signature, message, return value, edge cases) from the public",
    "  issue and match it precisely; make the smallest isolated source-only change.",
    "  Stop when: the minimal source patch is applied.",
    "  Final: state files changed, behavior changed, and \"verification: not run — hidden-",
    "  grader mode forbids local tests; the grader runs them.\" Do not overclaim.",
  ],
}

/** Flatten the selected verify strategy to the line array `buildSystemPrompt`
 *  splices as the third slot. Absent ⇒ `[]` (no lines, byte-identical). */
export const renderVerifyStrategy = (strategy: VerifyStrategy | undefined): readonly string[] => {
  switch (strategy) {
    case undefined:
      return []
    case "reproduce-first":
      return REPRODUCE_FIRST_RULE.lines
    case "verify-after-edit":
      return VERIFY_AFTER_EDIT_RULE.lines
    case "grader-only":
      return GRADER_ONLY_RULE.lines
  }
}
