/**
 * Hellgate — bench test-scope dispatch guard (RCA 2026-06-19, django-13417).
 *
 * The guard DENIES a mutating tool whose target is a test path when
 * `config.protectTestPaths` is set, so the bench agent cannot edit tests, chase
 * its own modified tests, and regress an already-correct minimal fix. These
 * tests prove: (1) a test-path edit is blocked AND the tool never executes;
 * (2) a source-path edit passes through and executes; (3) apply_patch V4A
 * touching a test file is blocked (no apply_patch hole); (4) with the flag OFF
 * the SAME test-path edit executes (red-on-injection — the guard, not some
 * other gate, is what blocks).
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { PermissionContext } from "@/permission"
import { type Tool, type ToolEvent, ToolRegistry } from "@/tool"
import type { ToolUseBlock } from "@/llm/types"

const makeMutating = (name: string, schema: z.ZodTypeAny): Tool => ({
  name,
  description: `${name} test tool`,
  inputSchema: schema as z.ZodType<unknown>,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  execute: async function* (): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: "EXECUTED" } }
  },
})

const editTool = makeMutating("edit", z.object({ path: z.string() }).passthrough())
const applyPatchTool = makeMutating("apply_patch", z.object({ patch: z.string() }).passthrough())

const config = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    registry: new ToolRegistry([editTool, applyPatchTool]),
    cwd: "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "acceptEdits" } as PermissionContext,
    ...over,
  }) as AgentConfig

const call = (name: string, input: unknown): ToolUseBlock => ({ type: "tool_use", id: "c1", name, input })
const perm: PermissionContext = { mode: "acceptEdits" }

describe("dispatch test-scope guard", () => {
  test("protectTestPaths ON: edit to a tests/ path is DENIED and the tool never runs", async () => {
    const res = await dispatchTool(
      call("edit", { path: "tests/queries/tests.py", old_string: "a", new_string: "b" }),
      config({ protectTestPaths: true }),
      perm,
    )
    expect(res.preview).toBe("test-scope-blocked")
    // teeth: the tool did NOT execute (no "EXECUTED" in the result content)
    expect(JSON.stringify(res)).not.toContain("EXECUTED")
  })

  test("protectTestPaths ON: edit to a test_*.py file (outside tests/ dir) is DENIED", async () => {
    const res = await dispatchTool(
      call("edit", { path: "django/foo/test_views.py", old_string: "a", new_string: "b" }),
      config({ protectTestPaths: true }),
      perm,
    )
    expect(res.preview).toBe("test-scope-blocked")
  })

  test("protectTestPaths ON: edit to a SOURCE path passes through and EXECUTES", async () => {
    const res = await dispatchTool(
      call("edit", { path: "django/db/models/query.py", old_string: "a", new_string: "b" }),
      config({ protectTestPaths: true }),
      perm,
    )
    expect(res.preview).not.toBe("test-scope-blocked")
    expect(JSON.stringify(res)).toContain("EXECUTED")
  })

  test("protectTestPaths ON: apply_patch V4A touching a test file is DENIED (no apply_patch hole)", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: tests/queries/tests.py",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n")
    const res = await dispatchTool(call("apply_patch", { patch }), config({ protectTestPaths: true }), perm)
    expect(res.preview).toBe("test-scope-blocked")
  })

  test("protectTestPaths ON: apply_patch V4A touching ONLY source executes", async () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: django/db/models/query.py",
      "@@",
      "-old",
      "+new",
      "*** End Patch",
    ].join("\n")
    const res = await dispatchTool(call("apply_patch", { patch }), config({ protectTestPaths: true }), perm)
    expect(res.preview).not.toBe("test-scope-blocked")
  })

  test("RED-on-injection: with the flag OFF, the SAME tests/ edit EXECUTES (guard is what blocks)", async () => {
    const res = await dispatchTool(
      call("edit", { path: "tests/queries/tests.py", old_string: "a", new_string: "b" }),
      config(), // protectTestPaths absent ⇒ guard OFF
      perm,
    )
    expect(res.preview).not.toBe("test-scope-blocked")
    expect(JSON.stringify(res)).toContain("EXECUTED")
  })
})
