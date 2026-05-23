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
import { ASSISTANT_PACK } from "./assistant";
import { BENCHMARK_PACK } from "./benchmark";
import { PR_AGENT_PACK } from "./pr-agent";
import { TASK_RUNNER_PACK } from "./task-runner";
/** Dispatch a mode to its pack and flatten to the line array `prompt.ts`
 *  splices into the static system prompt. Exhaustive over the 4 modes — adding
 *  a fifth without a case here is a compile error (the `mode satisfies never`
 *  pattern is not used because `switch` on a string literal type already gives
 *  the same narrowing under strict TS settings). */
export const renderPackByMode = (mode) => {
    switch (mode) {
        case "interactive":
            return ASSISTANT_PACK.flatMap((r) => r.lines);
        case "headless":
            return TASK_RUNNER_PACK.flatMap((r) => r.lines);
        case "batch":
            return BENCHMARK_PACK.flatMap((r) => r.lines);
        case "ci-bot":
            return PR_AGENT_PACK.flatMap((r) => r.lines);
        // ADR-0092 (C1): ide/daemon reuse existing packs per their promptPack
        // lever — ide = assistant (human-near), daemon = task-runner (autonomous).
        case "ide":
            return ASSISTANT_PACK.flatMap((r) => r.lines);
        case "daemon":
            return TASK_RUNNER_PACK.flatMap((r) => r.lines);
    }
};
/** Legacy entry point. Returns the assistant pack — byte-identical to the
 *  prior single-file `renderToolUseRules()` so the cached system-prompt prefix
 *  for interactive sessions never shifts. */
export const renderToolUseRules = () => renderPackByMode("interactive");
export { ASSISTANT_PACK } from "./assistant";
export { BENCHMARK_PACK } from "./benchmark";
export { CORE_RULES } from "./core";
export { PR_AGENT_PACK } from "./pr-agent";
export { TASK_RUNNER_PACK } from "./task-runner";
