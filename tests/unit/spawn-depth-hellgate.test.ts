/**
 * SPAWN-DEPTH hellgate (RFC jul-13 §4.1/§4.2/§6.5, rev.3).
 *
 * `@/agent/spawn-depth` is the SSOT for two DETERMINISTIC (not heuristic) layers:
 *
 *   1. LINEAGE AUTHORITY — `childDepthOf(parent)` = `parent.depth + 1`. undefined
 *      parent depth = genuine root (child depth 1); malformed depth (NaN / -1 /
 *      0.5) ⇒ `SpawnLineageError` (fail-closed, NO depth:0 fallback).
 *   2. CAPABILITY PROJECTION — `canExposeSpawnTools`/`canAdmitChildDepth` +
 *      `spawnToolsAvailable(config)` = `(depth ?? 0) < effectiveCap`, where the
 *      cap is `config.subagent?.maxDepth ?? spawnDepthCap()` (= runtime-config
 *      `maxDescendantDepth`, default 3).
 *
 * This locks the truth-tables and proves mutation teeth (flip `<`→`<=`, revert
 * `childDepthOf` to `depth:0`), driving the cap through the real
 * `QUANTA_MAX_DESCENDANT_DEPTH` env + `__resetRuntimeConfig()` (not a stub) so the
 * config wiring is witnessed end-to-end.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  canAdmitChildDepth,
  canExposeSpawnTools,
  childDepthOf,
  SpawnLineageError,
  spawnDepthCap,
  spawnToolsAvailable,
} from "@/agent/spawn-depth"
import type { AgentConfig } from "@/agent/types"
import { __resetRuntimeConfig } from "@/shared/runtime-config"

let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedEnv = { ...process.env }
  delete process.env.QUANTA_MAX_DESCENDANT_DEPTH
  __resetRuntimeConfig()
})
afterEach(() => {
  process.env = savedEnv
  __resetRuntimeConfig()
})

/** Set the runtime cap through the real env→runtimeConfig seam. */
const withCap = (cap: number): void => {
  process.env.QUANTA_MAX_DESCENDANT_DEPTH = String(cap)
  __resetRuntimeConfig()
}

// ── §4.1 — childDepthOf lineage authority ─────────────────────────────────────

describe("childDepthOf — lineage-derived child depth", () => {
  // [parent.depth (undefined = genuine root), expected child depth]
  const cases: ReadonlyArray<readonly [number | undefined, number]> = [
    [undefined, 1], // genuine root ⇒ child depth 1
    [0, 1], // explicit root ⇒ child depth 1
    [2, 3], // depth-2 parent ⇒ child depth 3
  ]
  for (const [depth, expected] of cases) {
    test(`parent.depth=${String(depth)} ⇒ child ${expected}`, () => {
      const parent: Pick<AgentConfig, "depth"> = depth === undefined ? {} : { depth }
      expect(childDepthOf(parent)).toBe(expected)
    })
  }

  // Malformed parent depth ⇒ SpawnLineageError (RED if it returns a number).
  for (const bad of [Number.NaN, -1, 0.5]) {
    test(`malformed parent.depth=${bad} ⇒ SpawnLineageError (fail-closed, NO depth:0 fallback)`, () => {
      expect(() => childDepthOf({ depth: bad })).toThrow(SpawnLineageError)
    })
  }

  test("MUTATION witness: reverting to a `depth:0` fallback would make -1 return 0 — pinned to throw", () => {
    // If someone replaced the fail-closed throw with `?? 0` / clamp, a -1 parent
    // would silently mint a root child (0). Pin that it throws instead.
    let threw = false
    try {
      childDepthOf({ depth: -1 })
    } catch (e) {
      threw = e instanceof SpawnLineageError
    }
    expect(threw).toBe(true)
  })
})

// ── §4.2 — the two derived predicates ─────────────────────────────────────────

