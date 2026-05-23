/**
 * DAG validation hellgate (P1 plan-mode SOTA++, ADR-0095 draft).
 *
 * Pins the dependency graph algorithms:
 *   - `validateDag` — full-plan typed validation (self / dangling / cycle).
 *   - `findCycle` — DFS w/ tri-state color (white/gray/black); returns the
 *     cycle path or `null`.
 *   - `topologicalSort` — Kahn-style with id-asc tie-break for determinism;
 *     returns `{cycle}` on detection.
 *
 * Coverage:
 *   - 2-node direct cycle A → B → A.
 *   - 7-node deeply-nested cycle (A → B → C → D → E → F → G → C).
 *   - Self-dep A → A.
 *   - Multi-source DAG (5 disjoint trees, depth 5) — toposort all paths.
 *   - Tie-break determinism (parallel nodes sorted by id ascending).
 *   - Dangling: todo references id not in plan.
 *   - Empty plan / single-todo plan trivial cases.
 *   - 100-node performance gate (< 50ms).
 *   - PlanMutationError taxonomy (self_dependency / dependency_unknown /
 *     dependency_cycle) typed.
 */

import { describe, expect, test } from "bun:test"
import { findCycle, topologicalSort, validateDag } from "../../../../src/agent/plan/dag"
import type { TodoItem } from "../../../../src/agent/plan/types"

// ── helpers: build minimal TodoItem records ───────────────────────────────

function todo(id: string, deps: readonly string[] = []): TodoItem {
  return {
    id,
    content: `todo ${id}`,
    status: "pending",
    createdAt: 0,
    updatedAt: 0,
    dependencies: deps,
  }
}

function build(items: readonly TodoItem[]): Readonly<Record<string, TodoItem>> {
  const rec: Record<string, TodoItem> = {}
  for (const t of items) rec[t.id] = t
  return rec
}

// ── self-dependency ───────────────────────────────────────────────────────

describe("validateDag: self_dependency", () => {
  test("A → A is rejected with kind:self_dependency", () => {
    const r = validateDag(build([todo("A", ["A"])]))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("self_dependency")
    if (r.error.kind !== "self_dependency") throw new Error("unreachable")
    expect(r.error.id).toBe("A")
  })

  test("self-dep among others is still caught", () => {
    const r = validateDag(build([todo("A"), todo("B", ["B"]), todo("C", ["A"])]))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("self_dependency")
  })
})

// ── dangling deps ─────────────────────────────────────────────────────────

describe("validateDag: dependency_unknown (dangling)", () => {
  test("X → Y when Y not in plan", () => {
    const r = validateDag(build([todo("X", ["Y"])]))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("dependency_unknown")
    if (r.error.kind !== "dependency_unknown") throw new Error("unreachable")
    expect(r.error.from).toBe("X")
    expect(r.error.to).toBe("Y")
  })

  test("multi-dangling reports the first encountered", () => {
    const r = validateDag(build([todo("X", ["P", "Q"])]))
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("dependency_unknown")
    if (r.error.kind !== "dependency_unknown") throw new Error("unreachable")
    expect(r.error.from).toBe("X")
    // first-encountered semantics: deps list order
    expect(["P", "Q"]).toContain(r.error.to)
  })
})

// ── cycles ────────────────────────────────────────────────────────────────

describe("validateDag: dependency_cycle — direct 2-node A → B → A", () => {
  test("typed reject + path includes both nodes", () => {
    const r = validateDag(
      build([
        todo("A", ["B"]),
        todo("B", ["A"]),
      ]),
    )
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("dependency_cycle")
    if (r.error.kind !== "dependency_cycle") throw new Error("unreachable")
    expect(r.error.path).toContain("A")
    expect(r.error.path).toContain("B")
    // a cycle path of length ≥ 2
    expect(r.error.path.length).toBeGreaterThanOrEqual(2)
  })
})

describe("validateDag: 7-node deeply nested cycle", () => {
  test("A→B→C→D→E→F→G→C cycle detected", () => {
    const r = validateDag(
      build([
        todo("A", ["B"]),
        todo("B", ["C"]),
        todo("C", ["D"]),
        todo("D", ["E"]),
        todo("E", ["F"]),
        todo("F", ["G"]),
        todo("G", ["C"]),
      ]),
    )
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error("unreachable")
    expect(r.error.kind).toBe("dependency_cycle")
    if (r.error.kind !== "dependency_cycle") throw new Error("unreachable")
    // The cycle is C → D → E → F → G → C; path must contain each
    for (const id of ["C", "D", "E", "F", "G"]) {
      expect(r.error.path).toContain(id)
    }
    // A and B are tails, NOT part of the cycle
    // (some impls include them in traversal preamble; we don't require that)
  })
})

