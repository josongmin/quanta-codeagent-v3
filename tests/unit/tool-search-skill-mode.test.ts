/**
 * RFC03-1 — ToolSearch `catalog:"skills"` mode.
 *
 * Additive skill-catalog mode over `createToolSearchTool`. Contract:
 *   - `catalog` defaults to `"tools"` ⇒ existing tool-mode behavior is
 *     byte-identical (no skill provider needed).
 *   - `catalog:"skills"` runs DETERMINISTIC field filters over the SAME pinned
 *     `SkillRegistry.entries` snapshot the session built — exact name, name
 *     prefix, scope. NO fuzzy/weighted scorer, NO standalone tool, NO second
 *     discovery. The winner for an exact lookup is exactly the registry winner.
 *   - skill mode returns bounded metadata (name/scope/description) only; the
 *     exact `Skill` tool loads the body.
 *
 * Anti-vacuous: assert the concrete returned skill names + that a skill NOT in
 * the pinned snapshot can never appear, and that the exact winner matches the
 * registry lookup (single source, no drift).
 */
import { describe, expect, test } from "bun:test"
import type { SkillRegistryEntry } from "@/skill"
import { createToolSearchTool } from "@/skill"
import type { ToolContext, ToolResult, ToolSpec } from "@/tool"

const CTX: ToolContext = { cwd: "/", signal: new AbortController().signal }

const run = async (
  tool: { execute: (i: never, c: ToolContext) => AsyncIterable<unknown> },
  input: unknown,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, CTX)) {
    const e = ev as { type: string; result?: ToolResult }
    if (e.type === "result") result = e.result
  }
  if (!result) throw new Error("tool produced no result")
  return result
}

const entry = (
  name: string,
  scope: SkillRegistryEntry["winnerScope"],
  description = `${name} desc`,
): SkillRegistryEntry =>
  ({
    skill: { name, description, body: "b", sourcePath: `/x/${name}`, scope },
    winnerScope: scope,
    overriddenScopes: [],
  }) as unknown as SkillRegistryEntry

const TOOLS = (): ToolSpec[] => [
  { name: "read_file", description: "Read a file", input_schema: { type: "object" } },
  { name: "write_file", description: "Write a file", input_schema: { type: "object" } },
]

const SKILLS = (): readonly SkillRegistryEntry[] => [
  entry("localize-fault", "system"),
  entry("localize-bug", "user"),
  entry("progress-audit", "system"),
]

describe("RFC03-1 ToolSearch skill mode", () => {
  test("default catalog is tools (byte-identical: no skill provider needed)", async () => {
    const tool = createToolSearchTool(TOOLS)
    const r = await run(tool, { query: "read" })
    expect(r.output).toContain("read_file")
    expect(r.output).not.toContain("localize-fault")
  })

  test("catalog:'skills' select: exact name resolves the registry winner", async () => {
    const tool = createToolSearchTool(TOOLS, SKILLS)
    const r = await run(tool, { query: "select:localize-fault", catalog: "skills" })
    expect(r.output).toContain("localize-fault")
    // metadata only — no tool schemas leak in.
    expect(r.output).not.toContain("read_file")
    expect(r.output).not.toContain("progress-audit")
  })

  test("catalog:'skills' prefix filter returns all name-prefix matches", async () => {
    const tool = createToolSearchTool(TOOLS, SKILLS)
    const r = await run(tool, { query: "localize", catalog: "skills" })
    expect(r.output).toContain("localize-fault")
    expect(r.output).toContain("localize-bug")
    expect(r.output).not.toContain("progress-audit")
  })

  test("catalog:'skills' can NEVER return a skill outside the pinned snapshot", async () => {
    const tool = createToolSearchTool(TOOLS, SKILLS)
    const r = await run(tool, { query: "select:phantom-skill", catalog: "skills" })
    // No phantom is RENDERED as an entry (no `### phantom-skill` heading);
    // it is only echoed in the deterministic "Unknown:" not-found affordance.
    expect(r.output).not.toContain("### phantom-skill")
    expect(r.output.toLowerCase()).toContain("no matching skills")
    expect(r.output).toContain("Unknown: phantom-skill")
  })

  test("catalog:'skills' scope filter narrows to a single scope", async () => {
    const tool = createToolSearchTool(TOOLS, SKILLS)
    const r = await run(tool, { query: "localize", catalog: "skills", scope: "user" })
    expect(r.output).toContain("localize-bug")
    expect(r.output).not.toContain("localize-fault")
  })

  test("catalog:'skills' with no provider ⇒ empty (no crash, no phantom)", async () => {
    const tool = createToolSearchTool(TOOLS)
    const r = await run(tool, { query: "localize", catalog: "skills" })
    expect(r.output.toLowerCase()).toContain("no matching skills")
    expect(r.output).not.toContain("localize-")
  })
})
