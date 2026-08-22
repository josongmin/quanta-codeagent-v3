/**
 * ADR-0342 — `createWorkspaceAppCatalog` integration hellgate.
 *
 * Asserts the loader + merge + port factory compose correctly so a
 * caller's one-liner produces the expected port.
 *
 *   A. Missing workspace file ⇒ default catalog            (1)
 *   B. Workspace adds new id (append)                       (1)
 *   C. Workspace overrides default id (workspace wins)      (1)
 *   D. Malformed workspace file ⇒ default catalog           (1)
 *
 * Total = 4 cases.
 */

import { describe, expect, test } from "bun:test"
import { DEFAULT_APP_CATALOG } from "../default-catalog"
import type { FilesystemPort } from "../loader"
import { createWorkspaceAppCatalog } from "../workspace-catalog"

const fakeFs = (content: string | null | (() => never)): FilesystemPort => ({
  async readFile(_path: string): Promise<string | null> {
    if (typeof content === "function") {
      content()
      return null // unreachable; typeof-function branch throws above
    }
    return content
  },
})

describe("createWorkspaceAppCatalog — ADR-0342 integration hellgate", () => {
  test("A1 — missing workspace file ⇒ port over DEFAULT_APP_CATALOG", async () => {
    const port = await createWorkspaceAppCatalog("/ws", fakeFs(null))
    expect(port.list().map((d) => d.id)).toEqual(DEFAULT_APP_CATALOG.map((d) => d.id))
    expect(port.lookup("cli")?.surface).toBe("cli")
  })

  test("B1 — workspace adds a new id ⇒ appended after defaults", async () => {
    const port = await createWorkspaceAppCatalog(
      "/ws",
      fakeFs(
        JSON.stringify({
          apps: [{ id: "figma", surface: "cli-browser", description: "Figma" }],
        }),
      ),
    )
    expect(port.list().map((d) => d.id)).toEqual(["cli", "browser", "desktop", "figma"])
    expect(port.lookup("figma")?.description).toBe("Figma")
  })

  test("C1 — workspace overrides default id ⇒ workspace wins", async () => {
    const port = await createWorkspaceAppCatalog(
      "/ws",
      fakeFs(
        JSON.stringify({
          apps: [{ id: "cli", surface: "cli", description: "ws-customized" }],
        }),
      ),
    )
    expect(port.lookup("cli")?.description).toBe("ws-customized")
    expect(port.list()).toHaveLength(3) // same count — replacement, not append
  })

  test("D1 — malformed workspace file ⇒ port over DEFAULT_APP_CATALOG (NO-THROW)", async () => {
    const port = await createWorkspaceAppCatalog("/ws", fakeFs("{ not json"))
    expect(port.list().map((d) => d.id)).toEqual(DEFAULT_APP_CATALOG.map((d) => d.id))
  })
})
