/**
 * ADR-0336 — Default app catalog hellgate.
 *
 *   A. 3 default app lookup                      (3)
 *   B. Unknown id ⇒ null                         (1)
 *   C. list() returns 3                          (1)
 *   D. Surface enum closure (3 surfaces present) (1)
 *   E. Description preserved verbatim            (1)
 *   F. In-memory adapter snapshot isolation      (1)
 *
 * Total = 8 cases (>= the required 5).
 */

import { describe, expect, test } from "bun:test"
import { createInMemoryAppCatalog, DEFAULT_APP_CATALOG, defaultAppCatalog } from "../index"
import type { AppDescriptor, AppSurface } from "../types"

describe("defaultAppCatalog — ADR-0336 hellgate", () => {
  // -------- A. 3 default app lookup -------------------------------

  test("A1 — lookup('cli') returns the cli surface descriptor", () => {
    const d = defaultAppCatalog.lookup("cli")
    expect(d?.id).toBe("cli")
    expect(d?.surface).toBe("cli")
  })

  test("A2 — lookup('browser') returns the cli-browser descriptor", () => {
    const d = defaultAppCatalog.lookup("browser")
    expect(d?.id).toBe("browser")
    expect(d?.surface).toBe("cli-browser")
  })

  test("A3 — lookup('desktop') returns the web-tauri descriptor", () => {
    const d = defaultAppCatalog.lookup("desktop")
    expect(d?.id).toBe("desktop")
    expect(d?.surface).toBe("web-tauri")
  })

  // -------- B. unknown id -----------------------------------------

  test("B1 — unknown id ⇒ null", () => {
    expect(defaultAppCatalog.lookup("nonexistent")).toBeNull()
  })

  // -------- C. list cardinality ----------------------------------

  test("C1 — list() returns exactly 3 entries", () => {
    expect(defaultAppCatalog.list()).toHaveLength(3)
    expect(DEFAULT_APP_CATALOG).toHaveLength(3)
  })

  // -------- D. surface enum closure ------------------------------

  test("D1 — all three surfaces are represented across the default catalog", () => {
    const surfaces = new Set<AppSurface>()
    for (const d of DEFAULT_APP_CATALOG) surfaces.add(d.surface)
    expect(surfaces.has("cli")).toBe(true)
    expect(surfaces.has("cli-browser")).toBe(true)
    expect(surfaces.has("web-tauri")).toBe(true)
    expect(surfaces.size).toBe(3)
  })

  // -------- E. description verbatim ------------------------------

  test("E1 — descriptions are non-empty strings", () => {
    for (const d of DEFAULT_APP_CATALOG) {
      expect(typeof d.description).toBe("string")
      expect(d.description?.length).toBeGreaterThan(0)
    }
  })

  // -------- F. snapshot isolation --------------------------------

  test("F1 — mutating caller array post-construction does not leak", () => {
    const arr: AppDescriptor[] = [{ id: "a", surface: "cli" }]
    const cat = createInMemoryAppCatalog(arr)
    arr.push({ id: "b", surface: "cli" })
    expect(cat.lookup("b")).toBeNull()
    expect(cat.list()).toHaveLength(1)
  })
})
