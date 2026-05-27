/**
 * ADR-0342 — `mergeAppCatalogs` hellgate.
 *
 *   A. Empty-input edges                          (3)
 *   B. Precedence on id collision                 (2)
 *   C. New-id append + ordering                   (3)
 *   D. Defensive input shape                      (2)
 *
 * Total = 10 cases (>= the required 6).
 */

import { describe, expect, test } from "bun:test"
import { DEFAULT_APP_CATALOG } from "../default-catalog"
import { mergeAppCatalogs } from "../merge"
import type { AppDescriptor } from "../types"

describe("mergeAppCatalogs — ADR-0342 hellgate", () => {
  // -------- A. empty edges ---------------------------------------

  test("A1 — base empty + overrides empty ⇒ []", () => {
    expect(mergeAppCatalogs([], [])).toEqual([])
  })

  test("A2 — base only (overrides empty) ⇒ base order preserved", () => {
    const base: readonly AppDescriptor[] = [
      { id: "a", surface: "cli" },
      { id: "b", surface: "cli" },
    ]
    expect(mergeAppCatalogs(base, [])).toEqual(base)
  })

  test("A3 — overrides only (base empty) ⇒ overrides order preserved", () => {
    const overrides: readonly AppDescriptor[] = [
      { id: "x", surface: "cli" },
      { id: "y", surface: "web-tauri" },
    ]
    expect(mergeAppCatalogs([], overrides)).toEqual(overrides)
  })

  // -------- B. precedence on collision ---------------------------

  test("B1 — id collision: workspace override REPLACES base entry", () => {
    const base: readonly AppDescriptor[] = [
      { id: "cli", surface: "cli", description: "default cli" },
    ]
    const overrides: readonly AppDescriptor[] = [
      { id: "cli", surface: "cli", description: "workspace-customized cli" },
    ]
    const merged = mergeAppCatalogs(base, overrides)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.description).toBe("workspace-customized cli")
  })

  test("B2 — id collision: override may change surface field too", () => {
    const base: readonly AppDescriptor[] = [{ id: "foo", surface: "cli" }]
    const overrides: readonly AppDescriptor[] = [{ id: "foo", surface: "web-tauri" }]
    const merged = mergeAppCatalogs(base, overrides)
    expect(merged[0]?.surface).toBe("web-tauri")
  })

  // -------- C. new id append + ordering --------------------------

  test("C1 — new override id APPENDS after base entries", () => {
    const base: readonly AppDescriptor[] = [{ id: "a", surface: "cli" }]
    const overrides: readonly AppDescriptor[] = [{ id: "b", surface: "cli" }]
    const merged = mergeAppCatalogs(base, overrides)
    expect(merged.map((d) => d.id)).toEqual(["a", "b"])
  })

  test("C2 — mixed: 1 collision-override + 1 new-id append", () => {
    const base: readonly AppDescriptor[] = [
      { id: "cli", surface: "cli", description: "old" },
      { id: "browser", surface: "cli-browser" },
    ]
    const overrides: readonly AppDescriptor[] = [
      { id: "cli", surface: "cli", description: "new" },
      { id: "figma", surface: "cli-browser", description: "Figma" },
    ]
    const merged = mergeAppCatalogs(base, overrides)
    expect(merged.map((d) => d.id)).toEqual(["cli", "browser", "figma"])
    expect(merged[0]?.description).toBe("new")
    expect(merged[2]?.description).toBe("Figma")
  })

  test("C3 — DEFAULT_APP_CATALOG passthrough when overrides empty", () => {
    const merged = mergeAppCatalogs(DEFAULT_APP_CATALOG, [])
    expect(merged.map((d) => d.id)).toEqual(["cli", "browser", "desktop"])
  })

  // -------- D. defensive shape ----------------------------------

  test("D1 — null / non-array inputs ⇒ treated as empty (NO-THROW)", () => {
    const base = null as unknown as readonly AppDescriptor[]
    const overrides = "not-an-array" as unknown as readonly AppDescriptor[]
    expect(mergeAppCatalogs(base, overrides)).toEqual([])
  })

  test("D2 — entries with missing id / non-object ⇒ skipped (NO-THROW)", () => {
    const base = [
      null,
      { surface: "cli" },
      { id: "", surface: "cli" },
      { id: "ok", surface: "cli" },
    ] as unknown as readonly AppDescriptor[]
    const overrides: readonly AppDescriptor[] = []
    const merged = mergeAppCatalogs(base, overrides)
    expect(merged).toHaveLength(1)
    expect(merged[0]?.id).toBe("ok")
  })
})
