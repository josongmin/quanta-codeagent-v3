/**
 * ADR-0413 / ADR-0418 — Composite resolver `files` dep async hellgate.
 *
 *   A. no `files` dep ⇒ port has NO resolveFile key (legacy shape)  (2)
 *   B. `files` dep wired ⇒ resolveFile reads the file               (1)
 *   C. file dep does NOT leak into skill/plugin/app dispatch        (1)
 *
 * Total = 4 cases. The ADR-0336 composite hellgate proves the 3-kind
 * shape is byte-identical (no edit there).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createCompositeMentionResolver } from "../composite-resolver"

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "quanta-composite-file-"))
  writeFileSync(join(root, "note.txt"), "hello from file\n", "utf8")
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("createCompositeMentionResolver files dep — ADR-0413 hellgate", () => {
  // -------- A. legacy shape preserved -------------------------------

  test("A1 — no files dep ⇒ resolveFile key is absent (legacy 3-kind shape)", async () => {
    const port = createCompositeMentionResolver()
    expect("resolveFile" in port).toBe(false)
    expect(port.resolveFile).toBeUndefined()
  })

  test("A2 — no files dep ⇒ 3-kind methods still present", async () => {
    const port = createCompositeMentionResolver()
    expect(typeof port.resolveSkill).toBe("function")
    expect(typeof port.resolvePlugin).toBe("function")
    expect(typeof port.resolveApp).toBe("function")
  })

  // -------- B. files dep wired --------------------------------------

  test("B1 — files dep wired ⇒ resolveFile reads the workspace file", async () => {
    const port = createCompositeMentionResolver({ files: { root } })
    expect(typeof port.resolveFile).toBe("function")
    expect(await port.resolveFile?.("note.txt")).toEqual({ bodyText: "hello from file\n" })
    expect(await port.resolveFile?.("missing.txt")).toBeNull()
  })

  // -------- C. isolation --------------------------------------------

  test("C1 — files dep does NOT make skill/plugin/app resolve (no leak)", async () => {
    const port = createCompositeMentionResolver({ files: { root } })
    expect(await port.resolveSkill?.("note.txt")).toBeNull()
    expect(await port.resolvePlugin?.("note.txt")).toBeNull()
    expect(await port.resolveApp?.("note.txt")).toBeNull()
  })
})
