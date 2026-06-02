/**
 * Tier-1 per-subsystem builder: PR-SHIP block (ADR-0459 gh_pr_open seam).
 *
 * Returns the single `gh_pr_open` tool (author a PR title/body from the diff,
 * then `gh pr create` in one step) wired to the host-supplied one-shot author
 * `LLMPort` when `config.composeAuthoring` is set; `[]` otherwise.
 *
 * WHY a SEPARATE builder from `buildComposeAuthoringBlock`: that block is sealed
 * READ-ONLY (its hellgate asserts every tool `isReadOnly()` — `git_compose_*`
 * author prose, open nothing). `gh_pr_open` is a WRITE tool (it runs `gh pr
 * create`), so it must NOT ride in the read-only block. It reuses the SAME
 * `composeAuthoring.authorLLM` slot (a PR author needs exactly that LLM) but is
 * gated and registered independently. WRITE SAFETY is enforced downstream, the
 * same way every mutating tool is: the permission layer prompts on a non-read
 * tool and plan-mode blocks its dispatch — registration here only makes the
 * tool VISIBLE, never auto-runs it.
 *
 * DEFAULT-OFF: `config.composeAuthoring` absent ⇒ `[]`, so the ToolRegistry is
 * byte-identical (RFC §1.2). Mirrors `buildComposeAuthoringBlock` posture.
 *
 * SLICE FENCE: the tool factory lives in the `@/tool/gh` slice (which already
 * imports `@/tool/git`); this builder is the composition root adapting the
 * `AgentConfig.composeAuthoring` slot into it using the default gh + git
 * runners. Directive emission is left to explicit-injection call sites (e.g.
 * ci-bot), matching how `gh_pr_create` behaves when built via `ghTools(runner)`.
 */

import { defaultGitRunner, type Tool } from "@/tool"
import { defaultGhRunner, ghPrOpenTool } from "@/tool/gh"
import type { AgentConfig } from "../types"

/** Build the PR-ship tool when the compose-authoring slot is wired. */
export const buildPrShipBlock = (config: AgentConfig): Tool[] => {
  const compose = config.composeAuthoring
  if (compose === undefined) return []
  return [ghPrOpenTool(defaultGhRunner, defaultGitRunner, compose.authorLLM) as Tool]
}
