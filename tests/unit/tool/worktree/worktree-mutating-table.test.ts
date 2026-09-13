/**
 * ticket-11 (P8) reinforcement — worktree tools MUST be classified in the
 * plan-mode mutating table (and, since sep-13, enumerable rather than caller-wire).
 *
 * The worktree tools are caller-wire (registered only when `QUANTA_WORKTREE_TOOL`
 * mints `AgentConfig.activeWorktreeSlot`). Before this fix they were ABSENT from
 * `MUTATING_TOOL_TABLE`, so `isMutatingTool('enter_worktree')` / `('exit_worktree')`
 * THREW `UnknownToolError` — meaning plan-mode dispatch crashed on the wrong path
 * (fail-closed-but-wrong: an `UnknownToolError` instead of the proper
 * `PlanModeMutatingBlockedError`), and the mode-mutating-table ratchet was blind
 * to the omission. This seals both directions.
 */

import { describe, expect, test } from "bun:test"
import {
  CALLER_WIRE_TOOL_NAMES,
  isMutatingTool,
  mutatingToolKind,
  planModeMutatingTable,
} from "@/agent/mode"
import { WORKTREE_TOOL_NAMES } from "@/tool/worktree"

describe("worktree tools are classified in the plan-mode mutating table", () => {
  test("every worktree tool name has an entry in planModeMutatingTable", () => {
    const table = planModeMutatingTable()
    const missing = WORKTREE_TOOL_NAMES.filter((n) => !(n in table))
    expect(missing).toEqual([])
  })

  test("isMutatingTool does NOT throw for the worktree tools", () => {
    // Pre-fix these threw UnknownToolError (table omission) → RED here.
    expect(() => isMutatingTool("enter_worktree")).not.toThrow()
    expect(() => isMutatingTool("exit_worktree")).not.toThrow()
    expect(() => isMutatingTool("worktree_status")).not.toThrow()
  })

  test("enter/exit are mutating; status is read-only", () => {
    expect(isMutatingTool("enter_worktree")).toBe(true)
    expect(isMutatingTool("exit_worktree")).toBe(true)
    expect(isMutatingTool("worktree_status")).toBe(false)
    // enter creates a worktree (shell-backed); exit tears it down (git mutating).
    expect(mutatingToolKind("enter_worktree")).toBe("bash_mutating")
    expect(mutatingToolKind("exit_worktree")).toBe("git_mutating")
    expect(mutatingToolKind("worktree_status")).toBe(null)
  })

  test("the worktree tools are ENUMERABLE, so they are NOT on the caller-wire list", () => {
    // They used to be pinned INTO `CALLER_WIRE_TOOL_NAMES`, which vouched for their rows
    // by name. Since sep-13 both drift detectors enumerate the assembled universe, which
    // builds them through `buildSessionFeatures` with `activeWorktreeSlot` set — so a
    // vanished registration now surfaces as an orphan row instead of being hidden by the
    // list. The invariant is the inverse of what this test used to assert.
    const allowlist = [...CALLER_WIRE_TOOL_NAMES] as string[]
    for (const name of WORKTREE_TOOL_NAMES) {
      expect(allowlist, `${name} is back on the caller-wire list`).not.toContain(name)
    }
  })
})
