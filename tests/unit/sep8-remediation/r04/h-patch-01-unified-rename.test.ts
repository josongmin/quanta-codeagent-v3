// H-PATCH-01 — unified git rename must become Update + Move to, not an
// in-place update of the old path. Apply-level assertions use an in-memory
// PatchFileSystemPort (MemFs). Public PatchOp stays kind:"update" + moveTo.

import { describe, expect, test } from "bun:test"
import { applyPatch, parsePatch, unifiedDiffToV4A } from "@/patch"
import { PatchConvertError, type PatchFileSystemPort } from "@/patch/types"

class MemFs implements PatchFileSystemPort {
  protected readonly files = new Map<string, string>()
  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.files.set(k, v)
  }
  async readFile(path: string): Promise<string> {
    const v = this.files.get(path)
    if (v === undefined) throw new Error(`MemFs: no such file '${path}'`)
    return v
  }
  async writeFile(path: string, content: string): Promise<void> {
    this.files.set(path, content)
  }
  async deleteFile(path: string): Promise<void> {
    if (!this.files.has(path)) throw new Error(`MemFs: cannot delete missing '${path}'`)
    this.files.delete(path)
  }
  async renameFile(from: string, to: string): Promise<void> {
    const v = this.files.get(from)
    if (v === undefined) throw new Error(`MemFs: cannot rename missing '${from}'`)
    this.files.delete(from)
    this.files.set(to, v)
  }
  async exists(path: string): Promise<boolean> {
    return this.files.has(path)
  }
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.files.entries())
  }
}

const renameEditDiff = [
  "diff --git a/old.py b/new.py",
  "similarity index 89%",
  "rename from old.py",
  "rename to new.py",
  "index abc..def 100644",
  "--- a/old.py",
  "+++ b/new.py",
  "@@ -1 +1 @@",
  "-old_content",
  "+new_content",
].join("\n")

describe("H-PATCH-01 — unified git rename is a move, not an update of the old path", () => {
  test("rename+edit: parsePatch yields kind:update with moveTo; apply moves edited bytes", async () => {
    const v4a = unifiedDiffToV4A(renameEditDiff)
    const patch = parsePatch(v4a)
    expect(patch.ops).toHaveLength(1)
    const op = patch.ops[0]
    expect(op?.kind).toBe("update")
    if (op?.kind !== "update") throw new Error("expected update")
    expect(op.path).toBe("old.py")
    expect(op.moveTo).toBe("new.py")
    expect(op.kind).not.toBe("move")

    const fs = new MemFs({ "old.py": "old_content\n" })
    const result = await applyPatch(patch, fs)
    expect(result.filesMoved).toEqual([["old.py", "new.py"]])
    expect(fs.snapshot()).toEqual({ "new.py": "new_content\n" })
    expect(await fs.exists("old.py")).toBe(false)
  })

  test("rename-only (no hunk body) still emits Update + Move to and relocates bytes", async () => {
    const input = [
      "diff --git a/old.py b/new.py",
      "similarity index 100%",
      "rename from old.py",
      "rename to new.py",
    ].join("\n")
    const v4a = unifiedDiffToV4A(input)
    expect(v4a).toContain("*** Update File: old.py")
    expect(v4a).toContain("*** Move to: new.py")
    expect(v4a).not.toContain("@@")
    const patch = parsePatch(v4a)
    const op = patch.ops[0]
    expect(op?.kind).toBe("update")
    if (op?.kind !== "update") throw new Error("expected update")
    expect(op.path).toBe("old.py")
    expect(op.moveTo).toBe("new.py")
    expect(op.hunks).toHaveLength(0)

    const fs = new MemFs({ "old.py": "unchanged-body\n" })
    const result = await applyPatch(patch, fs)
    expect(result.filesMoved).toEqual([["old.py", "new.py"]])
    expect(fs.snapshot()).toEqual({ "new.py": "unchanged-body\n" })
  })

  test("quoted git paths unquote to real paths and apply as a move", async () => {
    const input = [
      'diff --git "a/old file.py" "b/new file.py"',
      "similarity index 89%",
      'rename from "old file.py"',
      'rename to "new file.py"',
      '--- "a/old file.py"',
      '+++ "b/new file.py"',
      "@@ -1 +1 @@",
      "-old_content",
      "+new_content",
    ].join("\n")
    const patch = parsePatch(unifiedDiffToV4A(input))
    const op = patch.ops[0]
    expect(op?.kind).toBe("update")
    if (op?.kind !== "update") throw new Error("expected update")
    expect(op.path).toBe("old file.py")
    expect(op.moveTo).toBe("new file.py")

    const fs = new MemFs({ "old file.py": "old_content\n" })
    const result = await applyPatch(patch, fs)
    expect(result.filesMoved).toEqual([["old file.py", "new file.py"]])
    expect(fs.snapshot()).toEqual({ "new file.py": "new_content\n" })
  })

  test("inconsistent rename from/to vs ---/+++ is rejected, not degraded to update", () => {
    const input = [
      "diff --git a/old.py b/new.py",
      "rename from old.py",
      "rename to new.py",
      "--- a/old.py",
      "+++ b/other.py",
      "@@ -1 +1 @@",
      "-old_content",
      "+new_content",
    ].join("\n")
    expect(() => unifiedDiffToV4A(input)).toThrow(PatchConvertError)
    expect(() => unifiedDiffToV4A(input)).toThrow(/inconsistent|rename/i)
  })

  test("rename from without rename to is rejected, not degraded to update", () => {
    const input = [
      "diff --git a/old.py b/new.py",
      "rename from old.py",
      "--- a/old.py",
      "+++ b/new.py",
      "@@ -1 +1 @@",
      "-old_content",
      "+new_content",
    ].join("\n")
    expect(() => unifiedDiffToV4A(input)).toThrow(PatchConvertError)
  })

  test("destination collision is still rejected; source bytes stay put", async () => {
    const fs = new MemFs({ "old.py": "old_content\n", "new.py": "already-there\n" })
    const patch = parsePatch(unifiedDiffToV4A(renameEditDiff))
    await expect(applyPatch(patch, fs)).rejects.toThrow(/already exists/)
    expect(fs.snapshot()).toEqual({ "old.py": "old_content\n", "new.py": "already-there\n" })
  })

  test("converter emits literal paths; it does not rewrite symlink-style destinations", () => {
    const input = [
      "diff --git a/old.py b/link-dest.py",
      "rename from old.py",
      "rename to sub/../link-dest.py",
      "--- a/old.py",
      "+++ b/sub/../link-dest.py",
      "@@ -1 +1 @@",
      "-old_content",
      "+new_content",
    ].join("\n")
    const v4a = unifiedDiffToV4A(input)
    expect(v4a).toContain("*** Move to: sub/../link-dest.py")
    const patch = parsePatch(v4a)
    const op = patch.ops[0]
    if (op?.kind !== "update") throw new Error("expected update")
    expect(op.moveTo).toBe("sub/../link-dest.py")
  })
})
