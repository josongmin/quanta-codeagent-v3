/**
 * ADR-0336 — App resolver hellgate.
 *
 *   A. Catalog absent / null lookup            (2)
 *   B. Hit with description                    (1)
 *   C. Hit without description                 (1)
 *   D. NO-THROW invariant                      (1)
 *   E. Empty / whitespace target               (1)
 *   F. All 3 default surfaces resolvable       (1)
 *
 * Total = 7 cases (>= the required 6).
 */

import { describe, expect, test } from "bun:test"
import type { AppCatalogPort, AppDescriptor } from "@/agent/app-catalog"
import { defaultAppCatalog } from "@/agent/app-catalog"
import { createAppResolver } from "../app-resolver"

const stubCatalog = (lookup: (id: string) => AppDescriptor | null): AppCatalogPort => ({
  lookup,
  list: () => [],
})

describe("createAppResolver — ADR-0336 hellgate", () => {
  // -------- A. catalog absent / null -----------------------------

  test("A1 — catalog omitted ⇒ null", () => {
    const resolve = createAppResolver()
    expect(resolve?.("browser")).toBeNull()
  })

  test("A2 — catalog.lookup returns null ⇒ null", () => {
    const resolve = createAppResolver(stubCatalog(() => null))
    expect(resolve?.("missing")).toBeNull()
  })

  // -------- B. hit with description ------------------------------

  test("B1 — descriptor with description ⇒ bodyText = surface + ' — ' + description", () => {
    const resolve = createAppResolver(
      stubCatalog(() => ({
        id: "browser",
        surface: "cli-browser",
        description: "the embedded browser",
      })),
    )
    expect(resolve?.("browser")).toEqual({
      bodyText: "surface: cli-browser — the embedded browser",
    })
  })

  // -------- C. hit without description ---------------------------

  test("C1 — descriptor without description ⇒ bodyText = surface only", () => {
    const resolve = createAppResolver(stubCatalog(() => ({ id: "x", surface: "cli" })))
    expect(resolve?.("x")).toEqual({ bodyText: "surface: cli" })
  })

  // -------- D. NO-THROW invariant --------------------------------

  test("D1 — catalog throws ⇒ null", () => {
    const resolve = createAppResolver(
      stubCatalog(() => {
        throw new Error("hostile catalog")
      }),
    )
    expect(resolve?.("anything")).toBeNull()
  })

  // -------- E. empty / whitespace target -------------------------

  test("E1 — empty target ⇒ null (no lookup call)", () => {
    let called = false
    const resolve = createAppResolver(
      stubCatalog(() => {
        called = true
        return null
      }),
    )
    expect(resolve?.("")).toBeNull()
    expect(called).toBe(false)
  })

  // -------- F. all 3 default surfaces resolvable -----------------

  test("F1 — defaultAppCatalog resolves all three surface ids", () => {
    const resolve = createAppResolver(defaultAppCatalog)
    expect(resolve?.("cli")?.bodyText).toContain("surface: cli")
    expect(resolve?.("browser")?.bodyText).toContain("surface: cli-browser")
    expect(resolve?.("desktop")?.bodyText).toContain("surface: web-tauri")
  })
})
