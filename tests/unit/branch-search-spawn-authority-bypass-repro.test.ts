/**
 * REPRO (audit AUDIT-2026-07-14, finding D1) — `branch_search` bypasses the
 * spawn-depth AUTHORITY.
 *
 * rev.4 nesting-control makes the subagent-runner reject
 * (`childDepthOf(parent) > effectiveCap`) the single authority for descendant
 * admission, and `projectSpawnTools` removes creation vectors from a leaf's tool
 * set. BUT `branch_search`:
 *
 *   1. is NOT in `SPAWN_TOOL_NAMES` — so `projectSpawnTools` never withholds it.
 *   2. spawns candidates via a DIRECT `runAgent(child)` in
 *      `bindBranchRunCandidate` (branch-search-runner.ts) — it never crosses the
 *      `createSubagentRunner`/`childDepthOf`/`effectiveCap` reject.
 *
 * RFC §10 "Complete path coverage" acceptance criterion:
 *   > `branch_search` cap0 → candidate `runAgent` 0회.
 *
 * i.e. under the operator KILL-SWITCH `QUANTA_MAX_DESCENDANT_DEPTH=0`, a
 * branch-search candidate must NOT run. This test drives the REAL binder
 * (`bindBranchRunCandidate`) with `runAgent` stubbed and asserts the stub is
 * NEVER called when the cap forbids the child depth.
 *
 * CURRENT STATE: `bindBranchRunCandidate` has NO cap check, so it calls
 * `runAgent` unconditionally ⇒ this test is RED (documents the hole). Blast
 * radius is bounded (branchSearch is ROOT-only — never propagated to children by
 * `buildChildConfig`, and candidates get `branchSearch` stripped), but the RFC's
 * stated kill-switch completeness is not met. When the binder is fixed to skip
 * the fork on `!canAdmitChildDepth(childDepthOf(config), effectiveCap(...))`,
 * this flips GREEN.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

const runAgentCalls: number[] = []

// Stub the loop's `runAgent` BEFORE importing the binder so the binder closes
// over the stub (mock.module hoists for subsequent imports in this file).
mock.module("@/agent/loop", () => ({
  runAgent: async (child: { depth?: number }) => {
    runAgentCalls.push(child.depth ?? 0)
    return { reason: "completed", messages: [], turns: 1 }
  },
}))

const { bindBranchRunCandidate } = await import("@/agent/branch-search-runner")
const { __resetRuntimeConfig } = await import("@/shared/runtime-config")

let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedEnv = { ...process.env }
  runAgentCalls.length = 0
  __resetRuntimeConfig()
})
afterEach(() => {
  process.env = savedEnv
  __resetRuntimeConfig()
})

// Minimal AgentConfig the binder reads (depth + cwd + llm; the stub ignores the
// rest). Cast through unknown — the binder only touches these fields on the
// cap-0 path we exercise.
const rootConfig = (): Parameters<typeof bindBranchRunCandidate>[0] =>
  ({ depth: 0, cwd: "/tmp", llm: {} }) as unknown as Parameters<typeof bindBranchRunCandidate>[0]

const candidateArgs = () =>
  ({
    id: "c0",
    seed: {},
    workspace: "/tmp/ws",
    task: "do X",
    baseLlm: {},
    signal: new AbortController().signal,
  }) as unknown as Parameters<ReturnType<typeof bindBranchRunCandidate>>[0]

describe("branch_search kill-switch bypass (repro)", () => {
  test("cap-0 (kill switch): the branch-search candidate MUST NOT fork runAgent", async () => {
    process.env.QUANTA_MAX_DESCENDANT_DEPTH = "0"
    __resetRuntimeConfig()

    const run = bindBranchRunCandidate(rootConfig())
    await run(candidateArgs())

    // RFC §10: branch_search cap0 ⇒ candidate runAgent 0회. RED today: the binder
    // ignores the operator cap and forks the depth-1 candidate anyway.
    expect(runAgentCalls).toHaveLength(0)
  })

  test("default cap 1: a root's depth-1 candidate IS allowed to fork (no false-positive)", async () => {
    delete process.env.QUANTA_MAX_DESCENDANT_DEPTH
    __resetRuntimeConfig()

    const run = bindBranchRunCandidate(rootConfig())
    await run(candidateArgs())

    expect(runAgentCalls).toEqual([1]) // depth-1 candidate forked, admitted by cap 1
  })
})
