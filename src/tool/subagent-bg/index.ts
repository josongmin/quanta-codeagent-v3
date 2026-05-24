/** Background subagent tools — ADR-0130.
 *
 *  Three tools wrapping a {@link BackgroundSubagentSchedulerPort}:
 *    - `subagent_fork`   — fork a background subagent; returns handle id.
 *    - `subagent_poll`   — non-blocking status read.
 *    - `subagent_await`  — block (with optional timeout) for completion.
 *
 *  The scheduler is a DUCK-TYPED mirror of `BackgroundSubagentScheduler`
 *  from `@/agent/subagent-background`. We mirror it here so the `@/tool`
 *  slice does NOT import `@/agent` (slice fence, RFC §3.1; biome enforces).
 *  The composition root in `@/agent/tier1/subagent-bg` adapts the concrete
 *  scheduler into this narrower port at wire time — for the structural
 *  surface, a slot-match suffices.
 *
 *  Plane-clean: imports only `../types` + `zod`. NO `@/agent`. */

import type { Tool } from "../types"
import { subagentAwaitTool } from "./await"
import { subagentForkTool } from "./fork"
import { subagentPollTool } from "./poll"

export type { SubagentAwaitInput } from "./await"
export { subagentAwaitInputSchema, subagentAwaitTool } from "./await"
export type { SubagentForkInput } from "./fork"
export { subagentForkInputSchema, subagentForkTool } from "./fork"
export type { SubagentPollInput } from "./poll"
export { subagentPollInputSchema, subagentPollTool } from "./poll"
export type {
  BackgroundSubagentSchedulerPort,
  SubagentBgHandleId,
  SubagentBgResult,
  SubagentBgSpec,
  SubagentBgStatus,
} from "./port"

import type { BackgroundSubagentSchedulerPort } from "./port"

/** Build the 3 background subagent tools wired to a scheduler port. Order:
 *  fork first (the primary mutator), then read-only poll, then read-only
 *  blocking await. Mirrors `shadowTools` convention of grouping by behavior. */
export const subagentBgTools = (scheduler: BackgroundSubagentSchedulerPort): Tool[] => [
  subagentForkTool(scheduler) as Tool,
  subagentPollTool(scheduler) as Tool,
  subagentAwaitTool(scheduler) as Tool,
]
