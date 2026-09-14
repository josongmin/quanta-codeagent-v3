/**
 * Hellgate — a tool presented under a subagent namespace is still gated as itself.
 *
 * THE DEFECT (round-10 audit A2, reproduced). `namespaceRegistry` renamed each tool to
 * `<agent>__<name>`. Every policy at the dispatch seam is keyed by the tool's own name —
 * the ownership fence's tables, the deny-all permitted table, plan-mode rows, permission
 * rules — so a renamed tool matched none of them: `agent1__apply_patch` wrote outside a
 * fenced child's owned set, and `agent1__shadow_verify` ran under the deny-all posture.
 *
 * The registry now maps the presented name to the tool's own name, and dispatch runs every
 * gate under that name. Each arm dispatches through the REAL pipeline, with the same call
 * on the un-renamed registry as its paired control.
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import { buildNetworkDispatchGuard } from "@/agent/dispatch-guard"
import { buildOwnershipPolicy } from "@/agent/ownership-policy"
import { namespaceRegistry, prefixToolNamespace } from "@/agent/subagent-tool-namespace"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

let executed: string[] = []
const mkTool = (name: string, readOnly: boolean): Tool => ({
  name,
  description: `${name} test tool`,
  inputSchema: z.object({}).passthrough() as z.ZodType<unknown>,
  isReadOnly: () => readOnly,
  isConcurrencySafe: () => false,
  async *execute(): AsyncIterable<ToolEvent> {
    executed.push(name)
    yield { type: "result", result: { ok: true, output: "ran" } } satisfies ToolEvent
  },
})

const perm: PermissionContext = { mode: "bypass" }
const raw = (): ToolRegistry =>
  new ToolRegistry([
    mkTool("apply_patch", false),
    mkTool("shadow_verify", false),
    mkTool("read", true),
  ])
const renamed = (): ToolRegistry => namespaceRegistry(raw(), prefixToolNamespace, "agent1")
const call = (name: string, input: unknown): ToolUseBlock => ({
  type: "tool_use",
  id: `c-${name}`,
  name,
  input,
})
const cfg = (registry: ToolRegistry, over: Partial<AgentConfig>): AgentConfig =>
  ({
    registry,
    cwd: "/repo",
    signal: new AbortController().signal,
    permission: perm,
    ...over,
  }) as AgentConfig

const escapingPatch = {
  patch: "*** Begin Patch\n*** Add File: OUTSIDE.txt\n+x\n*** End Patch",
}

describe("the registry maps a presented name to the tool's own name", () => {
  test("policyNameOf and lookups by either name", () => {
    const r = renamed()
    expect(r.has("agent1__apply_patch")).toBe(true)
    expect(r.policyNameOf("agent1__apply_patch")).toBe("apply_patch")
    expect(r.policyNameOf("read")).toBe("read")
    expect(r.get("apply_patch")?.name).toBe("agent1__apply_patch")
    expect(raw().policyNameOf("apply_patch")).toBe("apply_patch")
  })
})

describe("a renamed tool is gated as itself", () => {
  const fenced = buildOwnershipPolicy({ owned: ["src"], cwd: "/repo", enforced: true })
  if (fenced === undefined) throw new Error("fixture: an enforced policy")

  test("RED: a renamed apply_patch outside the owned set is denied by the fence", async () => {
    executed = []
    const res = await dispatchTool(
      call("agent1__apply_patch", escapingPatch),
      cfg(renamed(), { ownershipPolicy: fenced }),
      perm,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.preview).toBe("ownership-policy-denied")
    expect(executed).toEqual([])
  })

  test("PAIRED CONTROL: the same call on the un-renamed registry is denied the same way", async () => {
    executed = []
    const res = await dispatchTool(
      call("apply_patch", escapingPatch),
      cfg(raw(), { ownershipPolicy: fenced }),
      perm,
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.preview).toBe("ownership-policy-denied")
  })

  test("RED: a renamed shadow_verify is refused under the deny-all posture; a renamed read runs", async () => {
    const guard = buildNetworkDispatchGuard({ posture: "denied" })
    if (guard === undefined) throw new Error("fixture: the denied posture builds a guard")
    executed = []
    const refused = await dispatchTool(
      call("agent1__shadow_verify", {}),
      cfg(renamed(), { dispatchGuard: guard }),
      perm,
    )
    expect(refused.ok).toBe(false)
    const allowed = await dispatchTool(
      call("agent1__read", {}),
      cfg(renamed(), { dispatchGuard: guard }),
      perm,
    )
    expect(allowed.ok).toBe(true)
    // `executed` records the name the tool was built with.
    expect(executed).toEqual(["read"])
  })
})
