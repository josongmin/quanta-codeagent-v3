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

import { ASSISTANT_PACK } from "./assistant"
import { BENCHMARK_PACK } from "./benchmark"
import { OWNED_RULES, type PromptRule } from "./core"
import { PR_AGENT_PACK } from "./pr-agent"
import { TASK_RUNNER_PACK } from "./task-runner"

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
export const renderPackByMode = (mode: AgentMode): readonly string[] => {
  switch (mode) {
    case "interactive":
      return ASSISTANT_PACK.flatMap((r) => r.lines)
    case "headless":
      return TASK_RUNNER_PACK.flatMap((r) => r.lines)
    case "batch":
      return BENCHMARK_PACK.flatMap((r) => r.lines)
    case "ci-bot":
      return PR_AGENT_PACK.flatMap((r) => r.lines)
    // ADR-0092 (C1): ide/daemon reuse existing packs per their promptPack
    // lever — ide = assistant (human-near), daemon = task-runner (autonomous).
    case "ide":
      return ASSISTANT_PACK.flatMap((r) => r.lines)
    case "daemon":
      return TASK_RUNNER_PACK.flatMap((r) => r.lines)
  }
}

/** Legacy entry point. Returns the assistant pack — byte-identical to the
 *  prior single-file `renderToolUseRules()` so the cached system-prompt prefix
 *  for interactive sessions never shifts. */
export const renderToolUseRules = (): readonly string[] => renderPackByMode("interactive")

/** Render the `owned` environment posture rule list (RFC jul-2-terminal-bench-levers/01)
 *  — flattened to the same line-array shape `renderPackByMode` returns so the prompt
 *  builder can splice it at the identical seam. PROMPT-TEXT-ONLY: this is the `owned`
 *  posture's replacement for the CORE-based rules; it drops R-ENV / R-STOP-ENV and the
 *  R-NO-SHIM stop-tail, and adds R-ENV-OWNED / R-INSTALL-THRASH. Never touches runtime
 *  enforcement. `frozen` callers never reach this path. */
export const renderOwnedRules = (): readonly string[] => OWNED_RULES.flatMap((r) => r.lines)

export { ASSISTANT_PACK } from "./assistant"
export { BENCHMARK_PACK } from "./benchmark"
export { CORE_RULES, OWNED_RULES } from "./core"
export { PR_AGENT_PACK } from "./pr-agent"
export { TASK_RUNNER_PACK } from "./task-runner"
export type { PromptRule }
