/**
 * ADR-0342 — Workspace `.quanta/apps.json` loader hellgate.
 *
 *   A. File-absent paths                          (2)
 *   B. JSON.parse failure modes                    (2)
 *   C. Shape failures (top-level / apps field)     (3)
 *   D. Valid entries                               (3)
 *   E. Per-entry validation                        (5)
 *   F. Workspace root edge cases                   (2)
 *
 * Total = 17 cases (>= the required 10).
 */

import { describe, expect, test } from "bun:test"
import { type FilesystemPort, loadWorkspaceAppCatalog } from "../loader"

/** Build a one-file in-memory fs. `null` ⇒ readFile returns `null`
 *  (file absent). A function ⇒ readFile delegates to it (lets tests
 *  throw / inspect path). A string ⇒ readFile returns the string. */
const fakeFs = (
  byPath: Record<
    string,
    string | null | ((path: string) => string | null | Promise<string | null>)
  >,
): FilesystemPort => ({
  async readFile(path: string): Promise<string | null> {
    const v = byPath[path]
    if (v === undefined) return null
    if (typeof v === "function") return v(path)
    return v
  },
})

const ROOT = "/ws"
const CATALOG_PATH = `${ROOT}/.quanta/apps.json`

describe("loadWorkspaceAppCatalog — ADR-0342 hellgate", () => {
  // -------- A. file-absent paths ---------------------------------

  test("A1 — readFile returns null ⇒ []", async () => {
    const fs = fakeFs({})
    const out = await loadWorkspaceAppCatalog(ROOT, fs)
    expect(out).toEqual([])
  })

  test("A2 — readFile throws (e.g. ENOENT) ⇒ []", async () => {
    const fs = fakeFs({
      [CATALOG_PATH]: () => {
        throw new Error("ENOENT")
      },
    })
    const out = await loadWorkspaceAppCatalog(ROOT, fs)
    expect(out).toEqual([])
  })

  // -------- B. JSON.parse failure --------------------------------

  test("B1 — JSON.parse throws on malformed input ⇒ []", async () => {
    const fs = fakeFs({ [CATALOG_PATH]: "{ this is not json" })
    const out = await loadWorkspaceAppCatalog(ROOT, fs)
    expect(out).toEqual([])
  })

  test("B2 — empty string body ⇒ JSON.parse throws ⇒ []", async () => {
    const fs = fakeFs({ [CATALOG_PATH]: "" })
    const out = await loadWorkspaceAppCatalog(ROOT, fs)
    expect(out).toEqual([])
  })

  // -------- C. shape failures ------------------------------------

  test("C1 — top-level JSON value is an array (not object) ⇒ []", async () => {
    const fs = fakeFs({ [CATALOG_PATH]: "[]" })
    const out = await loadWorkspaceAppCatalog(ROOT, fs)
    expect(out).toEqual([])
  })

  test("C2 — `apps` field absent ⇒ []", async () => {
    const fs = fakeFs({ [CATALOG_PATH]: JSON.stringify({ other: 1 }) })
    const out = await loadWorkspaceAppCatalog(ROOT, fs)
    expect(out).toEqual([])
  })

  test("C3 — `apps` is an object (not array) ⇒ []", async () => {
    const fs = fakeFs({ [CATALOG_PATH]: JSON.stringify({ apps: { a: 1 } }) })
    const out = await loadWorkspaceAppCatalog(ROOT, fs)
    expect(out).toEqual([])
  })

  // -------- D. valid entries -------------------------------------

  test("D1 — one valid entry ⇒ length 1 with verbatim fields", async () => {
    const fs = fakeFs({
      [CATALOG_PATH]: JSON.stringify({
        apps: [{ id: "figma", surface: "cli-browser", description: "Figma" }],
      }),
    })
    const out = await loadWorkspaceAppCatalog(ROOT, fs)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ id: "figma", surface: "cli-browser", description: "Figma" })
  })

  test("D2 — multiple valid entries preserve source order", async () => {
    const fs = fakeFs({
      [CATALOG_PATH]: JSON.stringify({
        apps: [
          { id: "a", surface: "cli" },
          { id: "b", surface: "cli-browser" },
          { id: "c", surface: "web-tauri" },
        ],
      }),
    })
    const out = await loadWorkspaceAppCatalog(ROOT, fs)
    expect(out.map((d) => d.id)).toEqual(["a", "b", "c"])
  })

  test("D3 — entry without description ⇒ field omitted (not null/undefined leak)", async () => {
    const fs = fakeFs({
      [CATALOG_PATH]: JSON.stringify({ apps: [{ id: "a", surface: "cli" }] }),
    })
    const out = await loadWorkspaceAppCatalog(ROOT, fs)
    expect(out[0]?.description).toBeUndefined()
    expect(Object.hasOwn(out[0] as object, "description")).toBe(false)
  })

  // -------- E. per-entry validation ------------------------------

  test("E1 — entry with missing id ⇒ skipped, valid siblings preserved", async () => {
    const fs = fakeFs({
      [CATALOG_PATH]: JSON.stringify({
        apps: [{ surface: "cli" }, { id: "ok", surface: "cli" }],
      }),
    })
    const out = await loadWorkspaceAppCatalog(ROOT, fs)
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe("ok")
  })

  test("E2 — entry with empty-string id ⇒ skipped", async () => {
    const fs = fakeFs({
      [CATALOG_PATH]: JSON.stringify({
        apps: [
          { id: "  ", surface: "cli" },
          { id: "ok", surface: "cli" },
        ],
      }),
    })
    const out = await loadWorkspaceAppCatalog(ROOT, fs)
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe("ok")
  })

  test("E3 — surface enum violation ⇒ entry skipped", async () => {
    const fs = fakeFs({
      [CATALOG_PATH]: JSON.stringify({
        apps: [
          { id: "x", surface: "ios" },
          { id: "y", surface: "cli" },
        ],
      }),
    })
    const out = await loadWorkspaceAppCatalog(ROOT, fs)
    expect(out.map((d) => d.id)).toEqual(["y"])
  })

  test("E4 — non-string description ⇒ entry skipped", async () => {
    const fs = fakeFs({
      [CATALOG_PATH]: JSON.stringify({
        apps: [
          { id: "x", surface: "cli", description: 42 },
          { id: "y", surface: "cli", description: null },
          { id: "z", surface: "cli" },
        ],
      }),
    })
    const out = await loadWorkspaceAppCatalog(ROOT, fs)
    expect(out.map((d) => d.id)).toEqual(["z"])
  })

  test("E5 — non-object entry (string, number, null) ⇒ skipped", async () => {
    const fs = fakeFs({
      [CATALOG_PATH]: JSON.stringify({
        apps: ["string", 42, null, { id: "ok", surface: "cli" }],
      }),
    })
    const out = await loadWorkspaceAppCatalog(ROOT, fs)
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe("ok")
  })

  // -------- F. workspace root edge cases -------------------------

  test("F1 — empty workspaceRoot ⇒ []", async () => {
    const fs = fakeFs({})
    const out = await loadWorkspaceAppCatalog("", fs)
    expect(out).toEqual([])
  })

  test("F2 — trailing slash on workspaceRoot ⇒ same catalog path resolved", async () => {
    const fs = fakeFs({
      [CATALOG_PATH]: JSON.stringify({ apps: [{ id: "ok", surface: "cli" }] }),
    })
    const out = await loadWorkspaceAppCatalog(`${ROOT}/`, fs)
    expect(out).toHaveLength(1)
    expect(out[0]?.id).toBe("ok")
  })
})
