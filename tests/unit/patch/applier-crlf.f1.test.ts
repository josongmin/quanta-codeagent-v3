import { describe, expect, test } from "bun:test"
import { detectEol as editDetectEol } from "../../../src/tool/edit/eol.js"
import { detectEol as sharedDetectEol } from "../../../src/shared/eol.js"
import {
  applyPatch,
  type PatchFileSystemPort,
  type PatchObservation,
  parsePatch,
} from "../../../src/patch/index.js"

// ---------------------------------------------------------------------------
// In-memory PatchFileSystemPort (same shape as applier.test.ts).
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

// ---------------------------------------------------------------------------
// [F1] CRLF CORRUPTION.
// The parser strips trailing \r from patch lines, so on a CRLF file the file
// lines keep "\r" while the patch oldBlock lines do not. Before the fix the
// exact tier never matches, every CRLF hunk falls to the trimmed tier, and the
// splice re-emits LF-only lines → MIXED EOL (edited region LF, rest CRLF).
// ---------------------------------------------------------------------------
describe("[F1] applyPatch — CRLF EOL preservation", () => {
  test("CRLF file stays uniformly CRLF after an Update hunk (no lone \\n)", async () => {
    // A genuine CRLF file. Every terminator is \r\n.
    const original = "line1\r\nline2\r\nline3\r\n"
    const fs = new MemFs({ "a.txt": original })
    const text = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      " line1",
      "-line2",
      "+LINE2",
      " line3",
      "*** End Patch",
    ].join("\n")
    await applyPatch(parsePatch(text), fs)
    const out = fs.snapshot()["a.txt"] ?? ""

    // The edited region (and the rest) must remain CRLF — the output must be
    // uniformly CRLF with NO lone LF (an \n not preceded by \r).
    expect(out).toBe("line1\r\nLINE2\r\nline3\r\n")
    // Belt-and-suspenders: assert there is no lone LF anywhere.
    let loneLf = 0
    for (let i = 0; i < out.length; i++) {
      if (out.charCodeAt(i) === 0x0a && !(i > 0 && out.charCodeAt(i - 1) === 0x0d)) loneLf++
    }
    expect(loneLf).toBe(0)
  })

  test("CRLF file matches at the EXACT tier (telemetry strict-improvement)", async () => {
    // Before the fix the patch oldBlock (\r-stripped) never line-equals the file
    // lines (with \r) so the tier degraded to "whitespace". After the fix the
    // EOL-agnostic split makes the EXACT tier match.
    const fs = new MemFs({ "a.txt": "alpha\r\nbeta\r\ngamma\r\n" })
    const text = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      " alpha",
      "-beta",
      "+BETA",
      " gamma",
      "*** End Patch",
    ].join("\n")
    const events: PatchObservation[] = []
    await applyPatch(parsePatch(text), fs, (e) => events.push(e))
    const hunkEvent = events.find((e) => "fuzzyMatchTier" in e)
    expect(hunkEvent).toEqual({ op: "update", fuzzyMatchTier: "exact" })
  })

  test("CRLF file with no trailing newline stays CRLF and keeps no terminator", async () => {
    const fs = new MemFs({ "a.txt": "x\r\ny\r\nz" }) // CRLF interior, no trailing terminator
    const text = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      " x",
      "-y",
      "+Y",
      " z",
      "*** End Patch",
    ].join("\n")
    await applyPatch(parsePatch(text), fs)
    expect(fs.snapshot()["a.txt"]).toBe("x\r\nY\r\nz")
  })

  test("EOF-anchored append to a CRLF file uses CRLF for the new lines", async () => {
    const fs = new MemFs({ "a.txt": "a\r\nb\r\n" })
    const text = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      "+appended-1",
      "+appended-2",
      "*** End of File",
      "*** End Patch",
    ].join("\n")
    await applyPatch(parsePatch(text), fs)
    expect(fs.snapshot()["a.txt"]).toBe("a\r\nb\r\nappended-1\r\nappended-2\r\n")
  })

  // ── DEFAULT byte-identical guard: LF path must be unchanged. ──────────────
  test("LF file legacy path stays byte-identical", async () => {
    const fs = new MemFs({ "a.txt": "line1\nline2\nline3\n" })
    const text = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      " line1",
      "-line2",
      "+LINE2",
      " line3",
      "*** End Patch",
    ].join("\n")
    await applyPatch(parsePatch(text), fs)
    expect(fs.snapshot()["a.txt"]).toBe("line1\nLINE2\nline3\n")
  })

  test("LF file with no trailing newline stays byte-identical (legacy)", async () => {
    const fs = new MemFs({ "a.txt": "x\ny\nz" })
    const text = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      " x",
      "-y",
      "+Y",
      " z",
      "*** End Patch",
    ].join("\n")
    await applyPatch(parsePatch(text), fs)
    expect(fs.snapshot()["a.txt"]).toBe("x\nY\nz")
  })
})

// ---------------------------------------------------------------------------
// [F1] PARITY RATCHET — the shared detectEol MUST NOT drift from the edit slice.
// Tests may cross slices (runtime must not). If these two ever diverge, the
// patch slice and edit slice would disagree on a file's EOL — exactly the kind
// of split-brain D6 + F1 exist to prevent.
// ---------------------------------------------------------------------------
describe("[F1] detectEol parity ratchet (@/shared vs @/tool/edit)", () => {
  const corpus: Array<{ name: string; src: string }> = [
    { name: "empty", src: "" },
    { name: "single line no terminator", src: "hello" },
    { name: "pure LF", src: "a\nb\nc\n" },
    { name: "pure CRLF", src: "a\r\nb\r\nc\r\n" },
    { name: "CRLF no trailing terminator", src: "a\r\nb\r\nc" },
    { name: "LF no trailing terminator", src: "a\nb\nc" },
    { name: "mixed CRLF-majority", src: "a\r\nb\r\nc\nd\r\n" },
    { name: "mixed LF-majority", src: "a\nb\nc\r\nd\n" },
    { name: "tie (1 CRLF, 1 LF) → LF", src: "a\r\nb\nc" },
    { name: "lone CR not a terminator", src: "a\rb\rc" },
    { name: "lone CR mixed with LF", src: "a\rb\nc\n" },
    { name: "blank lines LF", src: "\n\n\n" },
    { name: "blank lines CRLF", src: "\r\n\r\n\r\n" },
    { name: "leading CR then LF", src: "\r\na\r\n" },
  ]

  for (const { name, src } of corpus) {
    test(`identical detection: ${name}`, () => {
      expect(sharedDetectEol(src)).toBe(editDetectEol(src))
    })
  }
})
