/**
 * HELLGATE — the `/agents` Sub-Agents panel: `--tree` spawn view, `inspect`
 * drill-in, description-cap mutation pin, and BYTE-IDENTICAL pins for the
 * pre-existing table + json paths (additive change ⇒ default output unchanged).
 *
 * Colour is stripped because these tests run with no TTY / colour policy "off",
 * so the assertions match plain glyphs + labels.
 */
import { describe, expect, test } from "bun:test"
import { type AgentFleetRow, renderAgentFleet, renderAgentInspect } from "./agents-fleet-panel"

const NOW = 10_000

/** `over` allows explicit `undefined` per field so a test can pass
 *  `parentTaskId: undefined` (a ROOT node) verbatim under
 *  exactOptionalPropertyTypes. Undefined values are erased by the spread. */
type RowOver = { [K in keyof AgentFleetRow]?: AgentFleetRow[K] | undefined } & { id: string }
const row = (over: RowOver): AgentFleetRow => ({
  id: over.id,
  description: over.description ?? `task ${over.id}`,
  status: over.status ?? "running",
  startedAt: over.startedAt ?? 0,
  ...(over.agentType !== undefined ? { agentType: over.agentType } : {}),
  ...(over.endedAt !== undefined ? { endedAt: over.endedAt } : {}),
  ...(over.result !== undefined ? { result: over.result } : {}),
  ...(over.error !== undefined ? { error: over.error } : {}),
  ...(over.parentTaskId !== undefined ? { parentTaskId: over.parentTaskId } : {}),
  ...(over.depth !== undefined ? { depth: over.depth } : {}),
  ...(over.mailboxLabel !== undefined ? { mailboxLabel: over.mailboxLabel } : {}),
})

// root  ─ child ─ grandchild
//       ─ sibling
const child = row({ id: "task_child", agentType: "explorer", parentTaskId: undefined, depth: 1 })
const grandchild = row({
  id: "task_gc",
  agentType: "coder",
  parentTaskId: "task_child",
  depth: 2,
  description: "dig into the parser",
})
const sibling = row({ id: "task_sib", agentType: "reviewer", parentTaskId: undefined, depth: 1 })
const fleet = [child, grandchild, sibling]

describe("renderAgentFleet --tree — spawn tree", () => {
  const out = renderAgentFleet(fleet, { format: "tree", now: NOW })

  test("nests grandchild indented UNDER its parent (structure, not type-grouped)", () => {
    const lines = out.split("\n")
    const childLine = lines.findIndex((l) => l.includes("explorer"))
    const gcLine = lines.findIndex((l) => l.includes("coder"))
    expect(childLine).toBeGreaterThanOrEqual(0)
    expect(gcLine).toBeGreaterThan(childLine) // grandchild AFTER parent
    // grandchild indented deeper than parent (2-space per level)
    const indentOf = (l: string): number => l.length - l.replace(/^[│╭╰]?\s*/, "").length
    expect(indentOf(lines[gcLine] ?? "")).toBeGreaterThan(indentOf(lines[childLine] ?? ""))
  })

  test("carries status glyph + depth badge + bounded description preview", () => {
    expect(out).toContain("●") // running glyph
    expect(out).toContain("d2") // grandchild depth badge
    expect(out).toContain("dig into the parser")
  })

  test("title is the Sub-agents view (distinct from the flat fleet table)", () => {
    expect(out).toContain("Sub-agents")
  })

  // ─── MUTATION pin: unbounded description length-cap ────────────────────
  test("MUTATION desc-cap: a 200-char description is truncated with an ellipsis", () => {
    const huge = row({ id: "task_h", parentTaskId: undefined, description: "X".repeat(200) })
    const o = renderAgentFleet([huge], { format: "tree", now: NOW })
    expect(o).toContain("…") // ellipsised
    // the full 200-run never appears verbatim (cap enforced)
    expect(o.includes("X".repeat(200))).toBe(false)
    // and the visible run is bounded well under 200
    const longestXRun = (o.match(/X+/g) ?? []).reduce((m, s) => Math.max(m, s.length), 0)
    expect(longestXRun).toBeLessThan(60)
  })

  test("--depth 0 shows roots only (grandchild pruned)", () => {
    const o = renderAgentFleet(fleet, { format: "tree", now: NOW, maxDepth: 0 })
    expect(o).toContain("explorer")
    expect(o).toContain("reviewer")
    expect(o).not.toContain("coder") // grandchild at renderDepth 1 pruned
  })

  test("orphan (evicted parent) rendered at root with a marker, not dropped", () => {
    const orphan = row({ id: "task_o", agentType: "ghost", parentTaskId: "task_GONE" })
    const o = renderAgentFleet([orphan], { format: "tree", now: NOW })
    expect(o).toContain("ghost")
    expect(o).toContain("orphan")
  })

  test("cycle does not throw / hang and renders both nodes", () => {
    const a = row({ id: "task_A", agentType: "aa", parentTaskId: "task_B" })
    const b = row({ id: "task_B", agentType: "bb", parentTaskId: "task_A" })
    const o = renderAgentFleet([a, b], { format: "tree", now: NOW })
    expect(o).toContain("aa")
    expect(o).toContain("bb")
  })
})

