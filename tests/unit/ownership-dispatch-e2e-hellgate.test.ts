/**
 * §20.4 / ticket-12 — DISPATCH E2E. Proves the FS-ownership gate fires inside the
 * REAL `dispatchTool` pipeline (after the admissibility gate, before execute): a
 * mutating write outside the child's owned set is HARD-DENIED (`ok:false`,
 * preview `ownership-policy-denied`); an owned write RUNS; default-OFF
 * (`enforced:false` / absent policy) ⇒ byte-identical (the write runs).
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import { buildOwnershipPolicy } from "@/agent/ownership-policy"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

const writeTool = (): Tool => ({
  name: "write",
  description: "write test tool",
  inputSchema: z.object({ path: z.string() }) as z.ZodType<unknown>,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  async *execute(): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: "wrote" } } satisfies ToolEvent
  },
})

const call = (path: string): ToolUseBlock => ({
  type: "tool_use",
  id: "c1",
  name: "write",
  input: { path },
})

const perm: PermissionContext = { mode: "acceptEdits" }
const baseCfg = (over: Partial<AgentConfig> = {}): AgentConfig =>
  ({
    registry: new ToolRegistry([writeTool()]),
    cwd: "/repo",
    signal: new AbortController().signal,
    permission: perm,
    ...over,
  }) as AgentConfig

const enforced = buildOwnershipPolicy({ owned: ["src"], cwd: "/repo", enforced: true })

describe("§20.4 dispatch E2E — ownership gate fires in the real pipeline", () => {
  test("ENFORCED: write OUTSIDE owned ⇒ HARD-DENIED at dispatch", async () => {
    const res = await dispatchTool(
      call("/repo/docs/readme.md"),
      baseCfg({ ownershipPolicy: enforced }),
      perm,
    )
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error("expected deny")
    expect(res.preview).toBe("ownership-policy-denied")
    expect(res.block.is_error).toBe(true)
    expect(res.block.content.toLowerCase()).toContain("ownership boundary")
  })

  test("ENFORCED: write INSIDE owned ⇒ RUNS", async () => {
    const res = await dispatchTool(
      call("/repo/src/main.ts"),
      baseCfg({ ownershipPolicy: enforced }),
      perm,
    )
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error("expected run")
    expect(res.preview).toBe("wrote")
  })

  test("DEFAULT-OFF: enforced:false ⇒ write outside owned RUNS (byte-identical)", async () => {
    const off = buildOwnershipPolicy({ owned: ["src"], cwd: "/repo", enforced: false })
    const res = await dispatchTool(call("/repo/docs/x"), baseCfg({ ownershipPolicy: off }), perm)
    expect(res.ok).toBe(true)
  })

  test("DEFAULT-OFF: NO policy ⇒ write outside owned RUNS (byte-identical)", async () => {
    const res = await dispatchTool(call("/repo/docs/x"), baseCfg(), perm)
    expect(res.ok).toBe(true)
  })
})
