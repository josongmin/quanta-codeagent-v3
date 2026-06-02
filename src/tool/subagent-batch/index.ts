/** RFC-02 / ADR-0436 — `spawn_batch` slice barrel.
 *
 *  Builds the single batch tool wired to injected deps. Mirrors
 *  `subagent-bg/index.ts:subagentBgTools(scheduler)`. Plane-clean: imports only
 *  sibling modules + `../types`. NO `@/agent`. */

import type { Tool } from "../types"
import { spawnBatchTool } from "./batch"
import type { SubagentBatchDeps } from "./port"

export type { SpawnBatchInput } from "./batch"
export { spawnBatchInputSchema, spawnBatchTool } from "./batch"
export type { LoadResult } from "./load-items"
export { loadItems } from "./load-items"
export type {
  BatchClock,
  BatchItemResult,
  BatchRunResult,
  BatchSubagentRequest,
  BatchSubagentResult,
  BatchSubagentRunner,
  BatchSummary,
  BatchTaskBudget,
  BatchTimeoutPolicy,
  ReadFilePort,
  SubagentBatchDeps,
} from "./port"
export {
  clampBatchTimeout,
  DEFAULT_BATCH_TIMEOUT_POLICY,
  DEFAULT_MAX_BATCH_ITEMS,
} from "./port"
export type { RunBatchArgs, RunBatchDeps } from "./run-batch"
export { runBatch } from "./run-batch"
export type { BatchItem, RenderResult } from "./template"
export { renderTemplate } from "./template"

/** Build the batch tool set (single tool today) from injected deps. The tier1
 *  composition root supplies the closed deps bundle. Returns `[]` is NOT this
 *  builder's job — the tier1 adapter decides default-OFF; once deps exist the
 *  tool always builds. */
export const subagentBatchTools = (deps: SubagentBatchDeps): Tool[] => [
  spawnBatchTool(deps) as Tool,
]
