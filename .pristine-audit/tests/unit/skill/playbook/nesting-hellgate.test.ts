/**
 * Hellgate — playbook nesting (ADR-0258).
 *
 * 15 cases pinning the bounded recursion + cycle detection contract:
 *
 *   - HELL-PN-01  depth=1 invoke → childOutput surfaced
 *   - HELL-PN-02  depth=3 chain → all execute (within cap)
 *   - HELL-PN-03  depth=4 attempt → Err("depth-exceeded")
 *   - HELL-PN-04  cycle A→B→A → Err("cycle-detected", { chain: [A,B,A] })
 *   - HELL-PN-05  child not found → Err("child-not-found", { id })
 *   - HELL-PN-06  child throws → Err("child-error", { cause }) — verbatim cause
 *   - HELL-PN-07  args propagate — parent args reach child unchanged
 *   - HELL-PN-08  depthUsed accurate — equals the child's level
 *   - HELL-PN-09  cycle-detector pure — same input ⇒ same output, no I/O
 *   - HELL-PN-10  default-OFF: executor never constructed ⇒ byte-identical
 *                  to pre-0258 (the 1-pass macro path is untouched)
 *   - HELL-PN-11  NestError 4-arm closed exhaustive — switch covers all
 *   - HELL-PN-12  10-step chain attempt (cap=3) → 1..3 OK, 4th depth-exceeded
 *   - HELL-PN-13  concurrent (serial) top-level invoke isolation — no leak
 *   - HELL-PN-14  childOutput frozen on return (HELL-PN top-level only)
 *   - HELL-PN-15  visit-set bounded — 100-deep attempt short-circuits at cap
 *                  with no OOM, no 100-entry set
 */

import { describe, expect, test } from "bun:test"
import {
  buildMacroRegistry,
  type ChildLookup,
  checkCycle,
  createDefaultNestedExecutor,
  DEFAULT_MAX_DEPTH,
  expandStep,
  type NestError,
  type NestedPlaybookExecutor,
  type NestedResult,
  type Result,
} from "@/skill/playbook"

/* ------------------------------------------------------------------ helpers */

function asOk<T, E>(r: Result<T, E>): T {
  if (!r.ok) throw new Error(`expected ok, got error: ${JSON.stringify(r.error)}`)
  return r.value
}

function asErr<T, E>(r: Result<T, E>): E {
  if (r.ok) throw new Error(`expected error, got ok: ${JSON.stringify(r.value)}`)
  return r.error
}

/**
 * Build a child-lookup adapter from a `{ id → fn }` map. A `MISSING` value
 * is reserved as the sentinel for "registered but lookup miss" — none of the
 * cases use it; an absent key is just `undefined`.
 */
function lookupOf(table: Readonly<Record<string, (args: unknown) => unknown>>): ChildLookup {
  return (id: string) => table[id]
}

/* ----------------------------------------------------------- HELL-PN-01..02 */

