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

import { type PromptContext, renderAtoms, VERIFY_ATOMS } from "../prompt-graph"
import type { PromptRule } from "./core"

/** The verify-strategy axis value. Absent ⇒ no verify rule (byte-identical).
 *  `grader-only` is the OPPOSITE posture to `reproduce-first` (do NOT reproduce / run
 *  local tests) — they are mutually exclusive by being one axis value. */
export type VerifyStrategy = "reproduce-first" | "verify-after-edit" | "grader-only"

/** The verify-strategy PromptRule projection — DERIVED from the ADR-0538 atom
 *  graph (SSOT). `VERIFY_ATOMS` holds the atoms; a strategy selects exactly the
 *  atom whose `when.verifyStrategy` admits it. `atomLines` looks up the atom's
 *  rendered lines by the strategy's ctx (there is exactly one per strategy). */
const verifyCtx = (verifyStrategy: VerifyStrategy): PromptContext => ({
  envPosture: "frozen",
  promptPack: "interactive",
  verifyStrategy,
  mode: "default",
  hasRepoRules: false,
  hasGlobRules: false,
  hasSessionCtx: false,
  hasMemorySummary: false,
  hasWorkingState: false,
  hasActiveSkills: false,
  hasContextEvents: false,
  hasMentionInjection: false,
  hasHookInjects: false,
  hasImages: false,
  brief: false,
  untrustedEnvelope: false,
  hasLanguageHint: false,
  hasEnvBlock: false,
  hasRepoRulesDynamic: false,
  hasTaskBudget: false,
  hasDirectives: false,
  hasDelegationSuppress: false,
})

/** Rule constant kept for back-compat callers/tests — its `.lines` are the
 *  atom's rendered lines (single SSOT). `id` is the atom's `atomId` (the tag). */
const ruleFor = (strategy: VerifyStrategy, id: string): PromptRule => ({
  id,
  lines: renderAtoms(VERIFY_ATOMS, verifyCtx(strategy)),
})

/** SWE/bench: reproduce the reported failure BEFORE fixing, then rerun the same
 *  reproduction after (no-leak — public issue text only). */
export const REPRODUCE_FIRST_RULE: PromptRule = ruleFor("reproduce-first", "R-REPRODUCE-FIRST")

/** General/CLI: run the narrowest check that exercises the change, after each edit. */
export const VERIFY_AFTER_EDIT_RULE: PromptRule = ruleFor(
  "verify-after-edit",
  "R-VERIFY-AFTER-EDIT",
)

/** SWE hidden-grader: local verification is DISABLED. NO-LEAK: the grader is named
 *  only inside a forbid clause. Active ⇒ `buildSystemPrompt` also suppresses the
 *  body's reproduce-required + completion-bar blocks (Phase 2 body migration). */
export const GRADER_ONLY_RULE: PromptRule = ruleFor("grader-only", "R-GRADER-ONLY")

/** Flatten the selected verify strategy to the line array `buildSystemPrompt`
 *  splices as the third slot — DERIVED from the atom graph via `matches()`, NOT
 *  a list switch. Absent ⇒ `[]` (no atom fires, byte-identical). */
export const renderVerifyStrategy = (strategy: VerifyStrategy | undefined): readonly string[] => {
  if (strategy === undefined) return []
  return renderAtoms(VERIFY_ATOMS, verifyCtx(strategy))
}
