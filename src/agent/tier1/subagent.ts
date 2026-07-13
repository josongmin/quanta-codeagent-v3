/**
 * Tier-1 per-subsystem builder: SUBAGENT block.
 *
 * Materializes the `agent` / `task_output` / `task_stop` tool trio and the
 * shared `TaskRegistry` they were wired against, plus a cleanup hook that
 * aborts all in-flight background tasks at session end.
 *
 * Behavior preserved verbatim from the previous monolithic
 * `buildSessionFeatures` body — only the *location* of this slice has moved.
 *
 * DEFAULT-OFF: `config.subagent` absent ⇒ this builder returns `undefined` and
 * the composer skips the block (byte-identical, RFC §1.2).
 */

import { effectiveCap } from "@/agent/spawn-depth"
import { defaultPpidWalkKiller, escalatingKill } from "@/runtime"
import { runtimeConfig } from "@/shared"
import { resolveJailed } from "@/storage"
import type { Tool } from "@/tool"
import { spawnAgentsCsvTool } from "@/tool/spawn-agents-csv"
import { createRunWorkflowTool } from "@/tool/workflow/run-workflow-tool"
import {
  createAgentTool,
  createSubagent6Tools,
  createTaskOutputTool,
  createTaskStopTool,
  type TaskOutputTimeoutPolicy,
  type TaskRegistry,
  type WaitTimeoutPolicy,
} from "../../subagent"
import { buildInMemoryBatchRunPort } from "../batch-jobs-dispatch"
import { buildForkTurnsPreamble, composeForkedPrompt } from "../fork-turns"
import { createSubagentRunner } from "../subagent-runner"
import type { AgentConfig } from "../types"
import { subagentRunnerToAgentRunPort } from "../workflow-agent-adapter"
import { redactTranscript } from "./advisor"

/** Materialized subagent block. The three tools share ONE `TaskRegistry`
 *  instance — both `agentTool.registry` and the returned `taskRegistry` point
 *  to it, so the loop can observe/inspect background tasks via the same
 *  handle the LLM-facing tools mutate. */
export interface SubagentBlock {
  /** `[agent, task_output, task_stop]` — to be merged into the registry. When
   *  `config.subagent.enable6Tools === true` the six-tool router
   *  (`exec_command` / `write_stdin` / `spawn_agent` / `wait_agent` /
   *  `close_agent` / `send_input`) is APPENDED (COEXIST, ADR-0041), sharing the
   *  same `taskRegistry`. Absent/false ⇒ trio only (byte-identical). */
  extraTools: Tool[]
  /** The shared `TaskRegistry` instance the three tools were wired against. */
  taskRegistry: TaskRegistry
  /** Graceful shutdown hook. Aborts all currently-running background tasks
   *  (via `TaskRegistry.forceStop`) and awaits their settle via
   *  `waitForSettle`. Idempotent. */
  cleanup: () => Promise<void>
  /** B2/B3 — the 6-tool (`spawn_agent`/`wait_agent`/…) dispatch deps the host
   *  config asked for, surfaced for whatever assembles a `Subagent6Deps`. The
   *  trio tools above are wired directly in this builder; `waitTimeoutPolicy`
   *  already clamps trio `task_output(block:true)` and `maxConcurrent` now
   *  caps trio background `agent` launches too. The 6-tool router still needs
   *  the same knobs exposed here for any external `Subagent6Deps` assembler.
   *  Both omitted when the corresponding config field is absent ⇒ the consumer
   *  sees `{}` and the 6-tool defaults (30s policy / unlimited concurrency)
   *  apply — byte-identical to today. */
  subagent6Deps: {
    waitTimeoutPolicy?: WaitTimeoutPolicy
    maxConcurrent?: number
  }
}

/** Adapt a {@link WaitTimeoutPolicy} (handlers-6 slice) onto the structurally
 *  identical {@link TaskOutputTimeoutPolicy} (task-tools slice). The two types
 *  are deliberately kept apart (task-tools stays zod-only; handlers-6 pulls in
 *  `bun` Subprocess types) but the host wires the SAME band into both — this is
 *  the single adaptation point. Pure field copy. */
