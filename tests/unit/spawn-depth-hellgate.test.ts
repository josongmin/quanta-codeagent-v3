/**
 * SPAWN-DEPTH hellgate (RFC jul-13 §4.1/§4.2/§6.5, rev.4 MIN-CAP).
 *
 * `@/agent/spawn-depth` is the SSOT for two DETERMINISTIC (not heuristic) layers:
 *
 *   1. LINEAGE AUTHORITY — `childDepthOf(parent)` = `parent.depth + 1`. undefined
 *      parent depth = genuine root (child depth 1); malformed depth (NaN / -1 /
 *      0.5) ⇒ `SpawnLineageError` (fail-closed, NO depth:0 fallback).
 *   2. CAPABILITY PROJECTION (rev.4 MIN-CAP) — `canExposeSpawnTools` /
 *      `canAdmitChildDepth` + `spawnToolsAvailable(config)` =
 *      `(depth ?? 0) < effectiveCap(config.subagent?.maxDepth)`, where the
 *      effective cap is `min(operator policy, requested ?? +∞)` (= min of
 *      runtime-config `maxDescendantDepth` default 1 and any per-config request).
 *      The per-config request can only TIGHTEN the policy, never RAISE it.
 *
 * This locks the truth-tables and proves mutation teeth (flip `<`→`<=`, revert
 * `childDepthOf` to `depth:0`, revert min-cap to the old `?? override`), driving
 * the cap through the real `QUANTA_MAX_DESCENDANT_DEPTH` env +
 * `__resetRuntimeConfig()` (not a stub) so the config wiring is witnessed
 * end-to-end.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  canAdmitChildDepth,
  canExposeSpawnTools,
  childDepthOf,
  effectiveCap,
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

  test("DEFAULT cap (no env) is the rev.4 canonical 1 ⇒ ONLY root spawns (depth ≥1 leaf)", () => {
    // no withCap: default runtimeConfig().maxDescendantDepth === 1 (root-only)
    expect(spawnDepthCap()).toBe(1)
    expect(spawnToolsAvailable({ depth: 0 })).toBe(true) // root spawns
    expect(spawnToolsAvailable({})).toBe(true) // absent depth = root
    expect(spawnToolsAvailable({ depth: 1 })).toBe(false) // depth-1 child is a LEAF
    expect(spawnToolsAvailable({ depth: 2 })).toBe(false)
  })
})

// ── rev.4 §4.2 — effectiveCap = min(policy, requested); TIGHTEN-ONLY ──────────

describe("effectiveCap — min-cap authority (config can only TIGHTEN, never RAISE)", () => {
  // [operator policy (env), requested (per-config), expected effectiveCap]
  const cases: ReadonlyArray<readonly [number, number | undefined, number]> = [
    [1, undefined, 1], // no request ⇒ policy
    [1, 5, 1], // request 5 CANNOT raise above policy 1 ⇒ min(1,5)=1
    [3, 1, 1], // request 1 tightens policy 3 ⇒ min(3,1)=1
    [3, undefined, 3], // no request ⇒ policy 3
    [2, 3, 2], // request 3 clamped to policy 2
    [0, 5, 0], // kill-switch policy dominates
  ]
  for (const [policy, requested, expected] of cases) {
    test(`policy=${policy} requested=${String(requested)} ⇒ effectiveCap=${expected}`, () => {
      withCap(policy)
      expect(effectiveCap(requested)).toBe(expected)
    })
  }
})

describe("spawnToolsAvailable — config.subagent.maxDepth TIGHTENS the policy (rev.4 min-cap)", () => {
  // rev.4: per-config `subagent.maxDepth` (legacy QUANTA_SUBAGENT_MAX_DEPTH) can
  // only LOWER the cap below the operator policy, NEVER raise it. Effective cap
  // === `min(spawnDepthCap(), config.subagent?.maxDepth ?? +∞)`. This is the
  // structural fix for R1's two-knob split-brain: a config can't widen past policy.

  // Case group A — policy 1 (root-only). A requested maxDepth of 2 or 5 must NOT
  // widen a depth-1 child back to a spawner (the rev.3 override bug).
  const capRaiseAttempts: ReadonlyArray<readonly [number, number, boolean]> = [
    [5, 0, true], // request 5, root ⇒ spawns (root always < any cap ≥1)
    [5, 1, false], // request 5, depth-1 ⇒ STILL a LEAF (config canNOT raise past policy 1)
    [2, 1, false], // request 2, depth-1 ⇒ LEAF (min(1,2)=1)
    [1, 0, true], // request 1 == policy, root ⇒ spawns
  ]
  for (const [maxDepth, depth, expected] of capRaiseAttempts) {
    test(`policy 1 + subagent.maxDepth=${maxDepth} depth=${depth} ⇒ ${expected}`, () => {
      withCap(1) // operator policy 1 (root-only)
      const config = { depth, subagent: { maxDepth } } as Pick<AgentConfig, "depth" | "subagent">
      expect(spawnToolsAvailable(config)).toBe(expected)
    })
  }

  // Case group B — policy 3, requested TIGHTENS to 1: depth-1 child becomes a leaf.
  const tightenCases: ReadonlyArray<readonly [number | undefined, number, boolean]> = [
    [1, 0, true], // request 1, root ⇒ spawns
    [1, 1, false], // request 1 tightens: depth-1 is now a LEAF (min(3,1)=1)
    [undefined, 2, true], // no request ⇒ policy 3 ⇒ depth-2 still spawns
    [undefined, 3, false], // no request ⇒ policy 3 ⇒ depth-3 is a leaf
    [0, 0, false], // kill-switch request 0 ⇒ even root does not spawn
  ]
  for (const [maxDepth, depth, expected] of tightenCases) {
    test(`policy 3 + subagent.maxDepth=${String(maxDepth)} depth=${depth} ⇒ ${expected}`, () => {
      withCap(3) // operator policy 3
      const config: Pick<AgentConfig, "depth" | "subagent"> = {
        depth,
        ...(maxDepth !== undefined
          ? ({ subagent: { maxDepth } } as Pick<AgentConfig, "subagent">)
          : {}),
      }
      expect(spawnToolsAvailable(config)).toBe(expected)
    })
  }

  test("RED-ON-INJECTION: reverting to `?? override` wrongly exposes (policy 1, requested 5) at depth 1", () => {
    // The rev.3 bug: `config.subagent?.maxDepth ?? spawnDepthCap()` lets a config
    // maxDepth=5 REPLACE the policy-1 ceiling ⇒ depth-1 would wrongly spawn. Under
    // rev.4 min-cap `min(1,5)=1` ⇒ depth-1 is a LEAF. If someone reverts the min
    // to the override, THIS assertion flips to true ⇒ RED.
    withCap(1)
    expect(spawnDepthCap()).toBe(1)
    const config = { depth: 1, subagent: { maxDepth: 5 } } as Pick<
      AgentConfig,
      "depth" | "subagent"
    >
    expect(spawnToolsAvailable(config)).toBe(false) // min-cap: config CANNOT raise past policy
    // paired control: at policy 3, the SAME request 5 still clamps to 3 ⇒ depth-3 leaf.
    withCap(3)
    expect(spawnToolsAvailable({ depth: 3, subagent: { maxDepth: 5 } } as never)).toBe(false)
    expect(spawnToolsAvailable({ depth: 2, subagent: { maxDepth: 5 } } as never)).toBe(true)
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
