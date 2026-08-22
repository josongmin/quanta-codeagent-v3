import { describe, expect, test } from "bun:test"
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

// ===========================================================================
// [GAP A] applier scored-candidate decisive-best tie-break (mirror edit ADR-0456).
//
// The applier's trimmed tier accepts only a UNIQUE position; 2+ trimmed matches
// THROW PatchApplyError("ambiguous"). edit recovers many such cases SAFELY by
// scoring each ambiguous window on the COUNT of VERBATIM-exact lines and applying
// IFF exactly one window STRICTLY beats every other (a unique strict maximum).
// A tie at the top ⇒ keep failing ambiguous (fail-closed). Pure measurement,
// NO threshold. A wrong apply is the cardinal sin.
// ===========================================================================
describe("[GAP A] applyPatch — scored-candidate decisive-best tie-break", () => {
  test("DECISIVE: two trimmed-equal windows, one verbatim-exact on MORE lines ⇒ applies at the decisive window", async () => {
    // Two windows are trimmed-equal to the oldBlock ["foo","bar","baz"]:
    //   window @0: ["  foo","bar","baz"]   — lines 1,2 verbatim-exact (score 2)
    //   window @5: ["  foo","  bar","  baz"] — all indented      (score 0)
    // Neither matches at the EXACT tier (line 0 is indented in both / lines
    // differ), so the locator falls to the TRIMMED tier → 2 hits → today THROWS.
    // After the fix the scored tie-break applies at the strict-best window @0.
    const original = ["  foo", "bar", "baz", "MID-1", "MID-2", "  foo", "  bar", "  baz"].join("\n")
    const fs = new MemFs({ "a.txt": `${original}\n` })
    const text = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      " foo",
      " bar",
      "-baz",
      "+BAZ",
      "*** End Patch",
    ].join("\n")

    await applyPatch(parsePatch(text), fs)
    const out = fs.snapshot()["a.txt"] ?? ""

    // The edit MUST land at the decisive window @0. V4A splices in the hunk's
    // newBlock (context lines verbatim from the patch + the +insert), so the
    // window @0 becomes ["foo","bar","BAZ"] (the patch's un-indented context).
    // The SECOND window @5 must be byte-untouched (still indented "  foo"/etc).
    expect(out).toBe(
      `${["foo", "bar", "BAZ", "MID-1", "MID-2", "  foo", "  bar", "  baz"].join("\n")}\n`,
    )
  })

  test("DECISIVE: telemetry tier stays 'whitespace' for the scored (trimmed-derived) win", async () => {
    const original = ["  foo", "bar", "baz", "MID", "  foo", "  bar", "  baz"].join("\n")
    const fs = new MemFs({ "a.txt": `${original}\n` })
    const text = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      " foo",
      " bar",
      "-baz",
      "+BAZ",
      "*** End Patch",
    ].join("\n")
    const events: PatchObservation[] = []
    await applyPatch(parsePatch(text), fs, (e) => events.push(e))
    const hunkEvent = events.find((e) => "fuzzyMatchTier" in e)
    // A trimmed-derived win is reported as "whitespace" (no new tier introduced).
    expect(hunkEvent).toEqual({ op: "update", fuzzyMatchTier: "whitespace" })
  })

  test("TIE: two trimmed-equal windows with EQUAL verbatim-exact scores ⇒ still THROWS ambiguous (fail-closed)", async () => {
    // Both windows score exactly 2 verbatim lines (line 0 indented in both,
    // lines 1,2 exact in both). No unique strict maximum ⇒ keep failing.
    const original = ["  foo", "bar", "baz", "MID-1", "MID-2", "  foo", "bar", "baz"].join("\n")
    const before = `${original}\n`
    const fs = new MemFs({ "a.txt": before })
    const text = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      " foo",
      " bar",
      "-baz",
      "+BAZ",
      "*** End Patch",
    ].join("\n")

    await expect(applyPatch(parsePatch(text), fs)).rejects.toThrow(/[Aa]mbiguous/)
    // Fail-closed: the file is byte-untouched (whole patch is all-or-nothing).
    expect(fs.snapshot()["a.txt"]).toBe(before)
  })

  test("EXACT tier still wins outright — a single exact match never reaches the scored tier", async () => {
    // One window is verbatim-exact; an indented decoy is trimmed-equal. The exact
    // tier finds the unique exact window FIRST and applies there. The scored tier
    // never runs (no behavior change on the exact path).
    const original = ["foo", "bar", "baz", "MID", "  foo", "  bar", "  baz"].join("\n")
    const fs = new MemFs({ "a.txt": `${original}\n` })
    const text = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      " foo",
      " bar",
      "-baz",
      "+BAZ",
      "*** End Patch",
    ].join("\n")
    await applyPatch(parsePatch(text), fs)
    expect(fs.snapshot()["a.txt"]).toBe(
      `${["foo", "bar", "BAZ", "MID", "  foo", "  bar", "  baz"].join("\n")}\n`,
    )
  })

  test("MISAPPLY GUARD: the wrong (lower-score) window is NEVER edited on the decisive path", async () => {
    // Decisive window @0 (score 2) wins; the lower-score window @5 (score 0) must
    // remain byte-identical to its original indented form.
    const original = ["  foo", "bar", "baz", "X", "  foo", "  bar", "  baz"].join("\n")
    const fs = new MemFs({ "a.txt": `${original}\n` })
    const text = [
      "*** Begin Patch",
      "*** Update File: a.txt",
      "@@",
      " foo",
      " bar",
      "-baz",
      "+BAZ",
      "*** End Patch",
    ].join("\n")
    await applyPatch(parsePatch(text), fs)
    const out = (fs.snapshot()["a.txt"] ?? "").split("\n")
    // The lower-score window's lines (indices 4..6) are untouched.
    expect(out.slice(4, 7)).toEqual(["  foo", "  bar", "  baz"])
    // And the decisive window's "baz" became "BAZ".
    expect(out[2]).toBe("BAZ")
  })
})
