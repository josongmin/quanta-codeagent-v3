/**
 * ticket-15 §11.7(B) — colorblind palette SSOT hellgate.
 *
 *   §P-1  getColorPalette maps each known id → that palette
 *   §P-2  invalid / unknown / empty / undefined ⇒ default (NEVER throws)
 *   §P-3  generic light/dark/auto/claude themes ⇒ default (not a daltonized id)
 *   §P-4  case-insensitive + whitespace-tolerant id matching
 *   §P-5  EVERY variant's role colors are non-empty valid hex (#RRGGBB)
 *   §P-6  EVERY variant's categorical ramp is non-empty + all valid hex
 *   §P-7  the CC enum names (light-daltonized / dark-daltonized) are present
 *   §P-8  achromatopsia is greyscale only (R==G==B per swatch — hue-free)
 */

import { describe, expect, test } from "bun:test"
import { COLOR_PALETTE_IDS, type ColorPaletteId, getColorPalette } from "../color-palettes"

const HEX = /^#[0-9a-fA-F]{6}$/

describe("color-palettes — getColorPalette", () => {
  test("§P-1 each known id maps to a palette whose id matches", () => {
    for (const id of COLOR_PALETTE_IDS) {
      const p = getColorPalette(id)
      expect(p.id).toBe(id)
    }
  })

  test("§P-2 invalid / unknown / empty / undefined ⇒ default (no throw)", () => {
    for (const bad of [undefined, "", "   ", "nope", "rainbow", "light-x", "DALTON"]) {
      const p = getColorPalette(bad as string | undefined)
      expect(p.id).toBe("default")
    }
  })

  test("§P-2 prototype-chain keys ⇒ default (no Object.prototype leak)", () => {
    // `key in PALETTES` walks the prototype chain, so 'constructor'/'__proto__'/
    // 'toString'/'valueOf'/'hasOwnProperty' would resolve to Object.prototype
    // members — NOT palettes (the contract: ALWAYS a usable palette, never a
    // function/undefined). Each must fall back to `default`.
    for (const proto of [
      "constructor",
      "__proto__",
      "toString",
      "valueOf",
      "hasOwnProperty",
      "isPrototypeOf",
      "prototype",
    ]) {
      const p = getColorPalette(proto)
      expect(p.id).toBe("default")
      // Sanity: a real palette object (has the role keys), not a smuggled fn.
      expect(typeof p).toBe("object")
      expect(typeof p.primary).toBe("string")
    }
  })

  test("§P-3 generic themes (auto/light/dark/claude/none) ⇒ default", () => {
    for (const theme of ["auto", "light", "dark", "claude", "none"]) {
      expect(getColorPalette(theme).id).toBe("default")
    }
  })

  test("§P-4 id matching is case-insensitive + trims whitespace", () => {
    expect(getColorPalette("Light-Daltonized").id).toBe("light-daltonized")
    expect(getColorPalette("  dark-daltonized  ").id).toBe("dark-daltonized")
    expect(getColorPalette("DEUTERANOPIA").id).toBe("deuteranopia")
  })

  test("§P-7 CC enum names light-daltonized / dark-daltonized are present", () => {
    expect(COLOR_PALETTE_IDS).toContain("light-daltonized")
    expect(COLOR_PALETTE_IDS).toContain("dark-daltonized")
  })

  test("§P-5 every variant's role colors are valid non-empty hex", () => {
    for (const id of COLOR_PALETTE_IDS) {
      const p = getColorPalette(id)
      for (const role of [p.primary, p.success, p.warning, p.error, p.info, p.muted]) {
        expect(role.length).toBeGreaterThan(0)
        expect(role).toMatch(HEX)
      }
    }
  })

  test("§P-6 every variant's categorical ramp is non-empty + all valid hex", () => {
    for (const id of COLOR_PALETTE_IDS) {
      const p = getColorPalette(id)
      expect(p.categorical.length).toBeGreaterThan(0)
      for (const c of p.categorical) {
        expect(c).toMatch(HEX)
      }
    }
  })

  test("§P-8 achromatopsia swatches are greyscale (R==G==B, hue-free)", () => {
    const p = getColorPalette("achromatopsia" satisfies ColorPaletteId)
    const swatches = [p.primary, p.success, p.warning, p.error, p.info, p.muted, ...p.categorical]
    for (const hex of swatches) {
      const r = hex.slice(1, 3)
      const g = hex.slice(3, 5)
      const b = hex.slice(5, 7)
      expect(g.toLowerCase()).toBe(r.toLowerCase())
      expect(b.toLowerCase()).toBe(r.toLowerCase())
    }
  })

  test("§P-2b every distinct variant is structurally complete (no dup default leak)", () => {
    // Each non-default id resolves to a palette tagged with its own id — proves
    // the registry isn't silently collapsing variants onto `default`.
    const seen = new Set<string>()
    for (const id of COLOR_PALETTE_IDS) seen.add(getColorPalette(id).id)
    expect(seen.size).toBe(COLOR_PALETTE_IDS.length)
  })
})
