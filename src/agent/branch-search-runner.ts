/**
 * Loop-coupling binder for speculative branch search (ADR-0084) — the SINGLE
 * file that joins the loop-agnostic `@/agent/branch-search` slice to the real
 * `runAgent` + isolation strategy. Mirrors `subagent-runner.ts`'s role: keep
 * the `branch-search/` core pure + unit-testable (all ports), confine the
 * `runAgent` fork + `@/runtime` isolator choice to one place.
 *
 * The `loop → features → branch-search-runner → loop` import cycle is
 * tolerated exactly as `loop → features → subagent-runner → loop` is:
 * `runAgent` is only CALLED at runtime, never at module-init.
 */

import type { Tool } from "@/tool"
import {
  branchSearchTool,
  type Isolator,
  type RunCandidate,
  tmpdirIsolator,
  worktreeIsolator,
} from "./branch-search"
import { runAgent } from "./loop"
import type { AgentConfig } from "./types"

/** Build a candidate-scoped `runAgent` fork. Each candidate runs in its own
 *  isolated workspace at depth+1 with the seed's model/promptHint applied, and
 *  with `branchSearch` STRIPPED so a candidate can never recursively fan out
 *  (negative invariant — prevents N^depth explosion). */
export const bindBranchRunCandidate = (config: AgentConfig): RunCandidate => {
  // Strip `branchSearch` once (exactOptionalPropertyTypes: omit, never set
  // `undefined`). Reused for every candidate fork.
  const { branchSearch: _stripped, ...parentSansBranch } = config
  return async ({ workspace, seed, task, baseLlm, signal }) => {
    const llm = seed.modelOverride?.port ?? baseLlm
    const hint = seed.promptHint ? `\n\n<branch-hint>${seed.promptHint}</branch-hint>` : ""
    const child: AgentConfig = {
      ...parentSansBranch,
      llm,
      cwd: workspace,
      signal,
      depth: (config.depth ?? 0) + 1,
      messages: [{ role: "user", content: [{ type: "text", text: `${task}${hint}` }] }],
    }
    const outcome = await runAgent(child)
    return { kind: "completed", turns: outcome.turns }
  }
}

/** Pick the isolation strategy from `config.branchSearch.isolation`, rooted at
 *  the parent `cwd`. Default `tmpdir` (git-free); `worktree` for big repos. */
export const buildBranchIsolator = (config: AgentConfig): Isolator =>
  config.branchSearch?.isolation === "worktree"
    ? worktreeIsolator({ repoRoot: config.cwd })
    : tmpdirIsolator({ srcDir: config.cwd })

/** Construct the `branch_search` tool for a session, or `undefined` when
 *  `config.branchSearch` is unset (default-OFF — caller skips registration).
 *  `buildSessionFeatures` pushes the returned tool into `extraTools`. */
export const buildBranchSearchTool = (config: AgentConfig): Tool | undefined => {
  const bs = config.branchSearch
  if (bs === undefined) return undefined
  return branchSearchTool({
    config: bs,
    runCandidate: bindBranchRunCandidate(config),
    buildIsolator: () => buildBranchIsolator(config),
    baseLlm: config.llm,
    ...(config.modelCandidates ? { modelCandidates: config.modelCandidates } : {}),
  }) as Tool
}
