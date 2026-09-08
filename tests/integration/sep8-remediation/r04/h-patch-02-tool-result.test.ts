/**
 * H-PATCH-02.4 — Incomplete must reach the model-facing tool_result.
 * messageForModel is honest in-slice; dispatch still has to forward the
 * thrown error text (LocalEffectChannel → decorateToolOutput) without
 * rewriting it into a clean "unchanged" restore.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { dispatchTool } from "@/agent/dispatch"
import type { AgentConfig } from "@/agent/types"
import type { ToolUseBlock } from "@/llm"
import { messageForModel, PatchRollbackIncompleteError } from "@/patch"
import type { PermissionContext } from "@/permission"
import { __resetDefaultPermissionStore } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

const incomplete = new PatchRollbackIncompleteError(new Error("injected commit failure"), [
  { path: "A.txt", cause: "undo write failed" },
])

const throwIncomplete: Tool = {
  name: "apply_patch",
  description: "stub",
  inputSchema: z.object({ patch: z.string() }),
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  execute: async function* (): AsyncIterable<ToolEvent> {
    yield { type: "progress", message: "applying" }
    throw incomplete
  },
}

const perm: PermissionContext = { mode: "bypass" }

const config = (): AgentConfig =>
  ({
    registry: new ToolRegistry([throwIncomplete]),
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: perm,
  }) as AgentConfig

const call: ToolUseBlock = {
  type: "tool_use",
  id: "c1",
  name: "apply_patch",
  input: { patch: "*** Begin Patch\n*** End Patch" },
}

let permissionStateRoot: string | null = null

beforeEach(() => {
  permissionStateRoot = mkdtempSync(join(tmpdir(), "h-patch-02-perm-"))
  process.env.QUANTA_PERMISSION_STATE = join(permissionStateRoot, "permission-state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

afterEach(() => {
  if (permissionStateRoot !== null) {
    rmSync(permissionStateRoot, { recursive: true, force: true })
    permissionStateRoot = null
  }
  delete process.env.QUANTA_PERMISSION_STATE
})

describe("H-PATCH-02.4 Incomplete reaches the model-facing tool result", () => {
  test("formatter and dispatch preview both refuse unchanged/rolled-back wording", async () => {
    const hint = messageForModel(incomplete)
    expect(hint).toMatch(/incomplete/i)
    expect(hint).not.toContain("the file is unchanged")
    expect(hint).not.toMatch(/was rolled back/)

    const res = await dispatchTool(call, config(), perm)
    expect(res.ok).toBe(false)
    expect(res.preview).toContain("rollback was incomplete")
    expect(res.preview).toContain("A.txt")
    expect(res.preview).not.toContain("the file is unchanged")
    expect(res.preview).not.toMatch(/was rolled back/)
    expect(res.block.content).toContain("rollback was incomplete")
  })
})