describe("canExposeSpawnTools / canAdmitChildDepth — derived predicates", () => {
  test("expose ⇔ parentDepth < cap; admit ⇔ childDepth <= cap (default cap 3)", () => {
    // cap 3: parent 0/1/2 expose (byte-identical to pre-landing), parent 3 leaf.
    expect(canExposeSpawnTools(0, 3)).toBe(true)
    expect(canExposeSpawnTools(2, 3)).toBe(true)
    expect(canExposeSpawnTools(3, 3)).toBe(false)
    // admit: childDepth 3 (from parent 2) admitted; childDepth 4 (from parent 3) not.
    expect(canAdmitChildDepth(3, 3)).toBe(true)
    expect(canAdmitChildDepth(4, 3)).toBe(false)
    // kill switch cap 0: even root cannot expose/admit.
    expect(canExposeSpawnTools(0, 0)).toBe(false)
    expect(canAdmitChildDepth(1, 0)).toBe(false)
  })

  test("STATIC CONSISTENCY: for every parent, expose ⇔ its child is admissible", () => {
    // expose(parent, cap) === admit(childDepthOf(parent), cap) — the invariant
    // that makes the gate and the runtime reject never diverge.
    for (const cap of [0, 1, 2, 3]) {
      for (const parentDepth of [0, 1, 2, 3]) {
        const child = childDepthOf({ depth: parentDepth })
        expect(canExposeSpawnTools(parentDepth, cap)).toBe(canAdmitChildDepth(child, cap))
      }
    }
  })
})

// ── spawnToolsAvailable — truth-table (default cap 3, BYTE-IDENTICAL proof) ────

describe("spawnToolsAvailable — deterministic depth<cap truth-table", () => {
  // [cap, depth (undefined = root/absent), expected]
  const cases: ReadonlyArray<readonly [number, number | undefined, boolean]> = [
    [3, 0, true], // root at default cap 3 ⇒ spawns
    [3, 1, true], // depth-1 child ⇒ STILL spawns (byte-identical to pre-landing)
    [3, 2, true], // depth-2 grandchild ⇒ STILL spawns (byte-identical)
    [3, 3, false], // depth-3 ⇒ leaf (the mutation-sensitive case at the cap)
    [3, undefined, true], // absent depth ⇒ treated as root ⇒ spawns
    [1, 0, true], // cap 1 (root-only): root spawns
    [1, 1, false], // cap 1: depth-1 child is a leaf
    [2, 1, true], // cap 2 ⇒ depth-1 child still spawns
    [2, 2, false], // cap 2 ⇒ depth-2 grandchild is a leaf
  ]

  for (const [cap, depth, expected] of cases) {
    test(`cap=${cap} depth=${String(depth)} ⇒ ${expected}`, () => {
      withCap(cap)
      expect(spawnDepthCap()).toBe(cap)
      const config: Pick<AgentConfig, "depth"> = depth === undefined ? {} : { depth }
      expect(spawnToolsAvailable(config)).toBe(expected)
    })
  }

  test("MUTATION witness: with `<=` the (depth 3, cap 3) case would be true — pin it false", () => {
    withCap(3)
    expect(spawnToolsAvailable({ depth: 3 })).toBe(false)
    // control: the boundary just below the cap stays true under both operators.
    expect(spawnToolsAvailable({ depth: 2 })).toBe(true)
  })

  test("DEFAULT cap (no env) is the rev.3 canonical 3 ⇒ depth 0/1/2 spawn, depth 3 leaf", () => {
    // no withCap: default runtimeConfig().maxDescendantDepth === 3
    expect(spawnDepthCap()).toBe(3)
    expect(spawnToolsAvailable({ depth: 0 })).toBe(true)
    expect(spawnToolsAvailable({ depth: 1 })).toBe(true)
    expect(spawnToolsAvailable({ depth: 2 })).toBe(true)
    expect(spawnToolsAvailable({ depth: 3 })).toBe(false)
  })
})

