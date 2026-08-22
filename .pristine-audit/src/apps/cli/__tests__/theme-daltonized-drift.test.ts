/**
 * ticket-15 (§11.7B) — drift guard binding the colorblind theme ENUM to the
 * palette SSOT. This is a LIVE (green) invariant guard, NOT a pending-integration
 * stub: `VALID_THEMES` ALREADY carries `light-daltonized` / `dark-daltonized`
 * (registry-surface.ts) and `getColorPalette` ALREADY resolves both, so the two
 * surfaces are wired together TODAY and this test pins them so they cannot drift
 * apart.
 *
 * Claude Code's settings schema `theme` enum (schema.json:2691) includes
 * `light-daltonized` / `dark-daltonized` (CONFIRMED real CC names). The `/color`
 * slash accepts both (they are in `VALID_THEMES`) and they map to a colorblind
 * palette via `getColorPalette` (proven here).
 *
 * What is NOT yet wired is the DOWNSTREAM render seam: no host renderer reads
 * `getColorPalette` to map a selected `*-daltonized` theme onto the actual hex
 * role colors at the status/box render call-site. That render-root consumer is
 * the open seam tracked by this feature's `deliberate_hold` — it is unrelated to
 * the enum↔palette binding this test guards (which is green).
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { getColorPalette } from "../color-palettes"

// `VALID_THEMES` lives in the preferences sub-module of the surface registry
// (extracted from `registry-surface.ts` to keep that file under the god-module
// ceiling); the enum↔palette invariant this guard pins is unchanged.
const REGISTRY_SRC = "src/apps/cli/slash/registry-surface/preferences-cmds.ts"

/** Extract the `VALID_THEMES = [...] as const` literal members. */
const validThemes = (): readonly string[] => {
  const src = readFileSync(REGISTRY_SRC, "utf8")
  const m = src.match(/const VALID_THEMES = \[([^\]]*)\] as const/)
  if (m?.[1] === undefined) throw new Error("VALID_THEMES literal not found")
  return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1] as string)
}

describe("theme daltonized drift (enum ↔ palette binding)", () => {
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
