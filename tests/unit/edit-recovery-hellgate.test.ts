/**
 * ★ CONTRACT — E2: src/tool/edit/{fuzzy,strategy-hint}.ts + src/patch (V4A).
 *   3-stage recovery ladder: exact → fuzzy (whitespace-flex) → no-confident-
 *   match returns ok:false + structured `classifyMismatch` / `formatStrategy
 *   Hint` naming the next action (read_then_patch / scripted_replace).
 *   Ambiguous match (old_string appears 2+ times) → reject + scripted_replace
 *   hint, file NOT mutated. apply_patch V4A `*** Move to:` rename + edit is
 *   ATOMIC (invalid edit ⇒ rename does NOT half-apply; occupied dest ⇒ both
 *   files untouched).
 */
import { describe, expect, test } from "bun:test"
import {
  applyPatch,
  type FileSystemPort,
  parsePatch,
  PatchApplyError,
} from "../../src/patch/index.js"
import { applyFuzzyEdit } from "../../src/tool/edit/fuzzy"
import { classifyMismatch, formatStrategyHint } from "../../src/tool/edit/strategy-hint"

/**
 * E2 HELLGATE — the edit-recovery ladder's hard exhaustion behavior.
 *
 * The ladder must (a) recover via fuzzy when exact fails benignly, (b) FAIL
 * LOUDLY with a structured next-action hint when no confident match exists,
 * (c) REJECT ambiguous matches rather than silently editing the wrong span,
 * and (d) keep a V4A `*** Move to:` rename+edit ATOMIC — a bad edit must not
 * leave a half-applied rename. Each case asserts the hard gate.
 */

describe("E2 hellgate — exact fails → fuzzy recovers (whitespace-only diff)", () => {
  test("whitespace-only difference recovers with NO strategy hint emitted", () => {
    // File has irregular internal/leading whitespace; needle is normalized.
    const src = "function f() {\n      return    a +  b\n}"
    const r = applyFuzzyEdit(src, "return a + b", "return a - b", false)
    expect(r.ok).toBe(true)
    expect(r.next).toBe("function f() {\nreturn a - b\n}")
    // Recovery path matched via a fuzzy strategy — exact would have failed.
    expect(r.message).toMatch(/whitespace-flexible|anchored-trim/)
    // A success carries no failure hint at all.
    expect(r.message).not.toMatch(/no confident match|ambiguous/)
  })
})

describe("E2 hellgate — exact fails + fuzzy fails ⇒ ok:false + structured hint", () => {
  test("no confident match anywhere ⇒ failure names the next action (read_then_patch)", () => {
    const r = applyFuzzyEdit("alpha\nbeta\ngamma", "completely unrelated needle", "x", false)
    expect(r.ok).toBe(false)
    expect(r.next).toBeUndefined()
    expect(r.message).toContain("no confident match")

    // The structured hint routing names the recovery action explicitly.
    const strategy = classifyMismatch("no confident match (exact, whitespace-flexible, ...)")
    expect(strategy).toBe("read_then_patch")
    const hint = formatStrategyHint(strategy)
    expect(hint).toMatch(/read/i)
    expect(hint).toContain("nextStrategy: read_then_patch")
  })
})

describe("E2 hellgate — ambiguous match (old_string appears 2+ times)", () => {
  test("ambiguous fuzzy span ⇒ REJECT (ok:false), never a silent wrong edit", () => {
    // Single-space needle; every file line uses double spaces ⇒ exact never
    // matches, whitespace-flex finds 3 candidate spans ⇒ ambiguous.
    const src = "x  =  1\n  x  =  1\n    x  =  1"
    const r = applyFuzzyEdit(src, "x = 1", "x = 2", false)
    expect(r.ok).toBe(false)
    expect(r.next).toBeUndefined() // the file is NOT mutated
    expect(r.message).toMatch(/ambiguous/)

    // Documented routing: an ambiguous failure ⇒ scripted_replace hint.
    expect(classifyMismatch({ kind: "ambiguous" })).toBe("scripted_replace")
    expect(formatStrategyHint("scripted_replace")).toContain("nextStrategy: scripted_replace")
  })
})

// ── V4A `*** Move to:` rename+edit must be ATOMIC ───────────────────────────
class MemFs implements FileSystemPort {
  private files = new Map<string, string>()
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

describe("E2 hellgate — V4A `*** Move to:` rename+edit atomicity", () => {
  test("an INVALID edit portion ⇒ the rename does NOT half-apply (source kept, dest absent)", async () => {
    const fs = new MemFs({ "src/app.py": "def greet():\n    print('Hi')\n" })
    // Move + an edit whose anchor does not exist in the source ⇒ the whole
    // patch must reject. If the rename leaked, src would be gone / main.py
    // would appear.
    const text = [
      "*** Begin Patch",
      "*** Update File: src/app.py",
      "*** Move to: src/main.py",
      "@@ def greet():",
      "-    print('THIS LINE DOES NOT EXIST')",
      "+    print('Hello, world!')",
      "*** End Patch",
    ].join("\n")
    await expect(applyPatch(parsePatch(text), fs)).rejects.toBeInstanceOf(Error)

    // ATOMICITY: nothing changed. Source intact, destination never created.
    const snap = fs.snapshot()
    expect(snap["src/app.py"]).toBe("def greet():\n    print('Hi')\n")
    expect(snap["src/main.py"]).toBeUndefined()
    expect(Object.keys(snap)).toEqual(["src/app.py"])
  })

  test("control: a VALID Move+edit applies atomically (rename + edit together)", async () => {
    const fs = new MemFs({ "src/app.py": "def greet():\n    print('Hi')\n" })
    const text = [
      "*** Begin Patch",
      "*** Update File: src/app.py",
      "*** Move to: src/main.py",
      "@@ def greet():",
      "-    print('Hi')",
      "+    print('Hello, world!')",
      "*** End Patch",
    ].join("\n")
    const r = await applyPatch(parsePatch(text), fs)
    expect(r.filesMoved).toEqual([["src/app.py", "src/main.py"]])
    expect(fs.snapshot()).toEqual({
      "src/main.py": "def greet():\n    print('Hello, world!')\n",
    })
  })

  test("Move to an OCCUPIED destination rejects and leaves the source untouched", async () => {
    const fs = new MemFs({ "src/app.py": "x\n", "src/main.py": "occupied\n" })
    const text = [
      "*** Begin Patch",
      "*** Update File: src/app.py",
      "*** Move to: src/main.py",
      "@@",
      "-x",
      "+X",
      "*** End Patch",
    ].join("\n")
    await expect(applyPatch(parsePatch(text), fs)).rejects.toBeInstanceOf(PatchApplyError)
    // Both files untouched — no half-apply.
    expect(fs.snapshot()).toEqual({ "src/app.py": "x\n", "src/main.py": "occupied\n" })
  })
})
