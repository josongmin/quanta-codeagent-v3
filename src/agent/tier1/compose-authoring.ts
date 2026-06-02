/**
 * Tier-1 per-subsystem builder: COMPOSE-AUTHORING block (ADR-0016 compose seam).
 *
 * Returns the two diff→prose AUTHORING tools (`git_compose_commit` +
 * `git_compose_pr`) wired to the host-supplied one-shot author `LLMPort` when
 * `config.composeAuthoring` is set; `[]` otherwise.
 *
 * DEFAULT-OFF: `config.composeAuthoring` absent ⇒ this builder returns [], so
 * the loop sees no extra tool and the ToolRegistry stays byte-identical
 * (RFC §1.2 — proven by the compose hellgate battery). Mirrors
 * `buildAdvisorBlock` / `buildWebSearchBlock` posture.
 *
 * SLICE FENCE: the two tool factories live in the `@/tool/git` slice (already
 * type-only-importing `@/llm`); this builder is the composition root that
 * adapts the `AgentConfig.composeAuthoring` slot (host-built author LLM) into
 * those factories using the default git runner. The factories themselves are
 * the same ones `gitTools(runner, {authorLLM})` registers — this builder is the
 * agent-side equivalent for the knob-driven path (where git tools are NOT built
 * from the CLI `QUANTA_GIT_TOOLS` features path).
 */

import type { Tool } from "@/tool"
import { defaultGitRunner } from "@/tool"
import { gitComposeCommitTool, gitComposePrTool } from "@/tool/git/compose"
import type { AgentConfig } from "../types"

/** Build the compose-authoring tools when the slot is wired. */
export const buildComposeAuthoringBlock = (config: AgentConfig): Tool[] => {
  const compose = config.composeAuthoring
  if (compose === undefined) return []
  return [
    gitComposeCommitTool(defaultGitRunner, compose.authorLLM) as Tool,
    gitComposePrTool(defaultGitRunner, compose.authorLLM) as Tool,
  ]
}