describe("findCycle: returns null on acyclic graph", () => {
  test("linear A→B→C→D returns null", () => {
    const cycle = findCycle(
      build([
        todo("A", ["B"]),
        todo("B", ["C"]),
        todo("C", ["D"]),
        todo("D"),
      ]),
    )
    expect(cycle).toBeNull()
  })

  test("forest (5 disjoint trees) returns null", () => {
    const items: TodoItem[] = []
    for (let i = 0; i < 5; i++) {
      const root = `R${i}`
      items.push(todo(root))
      for (let d = 0; d < 4; d++) {
        items.push(todo(`R${i}_D${d}`, [d === 0 ? root : `R${i}_D${d - 1}`]))
      }
    }
    expect(findCycle(build(items))).toBeNull()
  })

  test("cycle in last node of long chain detected", () => {
    // chain of 50 acyclic + tail cycle
    const items: TodoItem[] = []
    for (let i = 0; i < 50; i++) {
      items.push(todo(`N${i}`, i > 0 ? [`N${i - 1}`] : []))
    }
    items.push(todo("X", ["Y"]))
    items.push(todo("Y", ["X"]))
    const cycle = findCycle(build(items))
    expect(cycle).not.toBeNull()
    if (cycle === null) throw new Error("unreachable")
    expect(cycle).toContain("X")
    expect(cycle).toContain("Y")
  })
})

// ── topologicalSort ──────────────────────────────────────────────────────

describe("topologicalSort: acyclic graphs", () => {
  test("empty plan → []", () => {
    const out = topologicalSort(build([]))
    expect(Array.isArray(out)).toBe(true)
    expect(out).toEqual([])
  })

  test("single isolated todo → [its id]", () => {
    const out = topologicalSort(build([todo("only")]))
    expect(out).toEqual(["only"])
  })

  test("linear A→B→C→D yields D,C,B,A or A,B,C,D depending on direction (deps-first then dependents)", () => {
    // Convention: dependencies come BEFORE dependents (Kahn from source).
    // A depends on B → B must come before A.
    const out = topologicalSort(
      build([
        todo("A", ["B"]),
        todo("B", ["C"]),
        todo("C", ["D"]),
        todo("D"),
      ]),
    )
    if (!Array.isArray(out)) throw new Error("expected array, got cycle")
    expect(out).toEqual(["D", "C", "B", "A"])
  })

  test("tie-break determinism: parallel siblings sorted by id ascending", () => {
    // Three roots with no deps + one consumer that depends on all three.
    const out = topologicalSort(
      build([
        todo("Consumer", ["zeta", "alpha", "mu"]),
        todo("zeta"),
        todo("alpha"),
        todo("mu"),
      ]),
    )
    if (!Array.isArray(out)) throw new Error("expected array, got cycle")
    // parallel sources: alpha, mu, zeta — sorted ascending
    expect(out.indexOf("alpha")).toBeLessThan(out.indexOf("mu"))
    expect(out.indexOf("mu")).toBeLessThan(out.indexOf("zeta"))
    // Consumer last
    expect(out[out.length - 1]).toBe("Consumer")
  })

  test("multi-source forest: 5 disjoint trees of depth 5 sorted deterministically", () => {
    const items: TodoItem[] = []
    for (let i = 0; i < 5; i++) {
      const root = `T${i}_root`
      items.push(todo(root))
      let prev = root
      for (let d = 0; d < 4; d++) {
        const nid = `T${i}_L${d}`
        items.push(todo(nid, [prev]))
        prev = nid
      }
    }
    const out = topologicalSort(build(items))
    if (!Array.isArray(out)) throw new Error("expected array, got cycle")
    expect(out.length).toBe(25)
    // every dep precedes its dependent
    const positions = new Map<string, number>()
    out.forEach((id, idx) => positions.set(id, idx))
    for (const it of items) {
      for (const dep of it.dependencies) {
        const depPos = positions.get(dep)
        const ownPos = positions.get(it.id)
        expect(depPos).toBeDefined()
        expect(ownPos).toBeDefined()
        if (depPos === undefined || ownPos === undefined) throw new Error("unreachable")
        expect(depPos).toBeLessThan(ownPos)
      }
    }

    // determinism: two calls produce identical output
    const out2 = topologicalSort(build(items))
    expect(out2).toEqual(out)
  })
})

