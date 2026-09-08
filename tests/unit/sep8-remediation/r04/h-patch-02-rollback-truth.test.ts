// H-PATCH-02 — rollback truth: a failed undo must not be reported as a
// clean restore. Successful rollback still claims unchanged.

import { describe, expect, test } from "bun:test"
import { applyPatch, messageForModel, parsePatch } from "@/patch"
import {
  PatchApplyError,
  type PatchFileSystemPort,
  PatchRollbackIncompleteError,
} from "@/patch/types"

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

/**
 * Two-file update patch. `throwOnCommitOf` mutates then throws on that path's
 * FIRST write (commit). Subsequent writes to `failUndoOf` throw (undo).
 */
class CommitThenUndoFailFs extends MemFs {
  private readonly writeCount = new Map<string, number>()
  constructor(
    seed: Record<string, string>,
    private readonly throwOnCommitOf: string,
    private readonly failUndoOf: ReadonlySet<string>,
  ) {
    super(seed)
  }
  override async writeFile(path: string, content: string): Promise<void> {
    const n = (this.writeCount.get(path) ?? 0) + 1
    this.writeCount.set(path, n)
    if (path === this.throwOnCommitOf && n === 1) {
      this.files.set(path, content)
      throw new Error(`injected commit failure on '${path}'`)
    }
    if (this.failUndoOf.has(path) && n >= 2) {
      throw new Error(`injected undo failure on '${path}'`)
    }
    await super.writeFile(path, content)
  }
}

const twoFilePatch = [
  "*** Begin Patch",
  "*** Update File: A.txt",
  "@@",
  "-A-original",
  "+A-edited",
  "*** Update File: B.txt",
  "@@",
  "-B-original",
  "+B-edited",
  "*** End Patch",
].join("\n")

describe("H-PATCH-02 — rollback outcome matches leftover disk bytes", () => {
  test("commit failure + undo failure → rollbackIncomplete; leftover bytes match failed paths", async () => {
    const fs = new CommitThenUndoFailFs(
      { "A.txt": "A-original\n", "B.txt": "B-original\n" },
      "B.txt",
      new Set(["A.txt", "B.txt"]),
    )
    let thrown: unknown
    try {
      await applyPatch(parsePatch(twoFilePatch), fs)
      throw new Error("expected applyPatch to throw")
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(PatchRollbackIncompleteError)
    if (!(thrown instanceof PatchRollbackIncompleteError)) {
      throw new Error("expected PatchRollbackIncompleteError")
    }
    expect(thrown.outcome).toBe("rollbackIncomplete")
    expect(thrown.failedUndos.length).toBeGreaterThan(0)
    expect(thrown.uncertainPaths).toEqual(expect.arrayContaining(["A.txt", "B.txt"]))
    expect(errMessage(thrown.originalError)).toContain("injected commit failure on 'B.txt'")
    expect(thrown.message).not.toMatch(/was rolled back/)
    expect(thrown.message).not.toContain("the file is unchanged")
    const hint = messageForModel(thrown)
    expect(hint).not.toContain("the file is unchanged")
    expect(hint).not.toMatch(/was rolled back/)
    expect(hint).toMatch(/incomplete|uncertain|leftover/i)
    expect(fs.snapshot()).toEqual({ "A.txt": "A-edited\n", "B.txt": "B-edited\n" })
    for (const failure of thrown.failedUndos) {
      expect(typeof failure.path).toBe("string")
      expect(failure.path.length).toBeGreaterThan(0)
      expect(failure.cause.length).toBeGreaterThan(0)
    }
  })

  test("successful rollback control still restores original bytes and may say unchanged", async () => {
    const fs = new CommitThenUndoFailFs(
      { "A.txt": "A-original\n", "B.txt": "B-original\n" },
      "B.txt",
      new Set(),
    )
    let thrown: unknown
    try {
      await applyPatch(parsePatch(twoFilePatch), fs)
      throw new Error("expected applyPatch to throw")
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(PatchApplyError)
    expect(thrown).not.toBeInstanceOf(PatchRollbackIncompleteError)
    if (!(thrown instanceof PatchApplyError)) throw new Error("expected PatchApplyError")
    expect(thrown.message).toMatch(/rolled back/)
    expect(thrown.message).toContain("injected commit failure on 'B.txt'")
    const hint = messageForModel(thrown)
    expect(hint).toMatch(/unchanged/)
    expect(fs.snapshot()).toEqual({ "A.txt": "A-original\n", "B.txt": "B-original\n" })
  })

  test("mutate-then-throw is recovered when undo succeeds (F5 journal-before-write)", async () => {
    const fs = new CommitThenUndoFailFs(
      { "A.txt": "A-original\n", "B.txt": "B-original\n" },
      "B.txt",
      new Set(),
    )
    await expect(applyPatch(parsePatch(twoFilePatch), fs)).rejects.toThrow(
      /injected commit failure/,
    )
    expect(fs.snapshot()).toEqual({ "A.txt": "A-original\n", "B.txt": "B-original\n" })
  })

  test("mutation: swallow undo errors or always say rolled-back/unchanged is RED", async () => {
    const fs = new CommitThenUndoFailFs(
      { "A.txt": "A-original\n", "B.txt": "B-original\n" },
      "B.txt",
      new Set(["A.txt"]),
    )
    let thrown: unknown
    try {
      await applyPatch(parsePatch(twoFilePatch), fs)
      throw new Error("expected applyPatch to throw")
    } catch (e) {
      thrown = e
    }
    // If rollback swallowed A's undo failure, this would be PatchApplyError
    // claiming rolled back while A.txt still holds edited bytes.
    expect(thrown).toBeInstanceOf(PatchRollbackIncompleteError)
    if (!(thrown instanceof PatchRollbackIncompleteError)) {
      throw new Error("expected PatchRollbackIncompleteError")
    }
    expect(thrown.uncertainPaths).toContain("A.txt")
    expect(messageForModel(thrown)).not.toContain("the file is unchanged")
    expect(messageForModel(thrown)).not.toMatch(/was rolled back/)
    expect(fs.snapshot()["A.txt"]).toBe("A-edited\n")
    expect(fs.snapshot()["B.txt"]).toBe("B-original\n")
  })
})

function errMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
