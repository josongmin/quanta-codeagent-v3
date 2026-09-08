// Slice-level convert → parse → apply for H-PATCH-01 rename-only + collision.

import { describe, expect, test } from "bun:test"
import { applyPatch, parsePatch, unifiedDiffToV4A } from "@/patch"
import type { PatchFileSystemPort } from "@/patch/types"

class MemFs implements PatchFileSystemPort {
  private readonly files = new Map<string, string>()
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

describe("H-PATCH-01 integration — convert, parse, apply", () => {
  test("rename+edit unified diff: old path gone, new path has edited bytes, filesMoved set", async () => {
    const input = [
      "diff --git a/old.py b/new.py",
      "similarity index 89%",
      "rename from old.py",
      "rename to new.py",
      "--- a/old.py",
      "+++ b/new.py",
      "@@ -1 +1 @@",
      "-alpha",
      "+beta",
    ].join("\n")
    const fs = new MemFs({ "old.py": "alpha\n" })
    const result = await applyPatch(parsePatch(unifiedDiffToV4A(input)), fs)
    expect(result.filesMoved).toEqual([["old.py", "new.py"]])
    expect(result.filesUpdated).toEqual([])
    expect(fs.snapshot()).toEqual({ "new.py": "beta\n" })
  })
})
