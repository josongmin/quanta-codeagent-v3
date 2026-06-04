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
import { runtimeConfig } from "@/shared"
import {
  type CreateGateResult,
  createDagGate,
  type DagRunner,
  type DagRunnerRequest,
  type TaskNode,
  wrapRunnerWithDagGate,
} from "@/subagent/coordination"
import type { Tool } from "@/tool"
import {
  type BatchSubagentRunner,
  DEFAULT_BATCH_TIMEOUT_POLICY,
  DEFAULT_MAX_BATCH_ITEMS,
  subagentBatchTools,
} from "@/tool/subagent-batch"
import { createSubagentRunner } from "../subagent-runner"
import type { AgentConfig } from "../types"

/**
 * Capability A wiring seam (plan: docs/plans/multiagent-coordination.md §2.A).
 *
 * Compose the DAG dispatch gate over a forked child runner. The `subagent-batch`
 * slice fans out all items concurrently (bounded by its worker semaphore); this
 * wrapper makes each child BLOCK until the pure DAG core (`@/subagent/
 * coordination`) reports its node ready, releasing dependents via `onComplete`
 * as children finish — net effect: dispatch order respects `dependsOn` while
 * reusing the existing pool (no edit to the sealed slice). A cyclic/dangling
 * graph is rejected here BEFORE any dispatch; a failed dep surfaces its
 * dependents as a typed dead branch (never a hang).
 *
 * Exported (not inlined) so the hellgate e2e drives the EXACT composition the
 * builder uses. KNOB-GATED + node-set-gated: with `QUANTA_TEAM_DAG` OFF, or an
 * empty node set, this returns the RAW runner unchanged — byte-identical flat
 * fan-out. With the knob ON and a node set present, it returns the DAG-gated
 * runner (or a typed rejection for a cyclic/dangling graph — the caller then
 * refuses the batch rather than dispatching a bad graph).
 */
export const composeDagBatchRunner = (
  runner: BatchSubagentRunner,
  nodes: readonly TaskNode[],
  idOf: (req: DagRunnerRequest) => string | undefined,
):
  | { ok: true; gated: false; runner: BatchSubagentRunner }
  | { ok: true; gated: true; runner: BatchSubagentRunner }
  | { ok: false; gate: CreateGateResult } => {
  // Default-OFF: knob unset OR no edges ⇒ raw runner (byte-identical).
  if (!runtimeConfig().teamDag || nodes.length === 0) {
    return { ok: true, gated: false, runner }
  }
  const made = createDagGate(nodes)
  if (!made.ok) return { ok: false, gate: made }
  const gated = wrapRunnerWithDagGate(runner as DagRunner, made.gate, idOf)
  return { ok: true, gated: true, runner: gated as BatchSubagentRunner }
}

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

  // Capability A — engage the DAG dispatch gate via `composeDagBatchRunner`.
  // The dependency edges arrive per-`spawn_batch` call, and the sealed
  // `@/tool/subagent-batch` schema carries no `dependsOn` field yet, so the
  // build-time node set is empty here. With an empty node set (OR the knob OFF)
  // `composeDagBatchRunner` returns the RAW runner unchanged — the OFF path is
  // BYTE-IDENTICAL. The gate becomes live the moment a node-set source exists
  // (a slice-schema extension is a deliberately separate wave); the composition
  // itself is proven end-to-end by `team-dag-batch-e2e-hellgate`.
  const composed = composeDagBatchRunner(runner, [], (req) => req.prompt)
  // `composed.ok` is always true here (empty node set never rejects); the
  // returned runner is the raw runner unless a node set engages the gate.
  const effectiveRunner: BatchSubagentRunner = composed.ok ? composed.runner : runner

  return subagentBatchTools({
    runner: effectiveRunner,
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
