/** F1 — MCP bridged tool-name COLLISION must never silently shadow a tool.
 *
 *  `mcpToolName` sanitizes free-form server/tool names through
 *  `replace(/[^A-Za-z0-9_]+/g, "_")`, and the tool registry is a name-keyed Map
 *  with LAST-WRITE-WINS. So two distinct source tools — across servers
 *  (`my-srv` vs `my_srv`) or on one server (`get.x` vs `get-x`) — can collapse to
 *  the SAME bridged name and one becomes silently uncallable.
 *
 *  `disambiguateMcpToolNames` is the assembler pass that DETECTS the collision
 *  and disambiguates the later tool with a deterministic `_<n>` suffix so BOTH
 *  stay callable, emitting a warn + an observable collision record. The first
 *  claimant keeps its name verbatim, so the non-colliding case is byte-identical.
 *
 *  TEETH: the old silent last-write-wins drops one tool with no record — proven
 *  here by feeding the SAME colliding set into a bare `ToolRegistry` (the registry
 *  the bridge would feed) and showing one tool is gone with zero disclosure. */

import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { disambiguateMcpToolNames, mcpToolName } from "@/agent"
import { type Tool, type ToolEvent, ToolRegistry } from "@/tool"

/** A minimal `Tool` whose `execute` yields a result tagging WHICH source tool
 *  ran — so we can prove BOTH colliding tools remain independently callable
 *  (the disambiguated one did not get shadowed by the first). */
const fakeTool = (name: string, tag: string): Tool => ({
  name,
  description: `tool ${tag}`,
  inputSchema: z.record(z.unknown()),
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  async *execute(): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: tag } }
  },
})

describe("mcpToolName — the sanitizer that creates the collision", () => {
  test("`my-srv` and `my_srv` sanitize to the SAME bridged name", () => {
    expect(mcpToolName("my-srv", "x")).toBe(mcpToolName("my_srv", "x"))
  })
  test("`get.x` and `get-x` on one server sanitize to the SAME bridged name", () => {
    expect(mcpToolName("srv", "get.x")).toBe(mcpToolName("srv", "get-x"))
  })
})

describe("F1 — disambiguateMcpToolNames keeps both colliding tools callable", () => {
  test("cross-server collision ⇒ second renamed with _2, both recorded", () => {
    const a = mcpToolName("my-srv", "x") // mcp__my_srv__x
    const b = mcpToolName("my_srv", "x") // identical
    expect(a).toBe(b)
    const { tools, collisions } = disambiguateMcpToolNames([fakeTool(a, "A"), fakeTool(b, "B")])
    expect(tools[0]?.name).toBe(a) // first claimant unchanged
    expect(tools[1]?.name).toBe(`${a}_2`) // later one disambiguated
    expect(tools[0]?.name).not.toBe(tools[1]?.name) // both callable identities
    // OBSERVABLE record (never silent)
    expect(collisions).toEqual([{ kept: a, renamed: a, to: `${a}_2` }])
  })

  test("same-server collision (get.x vs get-x) ⇒ both survive", () => {
    const a = mcpToolName("srv", "get.x")
    const b = mcpToolName("srv", "get-x")
    const { tools, collisions } = disambiguateMcpToolNames([
      fakeTool(a, "DOT"),
      fakeTool(b, "DASH"),
    ])
    expect(new Set(tools.map((t) => t.name)).size).toBe(2)
    expect(collisions).toHaveLength(1)
  })

  test("triple collision ⇒ _2 then _3 (smallest free suffix)", () => {
    const n = mcpToolName("s", "t")
    const { tools } = disambiguateMcpToolNames([
      fakeTool(n, "1"),
      fakeTool(n, "2"),
      fakeTool(n, "3"),
    ])
    expect(tools.map((t) => t.name)).toEqual([n, `${n}_2`, `${n}_3`])
  })

  test("no collision ⇒ byte-identical (every name unchanged, no record)", () => {
    const tools = [fakeTool(mcpToolName("a", "x"), "AX"), fakeTool(mcpToolName("b", "y"), "BY")]
    const { tools: out, collisions } = disambiguateMcpToolNames(tools)
    expect(out.map((t) => t.name)).toEqual(tools.map((t) => t.name))
    expect(collisions).toEqual([])
  })

  test("disambiguated tools register + run independently (both callable)", async () => {
    const a = mcpToolName("my-srv", "x")
    const b = mcpToolName("my_srv", "x")
    const { tools } = disambiguateMcpToolNames([fakeTool(a, "A"), fakeTool(b, "B")])
    const reg = new ToolRegistry(tools)
    const ctx = { cwd: process.cwd() } as never
    const r1 = await reg.run(tools[0]!.name, {}, ctx)
    const r2 = await reg.run(tools[1]!.name, {}, ctx)
    expect(r1.output).toBe("A")
    expect(r2.output).toBe("B") // NOT shadowed — both reachable
  })
})

describe("F1 TEETH — the OLD silent last-write-wins loses a tool with no record", () => {
  test("feeding the raw colliding set to the registry drops one silently", async () => {
    const a = mcpToolName("my-srv", "x")
    const b = mcpToolName("my_srv", "x")
    // The PRE-FIX path: bridged tools go straight into the name-keyed registry.
    const reg = new ToolRegistry([fakeTool(a, "A"), fakeTool(b, "B")])
    // Only ONE name exists — the collision silently collapsed two tools to one,
    // and last-write-wins means "A" is gone with zero disclosure.
    expect(reg.has(a)).toBe(true)
    const ctx = { cwd: process.cwd() } as never
    const r = await reg.run(a, {}, ctx)
    expect(r.output).toBe("B") // "A" was silently shadowed — the bug F1 fixes
  })
})
