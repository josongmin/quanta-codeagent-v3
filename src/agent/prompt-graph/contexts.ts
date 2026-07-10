/**
 * ADR-0538 Phase 1 — enumeration of the reachable `PromptContext` surface for
 * the migrated tool-use slice.
 *
 * The migrated atoms condition ONLY on `envPosture` × `verifyStrategy` (posture
 * base + verify axis). The remaining axes (promptPack / mode / presence facets)
 * are held at a single representative value per ctx — no migrated atom reads
 * them, so widening them would multiply identical points without changing what
 * fires. When the Phase 2 body atoms (which DO read presence facets) migrate,
 * this enumerator widens to cross those axes too.
 */

import type { EnvironmentPosture } from "../prompt"
import type { VerifyStrategy } from "../prompt-rules"
import type { AgentMode, PromptContext } from "./types"

const POSTURES: readonly EnvironmentPosture[] = ["frozen", "owned", "default"]
/** `undefined` is a REAL reachable state (no verify strategy selected). */
const VERIFY_STRATEGIES: readonly (VerifyStrategy | undefined)[] = [
  undefined,
  "reproduce-first",
  "verify-after-edit",
  "grader-only",
]

/** Representative fixed values for axes no migrated atom conditions on. */
const BASE: Omit<PromptContext, "envPosture" | "verifyStrategy"> = {
  promptPack: "interactive",
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
}

/**
 * The full reachable ctx set for the migrated slice = envPosture × verifyStrategy
 * (3 × 4 = 12 points). Every migrated variant's `when` is decidable over this set.
 */
export const reachableToolUseContexts = (): readonly PromptContext[] => {
  const out: PromptContext[] = []
  for (const envPosture of POSTURES) {
    for (const verifyStrategy of VERIFY_STRATEGIES) {
      out.push({ ...BASE, envPosture, verifyStrategy })
    }
  }
  return out
}

/** The full 6-mode set — the body atoms (completion-bar split) and the notice
 *  atoms read `mode`, so the body-graph verifier must cross it. */
const MODES: readonly AgentMode[] = [
  "default",
  "plan",
  "review",
  "audit",
  "architect",
  "editor",
]

/**
 * The reachable ctx set for the Phase 2 BODY + NOTICE slice = envPosture ×
 * verifyStrategy × mode (3 × 4 × 6 = 72 points). The body atoms condition on
 * `verifyStrategy` (grader-only suppression) and `mode` (completion-bar split);
 * the notice atoms condition on `mode` and `brief`. `brief` is crossed as a
 * final ×2 so the brief-notice atom's coverage is decidable (144 points).
 */
export const reachableBodyContexts = (): readonly PromptContext[] => {
  const out: PromptContext[] = []
  for (const envPosture of POSTURES) {
    for (const verifyStrategy of VERIFY_STRATEGIES) {
      for (const mode of MODES) {
        for (const brief of [false, true]) {
          out.push({ ...BASE, envPosture, verifyStrategy, mode, brief })
        }
      }
    }
  }
  return out
}
