/**
 * Tier-1 per-subsystem builder: SUBAGENT BATCH block (RFC-02 / ADR-0436).
 *
 * Returns the `spawn_batch` tool when `config.subagent?.enableBatchSpawn ===
 * true` (a runner must exist); empty array otherwise.
 *
 * DEFAULT-OFF: `config.subagent` absent OR `enableBatchSpawn` not `true` ⇒ this
 * builder returns [], so the loop sees no extra tool and the ToolRegistry stays
 * byte-identical. Mirrors `buildSubagentBgBlock` / `buildSubagentMailboxBlock`.
 *
 * COMPOSITION ROOT: this is the ONLY place the slice's injected non-determinism
 * is satisfied — `Date.now` for the clock, `fs.promises.readFile` for
 * `items_path`. The `@/tool/subagent-batch` slice itself imports neither.
 */

import { readFile as fsReadFile } from "node:fs/promises"
import type { Tool } from "@/tool"
import {
  DEFAULT_BATCH_TIMEOUT_POLICY,
  DEFAULT_MAX_BATCH_ITEMS,
  subagentBatchTools,
} from "@/tool/subagent-batch"
import { createSubagentRunner } from "../subagent-runner"
import type { AgentConfig } from "../types"

/** Build the `spawn_batch` tool when the gate is ON. */
export const buildSubagentBatchBlock = (config: AgentConfig): Tool[] => {
  const sub = config.subagent
  if (sub === undefined || sub.enableBatchSpawn !== true) return []

  // Reuse the SAME runner construction the trio/6-tool builders use so children
  // forked by the batch run through the identical depth-guarded `runAgent`
  // bridge. The batch slice only needs the narrow `(req)=>Promise<result>`
  // shape; `createSubagentRunner` returns a structurally-compatible superset.
  const runner = createSubagentRunner(config, {
    ...(sub.maxDepth !== undefined ? { maxDepth: sub.maxDepth } : {}),
    ...(sub.toolNamespace !== undefined ? { toolNamespace: sub.toolNamespace } : {}),
  })

  return subagentBatchTools({
    runner,
    readFile: (path: string) => fsReadFile(path, "utf8"),
    clock: Date.now,
    maxItems: sub.maxBatchItems ?? DEFAULT_MAX_BATCH_ITEMS,
    // The effective concurrency ceiling. Reuse the per-session concurrent cap
    // (B3) when set, else fall back to the batch item cap (so an unbounded host
    // still has a finite worker ceiling — never unbounded fan-out).
    schedulerCap: sub.maxConcurrent ?? sub.maxBatchItems ?? DEFAULT_MAX_BATCH_ITEMS,
    ...(config.depth !== undefined ? { parentDepth: config.depth } : {}),
    timeoutPolicy: sub.waitTimeoutPolicy ?? DEFAULT_BATCH_TIMEOUT_POLICY,
  })
}
