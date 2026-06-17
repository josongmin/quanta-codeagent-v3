/**
 * T-401 — patch hygiene gate. Teeth: #16642-class stray adds (`.Z`/`.br`) are
 * denied deterministically, `reproduce_issue.py` is allowed, a new source file
 * is NOT stray, and owner-outside is telemetry (no deny).
 */
import { describe, expect, test } from "bun:test"
import { buildPatchHygiene } from "@/runner/batch/eval/patch-hygiene"

const block = (file: string, added: boolean) =>
  `diff --git a/${file} b/${file}\n${added ? "new file mode 100644\n" : ""}--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n-x\n+y\n`

describe("buildPatchHygiene", () => {
  test("flags #16642-class stray added files (.Z/.br)", () => {
    const diff = block("django/http/response.py", false) + block("test.html.Z", true) + block("test.html.br", true)
    const r = buildPatchHygiene(diff)
    expect(r.strayAddedFiles.sort()).toEqual(["test.html.Z", "test.html.br"])
    expect(r.violation).toBe(true)
    expect(r.patchFileCount).toBe(3)
    expect(r.addedFiles.sort()).toEqual(["test.html.Z", "test.html.br"])
  })

  test("reproduce_issue.py is allowlisted (not a violation)", () => {
    const r = buildPatchHygiene(block("django/x.py", false) + block("reproduce_issue.py", true))
    expect(r.strayAddedFiles).toEqual([])
    expect(r.violation).toBe(false)
  })

  test("a newly-added SOURCE file is not stray", () => {
    const r = buildPatchHygiene(block("django/new_module.py", true))
    expect(r.violation).toBe(false)
    expect(r.addedFiles).toEqual(["django/new_module.py"])
  })

  test("owner-outside is telemetry only, never a deny", () => {
    const r = buildPatchHygiene(block("django/wrong.py", false), { ownerFiles: ["django/right.py"] })
    expect(r.filesOutsideOwner).toEqual(["django/wrong.py"])
    expect(r.violation).toBe(false) // outside-owner alone never blocks in v1
  })

  test("owner unknown (empty set) → no owner-outside noise", () => {
    const r = buildPatchHygiene(block("django/a.py", false), { ownerFiles: [] })
    expect(r.filesOutsideOwner).toEqual([])
  })

  test("empty diff degrades cleanly", () => {
    const r = buildPatchHygiene("")
    expect(r).toMatchObject({ patchFileCount: 0, addedFiles: [], strayAddedFiles: [], violation: false })
  })
})
