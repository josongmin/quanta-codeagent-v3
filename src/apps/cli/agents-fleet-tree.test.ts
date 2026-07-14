/**
 * HELLGATE (RED-first) — the `/agents --tree` spawn-tree builder.
 *
 * The builder reconstructs the real parent→child tree from `parentTaskId` (NOT
 * a flat list). The anti-flat-list pin below goes RED if the builder ignores
 * `parentTaskId`. Orphan + cycle safety pins prove the walk terminates and
 * never drops a node.
 */
import { describe, expect, test } from "bun:test"
import type { AgentFleetRow } from "./agents-fleet-panel"
import {
  type AgentTree,
  directChildrenOf,
  flattenTree,
  pruneTreeToDepth,
  rowsToTree,
} from "./agents-fleet-tree"

/** `over` allows explicit `undefined` per field so a test can assert
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

/** Ids reachable from a tree, in pre-order. */
const idsOf = (tree: AgentTree): string[] => flattenTree(tree).map((n) => n.row.id)

describe("rowsToTree — spawn-tree reconstruction", () => {
  // root  ─ child ─ grandchild
  //       ─ sibling
  const rootChild = row({ id: "task_child", parentTaskId: undefined, depth: 1 })
  const grandchild = row({ id: "task_gc", parentTaskId: "task_child", depth: 2 })
  const sibling = row({ id: "task_sib", parentTaskId: undefined, depth: 1 })
  const records = [rootChild, grandchild, sibling]

  test("nests grandchild UNDER child, siblings at root (structure, not flat)", () => {
    const tree = rowsToTree(records)
    // Two top-level roots (child + sibling), NOT three flat nodes.
    expect(tree.roots.map((r) => r.row.id)).toEqual(["task_child", "task_sib"])
    const childNode = tree.roots[0]
    expect(childNode?.children.map((c) => c.row.id)).toEqual(["task_gc"])
    // sibling has no children
    expect(tree.roots[1]?.children).toEqual([])
  })

  test("renderDepth increases per nesting level (indent source)", () => {
    const tree = rowsToTree(records)
    expect(tree.roots[0]?.renderDepth).toBe(0)
    expect(tree.roots[0]?.children[0]?.renderDepth).toBe(1)
  })

  test("directChildrenOf lists the grandchild as child's direct child", () => {
    expect(directChildrenOf(records, "task_child").map((r) => r.id)).toEqual(["task_gc"])
    expect(directChildrenOf(records, "task_gc")).toEqual([])
  })

  // ─── MUTATION pin (anti-flat-list) ────────────────────────────────────
  // If the builder IGNORED parentTaskId and returned a flat list, every record
  // would be a root and NO node would nest. This asserts nesting actually
  // happened — flip the builder to flat and this goes RED.
  test("MUTATION anti-flat-list: a flat build would have 3 roots + 0 nesting", () => {
    const tree = rowsToTree(records)
    expect(tree.roots.length).not.toBe(records.length) // flat ⇒ 3 roots
    const totalChildren = flattenTree(tree).reduce((n, node) => n + node.children.length, 0)
    expect(totalChildren).toBeGreaterThan(0) // flat ⇒ 0
  })

  describe("orphan safety (parent evicted from LRU)", () => {
    test("re-roots a node whose parent id is missing, flags orphan, never drops", () => {
      const orphan = row({ id: "task_orphan", parentTaskId: "task_GONE", depth: 3 })
      const tree = rowsToTree([orphan])
      expect(idsOf(tree)).toContain("task_orphan")
      expect(tree.roots.find((r) => r.row.id === "task_orphan")?.orphan).toBe(true)
    })
  })

  describe("cycle safety (defensive)", () => {
    test("A→B→A terminates, every node emitted at most once, none dropped", () => {
      const a = row({ id: "task_A", parentTaskId: "task_B" })
      const b = row({ id: "task_B", parentTaskId: "task_A" })
      const tree = rowsToTree([a, b])
      const ids = idsOf(tree)
      // both present…
      expect(ids.sort()).toEqual(["task_A", "task_B"])
      // …and each exactly once (no infinite re-expansion)
      expect(ids.length).toBe(2)
    })

    test("self-loop (parent === id) is re-rooted as orphan, does not recurse", () => {
      const selfLoop = row({ id: "task_self", parentTaskId: "task_self" })
      const tree = rowsToTree([selfLoop])
      expect(idsOf(tree)).toEqual(["task_self"])
      expect(tree.roots[0]?.orphan).toBe(true)
    })
  })

  describe("pruneTreeToDepth", () => {
    test("keeps renderDepth <= N, drops deeper subtrees", () => {
      const tree = rowsToTree(records)
      const pruned = pruneTreeToDepth(tree, 0)
      // depth 0 only ⇒ roots kept, grandchild (renderDepth 1) dropped
      expect(idsOf(pruned).sort()).toEqual(["task_child", "task_sib"])
    })
    test("depth 1 keeps the grandchild", () => {
      const pruned = pruneTreeToDepth(rowsToTree(records), 1)
      expect(idsOf(pruned)).toContain("task_gc")
    })
    test("does not mutate the source tree", () => {
      const tree = rowsToTree(records)
      const before = idsOf(tree)
      pruneTreeToDepth(tree, 0)
      expect(idsOf(tree)).toEqual(before)
    })
  })
})
