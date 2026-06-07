/**
 * Unified knob catalog (ADR-0503 P3) — the merge/search/resolve that powers the
 * SOTA `/knobs` + `--help` config UX across the 3 layer-bound registries.
 */

import { describe, expect, test } from "bun:test"
import {
  type CatalogSources,
  catalogByGroup,
  catalogList,
  mergeKnobCatalog,
  resolveCatalogValues,
  searchCatalog,
} from "@/config/knob-catalog"
import { buildKnobCatalog } from "@/apps/cli/knob-catalog-wire"

const SRC: CatalogSources = {
  cli: [
    { envKey: "QUANTA_PILLS", kind: "bool", default: true, describe: "status pills", group: "status-ui" },
    { envKey: "QUANTA_SHARED", kind: "bool", default: false, describe: "cli view", group: "render" },
  ],
  inventory: [
    { envKey: "QUANTA_OTEL_FLUSH_MS", kind: "int", default: 5000, describe: "otel flush", group: "observability", home: "runtime-config" },
    { envKey: "QUANTA_SHARED", kind: "string", default: "inv", describe: "inv view", group: "host-gate", home: "runtime-config" },
  ],
  runner: [
    { envKey: "QUANTA_ADVISOR_MODEL", describe: "advisor", category: "agent", default: "x", hotToggleable: true },
    { envKey: "QUANTA_SHARED", describe: "runner view", category: "tool", hotToggleable: false },
  ],
}

describe("knob-catalog merge/search/resolve (ADR-0503 P3)", () => {
  test("merge: precedence runner > inventory > cli on collision", () => {
    const cat = mergeKnobCatalog(SRC)
    // 4 distinct envKeys (QUANTA_SHARED collides across all 3)
    expect(cat.size).toBe(4)
    const shared = cat.get("QUANTA_SHARED")
    expect(shared?.home).toBe("runner-knobs") // runner wins
    expect(shared?.describe).toBe("runner view")
    expect(cat.get("QUANTA_PILLS")?.home).toBe("cli")
    expect(cat.get("QUANTA_OTEL_FLUSH_MS")?.home).toBe("runtime-config")
    expect(cat.get("QUANTA_ADVISOR_MODEL")?.hotToggleable).toBe(true)
  })

  test("list is envKey-sorted; byGroup buckets", () => {
    const cat = mergeKnobCatalog(SRC)
    const list = catalogList(cat)
    expect(list.map((k) => k.envKey)).toEqual([...list.map((k) => k.envKey)].sort())
    const groups = catalogByGroup(cat)
    expect(groups.has("status-ui")).toBe(true)
  })

  test("search: envKey-prefix ranked first, matches describe+group", () => {
    const cat = mergeKnobCatalog(SRC)
    expect(searchCatalog(cat, "otel").map((k) => k.envKey)).toContain("QUANTA_OTEL_FLUSH_MS")
    expect(searchCatalog(cat, "advisor")[0]?.envKey).toBe("QUANTA_ADVISOR_MODEL")
    expect(searchCatalog(cat, "observability").map((k) => k.envKey)).toContain("QUANTA_OTEL_FLUSH_MS")
  })

  test("resolve: env > session > default with source tracking", () => {
    const cat = mergeKnobCatalog(SRC)
    const vals = resolveCatalogValues(
      cat,
      { QUANTA_PILLS: "0" },
      { QUANTA_OTEL_FLUSH_MS: "9000" },
    )
    expect(vals.get("QUANTA_PILLS")).toMatchObject({ raw: "0", source: "env", isDefault: false })
    expect(vals.get("QUANTA_OTEL_FLUSH_MS")).toMatchObject({ raw: "9000", source: "session" })
    expect(vals.get("QUANTA_ADVISOR_MODEL")).toMatchObject({ raw: "x", source: "default", isDefault: true })
  })

  test("integration: buildKnobCatalog merges all 3 real registries (large + 0 dups)", () => {
    const cat = buildKnobCatalog()
    // cli-knobs (~89) + inventory (~150) + runner (~49) minus cross-surface dups
    expect(cat.size).toBeGreaterThan(200)
    // every entry has the required UI fields populated
    for (const k of cat.values()) {
      expect(k.envKey.startsWith("QUANTA_")).toBe(true)
      expect(typeof k.describe).toBe("string")
      expect(k.describe.length).toBeGreaterThan(0)
      expect(["cli", "runtime-config", "runner-knobs", "bench"]).toContain(k.home)
    }
    // the runner registry actually populated (side-effect import worked)
    expect([...cat.values()].some((k) => k.home === "runner-knobs")).toBe(true)
  })
})