describe("playbook nesting hellgate (ADR-0258)", () => {
  test("HELL-PN-01: depth=1 invoke surfaces childOutput", () => {
    const exec = createDefaultNestedExecutor(
      lookupOf({
        echo: (args) => ({ received: args }),
      }),
    )
    const r = exec.invoke("root", "echo", "hello", 0)
    const v = asOk(r)
    expect(v.childOutput).toEqual({ received: "hello" })
    expect(v.depthUsed).toBe(1)
  })

  test("HELL-PN-02: depth=3 chain A→B→C all execute (cap=3)", () => {
    // We capture the executor via let so children can recurse into it.
    let exec: NestedPlaybookExecutor
    const table: Record<string, (args: unknown) => unknown> = {
      A: (args) => asOk(exec.invoke("A", "B", `${String(args)}-A`, 1)).childOutput,
      B: (args) => asOk(exec.invoke("B", "C", `${String(args)}-B`, 2)).childOutput,
      C: (args) => `${String(args)}-C`,
    }
    exec = createDefaultNestedExecutor(lookupOf(table))
    const r = exec.invoke("root", "A", "seed", 0)
    const v = asOk(r)
    expect(v.childOutput).toBe("seed-A-B-C")
    expect(v.depthUsed).toBe(1) // outermost child's depth
  })

  /* --------------------------------------------------------- HELL-PN-03 */

  test("HELL-PN-03: depth=4 attempt yields depth-exceeded", () => {
    let exec: NestedPlaybookExecutor
    const table: Record<string, (args: unknown) => unknown> = {
      A: () => asOk(exec.invoke("A", "B", null, 1)).childOutput,
      B: () => asOk(exec.invoke("B", "C", null, 2)).childOutput,
      // C tries to invoke D at depth 3 → nextDepth=4 > max=3.
      C: () => {
        const r = exec.invoke("C", "D", null, 3)
        if (r.ok) throw new Error("expected depth-exceeded")
        return r.error
      },
      D: () => "should-never-run",
    }
    exec = createDefaultNestedExecutor(lookupOf(table))
    const r = exec.invoke("root", "A", null, 0)
    const v = asOk(r)
    const surfaced = v.childOutput as NestError
    expect(surfaced.kind).toBe("depth-exceeded")
    if (surfaced.kind === "depth-exceeded") {
      expect(surfaced.attempted).toBe(4)
      expect(surfaced.max).toBe(3)
    }
  })

  /* --------------------------------------------------------- HELL-PN-04 */

  test("HELL-PN-04: cycle A→B→A is detected with verbatim chain", () => {
    let exec: NestedPlaybookExecutor
    const table: Record<string, (args: unknown) => unknown> = {
      A: () => asOk(exec.invoke("A", "B", null, 1)).childOutput,
      // B calls back into A → cycle.
      B: () => {
        const r = exec.invoke("B", "A", null, 2)
        if (r.ok) throw new Error("expected cycle-detected")
        return r.error
      },
    }
    exec = createDefaultNestedExecutor(lookupOf(table))
    const r = exec.invoke("root", "A", null, 0)
    const v = asOk(r)
    const surfaced = v.childOutput as NestError
    expect(surfaced.kind).toBe("cycle-detected")
    if (surfaced.kind === "cycle-detected") {
      expect(surfaced.chain).toEqual(["A", "B", "A"])
    }
  })

  /* --------------------------------------------------------- HELL-PN-05 */

  test("HELL-PN-05: child not found yields child-not-found", () => {
    const exec = createDefaultNestedExecutor(lookupOf({}))
    const r = exec.invoke("root", "ghost", null, 0)
    const e = asErr(r)
    expect(e.kind).toBe("child-not-found")
    if (e.kind === "child-not-found") expect(e.id).toBe("ghost")
  })

  /* --------------------------------------------------------- HELL-PN-06 */

  test("HELL-PN-06: child throws → child-error with verbatim cause", () => {
    const exploded = new Error("kaboom")
    const exec = createDefaultNestedExecutor(
      lookupOf({
        bomb: () => {
          throw exploded
        },
      }),
    )
    const r = exec.invoke("root", "bomb", null, 0)
    const e = asErr(r)
    expect(e.kind).toBe("child-error")
    if (e.kind === "child-error") {
      expect(e.id).toBe("bomb")
      // Identity preserved (HELL-PN-06: verbatim, no re-throw / no stringify).
      expect(e.cause).toBe(exploded)
    }
  })

  /* --------------------------------------------------------- HELL-PN-07 */

  test("HELL-PN-07: args propagate from parent to child unchanged", () => {
    const sentinel = { nested: { x: 1 }, list: [1, 2, 3] }
    let captured: unknown
    const exec = createDefaultNestedExecutor(
      lookupOf({
        sink: (args) => {
          captured = args
          return "ok"
        },
      }),
    )
    asOk(exec.invoke("root", "sink", sentinel, 0))
    // Same reference — no clone, no JSON round-trip.
    expect(captured).toBe(sentinel)
  })

  /* --------------------------------------------------------- HELL-PN-08 */

  test("HELL-PN-08: depthUsed equals child's level", () => {
    let exec: NestedPlaybookExecutor
    const table: Record<string, (args: unknown) => unknown> = {
      A: () => exec.invoke("A", "B", null, 1),
      B: () => exec.invoke("B", "C", null, 2),
      C: () => "leaf",
    }
    exec = createDefaultNestedExecutor(lookupOf(table))
    const outer = asOk(exec.invoke("root", "A", null, 0))
    // outer.childOutput is the result returned by A — i.e. the
    // Result<NestedResult,NestError> from invoke("A","B",1).
    const fromA = outer.childOutput as Result<NestedResult, NestError>
    const fromAOk = asOk(fromA)
    const fromB = fromAOk.childOutput as Result<NestedResult, NestError>
    const fromBOk = asOk(fromB)
    expect(outer.depthUsed).toBe(1) // A ran at level 1
    expect(fromAOk.depthUsed).toBe(2) // B ran at level 2
    expect(fromBOk.depthUsed).toBe(3) // C ran at level 3
    expect(fromBOk.childOutput).toBe("leaf")
  })

  /* --------------------------------------------------------- HELL-PN-09 */

  test("HELL-PN-09: cycle-detector is a pure function (no I/O, deterministic)", () => {
    const chain = ["A", "B"]
    const visited = new Set(["A", "B"])

    const first = checkCycle(chain, visited, "C")
    const second = checkCycle(chain, visited, "C")
    expect(first.kind).toBe("ok")
    expect(second.kind).toBe("ok")
    if (first.kind === "ok" && second.kind === "ok") {
      // Same input ⇒ structurally same output set.
      expect([...first.visited].sort()).toEqual(["A", "B", "C"])
      expect([...second.visited].sort()).toEqual(["A", "B", "C"])
    }
    // Cycle path.
    const cycle = checkCycle(chain, visited, "A")
    expect(cycle.kind).toBe("cycle")
    if (cycle.kind === "cycle") {
      expect(cycle.chain).toEqual(["A", "B", "A"])
    }
    // Original inputs untouched (no mutation of caller's set).
    expect([...visited].sort()).toEqual(["A", "B"])
    expect(chain).toEqual(["A", "B"])
  })

  /* --------------------------------------------------------- HELL-PN-10 */

  test("HELL-PN-10: default-OFF — pre-0258 macro path is byte-identical", () => {
    // Sanity: nothing in @/skill/playbook constructs a nested executor
    // implicitly. The 1-pass macro expansion remains unchanged — repeated
    // expand on a step with a macro returns the exact same expansion shape
    // as ADR-0203 pins.
    const reg = buildMacroRegistry([{ name: "go", expansion: "execute" }])
    const a = expandStep("then !go now", reg)
    const b = expandStep("then !go now", reg)
    expect(a).toEqual(b)
    expect(a.text).toBe("then execute now")
    expect(a.resolved).toEqual(["go"])
    expect(a.missing).toEqual([])

    // The DEFAULT_MAX_DEPTH constant is exported but no production wire
    // consumes it — host has to opt in by constructing an executor.
    expect(DEFAULT_MAX_DEPTH).toBe(3)
  })

  /* --------------------------------------------------------- HELL-PN-11 */

  test("HELL-PN-11: NestError union is closed 4-arm exhaustive", () => {
    // The four arms — explicitly enumerated. If a new arm is ever added,
    // this `switch` will fail to compile (tsc) and the assertion will
    // need updating in lock-step.
    const arms: NestError["kind"][] = [
      "depth-exceeded",
      "cycle-detected",
      "child-not-found",
      "child-error",
    ]
    // Sanity — every arm classifiable via switch (no default fall-through).
    const cover = (e: NestError): string => {
      switch (e.kind) {
        case "depth-exceeded":
          return "depth"
        case "cycle-detected":
          return "cycle"
        case "child-not-found":
          return "miss"
        case "child-error":
          return "throw"
      }
    }
    expect(cover({ kind: "depth-exceeded", attempted: 4, max: 3 })).toBe("depth")
    expect(cover({ kind: "cycle-detected", chain: ["a"] })).toBe("cycle")
    expect(cover({ kind: "child-not-found", id: "x" })).toBe("miss")
    expect(cover({ kind: "child-error", id: "x", cause: new Error("e") })).toBe("throw")
    expect(arms.length).toBe(4)
  })

  /* --------------------------------------------------------- HELL-PN-12 */

  test("HELL-PN-12: 10-step chain (cap=3) — first 3 OK, 4th depth-exceeded", () => {
    let exec: NestedPlaybookExecutor
    // 10 ids; each tries to invoke the next at its `currentDepth + 1`.
    const ids = ["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8", "P9", "P10"]
    const sawLevels: number[] = []
    const table: Record<string, (args: unknown) => unknown> = {}
    ids.forEach((id, idx) => {
      const nextId = ids[idx + 1]
      table[id] = () => {
        sawLevels.push(idx + 1)
        if (nextId === undefined) return "leaf"
        const callerDepth = idx + 1 // the depth at which THIS child is running
        return exec.invoke(id, nextId, null, callerDepth)
      }
    })
    exec = createDefaultNestedExecutor(lookupOf(table))
    const outer = asOk(exec.invoke("root", "P1", null, 0))
    // P1 at level 1 → invoked P2 with caller depth 1
    // P2 at level 2 → invoked P3 with caller depth 2
    // P3 at level 3 → tried to invoke P4 with caller depth 3 → nextDepth=4 > 3
    // ⇒ exactly 3 children ran (P1, P2, P3).
    expect(sawLevels).toEqual([1, 2, 3])

    // Walk down outer → P2 → P3 → depth-exceeded error.
    const p1Out = outer.childOutput as Result<NestedResult, NestError>
    const p2Wrap = asOk(p1Out).childOutput as Result<NestedResult, NestError>
    const p3Wrap = asOk(p2Wrap).childOutput as Result<NestedResult, NestError>
    expect(p3Wrap.ok).toBe(false)
    if (!p3Wrap.ok) {
      expect(p3Wrap.error.kind).toBe("depth-exceeded")
    }
  })

  /* --------------------------------------------------------- HELL-PN-13 */

  test("HELL-PN-13: serial top-level invokes are isolated (no chain leak)", () => {
    // A child throws — make sure the executor still cleans up so the next
    // top-level invoke sees an empty chain (no spurious cycle / depth).
    const exploded = new Error("first-blew-up")
    const table: Record<string, (args: unknown) => unknown> = {
      blow: () => {
        throw exploded
      },
      // Second pass: invoke blow again (this should NOT report cycle).
      good: (args) => `ok:${String(args)}`,
    }
    const exec = createDefaultNestedExecutor(lookupOf(table))

    const e1 = asErr(exec.invoke("root", "blow", null, 0))
    expect(e1.kind).toBe("child-error")

    // Second invoke should NOT see "blow" still in the chain.
    const e2 = asErr(exec.invoke("root", "blow", null, 0))
    expect(e2.kind).toBe("child-error")

    // And an entirely different invoke also runs cleanly.
    const v3 = asOk(exec.invoke("root", "good", "x", 0))
    expect(v3.childOutput).toBe("ok:x")
    expect(v3.depthUsed).toBe(1)
  })

  /* --------------------------------------------------------- HELL-PN-14 */

  test("HELL-PN-14: childOutput is frozen on return (shallow)", () => {
    const exec = createDefaultNestedExecutor(
      lookupOf({
        produce: () => ({ a: 1, b: "two" }),
      }),
    )
    const v = asOk(exec.invoke("root", "produce", null, 0))
    expect(Object.isFrozen(v.childOutput)).toBe(true)
    // Mutation attempt is rejected in strict mode (bun runs strict).
    expect(() => {
      ;(v.childOutput as { a: number }).a = 999
    }).toThrow()
  })

  /* --------------------------------------------------------- HELL-PN-15 */

  test("HELL-PN-15: 100-deep attempt short-circuits at cap — no OOM, no 100-entry set", () => {
    let exec: NestedPlaybookExecutor
    // Each child (running AT `level`) tries to invoke the next deeper one
    // (`L${level+1}`) using its own `level` as the caller depth.
    let invocations = 0
    const childAtLevel = (level: number) => () => {
      invocations++
      return exec.invoke(`L${level}`, `L${level + 1}`, null, level)
    }
    const lookup: ChildLookup = (id) => {
      // Strip leading "L", parse the level (which is what depth this child
      // runs at AFTER the executor's +1).
      const m = id.match(/^L(\d+)$/)
      if (m === null) return undefined
      const level = Number.parseInt(m[1] ?? "0", 10)
      // ALL ids are valid lookups — the cap is what stops us, not the lookup.
      return childAtLevel(level)
    }
    exec = createDefaultNestedExecutor(lookup)
    // Top-level invoke targets the chain L1 → L2 → ... — but the cap is 3.
    // L1 runs at level 1 → invokes L2 at level 2 → invokes L3 at level 3.
    // L3 tries L4 with callerDepth=3 → nextDepth=4 > 3 → depth-exceeded.
    const outer = asOk(exec.invoke("root", "L1", null, 0))
    expect(invocations).toBe(3)
    expect(invocations).toBeLessThan(100) // proof of "no 100-entry set"

    // Surface the typed depth-exceeded at the deepest frame.
    const wrap1 = outer.childOutput as Result<NestedResult, NestError>
    const wrap2 = asOk(wrap1).childOutput as Result<NestedResult, NestError>
    const wrap3 = asOk(wrap2).childOutput as Result<NestedResult, NestError>
    expect(wrap3.ok).toBe(false)
    if (!wrap3.ok) {
      expect(wrap3.error.kind).toBe("depth-exceeded")
    }
  })
})
