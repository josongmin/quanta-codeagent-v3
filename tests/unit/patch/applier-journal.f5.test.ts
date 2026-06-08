import { describe, expect, test } from "bun:test"
import { applyPatch, type PatchFileSystemPort, parsePatch } from "../../../src/patch/index.js"

// Base in-memory port.
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
 * A port that, for ONE designated path, PARTIALLY mutates the file (writes the
 * new bytes — an observable side effect, like a real partial fsync) and THEN
 * THROWS. This models a writeFile that fails mid-effect on a LATER op.
 *
 * [F5] If commitPlan pushes the restore journal entry AFTER the mutating write,
 * then when this write throws the restore closure is NEVER registered, so the
 * rollback cannot undo the partial mutation. The fix journals the inverse BEFORE
 * invoking the write.
 */
class PartialWriteThenThrowFs extends MemFs {
  constructor(
    seed: Record<string, string>,
    private readonly throwOnPath: string,
  ) {
    super(seed)
  }
  override async writeFile(path: string, content: string): Promise<void> {
    if (path === this.throwOnPath) {
      // Observable partial mutation FIRST, then fail — exactly the hazard.
      this.files.set(path, content)
      throw new Error(`injected partial-write failure on '${path}'`)
    }
    await super.writeFile(path, content)
  }
}

// ---------------------------------------------------------------------------
// [F5] JOURNAL-AFTER-WRITE GAP.
// ---------------------------------------------------------------------------
describe("[F5] applyPatch — transactional journal-before-write", () => {
  test("a write that mutates-then-throws on a LATER op restores ALL files to original bytes", async () => {
    // op1 updates A (succeeds). op2 updates B, whose write partially mutates B
    // and then throws. Rollback MUST restore A AND B to their original bytes.
    // Before the fix, B has no journal entry (the push followed the throwing
    // write), so B is left CORRUPTED with the partial new content.
    const fs = new PartialWriteThenThrowFs(
      { "A.txt": "A-original\n", "B.txt": "B-original\n" },
      "B.txt",
    )
    const text = [
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

    await expect(applyPatch(parsePatch(text), fs)).rejects.toThrow(/partial-write failure/)

    // The WHOLE patch is all-or-nothing: both files back to original bytes.
    expect(fs.snapshot()).toEqual({ "A.txt": "A-original\n", "B.txt": "B-original\n" })
  })

  test("an Add whose write mutates-then-throws leaves NO orphan file behind", async () => {
    // op1 adds new.txt. op2 adds boom.txt whose write partially lands then
    // throws. Rollback must delete BOTH partial creations.
    const fs = new PartialWriteThenThrowFs({}, "boom.txt")
    const text = [
      "*** Begin Patch",
      "*** Add File: new.txt",
      "+created",
      "*** Add File: boom.txt",
      "+partial",
      "*** End Patch",
    ].join("\n")

    await expect(applyPatch(parsePatch(text), fs)).rejects.toThrow(/partial-write failure/)
    // Neither file should survive — the partial add is journaled BEFORE its write.
    expect(fs.snapshot()).toEqual({})
  })

  test("a move whose source write mutates-then-throws restores the source to original", async () => {
    // The move path writes the edited content into the SOURCE before rename. If
    // that write mutates-then-throws, the source must be restored to original.
    const fs = new PartialWriteThenThrowFs({ "src.txt": "src-original\n" }, "src.txt")
    const text = [
      "*** Begin Patch",
      "*** Update File: src.txt",
      "*** Move to: dst.txt",
      "@@",
      "-src-original",
      "+src-edited",
      "*** End Patch",
    ].join("\n")

    await expect(applyPatch(parsePatch(text), fs)).rejects.toThrow(/partial-write failure/)
    expect(fs.snapshot()).toEqual({ "src.txt": "src-original\n" })
  })

  test("legacy: a clean successful multi-op patch still commits and journals nothing observable", async () => {
    const fs = new MemFs({ "a.txt": "x\n" })
    const text = [
      "*** Begin Patch",
      "*** Add File: b.txt",
      "+created",
      "*** Update File: a.txt",
      "@@",
      "-x",
      "+X",
      "*** End Patch",
    ].join("\n")
    const r = await applyPatch(parsePatch(text), fs)
    expect(r.filesAdded).toEqual(["b.txt"])
    expect(r.filesUpdated).toEqual(["a.txt"])
    expect(fs.snapshot()).toEqual({ "a.txt": "X\n", "b.txt": "created" })
  })
})