const toTaskOutputPolicy = (p: WaitTimeoutPolicy): TaskOutputTimeoutPolicy => ({
  minMs: p.minMs,
  maxMs: p.maxMs,
  defaultMs: p.defaultMs,
})

/** §25.1 — the `run_workflow` tool as a spread-ready array (`[]` when off).
 *  Reuses THIS block's `runner` via the workflow adapter so each workflow
 *  `agent` step forks a child exactly like the trio / 6-tool do (the same
 *  runner enforces `maxDepth`). Extracted so `buildSubagentBlock` stays under
 *  the cognitive-complexity cap. Default-OFF ⇒ `[]` ⇒ byte-identical tool menu. */
const workflowTools = (
  enabled: boolean,
  runner: ReturnType<typeof createSubagentRunner>,
  activityStore: import("@/activity").ActivityStore | undefined,
  parentDepth: number,
): Tool[] =>
  enabled
    ? [
        createRunWorkflowTool({
          // ALBB-16 #3 — thread the ACCUMULATED recursion depth (parent + 1),
          // matching the CSV (`buildInMemoryBatchRunPort(runner, config.depth ?? 0)`)
          // and 6-tool (`parentDepth: config.depth`) siblings below. A constant
          // `{ depth: 1 }` reset the bound: a deep child minting its own
          // `run_workflow` would restart at depth 1 and BYPASS the runner's
          // `req.depth > maxDepth` deny. `(config.depth ?? 0) + 1` makes a nested
          // workflow spawn from a parent at `maxDepth` land at `maxDepth + 1` ⇒
          // DENIED. At the root (`config.depth` undefined) this is `1` —
          // byte-identical to the old constant for the top-level case.
          agentRun: subagentRunnerToAgentRunPort(runner, { depth: parentDepth + 1 }),
          // jun-15 P0-b — thread the session Activity Spine store so live runs
          // feed `/activity`. Absent ⇒ omitted ⇒ byte-identical (no recording).
          ...(activityStore !== undefined ? { activityStore } : {}),
        }),
      ]
    : []

/** Optional wiring the composition root injects alongside `config`. */
export interface SubagentBlockDeps {
  /** ALBB-16 #1 — LIVE working-memory source for `fork_turns`, mirroring the
   *  advisor's `transcriptSource` (advisor.ts:140). The loop owns its live
   *  message buffer and injects this getter; `forkPrompt` resolves it LAZILY at
   *  spawn time so a child spawned mid-session inherits the turns accrued AFTER
   *  block build — not just the frozen `config.messages` seed. ABSENT ⇒ falls
   *  back to `config.messages ?? []` (byte-identical to the seed-sourced path). */
  readonly transcriptSource?: () => readonly import("@/llm").Message[]
}

/** Build the subagent block from `config.subagent`. Returns `undefined` when
 *  the block is absent so the composer can skip it. */
