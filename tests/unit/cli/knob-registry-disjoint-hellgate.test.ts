/**
 * KNOB DECLARATION-REGISTRY DISJOINTNESS (ADR-0503 P3).
 *
 * quanta declares knobs across THREE author-owned declaration registries:
 *   - `apps/cli/cli-knobs.ts`        (CLI-render/surface)
 *   - `@/config/knob-inventory.ts`   (daemon/agent orphans)
 *   - `@/shared/runtime-config-knobs.ts` (typed runtime-config fields)
 * Each `QUANTA_*` knob must be declared in EXACTLY ONE of these — a knob in two
 * is a maintenance hazard (drift: which default/describe wins?). This ratchet
 * asserts the three are pairwise DISJOINT by envKey.
 *
 * NOTE: `@/runner/knobs` is intentionally EXCLUDED from this check — a few knobs
 * are read both there (typed Knob with apply) AND in runtime-config (dual
 * channel, e.g. mcp-tool-annotations, pinned by its own SSOT test). The unified
 * catalog's merge precedence (runner > runtime-config > inventory > cli) resolves
 * those; this ratchet only governs the three pure-declaration registries.
 */

import { describe, expect, test } from "bun:test"
import { CLI_KNOBS } from "@/apps/cli/cli-knobs"
import { KNOB_INVENTORY } from "@/config/knob-inventory"
import { RUNTIME_CONFIG_KNOBS } from "@/shared/runtime-config-knobs"

const keys = (xs: readonly { envKey: string }[]): ReadonlySet<string> =>
  new Set(xs.map((k) => k.envKey))
const intersect = (a: ReadonlySet<string>, b: ReadonlySet<string>): string[] =>
  [...a].filter((x) => b.has(x)).sort()

describe("knob declaration registries are pairwise disjoint (ADR-0503 P3)", () => {
  const cli = keys(CLI_KNOBS)
  const inv = keys(KNOB_INVENTORY)
  const rc = keys(RUNTIME_CONFIG_KNOBS)

  test("no envKey appears in more than one declaration registry", () => {
    expect(intersect(cli, inv)).toEqual([])
    expect(intersect(cli, rc)).toEqual([])
    expect(intersect(inv, rc)).toEqual([])
  })

  test("no duplicate envKey WITHIN a registry", () => {
    expect(CLI_KNOBS.length).toBe(cli.size)
    expect(KNOB_INVENTORY.length).toBe(inv.size)
    expect(RUNTIME_CONFIG_KNOBS.length).toBe(rc.size)
  })
})