describe("renderAgentInspect — drill-in", () => {
  test("lists the grandchild as a DIRECT child of the child task", () => {
    const o = renderAgentInspect(fleet, "task_child", { now: NOW })
    expect(o).toContain("children (1)")
    expect(o).toContain("coder") // grandchild's label
  })

  test("shows task description, depth, and parent (root) for a root task", () => {
    const o = renderAgentInspect(fleet, "task_child", { now: NOW })
    expect(o).toContain("root") // parent cell for a root-level task
    expect(o).toContain("depth")
  })

  test("shows parent id + nickname for a nested task", () => {
    const o = renderAgentInspect(fleet, "task_gc", { now: NOW })
    expect(o).toContain("dig into the parser")
    expect(o).toContain("explorer") // parent nickname resolvable
  })

  test("final-response preview from result, bounded", () => {
    const settled = row({
      id: "task_done",
      parentTaskId: undefined,
      status: "completed",
      endedAt: 500,
      result: { ok: true, finalText: `${"Y".repeat(300)}`, turns: 4 },
    })
    const o = renderAgentInspect([settled], "task_done", { now: NOW })
    expect(o.includes("Y".repeat(300))).toBe(false) // bounded
  })

  test("unknown id ⇒ not-found box, no throw", () => {
    const o = renderAgentInspect(fleet, "task_nope", { now: NOW })
    expect(o).toContain("not found")
  })
})

// ─── BYTE-IDENTICAL pins: the additive change must NOT alter table/json ────
describe("byte-identical — table + json unchanged by lineage fields", () => {
  const withLineage = [child, grandchild, sibling]
  const withoutLineage: AgentFleetRow[] = [
    row({ id: "task_child", agentType: "explorer" }),
    row({ id: "task_gc", agentType: "coder", description: "dig into the parser" }),
    row({ id: "task_sib", agentType: "reviewer" }),
  ]

  test("default (table) output ignores parentTaskId/depth ⇒ identical", () => {
    const a = renderAgentFleet(withLineage, { format: "table", now: NOW })
    const b = renderAgentFleet(withoutLineage, { format: "table", now: NOW })
    expect(a).toBe(b)
  })

  test("--json output ignores lineage fields ⇒ identical", () => {
    const a = renderAgentFleet(withLineage, { format: "json", now: NOW })
    const b = renderAgentFleet(withoutLineage, { format: "json", now: NOW })
    expect(a).toBe(b)
  })

  test("json is valid + carries the pre-existing fields only", () => {
    const parsed = JSON.parse(renderAgentFleet(withLineage, { format: "json", now: NOW }))
    expect(Array.isArray(parsed)).toBe(true)
    expect(Object.keys(parsed[0]).sort()).toEqual(
      [
        "age",
        "agentType",
        "description",
        "endedAt",
        "error",
        "finalText",
        "id",
        "startedAt",
        "status",
        "turns",
      ].sort(),
    )
  })
})
