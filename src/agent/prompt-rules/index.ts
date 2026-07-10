/**
 * Barrel + mode-dispatch for the tool-use prompt rules.
 *
 * Topology (RFC may-22-unified-agent-runtime §1.1, §2):
 *   - `core.ts`        — the 6 verbatim safety/honesty rules + `PromptRule` shape.
 *   - `assistant.ts`   — interactive-mode pack = core (byte-stable legacy).
 *   - `task-runner.ts` — headless-mode pack = core + R-SINGLE-COHERENT.
 *   - `benchmark.ts`   — batch-mode pack = core + R-NO-EXPLORE-OVER-EDIT.
 *   - `pr-agent.ts`    — ci-bot-mode pack = core + R-SMALL-DIFF / R-EXPLAIN-IN-PR / R-NO-PUSH-MAIN.
 *
 * Back-compat: `renderToolUseRules()` still returns the assistant (interactive)
 * pack byte-for-byte, so the existing `prompt.ts` consumer and the cached
 * provider prefix are untouched until a caller opts in via `promptPack`.
 *
 * Slice boundary: this barrel imports only sibling files and (type-only)
 * `AgentMode`. No `@/llm`, no `@/tool`, no `@/apps` — rules are pure text data.
 */

import { POSTURE_ATOMS, type PromptContext, renderAtoms } from "../prompt-graph"
import { BATCH_RULES } from "./benchmark"
import { CORE_RULES, DEFAULT_BASE, OWNED_RULES, type PromptRule } from "./core"
import { PR_RULES } from "./pr-agent"
import { HEADLESS_RULES } from "./task-runner"

/**
 * Pack-selection enum. Distinct from `prompt.ts`'s `AgentMode`
 * (`default|plan|review|audit`) on purpose — that enum is the legacy 4-mode
 * task posture; this one names the *runtime surface* a session was launched on.
 *
 * SSOT migration DONE (ADR-0092): re-exports `@/agent/run-mode`'s `AgentMode`
 * (the run-mode slice has landed) so the pack registry and the mode matrix can
 * never drift — adding a mode there forces a `renderPackByMode` case here.
 */
export type { AgentMode } from "../run-mode/types"

import type { AgentMode } from "../run-mode/types"

/** Dispatch a mode to its pack and flatten to the line array `prompt.ts`
 *  splices into the static system prompt. Exhaustive over the 4 modes — adding
 *  a fifth without a case here is a compile error (the `mode satisfies never`
 *  pattern is not used because `switch` on a string literal type already gives
 *  the same narrowing under strict TS settings). */
// ── 2-axis rendering (jul-4): env posture and task pack are INDEPENDENT axes ──
// The prompt rules split into two orthogonal slots that `buildSystemPrompt` composes:
//   1. POSTURE-BASE (env axis) — the honesty rails + env guardrails, selected by envPosture
//      (`frozen` = SWE-bench "don't install / stop when env-blocked" = CORE_RULES;
//       `owned`  = container-owned "install freely" = OWNED_RULES).
//   2. TASK rules (task axis) — mode-specific narrowing, selected by promptPack
//      (batch/headless/ci-bot; interactive/ide have none). Env-independent.
// The prior code XOR'd these (owned XOR pack) so an owned surface could not carry a task
// pack. Composing them independently removes the XOR while staying byte-identical for every
// legacy combination (a frozen pack == CORE + task; owned == OWNED + no task).

/** Base ctx skeleton for the posture-base projection — only `envPosture` varies;
 *  no posture atom conditions on the other axes (ADR-0538 §Migration). */
const postureCtx = (envPosture: PromptContext["envPosture"]): PromptContext => ({
  envPosture,
  promptPack: "interactive",
  verifyStrategy: undefined,
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
})

/** POSTURE-BASE rules (env axis) — DERIVED from the ADR-0538 atom graph, NOT from
 *  list membership + `withoutBlocks`. `renderAtoms` selects the applicable posture
 *  atoms via `matches()` (matcher + supersede resolution + ordering) and flattens
 *  their lines. Byte-identical to the prior CORE/OWNED/DEFAULT projections. */
export const renderPostureBase = (
  posture: "frozen" | "owned" | "default",
): readonly string[] => renderAtoms(POSTURE_ATOMS, postureCtx(posture))

/** TASK-only rules (task axis) — env-independent mode narrowing. interactive/ide carry none;
 *  headless/daemon → R-SINGLE-COHERENT; batch → R-NO-EXPLORE-OVER-EDIT; ci-bot → PR rules. */
export const renderTaskRules = (mode: AgentMode): readonly string[] => {
  switch (mode) {
    case "interactive":
    case "ide":
      return []
    case "headless":
    case "daemon":
      return HEADLESS_RULES.flatMap((r) => r.lines)
    case "batch":
      return BATCH_RULES.flatMap((r) => r.lines)
    case "ci-bot":
      return PR_RULES.flatMap((r) => r.lines)
  }
}

/** Legacy single-axis entry: `frozen` posture-base + the mode's task rules — byte-identical to
 *  the prior pack dispatch (a `*_PACK` == CORE_RULES + its task rules). Kept for callers that
 *  pass only a mode; `buildSystemPrompt` now composes the two axes directly. */
export const renderPackByMode = (mode: AgentMode): readonly string[] => [
  ...renderPostureBase("frozen"),
  ...renderTaskRules(mode),
]

/** Legacy entry point. Returns the frozen interactive base — byte-identical to the
 *  prior single-file `renderToolUseRules()` so the cached system-prompt prefix
 *  for interactive sessions never shifts. */
export const renderToolUseRules = (): readonly string[] => renderPackByMode("interactive")

/** Render the `owned` environment posture rule list (RFC jul-2 TB levers /01).
 *  Byte-identical to `renderPostureBase("owned")` — kept as the named legacy entry the
 *  terminal surface calls; `frozen` callers never reach this path. */
export const renderOwnedRules = (): readonly string[] => renderPostureBase("owned")

export { ASSISTANT_PACK } from "./assistant"
export { BENCHMARK_PACK } from "./benchmark"
export { CORE_RULES, DEFAULT_BASE, OWNED_RULES } from "./core"
export { PR_AGENT_PACK } from "./pr-agent"
export { TASK_RUNNER_PACK } from "./task-runner"
export {
  GRADER_ONLY_RULE,
  REPRODUCE_FIRST_RULE,
  renderVerifyStrategy,
  VERIFY_AFTER_EDIT_RULE,
  type VerifyStrategy,
} from "./verify-strategy"
export type { PromptRule }
