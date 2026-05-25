/**
 * S2 hellgate — MUTATING_TOOL_TABLE drift closeout + `agent.isReadOnly` fix.
 *
 * Adversarial pins for the 12 newly-added table entries + the `agent` tool's
 * corrected `isReadOnly` classification:
 *
 *   - Every new entry resolves WITHOUT throwing `UnknownToolError` (the
 *     original bug: plan-mode dispatch crashed when a host wired one of
 *     these tools).
 *   - Read-only entries (gh_pr_view/list/blame/review_diff, gh_issue_view,
 *     gh_check_status, memory_search, task_output, Skill, ToolSearch,
 *     web_search, read_image_url) return `null` from `mutatingToolKind` and
 *     pass `assertNotMutatingInPlanMode("plan", …)` silently.
 *   - Mutating entries throw `PlanModeMutatingBlockedError` carrying the
 *     correct typed kind:
 *       gh_pr_comment/create/auto_merge → "git_mutating"
 *       memory_write/update              → "memory_mutating"
 *       branch_search                    → "bash_mutating"
 *       task_stop                        → "subagent_control"
 *       agent                            → "subagent_spawn"
 *   - In `default` collab mode, every entry (mutating or not) passes —
 *     plan-mode is the only gate this seam owns.
 *   - The `agent` tool's `isReadOnly()` now returns `false` (was a lie
 *     returning `true`) — `inferToolTier` must route it to "always-confirm"
 *     instead of silently bypassing to "none".
 *   - Plan-mode dispatch with the `agent` tool blocks via the seam guard
 *     before any execute call.
 */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import {
  assertNotMutatingInPlanMode,
  isMutatingTool,
  mutatingToolKind,
  PlanModeMutatingBlockedError,
  planModeMutatingTable,
  UnknownToolError,
} from "@/agent/mode"
import type { ToolUseBlock } from "@/llm"
import { inferToolTier } from "@/permission"
import type { PermissionContext } from "@/permission"
import { createAgentTool } from "@/subagent"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

const READ_ONLY_NEW_ENTRIES = [
  "gh_pr_view",
  "gh_pr_list",
  "gh_pr_blame",
  "gh_pr_review_diff",
  "gh_issue_view",
  "gh_check_status",
  "memory_search",
  "task_output",
  "Skill",
  "ToolSearch",
  "web_search",
  "read_image_url",
] as const

const MUTATING_NEW_ENTRIES: ReadonlyArray<readonly [string, string]> = [
  ["gh_pr_comment", "git_mutating"],
  ["gh_pr_create", "git_mutating"],
  ["gh_pr_auto_merge", "git_mutating"],
  ["memory_write", "memory_mutating"],
  ["memory_update", "memory_mutating"],
  ["branch_search", "bash_mutating"],
  ["task_stop", "subagent_control"],
  ["agent", "subagent_spawn"],
]

describe("S2 — MUTATING_TOOL_TABLE drift closeout", () => {
  test("every newly-added entry is recognized by isMutatingTool (no UnknownToolError)", () => {
    for (const name of READ_ONLY_NEW_ENTRIES) {
      expect(() => isMutatingTool(name)).not.toThrow()
      expect(isMutatingTool(name)).toBe(false)
    }
    for (const [name] of MUTATING_NEW_ENTRIES) {
      expect(() => isMutatingTool(name)).not.toThrow()
      expect(isMutatingTool(name)).toBe(true)
    }
  })

  test("read-only entries resolve to null kind and pass plan-mode assertion silently", () => {
    for (const name of READ_ONLY_NEW_ENTRIES) {
      expect(mutatingToolKind(name)).toBeNull()
      expect(() => assertNotMutatingInPlanMode("plan", name)).not.toThrow()
      expect(() => assertNotMutatingInPlanMode("default", name)).not.toThrow()
    }
  })

  test("each mutating entry resolves to the documented kind", () => {
    const table = planModeMutatingTable()
    for (const [name, kind] of MUTATING_NEW_ENTRIES) {
      expect(table[name]).toBe(kind as never)
      expect(mutatingToolKind(name)).toBe(kind as never)
    }
  })

  test("plan-mode assertion throws PlanModeMutatingBlockedError with the correct kind for each mutating entry", () => {
    for (const [name, kind] of MUTATING_NEW_ENTRIES) {
      let caught: unknown
      try {
        assertNotMutatingInPlanMode("plan", name)
      } catch (err) {
        caught = err
      }
      expect(caught).toBeInstanceOf(PlanModeMutatingBlockedError)
      const e = caught as PlanModeMutatingBlockedError
      expect(e.toolName).toBe(name)
      expect(e.mutatingKind).toBe(kind as never)
    }
  })

  test("default-mode assertion is a no-op for every entry (mutating or not)", () => {
    for (const name of READ_ONLY_NEW_ENTRIES) {
      expect(() => assertNotMutatingInPlanMode("default", name)).not.toThrow()
    }
    for (const [name] of MUTATING_NEW_ENTRIES) {
      expect(() => assertNotMutatingInPlanMode("default", name)).not.toThrow()
    }
  })

  test("UnknownToolError still fires for a completely unregistered name (fail-closed preserved)", () => {
    expect(() => isMutatingTool("S2_brand_new_fake_tool_xyzzy")).toThrow(UnknownToolError)
  })

  test("gh_pr_* mutating trio all map to git_mutating (parity with git_commit)", () => {
    expect(mutatingToolKind("gh_pr_comment")).toBe("git_mutating")
    expect(mutatingToolKind("gh_pr_create")).toBe("git_mutating")
    expect(mutatingToolKind("gh_pr_auto_merge")).toBe("git_mutating")
  })

  test("memory_search read-only / memory_write+update mutating (asymmetric retrieval vs durable write)", () => {
    expect(isMutatingTool("memory_search")).toBe(false)
    expect(isMutatingTool("memory_write")).toBe(true)
    expect(isMutatingTool("memory_update")).toBe(true)
    expect(mutatingToolKind("memory_write")).toBe("memory_mutating")
    expect(mutatingToolKind("memory_update")).toBe("memory_mutating")
  })

  test("task_output read-only / task_stop mutating (poll-vs-cancel asymmetry)", () => {
    expect(isMutatingTool("task_output")).toBe(false)
    expect(isMutatingTool("task_stop")).toBe(true)
    expect(mutatingToolKind("task_stop")).toBe("subagent_control")
  })

  test("Skill + ToolSearch + web_search + read_image_url are read-only (prompt/registry surfaces)", () => {
    expect(isMutatingTool("Skill")).toBe(false)
    expect(isMutatingTool("ToolSearch")).toBe(false)
    expect(isMutatingTool("web_search")).toBe(false)
    expect(isMutatingTool("read_image_url")).toBe(false)
  })

  test("request_plan_exit is explicitly read-only so plan mode has a live exit seam", () => {
    expect(isMutatingTool("request_plan_exit")).toBe(false)
    expect(mutatingToolKind("request_plan_exit")).toBeNull()
    expect(() => assertNotMutatingInPlanMode("plan", "request_plan_exit")).not.toThrow()
  })
})

