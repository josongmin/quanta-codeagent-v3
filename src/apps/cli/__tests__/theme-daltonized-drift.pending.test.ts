/**
 * ticket-15 (§11.7B) — PENDING-INTEGRATION drift guard for the colorblind theme
 * enum. RED until the orchestrator applies the `VALID_THEMES += daltonized`
 * integration snippet to `src/apps/cli/slash/registry-surface.ts` (an
 * integration file this slice must NOT edit directly).
 *
 * Claude Code's settings schema `theme` enum (schema.json:2691) includes
 * `light-daltonized` / `dark-daltonized` (CONFIRMED real CC names). Once
 * `VALID_THEMES` carries both, `/color light-daltonized` becomes accepted and
 * the host renderer can resolve the colorblind palette via `getColorPalette`.
 *
 * Mirrors the existing `getColorPalette` SSOT: the two CC enum names MUST be
 * accepted themes AND map to a colorblind palette (proven here), so the palette
 * surface and the slash surface cannot drift apart.
 *
 * When the snippet lands, this file goes GREEN and should be renamed off the
 * `.pending` suffix (or merged into the registry-surface test).
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { getColorPalette } from "../color-palettes"

const REGISTRY_SRC = "src/apps/cli/slash/registry-surface.ts"

/** Extract the `VALID_THEMES = [...] as const` literal members. */
const validThemes = (): readonly string[] => {
  const src = readFileSync(REGISTRY_SRC, "utf8")
  const m = src.match(/const VALID_THEMES = \[([^\]]*)\] as const/)
  if (m?.[1] === undefined) throw new Error("VALID_THEMES literal not found")
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1] as string)
}

describe("theme daltonized drift (PENDING integration)", () => {
  test("VALID_THEMES includes the CC colorblind enum names", () => {
    const themes = validThemes()
    expect(themes).toContain("light-daltonized")
    expect(themes).toContain("dark-daltonized")
  })

  test("legacy themes are preserved (additive, no regression)", () => {
    const themes = validThemes()
    for (const legacy of ["auto", "light", "dark", "claude", "none"]) {
      expect(themes).toContain(legacy)
    }
  })

  test("each daltonized theme resolves to a colorblind palette", () => {
    expect(getColorPalette("light-daltonized").id).toBe("light-daltonized")
    expect(getColorPalette("dark-daltonized").id).toBe("dark-daltonized")
  })
})
