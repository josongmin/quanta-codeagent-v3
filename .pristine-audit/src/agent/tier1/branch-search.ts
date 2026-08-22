/**
 * Tier-1 per-subsystem builder: BRANCH SEARCH block (ADR-0083).
 *
 * Returns the `branch_search` N-best tool, with its `runCandidate` bound to a
 * candidate-scoped `runAgent` fork and the isolator chosen per `isolation`.
 *
 * Behavior preserved verbatim from the previous monolithic
 * `buildSessionFeatures` body — only the *location* of this slice has moved.
 *
 * DEFAULT-OFF: `config.branchSearch` absent ⇒ `buildBranchSearchTool` returns
 * `undefined` and this builder propagates that (byte-identical, RFC §1.2).
 */

import type { Tool } from "@/tool"
import { buildBranchSearchTool } from "../branch-search-runner"
import type { AgentConfig } from "../types"

/** Build the branch-search block from `config.branchSearch`. Thin pass-through
 *  to `buildBranchSearchTool` — the underlying builder already implements the
 *  default-OFF contract. */
export const buildBranchSearchBlock = (config: AgentConfig): Tool | undefined =>
  buildBranchSearchTool(config)