describe("S2 — agent.isReadOnly() lie fixed", () => {
  test("the `agent` tool now reports isReadOnly() === false", () => {
    const tool = createAgentTool({
      runner: async () => ({ ok: true, finalText: "ok", turns: 1 }),
    })
    expect(tool.isReadOnly()).toBe(false)
  })

  test("inferToolTier for the `agent` tool routes to 'always-confirm' (not 'none')", () => {
    const tool = createAgentTool({
      runner: async () => ({ ok: true, finalText: "ok", turns: 1 }),
    })
    // Build a HITLToolDuck-shaped object — only set hitlTier when the tool
    // actually carries one (exactOptionalPropertyTypes forbids `undefined`).
    const duck: { isReadOnly: () => boolean; hitlTier?: (input: unknown) => ReturnType<typeof inferToolTier> } = {
      isReadOnly: () => tool.isReadOnly(),
    }
    const ht = tool.hitlTier
    if (typeof ht === "function") {
      duck.hitlTier = (input: unknown) => ht.call(tool, input as never)
    }
    const tier = inferToolTier(duck, { task: "anything" })
    expect(tier).not.toBe("none")
    expect(tier).toBe("always-confirm")
  })
})

describe("S2 — plan-mode dispatch blocks the `agent` tool", () => {
  const makeFakeAgentTool = (): Tool =>
    ({
      name: "agent",
      description: "test agent stub",
      inputSchema: z.object({ task: z.string() }) as z.ZodType<unknown>,
      isReadOnly: () => false,
      isConcurrencySafe: () => false,
      // If this is ever reached in plan mode, the seam guard failed —
      // the test will fail because preview will not be "mode-blocked".
      execute: async function* (): AsyncIterable<ToolEvent> {
        yield { type: "result", result: { ok: true, output: "agent-ran" } }
      },
    }) as Tool

  const perm: PermissionContext = { mode: "acceptEdits" }
  const cfg = (over: Partial<AgentConfig>): AgentConfig =>
    ({
      registry: new ToolRegistry([makeFakeAgentTool()]),
      cwd: "/tmp",
      signal: new AbortController().signal,
      permission: perm,
      ...over,
    }) as AgentConfig
  const call = (input: unknown = { task: "x" }): ToolUseBlock => ({
    type: "tool_use",
    id: "a1",
    name: "agent",
    input,
  })

  test("planMode=true blocks `agent` via the seam guard (subagent_spawn kind)", async () => {
    const res = await dispatchTool(call(), cfg({ planMode: true }), perm)
    expect(res.ok).toBe(false)
    expect(res.preview).toBe("mode-blocked")
    expect(res.block.is_error).toBe(true)
    expect(res.block.content).toContain("agent")
    expect(res.block.content).toContain("blocked in plan collaboration mode")
    expect(res.block.content).toContain("subagent_spawn")
  })

  test("collaborationMode='default' explicitly allows `agent` even when planMode=true (precedence)", async () => {
    // resolveCollaborationMode: explicit collaborationMode wins over planMode.
    const res = await dispatchTool(
      call(),
      cfg({ planMode: true, collaborationMode: "default" }),
      perm,
    )
    // Either the call succeeds OR if it denies, the denial is NOT the
    // seam-guard's "mode-blocked" preview (could deny via downstream perm).
    if (!res.ok) {
      expect(res.preview).not.toBe("mode-blocked")
    }
  })
})
