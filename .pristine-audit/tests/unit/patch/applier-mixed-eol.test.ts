import { describe, expect, test } from "bun:test"
import { applyPatch, type PatchFileSystemPort, parsePatch } from "../../../src/patch/index.js"

// ---------------------------------------------------------------------------
// In-memory PatchFileSystemPort.
// ---------------------------------------------------------------------------
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

/** Count lone-LF (an \n not preceded by \r) and CRLF terminators in `s`. */
const eolTally = (s: string): { crlf: number; loneLf: number } => {
  let crlf = 0
  let loneLf = 0
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 0x0a) {
      if (i > 0 && s.charCodeAt(i - 1) === 0x0d) crlf++
      else loneLf++
    }
  }
  return { crlf, loneLf }
}

// ===========================================================================
// [F1] MIXED-EOL INPUT — whole-file normalization to the DOMINANT EOL.
//
// The documented contract: `splitLines` detects the file's DOMINANT terminator
// (CRLF iff a STRICT majority, else LF) and `joinLines` re-emits the WHOLE file
// with that one terminator. So an Update on a genuinely mixed-EOL file
// normalizes EVERY line — including untouched lines whose original terminator
// differed from the majority. These tests PIN that observable byte output so a
// future detectEol tie/majority change cannot silently alter untouched-line
// bytes uncaught. Production is ALREADY correct; the suite did not lock it.
// ===========================================================================
describe("[F1] applyPatch — mixed-EOL input normalizes whole file to dominant EOL", () => {
  test("CRLF-majority mixed file (3 CRLF, 1 LF) ⇒ untouched lone-LF line is rewritten to CRLF", async () => {
    // l1\r\n l2\n l3\r\n l4\r\n  → CRLF majority (3 vs 1). The lone-LF after l2
    // is on an UNTOUCHED line (the hunk only edits l3), yet the dominant-EOL
    // contract rewrites the WHOLE file to CRLF. Pin that exact output.
    const original = "l1\r\nl2\nl3\r\nl4\r\n"
    expect(eolTally(original)).toEqual({ crlf: 3, loneLf: 1 }) // sanity: CRLF majority
    const fs = new MemFs({ "a.txt": original })
    const text = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      " l2",
      "-l3",
      "+L3",
      " l4",
      "*** End Patch",
    ].join("\n")
    await applyPatch(parsePatch(text), fs)
    const out = fs.snapshot()["a.txt"] ?? ""

    // Whole file is uniformly CRLF — the untouched l2's lone LF became \r\n.
    expect(out).toBe("l1\r\nl2\r\nL3\r\nl4\r\n")
    // No lone LF survives anywhere; every terminator is now CRLF.
    expect(eolTally(out)).toEqual({ crlf: 4, loneLf: 0 })
  })

  test("LF-majority mixed file (1 CRLF, 3 LF) ⇒ untouched CRLF line is rewritten to LF", async () => {
    // a\r\n b\n c\n d\n → LF majority (3 vs 1). The CRLF after `a` is untouched
    // (the hunk edits c) yet normalizes to LF (dominant). Pin the exact output.
    const original = "a\r\nb\nc\nd\n"
    expect(eolTally(original)).toEqual({ crlf: 1, loneLf: 3 }) // sanity: LF majority
    const fs = new MemFs({ "a.txt": original })
    const text = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      " b",
      "-c",
      "+C",
      " d",
      "*** End Patch",
    ].join("\n")
    await applyPatch(parsePatch(text), fs)
    const out = fs.snapshot()["a.txt"] ?? ""

    // Whole file uniformly LF — `a`'s original CRLF normalized to a lone LF.
    expect(out).toBe("a\nb\nC\nd\n")
    expect(eolTally(out)).toEqual({ crlf: 0, loneLf: 4 })
  })

  test("EOL tie (1 CRLF, 1 LF) ⇒ resolves to LF (default) and rewrites the CRLF line", async () => {
    // a\r\n b\n → tie. detectEol's STRICT-majority rule keeps the LF default on a
    // tie (never introduces CRLF), so the whole file normalizes to LF.
    const original = "a\r\nb\n"
    expect(eolTally(original)).toEqual({ crlf: 1, loneLf: 1 }) // sanity: tie
    const fs = new MemFs({ "a.txt": original })
    const text = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "-a",
      "+A",
      " b",
      "*** End Patch",
    ].join("\n")
    await applyPatch(parsePatch(text), fs)
    const out = fs.snapshot()["a.txt"] ?? ""
    expect(out).toBe("A\nb\n")
    expect(eolTally(out)).toEqual({ crlf: 0, loneLf: 2 })
  })
})
