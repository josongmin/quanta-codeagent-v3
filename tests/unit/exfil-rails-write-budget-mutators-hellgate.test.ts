/**
 * P0: Every filesystem-mutating tool must consume the same turn-local write
 * budget before its commit. `write` already had this rail; this file locks the
 * sibling mutation boundaries so a future tool-specific refactor cannot create
 * an unmetered edit/replace/patch escape hatch.
 */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { applyPatchTool } from "@/tool/apply-patch"
import { createSessionWriteBudget, bindWriteBudgetTurn, WRITE_BUDGET_REASON } from "@/tool/_shared/write-budget"
import { makeEditTool } from "@/tool/edit"
import { makeScriptedReplaceTool } from "@/tool/scripted-replace"
import type { Tool, ToolContext, ToolResult } from "@/tool/types"

const dir = mkdtempSync(join(tmpdir(), "exfil-budget-mutators-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const run = async (tool: Tool<never>, input: unknown, ctx: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const event of tool.execute(input as never, ctx)) {
    if (event.type === "result") result = event.result
  }
  if (result === undefined) throw new Error("tool produced no result")
  return result
}

const budgetCtx = (): ToolContext => {
  const session = createSessionWriteBudget({
    untrustedContext: true,
    maxWritesPerTurn: 1,
    overVerdict: "deny",
  })
  return {
    cwd: dir,
    signal: new AbortController().signal,
    writeBudget: bindWriteBudgetTurn(session, 0, 1),
  }
}

const expectBudgetDeny = (result: ToolResult): void => {
  expect(result.ok).toBe(false)
  expect(result.failure).toEqual({ mode: "rejected", reason: WRITE_BUDGET_REASON })
}

describe("P0 write-budget parity across mutators", () => {
  test("edit consumes the only slot; its second commit is denied without mutation", async () => {
    const path = join(dir, "edit.txt")
    writeFileSync(path, "one")
    const ctx = budgetCtx()
    const tool = makeEditTool()
    expect((await run(tool as Tool<never>, { path, old_string: "one", new_string: "two" }, ctx)).ok).toBe(true)
    const over = await run(tool as Tool<never>, { path, old_string: "two", new_string: "three" }, ctx)
    expectBudgetDeny(over)
    expect(readFileSync(path, "utf8")).toBe("two")
  })

  test("scripted_replace consumes the only slot; its second commit is denied without mutation", async () => {
    const path = join(dir, "scripted.txt")
    writeFileSync(path, "one")
    const ctx = budgetCtx()
    const tool = makeScriptedReplaceTool()
    expect((await run(tool as Tool<never>, { file: path, pattern: "one", replacement: "two" }, ctx)).ok).toBe(true)
    const over = await run(tool as Tool<never>, { file: path, pattern: "two", replacement: "three" }, ctx)
    expectBudgetDeny(over)
    expect(readFileSync(path, "utf8")).toBe("two")
  })

  test("apply_patch consumes one slot even for a multi-file patch; next patch is denied atomically", async () => {
    const first = join(dir, "patch-first.txt")
    const second = join(dir, "patch-second.txt")
    writeFileSync(first, "one\n")
    writeFileSync(second, "one\n")
    const ctx = budgetCtx()
    const tool = applyPatchTool as Tool<never>
    const twoFilePatch = `*** Begin Patch\n*** Update File: ${first}\n@@\n-one\n+two\n*** Update File: ${second}\n@@\n-one\n+two\n*** End Patch`
    expect((await run(tool, { patch: twoFilePatch }, ctx)).ok).toBe(true)
    const over = await run(tool, { patch: `*** Begin Patch\n*** Update File: ${first}\n@@\n-two\n+three\n*** End Patch` }, ctx)
    expectBudgetDeny(over)
    expect(readFileSync(first, "utf8")).toBe("two\n")
    expect(readFileSync(second, "utf8")).toBe("two\n")
  })
})