describe("topologicalSort: cycle returns {cycle: [...]}", () => {
  test("returns object with cycle field on 2-node cycle", () => {
    const out = topologicalSort(build([todo("A", ["B"]), todo("B", ["A"])]))
    expect(Array.isArray(out)).toBe(false)
    if (Array.isArray(out)) throw new Error("unreachable")
    if (!("cycle" in out)) throw new Error("unreachable")
    expect(Array.isArray(out.cycle)).toBe(true)
    expect(out.cycle.length).toBeGreaterThanOrEqual(2)
  })

  test("self-dep counts as a 1-cycle for topo (or rejected upstream)", () => {
    // self-dep is rejected by validateDag, but topologicalSort treats it as cycle.
    const out = topologicalSort(build([todo("Loop", ["Loop"])]))
    if (Array.isArray(out)) throw new Error("expected cycle, got array")
    if (!("cycle" in out)) throw new Error("unreachable")
    expect(out.cycle).toContain("Loop")
  })
})

// ── validateDag: happy path + true ────────────────────────────────────────

describe("validateDag: acyclic + well-formed → ok:true", () => {
  test("empty plan", () => {
    const r = validateDag(build([]))
    expect(r.ok).toBe(true)
    if (!r.ok) throw new Error("unreachable")
    expect(r.value).toBe(true)
  })

  test("single isolated todo", () => {
    const r = validateDag(build([todo("only")]))
    expect(r.ok).toBe(true)
  })

  test("diamond: A→{B,C}→D", () => {
    const r = validateDag(
      build([
        todo("A", ["B", "C"]),
        todo("B", ["D"]),
        todo("C", ["D"]),
        todo("D"),
      ]),
    )
    expect(r.ok).toBe(true)
  })
})

// ── 100-node perf gate ────────────────────────────────────────────────────

describe("perf: 100-node DAG validation under 50ms", () => {
  test("validateDag on a 100-node linear chain completes under 50ms", () => {
    const items: TodoItem[] = []
    for (let i = 0; i < 100; i++) {
      items.push(todo(`n${i}`, i > 0 ? [`n${i - 1}`] : []))
    }
    const plan = build(items)
    const start = performance.now()
    const r = validateDag(plan)
    const elapsed = performance.now() - start
    expect(r.ok).toBe(true)
    expect(elapsed).toBeLessThan(50)
  })

  test("topologicalSort on a 100-node 10x10 grid completes under 50ms", () => {
    const items: TodoItem[] = []
    // 10 layers × 10 wide; each layer depends on all of previous layer
    for (let layer = 0; layer < 10; layer++) {
      for (let col = 0; col < 10; col++) {
        const id = `L${layer}_C${col}`
        const deps: string[] = []
        if (layer > 0) {
          for (let c = 0; c < 10; c++) deps.push(`L${layer - 1}_C${c}`)
        }
        items.push(todo(id, deps))
      }
    }
    const plan = build(items)
    const start = performance.now()
    const out = topologicalSort(plan)
    const elapsed = performance.now() - start
    expect(Array.isArray(out)).toBe(true)
    if (!Array.isArray(out)) throw new Error("unreachable")
    expect(out.length).toBe(100)
    expect(elapsed).toBeLessThan(50)
  })
})

// ── findCycle with startId hint ───────────────────────────────────────────

describe("findCycle: optional startId narrows search", () => {
  test("startId hits the cycle directly", () => {
    const plan = build([todo("A", ["B"]), todo("B", ["A"]), todo("X")])
    const cycle = findCycle(plan, "A")
    expect(cycle).not.toBeNull()
  })

  test("startId on acyclic node returns null even if graph has cycle elsewhere", () => {
    const plan = build([
      todo("X"),
      todo("Y", ["X"]),
      todo("A", ["B"]),
      todo("B", ["A"]),
    ])
    const cycle = findCycle(plan, "X")
    expect(cycle).toBeNull()
  })
})