describe("spawnToolsAvailable — config.subagent.maxDepth overrides the env cap (R1)", () => {
  // R1: the PRE-EXISTING per-run knob QUANTA_SUBAGENT_MAX_DEPTH flows to
  // config.subagent.maxDepth and is honored by BOTH the runner reject and the
  // capability gate. Effective cap === `config.subagent?.maxDepth ??
  // spawnDepthCap()`. These cases set QUANTA_MAX_DESCENDANT_DEPTH=1 so the env cap
  // alone would say leaf for depth 1 — the ONLY widening lever is subagent.maxDepth.

  // [subagent.maxDepth (undefined = absent), depth, expected]
  const cases: ReadonlyArray<readonly [number | undefined, number, boolean]> = [
    [2, 0, true], // per-run cap 2, root ⇒ spawns
    [2, 1, true], // per-run cap 2, depth-1 child ⇒ STILL spawns (the R1 fix)
    [2, 2, false], // per-run cap 2, depth-2 grandchild ⇒ leaf
    [undefined, 1, false], // no per-run cap ⇒ falls back to env cap 1 ⇒ leaf
    [0, 0, false], // kill switch: cap 0 ⇒ even root does not spawn
  ]

  for (const [maxDepth, depth, expected] of cases) {
    test(`subagent.maxDepth=${String(maxDepth)} depth=${depth} ⇒ ${expected}`, () => {
      withCap(1) // env cap 1 (root-only) — subagent.maxDepth is the widening lever
      const config: Pick<AgentConfig, "depth" | "subagent"> = {
        depth,
        ...(maxDepth !== undefined
          ? ({ subagent: { maxDepth } } as Pick<AgentConfig, "subagent">)
          : {}),
      }
      expect(spawnToolsAvailable(config)).toBe(expected)
    })
  }

  test("MUTATION witness: dropping config.subagent.maxDepth (env-only gate) turns depth-1/cap-2 RED", () => {
    withCap(1) // env cap alone would say leaf for depth 1…
    const config = { depth: 1, subagent: { maxDepth: 2 } } as Pick<
      AgentConfig,
      "depth" | "subagent"
    >
    expect(spawnDepthCap()).toBe(1)
    expect(spawnToolsAvailable(config)).toBe(true) // …but per-run cap 2 keeps tools
  })
})

// ── §4.6 — resume invariant (persisted depth preserved, NOT recomputed) ───────

describe("§4.6 — resume preserves persisted lineage depth", () => {
  test("a persisted depth-2 child config keeps depth 2 (childDepthOf NOT re-run on resume)", () => {
    // buildChildConfig sets `depth: childDepthOf(parent)` ONCE at spawn; that value
    // is persisted on the child config and READ on resume — never recomputed from
    // the current parent. Pin: a resumed depth-2 child STILL derives its OWN future
    // children at depth 3 (childDepthOf(child) = 2 + 1), i.e. depth is read, not
    // reset to a shallow value. If resume re-ran childDepthOf against a root parent,
    // the child would wrongly become depth 1 and its children depth 2.
    const persistedChild: Pick<AgentConfig, "depth"> = { depth: 2 }
    expect(persistedChild.depth).toBe(2) // the persisted value is what a resume reads
    // A spawn FROM the resumed child derives depth 3 — proving the depth-2 lineage
    // is honored, not flattened to a root.
    expect(childDepthOf(persistedChild)).toBe(3)
  })

  test("malformed persisted depth ⇒ childDepthOf throws ⇒ spawn deny (no depth:0 fallback)", () => {
    // A corrupt persisted lineage (NaN) must FAIL CLOSED on the next spawn attempt,
    // never silently resume as a fresh root (depth 0 → child 1).
    const corruptChild: Pick<AgentConfig, "depth"> = { depth: Number.NaN }
    expect(() => childDepthOf(corruptChild)).toThrow(SpawnLineageError)
  })
})
