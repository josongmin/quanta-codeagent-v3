import { describe, expect, test } from "bun:test"
import { applyPatch, type PatchFileSystemPort, parsePatch } from "../../../src/patch/index.js"

// ---------------------------------------------------------------------------
// Base in-memory port.
// ---------------------------------------------------------------------------
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
 * A port whose renameFile, for ONE designated destination, PARTIALLY mutates the
 * filesystem (removes the source AND writes the destination — an observable side
 * effect, like a real partial rename across a boundary) and THEN throws. Models
 * a renameFile that fails mid-effect on a LATER op.
 *
 * [F5] The move-op journals its rename-undo BEFORE calling renameFile (reaping
 * the leaked destination + restoring the source). If the inverse were journaled
 * AFTER the throwing rename, that step would be un-recoverable and rollback would
 * leave the moved file orphaned at the destination + the source gone.
 */
class PartialRenameThenThrowFs extends MemFs {
  constructor(
    seed: Record<string, string>,
    private readonly throwOnTo: string,
  ) {
    super(seed)
  }
  override async renameFile(from: string, to: string): Promise<void> {
    if (to === this.throwOnTo) {
      const v = this.files.get(from)
      if (v === undefined) throw new Error(`MemFs: cannot rename missing '${from}'`)
      // Observable partial mutation FIRST (source removed, dest written), then
      // fail — exactly the leak-then-throw rename hazard.
      this.files.delete(from)
      this.files.set(to, v)
      throw new Error(`injected partial-rename failure on '${to}'`)
    }
    await super.renameFile(from, to)
  }
}

/**
 * A port whose deleteFile, for ONE designated path, PARTIALLY mutates (removes
 * the file) and THEN throws. Models a deleteFile that fails mid-effect on a
 * LATER op (e.g. the inode is unlinked but the syscall reports a later error).
 *
 * [F5] The delete-op journals its restore (rewrite original bytes) BEFORE calling
 * deleteFile, so rollback re-materialises the removed file. Journaling after the
 * throwing delete would leave the file permanently gone.
 */
class PartialDeleteThenThrowFs extends MemFs {
  constructor(
    seed: Record<string, string>,
    private readonly throwOnPath: string,
  ) {
    super(seed)
  }
  override async deleteFile(path: string): Promise<void> {
    if (path === this.throwOnPath) {
      if (!this.files.has(path)) throw new Error(`MemFs: cannot delete missing '${path}'`)
      // Observable partial mutation FIRST (file removed), then fail.
      this.files.delete(path)
      throw new Error(`injected partial-delete failure on '${path}'`)
    }
    await super.deleteFile(path)
  }
}

// ===========================================================================
// [F5] RENAME-THROW / DELETE-THROW ROLLBACK.
//
// The shipped F5 test only injected a throwing writeFile. These extend coverage
// to the OTHER two mutating port methods (rename for a Move op, delete for a
// Delete op): a mutate-then-throw on a LATER op must roll ALL files back to
// exact original bytes (the WHOLE patch is all-or-nothing).
// ===========================================================================
describe("[F5] applyPatch — transactional rollback across rename + delete throws", () => {
  test("a MOVE whose renameFile mutates-then-throws on a LATER op restores ALL files to original bytes", async () => {
    // op1 updates A in place (succeeds). op2 updates src.txt and moves it to
    // dst.txt; the rename to dst.txt partially mutates then throws. Rollback MUST
    // restore A AND src.txt to original bytes, and leave NO dst.txt orphan.
    const fs = new PartialRenameThenThrowFs(
      { "A.txt": "A-original\n", "src.txt": "src-original\n" },
      "dst.txt",
    )
    const text = [
      "*** Begin Patch",
      "*** Update File: A.txt",
      "@@",
      "-A-original",
      "+A-edited",
      "*** Update File: src.txt",
      "*** Move to: dst.txt",
      "@@",
      "-src-original",
      "+src-edited",
      "*** End Patch",
    ].join("\n")

    await expect(applyPatch(parsePatch(text), fs)).rejects.toThrow(
      /partial-rename failure|rolled back/,
    )

    // WHOLE patch is all-or-nothing: A back to original, src back to original,
    // and dst.txt must NOT survive (the leaked destination is reaped).
    expect(fs.snapshot()).toEqual({ "A.txt": "A-original\n", "src.txt": "src-original\n" })
  })

  test("a DELETE whose deleteFile mutates-then-throws on a LATER op restores ALL files to original bytes", async () => {
    // op1 updates keep.txt (succeeds). op2 deletes doomed.txt; the delete
    // partially removes it then throws. Rollback MUST restore keep.txt AND
    // re-materialise doomed.txt with its exact original bytes.
    const fs = new PartialDeleteThenThrowFs(
      { "keep.txt": "keep-original\n", "doomed.txt": "doomed-original\n" },
      "doomed.txt",
    )
    const text = [
      "*** Begin Patch",
      "*** Update File: keep.txt",
      "@@",
      "-keep-original",
      "+keep-edited",
      "*** Delete File: doomed.txt",
      "*** End Patch",
    ].join("\n")

    await expect(applyPatch(parsePatch(text), fs)).rejects.toThrow(
      /partial-delete failure|rolled back/,
    )

    expect(fs.snapshot()).toEqual({
      "keep.txt": "keep-original\n",
      "doomed.txt": "doomed-original\n",
    })
  })

  test("a lone MOVE (first op) whose rename mutates-then-throws restores the source + no dst orphan", async () => {
    // No earlier op — the move's own in-place source write succeeds, then the
    // rename leaks dst + throws. Rollback restores src to original, removes dst.
    const fs = new PartialRenameThenThrowFs({ "src.txt": "src-original\n" }, "dst.txt")
    const text = [
      "*** Begin Patch",
      "*** Update File: src.txt",
      "*** Move to: dst.txt",
      "@@",
      "-src-original",
      "+src-edited",
      "*** End Patch",
    ].join("\n")
    await expect(applyPatch(parsePatch(text), fs)).rejects.toThrow(
      /partial-rename failure|rolled back/,
    )
    expect(fs.snapshot()).toEqual({ "src.txt": "src-original\n" })
  })
})
