/**
 * ADR-0036: cross-check every tool name in the v3 registry against the
 * plan-mode mutating table. A missing entry is a CI failure — adding a new
 * tool MUST consciously classify its mutating kind, or plan mode could
 * silently allow it. Conversely, table entries that no longer correspond
 * to a real tool are also flagged (drift in the other direction).
 */

import { describe, expect, test } from "bun:test"
import { isMutatingTool, planModeMutatingTable, UnknownToolError } from "@/agent/mode"
import {
  createUpdateWorkingStateTool,
  defaultTools,
  gitTools,
  lspNavTools,
  nullLspNavProvider,
  requestUserInputTool,
} from "@/tool"

describe("mode mutating-table cross-check (ADR-0036)", () => {
  // Caller-wire tools: registered ONLY when the relevant AgentConfig slot is
  // wired (ADR-0119/0122 shadow*, ADR-0130 subagent_*, ADR-0136 budget_status).
  // Their MUTATING_TOOL_TABLE entries are PERMANENT so plan-mode dispatch
  // cannot trip `UnknownToolError` on hosts that wire them. Cross-check
  // includes them by NAME so the orphan check tolerates the entries without
  // forcing every caller-wire factory to be reachable from this test.
  const callerWireToolNames = [
    "shadow_snapshots",
    "shadow_rewind",
    "shadow_restore_partial",
    "subagent_fork",
    "subagent_poll",
    "subagent_await",
    "budget_status",
    // S2 closeout: caller-wire tools added to MUTATING_TOOL_TABLE so plan-mode
    // dispatch never trips `UnknownToolError` regardless of which AgentConfig
    // slots are wired. Same allowlist convention as the entries above —
    // their factories are not enumerable from this test without forcing
    // every host port (gh runner / memory provider / branch-search isolator /
    // subagent runner / skill loader / workspace-search pipeline / web search
    // provider / image-url fetcher / user-input port) to be injected.
    "gh_pr_view",
    "gh_pr_list",
    "gh_pr_blame",
    "gh_pr_review_diff",
    "gh_issue_view",
    "gh_check_status",
    "gh_pr_comment",
    "gh_pr_create",
    "gh_pr_auto_merge",
    "memory_search",
    "memory_write",
    "memory_update",
    "branch_search",
    "task_output",
    "task_stop",
    "request_plan_exit",
    "agent",
    "Skill",
    "ToolSearch",
    "web_search",
    "search_codebase",
    "read_image_url",
    // jun-04 caller-wire tools — coverage_check (DefaultToolPorts.coverageCheck),
    // prompt_cache_status (wired observer), image_gen (DefaultToolPorts.imageGen),
    // and the Office authoring writers (DefaultToolPorts.officeAuthoring). Their
    // MUTATING_TOOL_TABLE entries are PERMANENT (plan-mode dispatch must never
    // throw UnknownToolError when a host injects them), but the factories aren't
    // enumerable here without forcing every gate on.
    "coverage_check",
    "prompt_cache_status",
    "image_gen",
    "xlsx_write",
    "docx_write",
    "pptx_write",
  ]
  const allTools = [
    ...defaultTools.map((t) => t.name),
    ...gitTools().map((t) => t.name),
    ...lspNavTools(nullLspNavProvider).map((t) => t.name),
    createUpdateWorkingStateTool(undefined).name,
    // ADR-0097 (Tier-S6) — `request_user_input` is registered conditionally
    // (only when `AgentConfig.userInputPort` is wired). Its MUTATING_TOOL_TABLE
    // entry (read-only / `null` kind) must still satisfy the cross-check.
    requestUserInputTool().name,
    ...callerWireToolNames,
  ]

  test("every registered tool name has an entry in the mutating table", () => {
    const table = planModeMutatingTable()
    const missing: string[] = []
    for (const name of allTools) {
      if (!(name in table)) missing.push(name)
    }
    expect(missing).toEqual([])
  })

  test("every entry in the mutating table corresponds to a known tool", () => {
    const table = planModeMutatingTable()
    const orphans: string[] = []
    for (const name of Object.keys(table)) {
      if (!allTools.includes(name)) orphans.push(name)
    }
    // Tools may exist in the table that are not in the *default* set if a
    // future tool is registered conditionally. For this baseline, the
    // assertion is exact — drift in either direction surfaces here.
    expect(orphans).toEqual([])
  })

  test("isMutatingTool returns boolean for every registered tool", () => {
    for (const name of allTools) {
      const v = isMutatingTool(name)
      expect(typeof v).toBe("boolean")
    }
  })

  test("isMutatingTool throws UnknownToolError for an unregistered name", () => {
    expect(() => isMutatingTool("totally_not_a_real_tool")).toThrow(UnknownToolError)
    try {
      isMutatingTool("nope_v2")
    } catch (err) {
      expect(err).toBeInstanceOf(UnknownToolError)
      expect((err as UnknownToolError).toolName).toBe("nope_v2")
    }
  })

  test("mutating kinds are exactly those expected for the v3 baseline", () => {
    const table = planModeMutatingTable()
    expect(table.write).toBe("write_filesystem")
    expect(table.edit).toBe("write_filesystem")
    expect(table.scripted_replace).toBe("write_filesystem")
    expect(table.bash).toBe("bash_mutating")
    expect(table.update_working_state).toBe("working_state_write")
    // ADR-0097 — `request_user_input` is read-only (host-port elicitation only;
    // no FS / shell touch). Tier resolves to "none" via `isReadOnly: true`.
    expect(table.request_user_input).toBeNull()
    expect(table.read).toBeNull()
    expect(table.grep).toBeNull()
    expect(table.glob).toBeNull()
    expect(table.diagnostics).toBeNull()
    expect(table.git_status).toBeNull()
    expect(table.git_diff).toBeNull()
    expect(table.search_codebase).toBeNull()
  })
})
