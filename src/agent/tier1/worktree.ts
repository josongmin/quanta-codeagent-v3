/**
 * Tier-1 per-subsystem builder: WORKTREE block (ticket-11, P8 git-worktree
 * agent tools).
 *
 * Registers the `enter_worktree` / `exit_worktree` / `worktree_status` tools
 * ONLY when the composition root wired a session-scoped `activeWorktreeSlot`
 * (which it does ONLY when `QUANTA_WORKTREE_TOOL` is on). Absent slot ⇒ `[]` ⇒
 * the tools are NOT in the registry and `bash`/`edit` cwd is byte-identical
 * (default-OFF, RFC §1.2).
 *
 * The tools mutate + read the slot through `ToolContext.worktreeSlot` (threaded
 * by the dispatch seam from `AgentConfig.activeWorktreeSlot`), so the block here
 * carries NO per-tool state — it just gates registration on slot presence. This
 * mirrors how the env-gated tier-1 blocks (`buildCheckSecretsBlock`) gate on a
 * config-derived condition, not on env directly.
 */

import { type Tool, worktreeTools } from "@/tool"
import type { FeaturesConfig } from "../types"

/** Build the worktree tool block. Returns the 3 tools when a session-scoped
 *  `activeWorktreeSlot` is wired; `[]` otherwise (default-OFF). */
export const buildWorktreeBlock = (
  config: Pick<FeaturesConfig, "activeWorktreeSlot">,
): readonly Tool[] => (config.activeWorktreeSlot !== undefined ? worktreeTools : [])
