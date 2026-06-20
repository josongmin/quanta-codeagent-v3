/**
 * BENCH knob discoverability hellgate.
 *
 * Hole class sealed here:
 *   a bench-surface runner knob exists and presets/reporting can resolve it, but
 *   its env key is absent from the pure declaration registries
 *   (cli/inventory/runtime-config). That leaves operator-facing config truth
 *   drifting from live bench posture.
 *
 * Invariant:
 *   every bench-surface `@/runner/knobs` envKey must also be declared in one of
 *   the discoverability registries:
 *     - `apps/cli/cli-knobs.ts`
 *     - `config/knob-inventory.ts`
 *     - `shared/runtime-config-knobs.ts`
 *
 * The runner registry itself is NOT enough for this test: it proves execution
 * wiring, not the cross-surface declaration truth operators inspect.
 */

import { beforeEach, describe, expect, test } from "bun:test"
import { CLI_KNOBS } from "@/apps/cli/cli-knobs"
import { KNOB_INVENTORY } from "@/config/knob-inventory"
import {
  __restoreRegistry,
  __snapshotRegistry,
  allKnobs,
} from "@/runner/knobs"
import { RUNTIME_CONFIG_KNOBS } from "@/shared/runtime-config-knobs"
import "@/runner/knobs/knobs"

const REGISTRY_SNAPSHOT = __snapshotRegistry()
const DECLARED = new Set(
  [...CLI_KNOBS, ...KNOB_INVENTORY, ...RUNTIME_CONFIG_KNOBS].map((k) => k.envKey),
)

beforeEach(() => {
  __restoreRegistry(REGISTRY_SNAPSHOT)
})

describe("bench knob discoverability registries", () => {
  test("every bench-surface runner knob envKey is declared in cli/inventory/runtime-config", () => {
    const missing = [...allKnobs().values()]
      .filter((k) => k.surfaces.includes("bench") && !DECLARED.has(k.envKey))
      .map((k) => `${k.id} (${k.envKey})`)
      .sort()
    expect(missing).toEqual([])
  })

  test("union is non-vacuous: runtime-config-backed shadows and inventory-backed bench knobs both exist", () => {
    const bench = [...allKnobs().values()].filter((k) => k.surfaces.includes("bench"))
    const runtimeConfigBacked = bench
      .filter((k) => RUNTIME_CONFIG_KNOBS.some((decl) => decl.envKey === k.envKey))
      .map((k) => k.id)
    const inventoryBacked = bench
      .filter((k) => KNOB_INVENTORY.some((decl) => decl.envKey === k.envKey))
      .map((k) => k.id)

    expect(runtimeConfigBacked).toContain("read-outline")
    expect(runtimeConfigBacked).toContain("test-runner")
    expect(inventoryBacked).toContain("verify-select-regression")
    expect(inventoryBacked).toContain("verify-select-repro")
  })
})