export const buildSubagentBlock = (
  config: AgentConfig,
  deps: SubagentBlockDeps = {},
): SubagentBlock | undefined => {
  if (!config.subagent) return undefined
  // rev.4 §4.4 — capability projection is NO LONGER gated here. The single
  // `projectSpawnTools` filter at the `features.ts` assembly seam (over the
  // finalized `extraTools`) owns spawn-tool removal for a leaf (SSOT). This
  // builder mints the trio/6-tool/workflow/CSV tools UNCONDITIONALLY; the leaf's
  // creation tools are dropped once, downstream. The runner reject
  // (`effectiveMaxDepth` below → subagent-runner) remains the authoritative bound.

  // FIX-A (jul-13 nesting-control, rev.4 MIN-CAP SSOT): resolve the effective
  // recursion cap at THIS `@/agent` caller boundary — the SAME min-cap the
  // exposure gate and the runner reject use
  // (`effectiveCap(config.subagent?.maxDepth) = min(operator policy, requested)`,
  // spawn-depth.ts / subagent-runner.ts). Passing it EXPLICITLY (not a
  // conditional spread) into the runner AND the two `@/subagent` secondary
  // pre-checks (`createAgentTool`, `createSubagent6Tools`) means their
  // `?? DEFAULT_MAX_DEPTH` fallback is never hit in practice — all three cap
  // sources see the identical resolved value. The slice fence is respected:
  // `@/subagent` never imports `effectiveCap`; the resolved number is threaded in
  // as `opts.maxDepth`/`deps.maxDepth`. With no `subagent.maxDepth` set ⇒ operator
  // policy (default 1 = root-only); `config.subagent.maxDepth` can only TIGHTEN
  // below policy, never raise it (min-cap): policy 1 + maxDepth 5 ⇒ min(1,5)=1.
  const effectiveMaxDepth = effectiveCap(config.subagent.maxDepth)

  // B1 — `toolNamespace` (when present) is threaded into the runner so forked
  // children expose SCOPED tool names. Absent ⇒ raw names (byte-identical):
  // the conditional spread keeps the options object empty on the unset path.
  // `maxDepth` is passed unconditionally as the resolved effective cap (FIX-A):
  // the runner's own `opts.maxDepth ?? spawnDepthCap()` yielded the identical
  // value on the unset path, so this is byte-identical while making the cap
  // source explicit and consistent with the secondary pre-checks below.
  const runner = createSubagentRunner(config, {
    maxDepth: effectiveMaxDepth,
    ...(config.subagent.toolNamespace !== undefined
      ? { toolNamespace: config.subagent.toolNamespace }
      : {}),
  })

  // GAP8a / ALBB-16 #1+#2 — the ONE shared `forkPrompt` source. Both the trio
  // `agent` tool and the 6-tool `spawn_agent` path close over THIS single
  // closure, so their inherited-context preambles are byte-identical by
  // construction (no divergent second implementation). The transcript is read
  // LAZILY at spawn time from the live working-memory thunk when the composition
  // root wired one (`deps.transcriptSource`), else fails CLOSED to the frozen
  // session seed (`config.messages ?? []`) — byte-identical to the legacy path.
  // `redactTranscript` (advisor) scrubs secrets + PII; `fork_turns:"none"`
  // (default) ⇒ identity (byte-identical cold start).
  const forkPrompt = (prompt: string, spec: "none" | "all" | number): string =>
    composeForkedPrompt(
      prompt,
      buildForkTurnsPreamble(
        deps.transcriptSource?.() ?? config.messages ?? [],
        spec,
        redactTranscript,
      ),
    )

  // `createAgentTool` mints a fresh TaskRegistry when none is passed and
  // re-exposes whichever instance it used as `.registry`. We let it create
  // one and read `.registry` back, then wire the Task* tools against THAT
  // same instance so all three tools observe the same background tasks.
  // When the surface (CLI lifecycle pills) provided a `taskRegistry` we
  // thread it in here so the surface keeps a live reference — byte-identical
  // for the unset path (the conditional `registry` spread is the only
  // delta and `createAgentTool` defaults to `new TaskRegistry()` when absent).
  const agentTool = createAgentTool({
    runner,
    // FIX-A — resolved min-cap (see `effectiveMaxDepth` above), so the
    // `agent-tool.ts` secondary pre-check receives the operator policy (default 1)
    // when no per-config `maxDepth` is set, NOT its `?? DEFAULT_MAX_DEPTH(=3)`.
    maxDepth: effectiveMaxDepth,
    ...(config.subagent.maxConcurrent !== undefined
      ? { maxConcurrent: config.subagent.maxConcurrent }
      : {}),
    ...(config.subagent.taskRegistry !== undefined
      ? { registry: config.subagent.taskRegistry }
      : {}),
    // GAP8a fork_turns — the SHARED `forkPrompt` (see above); live-WM sourced,
    // fail-closed to the seed. The 6-tool path is wired to the SAME closure.
    forkPrompt,
    // §4.4 — TYPED agent kind boundary validation. Gate read at the composition
    // root (ADR-0144: `@/agent` reads `runtimeConfig()`, never `process.env`).
    // Default-OFF (gate absent) ⇒ `enforceTypedAgentKind` omitted ⇒ the legacy
    // free-string path (byte-identical). When ON, the registered named-agent
    // names are the boundary's `knownCustom` set so a custom agent passes while
    // an unknown type is a Claude-Code-style miss. `names?.()` is the resolver's
    // optional enumeration — `?? []` when the wired resolver predates it.
    ...(runtimeConfig().subagentTypedKind
      ? {
          enforceTypedAgentKind: true,
          knownAgentTypes: () => config.namedAgentResolver?.names?.() ?? [],
        }
      : {}),
  })
  // Bind a NON-undefined local so the cleanup closure doesn't need a non-
  // null assertion on the outer `taskRegistry` (which is typed as optional
  // for callers that don't configure subagent).
  const reg = agentTool.registry
  // B2 — the SAME `{minMs,maxMs,defaultMs}` band the host configured for the
  // 6-tool `wait_agent` clamp is also fed into the trio's `task_output`
  // blocking clamp. `WaitTimeoutPolicy` and `TaskOutputTimeoutPolicy` are
  // distinct nominal types kept on separate slices (handlers-6 vs task-tools)
  // but share an identical structural shape; we adapt explicitly so a single
  // config knob clamps both families. Absent ⇒ `createTaskOutputTool(reg)` is
  // called 1-arg exactly as before (its own DEFAULT policy applies) —
  // byte-identical to today.
  const wtp = config.subagent.waitTimeoutPolicy
  const taskOutputTool =
    wtp !== undefined
      ? createTaskOutputTool(reg, toTaskOutputPolicy(wtp))
      : createTaskOutputTool(reg)
  // §25.1 — `run_workflow` spread (default-OFF; see {@link workflowTools}). Built
  // as a spread so `buildSubagentBlock` stays under the cognitive-complexity cap.
  const extraTools: Tool[] = [
    agentTool,
    taskOutputTool,
    createTaskStopTool(reg),
    ...workflowTools(
      config.subagent.enableWorkflow === true,
      runner,
      config.subagent.activityStore,
      config.depth ?? 0,
    ),
    // GAP7-4 — `spawn_agents_on_csv` over the SAME runner (one child per CSV row,
    // ephemeral in-memory store). Default-OFF (QUANTA_SPAWN_AGENTS_CSV).
    ...(config.subagent.enableSpawnAgentsCsv === true
      ? [spawnAgentsCsvTool(buildInMemoryBatchRunPort(runner, config.depth ?? 0)) as Tool]
      : []),
  ]

  // ADR-0041 LIVE assembly — when `enable6Tools` is set, build the six-tool
  // router AND keep the trio (COEXIST — see agent-tools-6.ts header + ADR-0041
  // "두 surface가 한동안 공존"). The 6-tool set shares the SAME `reg` so
  // spawn/wait/close observe the same background tasks the trio does, and the
  // already-exposed `maxConcurrent` / `waitTimeoutPolicy` knobs are threaded
  // straight into the spawn/wait handlers (making them behavior-live). Absent/
  // false ⇒ `extraTools` is the trio ONLY (byte-identical) and no PtyTable /
  // InputChannelRegistry is minted. `subagent6Cleanup` tears down PTY children.
  let subagent6Cleanup: (() => void) | undefined
  if (config.subagent.enable6Tools === true) {
    const set = createSubagent6Tools({
      runner,
      registry: reg,
      // FIX-A — resolved min-cap (see `effectiveMaxDepth` above), so the
      // `handlers-6.ts` secondary pre-check (`deps.maxDepth ?? DEFAULT_MAX_DEPTH`)
      // receives the operator policy (default 1) when no per-config `maxDepth` is
      // set, NOT its 3-fallback. Keeps spawn_agent's hostCap consistent with the
      // gate and the runner reject.
      maxDepth: effectiveMaxDepth,
      // (f) Thread THIS agent's recursion depth so a nested `spawn_agent`
      // computes `childDepth = parentDepth + 1` and the recursion guard
      // accumulates across forks (mirrors `subagent-batch.ts` parentDepth).
      // Absent ⇒ defaults to 0 (root) in the handler — byte-identical.
      ...(config.depth !== undefined ? { parentDepth: config.depth } : {}),
      // ALBB-16 #2 — thread the SAME shared `forkPrompt` the trio uses so a
      // `spawn_agent(fork_turns:…)` inherits the identical (redacted, live-WM)
      // preamble by construction. Absent on the deps ⇒ raw prompt (the handler's
      // legacy byte-identical path).
      forkPrompt,
      ...(config.subagent.maxConcurrent !== undefined
        ? { maxConcurrent: config.subagent.maxConcurrent }
        : {}),
      ...(config.subagent.waitTimeoutPolicy !== undefined
        ? { waitTimeoutPolicy: config.subagent.waitTimeoutPolicy }
        : {}),
      // (c) Path-jail port — confine `exec_command`'s model-supplied `cwd` to
      // the session workspace (`config.cwd`). The composition root owns the
      // `@/storage resolveJailed` wiring so the handlers-6 slice stays
      // storage-import-free. `resolveJailed` throws an `FsJailError` on escape,
      // which the handler converts to `cause:"cwd_outside_workspace"`. Only
      // wired when a workspace root is actually known — absent `config.cwd` ⇒
      // no jail (byte-identical legacy), never a jail against an undefined root.
      ...(config.cwd !== undefined
        ? { cwdJail: { resolve: resolveJailed, jailRoot: config.cwd } }
        : {}),
      // WS1 (jul-12 OmO absorption, self-audit 04 §5) — exec_command's
      // timeout/abort previously did a single-pid `proc.kill()` on the `bash -lc`
      // shell, orphaning any grandchild it forked (a LIVE 6-tool BASE leak, worse
      // than the side-agent one). The composition root owns the @/runtime wiring
      // (this slice may cross-import; handlers-6 may not) and injects the
      // production-grade escalating tree-killer (SIGTERM→grace→SIGKILL over the
      // whole process tree) — reusing `escalatingKill`, not reinventing a ladder.
      // Always-on: this is a correctness leak-fix, not a measured quality lever.
      makeKill: (proc) => escalatingKill(proc, defaultPpidWalkKiller()),
      // RFC-04 — when the host wired an AgentMetaRegistry, thread it so
      // spawn_agent records depth/label for list_agents. Absent ⇒ no write.
      ...(config.subagentAgentMeta !== undefined ? { agentMeta: config.subagentAgentMeta } : {}),
    })
    extraTools.push(...set.tools)
    subagent6Cleanup = set.cleanup
  }

  const cleanup = async (): Promise<void> => {
    // Tear down any PTY children the 6-tool `exec_command` kept alive FIRST so
    // a live child can't outlive the registry teardown. No-op when 6-tool is
    // off (subagent6Cleanup is undefined).
    subagent6Cleanup?.()
    const ids = reg.pendingIds()
    // S17: host-side cleanup uses `forceStop` — not the token-gated `stop`.
    // The session owner has the authority to cancel ALL pending tasks at
    // shutdown regardless of who minted them; per-task owner tokens are
    // only the LLM-facing capability gate.
    for (const id of ids) reg.forceStop(id)
    // Await all settles in parallel. waitForSettle resolves immediately for
    // already-settled tasks, so this is bounded by the slowest in-flight
    // runner observing the abort and unwinding.
    await Promise.all(ids.map((id) => reg.waitForSettle(id)))
    // `forceStop` resolves the settler SYNCHRONOUSLY, so the await above can
    // return while the fire-and-forget child-runner promises are still
    // unwinding. Drain those tracked promises too so teardown is deterministic
    // (no child work outlives cleanup). Resolves immediately when none are in
    // flight — keeps the no-pending fast path bounded. drainRunners never
    // rejects (each tracked chain is rejection-swallowed).
    await reg.drainRunners()
  }
  // B2/B3 — surface the 6-tool-only knobs for a `Subagent6Deps` assembler.
  // Conditional-spread so absent config fields ⇒ `{}` (the consumer falls back
  // to the 6-tool handler defaults — 30s policy / unlimited concurrency).
  const subagent6Deps: SubagentBlock["subagent6Deps"] = {
    ...(config.subagent.waitTimeoutPolicy !== undefined
      ? { waitTimeoutPolicy: config.subagent.waitTimeoutPolicy }
      : {}),
    ...(config.subagent.maxConcurrent !== undefined
      ? { maxConcurrent: config.subagent.maxConcurrent }
      : {}),
  }
  return { extraTools, taskRegistry: reg, cleanup, subagent6Deps }
}
