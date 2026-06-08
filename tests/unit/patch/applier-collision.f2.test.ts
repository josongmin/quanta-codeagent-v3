import { describe, expect, test } from "bun:test"
import { applyPatch, PatchApplyError, type PatchFileSystemPort, parsePatch } from "../../../src/patch/index.js"

// In-memory PatchFileSystemPort.
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

// ---------------------------------------------------------------------------
// [F2] INTRA-PATCH OP COLLISION.
// plan* validate each op against the REAL disk, ignoring earlier ops in the same
// patch. So:
//   (a) "move A to B" + "add B": both pass planning, then add SILENTLY CLOBBERS
//       the moved file at commit (no existence recheck) → data loss.
//   (b) "delete A" + "add A": FALSELY rejected (add sees A still on disk).
//   (c) "add A" + "update A": FALSELY rejected (update sees A not on disk).
// FIX: validate + read each op against a virtual-FS overlay accumulating prior
// planned effects. A genuine collision (two ops writing the same final path) is
// a typed PatchApplyError — never a silent clobber.
// ---------------------------------------------------------------------------

describe("[F2] applyPatch — intra-patch op collision", () => {
  test("(a) move A→B + add B must NOT silently clobber the moved file", async () => {
    const fs = new MemFs({ "A.txt": "moved-content\n" })
    // Move A to B (with a trivial edit), THEN add a new file at B.
    const text = [
      "*** Begin Patch",
      "*** Update File: A.txt",
      "*** Move to: B.txt",
      "@@",
      "-moved-content",
      "+moved-content-edited",
      "*** Add File: B.txt",
      "+brand-new",
      "*** End Patch",
    ].join("\n")

    // Two ops target the final path B.txt. The ONLY acceptable behaviours are:
    //   - a clear typed error (collision), OR
    //   - both land deterministically with NO silent loss.
    // A silent clobber (B.txt ends up = "brand-new", the moved content vanished)
    // is the bug. Today this throws nothing and B.txt = "brand-new\n".
    let threw = false
    try {
      await applyPatch(parsePatch(text), fs)
    } catch (e) {
      threw = true
      expect(e).toBeInstanceOf(PatchApplyError)
    }

    if (!threw) {
      // If it did NOT error, it must not have silently destroyed the moved
      // content. (This assertion is what fails today: B.txt = "brand-new\n".)
      const out = fs.snapshot()["B.txt"] ?? ""
      expect(out).not.toBe("brand-new\n")
    }
    // Regardless: the move's edited content must not be lost without a trace.
    expect(threw).toBe(true)
  })

  test("(b) delete A + add A must SUCCEED (replace a file in one patch)", async () => {
    const fs = new MemFs({ "A.txt": "old\n" })
    const text = [
      "*** Begin Patch",
      "*** Delete File: A.txt",
      "*** Add File: A.txt",
      "+new\n".trimEnd(), // "+new"
      "*** End Patch",
    ].join("\n")
    await applyPatch(parsePatch(text), fs)
    expect(fs.snapshot()).toEqual({ "A.txt": "new" })
  })

  test("(c) add A + update A must SUCCEED (create then edit in one patch)", async () => {
    const fs = new MemFs()
    const text = [
      "*** Begin Patch",
      "*** Add File: A.txt",
      "+hello",
      "+world",
      "*** Update File: A.txt",
      "@@",
      " hello",
      "-world",
      "+WORLD",
      "*** End Patch",
    ].join("\n")
    await applyPatch(parsePatch(text), fs)
    expect(fs.snapshot()).toEqual({ "A.txt": "hello\nWORLD" })
  })

  test("(d) add A + add A (true collision) is a typed PatchApplyError, not a clobber", async () => {
    const fs = new MemFs()
    const text = [
      "*** Begin Patch",
      "*** Add File: A.txt",
      "+first",
      "*** Add File: A.txt",
      "+second",
      "*** End Patch",
    ].join("\n")
    await expect(applyPatch(parsePatch(text), fs)).rejects.toBeInstanceOf(PatchApplyError)
    // And nothing was written (plan-phase rejection ⇒ disk untouched).
    expect(fs.snapshot()).toEqual({})
  })

  test("(e) legacy single-op add against real disk still rejects existing target", async () => {
    const fs = new MemFs({ "A.txt": "exists" })
    const text = ["*** Begin Patch", "*** Add File: A.txt", "+x", "*** End Patch"].join("\n")
    await expect(applyPatch(parsePatch(text), fs)).rejects.toBeInstanceOf(PatchApplyError)
  })
})
