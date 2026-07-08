/**
 * HELLGATE — ALBB-16 #3: workflow adapter must NOT reset recursion depth.
 *
 * `tier1/subagent.ts` mints the `run_workflow` tool via
 * `subagentRunnerToAgentRunPort(runner, { depth: ... })`. The buggy impl stamped
 * a CONSTANT `{ depth: 1 }`, so a deep child that mints its own `run_workflow`
 * resets the accumulated depth to 1 and BYPASSES the runner's `maxDepth` bound.
 *
 * This test spies the `subagentRunnerToAgentRunPort` call site (namespace spy —
 * `mockRestore`-able, unlike `mock.module` which leaks across files) and asserts
 * the call site passes `depth = (config.depth ?? 0) + 1`. With
 * `config.depth = maxDepth` the child therefore lands at `maxDepth + 1`, so the
 * runner's `req.depth > maxDepth` deny fires (recursion bound is honored). No
 * real subagent loop is spawned — the spy returns a stub port.
 *
 * MUTATION: the constant `{ depth: 1 }` impl passes `1` regardless of
 * `config.depth`, so this goes RED the moment the defect is reintroduced.
 */
import { afterAll, afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as adapter from "@/agent/workflow-agent-adapter"
import type { AgentConfig } from "@/agent/types"
import type { AgentRunPort } from "@/workflow"

// Capture the `options.depth` the tier-1 call site stamps on the workflow
// adapter. Namespace spy so the ONLY thing under test is the depth the call
// site threads through — no real subagent loop is spawned.
const capturedDepths: Array<number | undefined> = []

const spy = spyOn(adapter, "subagentRunnerToAgentRunPort").mockImplementation(
  (_runner: unknown, options: { depth?: number } = {}): AgentRunPort => {
    capturedDepths.push(options.depth)
    return {
      async run() {
        return { ok: false, text: "", errorMessage: "spy adapter — no real spawn" }
      },
    }
  },
)

// Import AFTER the spy is installed so `buildSubagentBlock` calls through it.
const { buildSubagentBlock } = await import("@/agent/tier1/subagent")

beforeEach(() => {
  capturedDepths.length = 0
})
afterEach(() => {
  capturedDepths.length = 0
})
// Restore the real adapter so this file's spy never leaks into sibling suites.
afterAll(() => {
  spy.mockRestore()
})

// Minimal AgentConfig stub — buildSubagentBlock reads `config.subagent` and
// `config.depth`; createSubagentRunner reads a few identity fields off the parent
// but never spawns here (the adapter is spied). Cast keeps the test focused.
const cfg = (over: Partial<AgentConfig>): AgentConfig =>
  ({
    subagent: { enableWorkflow: true, maxDepth: 3 },
    ...over,
  }) as unknown as AgentConfig

describe("ALBB-16 #3 — workflow depth propagation (no reset to 1)", () => {
  test("a deep parent (config.depth = maxDepth) stamps depth = maxDepth + 1", () => {
    const maxDepth = 3
    const block = buildSubagentBlock(
      cfg({ depth: maxDepth, subagent: { enableWorkflow: true, maxDepth } }),
    )
    expect(block?.extraTools.some((t) => t.name === "run_workflow")).toBe(true)
    // The call site ran during block build; it must have threaded the ACCUMULATED
    // depth, not the constant 1.
    expect(capturedDepths).toContain(maxDepth + 1)
    expect(capturedDepths).not.toContain(1)
  })

  test("a root parent (config.depth undefined) stamps depth = 1 (0 + 1)", () => {
    const block = buildSubagentBlock(cfg({ subagent: { enableWorkflow: true, maxDepth: 3 } }))
    expect(block?.extraTools.some((t) => t.name === "run_workflow")).toBe(true)
    // (config.depth ?? 0) + 1 = 1 at the root — same net value as the old
    // constant for the root case (byte-identical there), so this asserts the
    // FORMULA, not just any non-1 value.
    expect(capturedDepths).toContain(1)
  })

  test("depth 1 (one level deep) stamps depth = 2", () => {
    const block = buildSubagentBlock(
      cfg({ depth: 1, subagent: { enableWorkflow: true, maxDepth: 3 } }),
    )
    expect(block?.extraTools.some((t) => t.name === "run_workflow")).toBe(true)
    expect(capturedDepths).toContain(2)
  })
})
