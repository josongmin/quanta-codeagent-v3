/**
 * SPAWN-DEPTH-POLICY hellgate (RFC jul-13 §6.5 B, Phase 1 L1).
 *
 * `spawnToolsAvailable(config)` is the SSOT predicate that decides whether an
 * agent at `config.depth` is entitled to the spawn tool families. It is a
 * DETERMINISTIC threshold — `(depth ?? 0) < spawnDepthCap()` — NOT a heuristic.
 *
 * This locks the full truth-table across two caps and proves mutation teeth:
 * flipping `<` → `<=` in the predicate turns the (depth 1, cap 1) case RED.
 * The cap is driven through the real `runtimeConfig()` seam via the
 * `QUANTA_MAX_SPAWN_DEPTH` env + `__resetRuntimeConfig()` (not a stub), so this
 * also witnesses the config wiring end-to-end.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { spawnDepthCap, spawnToolsAvailable } from "@/agent/spawn-depth-policy"
import type { AgentConfig } from "@/agent/types"
import { __resetRuntimeConfig } from "@/shared/runtime-config"

let savedEnv: NodeJS.ProcessEnv

beforeEach(() => {
  savedEnv = { ...process.env }
  delete process.env.QUANTA_MAX_SPAWN_DEPTH
  __resetRuntimeConfig()
})
afterEach(() => {
  process.env = savedEnv
  __resetRuntimeConfig()
})

/** Set the runtime cap through the real env→runtimeConfig seam. */
const withCap = (cap: number): void => {
  process.env.QUANTA_MAX_SPAWN_DEPTH = String(cap)
  __resetRuntimeConfig()
}

describe("spawnToolsAvailable — deterministic depth<cap truth-table", () => {
  // [cap, depth (undefined = root/absent), expected]
  const cases: ReadonlyArray<readonly [number, number | undefined, boolean]> = [
    [1, 0, true], // root at default cap ⇒ spawns
    [1, 1, false], // child at default cap ⇒ leaf (the mutation-sensitive case)
    [1, undefined, true], // absent depth ⇒ treated as root ⇒ spawns
    [2, 1, true], // cap 2 ⇒ depth-1 child still spawns
    [2, 2, false], // cap 2 ⇒ depth-2 grandchild is a leaf
  ]

  for (const [cap, depth, expected] of cases) {
    test(`cap=${cap} depth=${String(depth)} ⇒ ${expected}`, () => {
      withCap(cap)
      expect(spawnDepthCap()).toBe(cap)
      // undefined depth ⇒ OMIT the key (exactOptionalPropertyTypes) so we
      // exercise the real `?? 0` absent-depth branch, not an explicit undefined.
      const config: Pick<AgentConfig, "depth"> = depth === undefined ? {} : { depth }
      expect(spawnToolsAvailable(config)).toBe(expected)
    })
  }

  test("MUTATION witness: with `<=` the (depth 1, cap 1) case would be true — pin it false", () => {
    // This is the case that distinguishes `<` (correct: child is a leaf) from
    // `<=` (wrong: child at the cap still spawns). If someone loosens the
    // predicate to `<=`, THIS assertion goes RED.
    withCap(1)
    expect(spawnToolsAvailable({ depth: 1 })).toBe(false)
    // control: the boundary just below the cap stays true under both operators,
    // so it can't be what catches the mutation — the depth===cap case above is.
    expect(spawnToolsAvailable({ depth: 0 })).toBe(true)
  })

  test("default cap (no env) is the intent policy 1 ⇒ root spawns, child is leaf", () => {
    // no withCap: default runtimeConfig().maxSpawnDepth === 1
    expect(spawnDepthCap()).toBe(1)
    expect(spawnToolsAvailable({ depth: 0 })).toBe(true)
    expect(spawnToolsAvailable({ depth: 1 })).toBe(false)
  })
})

describe("spawnToolsAvailable — config.subagent.maxDepth overrides the env cap (R1)", () => {
  // R1: the PRE-EXISTING per-run knob QUANTA_SUBAGENT_MAX_DEPTH flows to
  // config.subagent.maxDepth and is honored by BOTH the runner reject and (now)
  // the capability gate. Effective cap === `config.subagent?.maxDepth ??
  // spawnDepthCap()`. These cases leave QUANTA_MAX_SPAWN_DEPTH UNSET
  // (spawnDepthCap()===1) so the ONLY lever is config.subagent.maxDepth.

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
      // no withCap ⇒ spawnDepthCap() === 1 (default). subagent.maxDepth is the lever.
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
    // If the gate reverts to `(depth ?? 0) < spawnDepthCap()` (ignoring
    // config.subagent.maxDepth), this depth-1 child with per-run cap 2 would lose
    // its tools (1 < 1 === false) — the exact HIGH regression. Pin it TRUE.
    const config = { depth: 1, subagent: { maxDepth: 2 } } as Pick<
      AgentConfig,
      "depth" | "subagent"
    >
    expect(spawnDepthCap()).toBe(1) // env cap alone would say leaf…
    expect(spawnToolsAvailable(config)).toBe(true) // …but per-run cap 2 keeps tools
  })
})
