/**
 * Hand-curated grep rules — `UseCaseId` → tokens to look for in `src/`/`tests/`.
 *
 * Rules are intentionally *seed-thin*: cover the leaves where current quanta
 * slices already have obvious tokens; everything else degrades to `tbd` and
 * surfaces as a gap. Add a rule when you have real evidence of coverage; do
 * NOT pattern-match optimistically (a false `ok` hides a real hole).
 *
 * Token choice rule of thumb: pick a unique-ish identifier (class name, slash
 * command, MCP tool name, RFC anchor) rather than a generic English word.
 */
import type { UseCaseId } from "../types"
import type { AuditRule } from "./grep-mapper"

export const RULES: Readonly<Record<UseCaseId, AuditRule>> = {
  // ── software-quality.debugging ────────────────────────────────────────────
  "software-quality.debugging.error-message-paste": {
    tokens: ["classifyLLMError", "errorEvent", "AgentEvent.*error"],
  },
  "software-quality.debugging.log-analysis": {
    tokens: ["fullLogPath", "stdoutTail", "stderrTail"],
  },

  // ── software-quality.testing ──────────────────────────────────────────────
  "software-quality.testing.unit-gen": {
    tokens: ["bun:test", "describe(", "test("],
    note: "host-side test infra; agent-driven test gen is Tier 1",
  },

  // ── software-quality.code-review ──────────────────────────────────────────
  "software-quality.code-review.diff-pr": {
    tokens: ["countDiff", "patch_generated"],
  },

  // ── learning.comprehension ────────────────────────────────────────────────
  "learning.comprehension.function-explain": {
    tokens: ["Read", "src/tool/read"],
    note: "Read tool is the primary explanation enabler",
  },
  "learning.comprehension.callsite-trace": {
    tokens: ["findReferences", "@/lsp"],
  },

  // ── read-mode ─────────────────────────────────────────────────────────────
  "read-mode.reading.open-file": {
    tokens: ["src/tool/read", "ReadTool"],
  },
  "read-mode.search.grep": {
    tokens: ["src/tool/grep", "GrepTool"],
  },
  "read-mode.reading.goto-definition": {
    tokens: ["@/lsp", "gotoDefinition"],
  },

  // ── persistent-context (Cursor-rules analogue: AGENTS.md / CLAUDE.md / memory) ─
  "persistent-context.project-info.domain": {
    tokens: ["AGENTS.md", "CLAUDE.md", "buildSystemPrompt"],
  },
  "persistent-context.examples.few-shot": {
    tokens: ["SystemPromptInput"],
  },
  "persistent-context.llm-directives.direct-instr": {
    tokens: ["buildSystemPrompt", "system-reminder"],
  },

  // ── meta ──────────────────────────────────────────────────────────────────
  "meta.memory.save-recall": {
    tokens: ["@/memory", "WorkingMemory", "persistSession"],
  },
  "meta.session.resume": {
    tokens: ["@/session", "resumeSession", "@/runner/session-ops"],
  },
  "meta.configuration.settings": {
    tokens: ["loadEnv", "@/permission"],
  },
  "meta.cost-usage.token-cost": {
    tokens: ["LlmUsageData", "inputTokens", "outputTokens"],
  },

  // ── process-automation (host-side absent — Tier 1/2 territory) ────────────
  "process-automation.pr.pr-description": {
    tokens: [],
    scopedOut: true,
    note: "out of scope for the agent slice — evaluated via Tier 1/2",
  },
  "process-automation.commit.commit-message": {
    tokens: [],
    scopedOut: true,
    note: "out of scope for the agent slice — evaluated via Tier 1/2",
  },

  // ── dev-environment (host config, not agent — Tier 1) ─────────────────────
  "dev-environment.ci-cd.gh-actions": {
    tokens: [".github/workflows"],
    note: "host CI config presence only; agent-authoring is Tier 1",
  },
}
