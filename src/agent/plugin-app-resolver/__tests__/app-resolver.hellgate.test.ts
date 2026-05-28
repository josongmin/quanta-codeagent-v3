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

describe("createAppResolver — ADR-0336/0418 async hellgate", () => {
  // -------- A. catalog absent / null -----------------------------

  test("A1 — catalog omitted ⇒ null", async () => {
    const resolve = createAppResolver()
    expect(await resolve?.("browser")).toBeNull()
  })

  test("A2 — catalog.lookup returns null ⇒ null", async () => {
    const resolve = createAppResolver(stubCatalog(() => null))
    expect(await resolve?.("missing")).toBeNull()
  })

  // -------- B. hit with description ------------------------------

  test("B1 — descriptor with description ⇒ bodyText = surface + ' — ' + description", async () => {
    const resolve = createAppResolver(
      stubCatalog(() => ({
        id: "browser",
        surface: "cli-browser",
        description: "the embedded browser",
      })),
    )
    expect(await resolve?.("browser")).toEqual({
      bodyText: "surface: cli-browser — the embedded browser",
    })
  })

  // -------- C. hit without description ---------------------------

  test("C1 — descriptor without description ⇒ bodyText = surface only", async () => {
    const resolve = createAppResolver(stubCatalog(() => ({ id: "x", surface: "cli" })))
    expect(await resolve?.("x")).toEqual({ bodyText: "surface: cli" })
  })

  // -------- D. NO-THROW invariant --------------------------------

  test("D1 — catalog throws ⇒ null", async () => {
    const resolve = createAppResolver(
      stubCatalog(() => {
        throw new Error("hostile catalog")
      }),
    )
    expect(await resolve?.("anything")).toBeNull()
  })

  // -------- E. empty / whitespace target -------------------------

  test("E1 — empty target ⇒ null (no lookup call)", async () => {
    let called = false
    const resolve = createAppResolver(
      stubCatalog(() => {
        called = true
        return null
      }),
    )
    expect(await resolve?.("")).toBeNull()
    expect(called).toBe(false)
  })

  // -------- F. all 3 default surfaces resolvable -----------------

  test("F1 — defaultAppCatalog resolves all three surface ids", async () => {
    const resolve = createAppResolver(defaultAppCatalog)
    expect((await resolve?.("cli"))?.bodyText).toContain("surface: cli")
    expect((await resolve?.("browser"))?.bodyText).toContain("surface: cli-browser")
    expect((await resolve?.("desktop"))?.bodyText).toContain("surface: web-tauri")
  })
})
