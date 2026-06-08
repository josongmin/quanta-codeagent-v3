import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ToolContext, ToolResult } from "@/tool"
import { applyPatchTool } from "@/tool/apply-patch"

// ===========================================================================
// HELLGATE E2E — GAP A scored-candidate decisive-best tie-break, END-TO-END
// through the REAL `applyPatchTool.execute` (NOT the internal locate function)
// against a REAL temp-dir filesystem.
//
//  - A patch whose hunk context is trimmed-ambiguous (2 windows) but
//    verbatim-decisive for ONE ⇒ applyPatchTool yields ok:true and the edit
//    lands at the DECISIVE window; the OTHER (lower-score) window is untouched.
//  - A TIE patch ⇒ applyPatchTool throws PatchApplyError (ambiguous, fail-
//    closed) and the file is left byte-UNTOUCHED — no misapply ever happens.
//
// Reverting the scored-tier code in src/patch/applier.ts turns the decisive
// case RED (back to an ambiguous throw). The MISAPPLY guard (wrong window never
// edited) holds in both branches.
// ===========================================================================

const root = mkdtempSync(join(tmpdir(), "applier-scored-e2e-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const ctx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
})

/** Drive the real tool generator to completion; return the terminal result. */
const run = async (patch: string, cwd: string): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of applyPatchTool.execute({ patch } as never, ctx(cwd))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result yielded")
  return result
}

describe("[hellgate] apply_patch scored-tier decisive-best — end-to-end", () => {
  test("DECISIVE patch ⇒ ok:true; lands at the verbatim-best window; other window untouched", async () => {
    const dir = mkdtempSync(join(root, "decisive-"))
    // Two trimmed-equal windows for oldBlock ["foo","bar","baz"]:
    //   @0: ["  foo","bar","baz"]   verbatim score 2 (lines 1,2 exact)
    //   @5: ["  foo","  bar","  baz"] verbatim score 0 (all indented)
    // EXACT tier finds neither (line 0 indented in both) ⇒ falls to the TRIMMED
    // tier → 2 hits → was an ambiguous throw; the scored tie-break recovers @0.
    const original =
      ["  foo", "bar", "baz", "MID-1", "MID-2", "  foo", "  bar", "  baz"].join("\n") + "\n"
    const file = join(dir, "code.txt")
    writeFileSync(file, original)

    const patch = [
      "*** Begin Patch",
      "*** Update File: code.txt",
      "@@",
      " foo",
      " bar",
      "-baz",
      "+BAZ",
      "*** End Patch",
    ].join("\n")

    const r = await run(patch, dir)
    expect(r.ok).toBe(true)
    expect(r.output).toContain("updated: code.txt")

    const out = readFileSync(file, "utf8")
    // The edit landed at the decisive window @0 (its context rewritten verbatim
    // from the patch + baz→BAZ). The SECOND window (indices 5..7) is UNTOUCHED.
    expect(out).toBe(
      ["foo", "bar", "BAZ", "MID-1", "MID-2", "  foo", "  bar", "  baz"].join("\n") + "\n",
    )
    // MISAPPLY guard: the wrong (lower-score) window kept its exact original bytes.
    expect(out.split("\n").slice(5, 8)).toEqual(["  foo", "  bar", "  baz"])
  })

  test("TIE patch ⇒ throws ambiguous (fail-closed); file byte-UNTOUCHED, NO misapply", async () => {
    const dir = mkdtempSync(join(root, "tie-"))
    // Two trimmed-equal windows that BOTH score 2 verbatim (line 0 indented in
    // both; lines 1,2 exact in both) ⇒ no strict winner ⇒ stay ambiguous.
    const original =
      ["  foo", "bar", "baz", "MID-1", "MID-2", "  foo", "bar", "baz"].join("\n") + "\n"
    const file = join(dir, "code.txt")
    writeFileSync(file, original)

    const patch = [
      "*** Begin Patch",
      "*** Update File: code.txt",
      "@@",
      " foo",
      " bar",
      "-baz",
      "+BAZ",
      "*** End Patch",
    ].join("\n")

    // The tool generator THROWS the typed ambiguous PatchApplyError (no fallback
    // wired ⇒ the typed error surfaces straight out of execute, never ok:false).
    await expect(run(patch, dir)).rejects.toThrow(/[Aa]mbiguous/)

    // Fail-closed: the whole patch is all-or-nothing → the file is byte-identical
    // to the original. NEITHER window was edited (no misapply).
    expect(readFileSync(file, "utf8")).toBe(original)
  })

  test("EXACT-tier path is unaffected — a unique exact match still lands without the scored tier", async () => {
    const dir = mkdtempSync(join(root, "exact-"))
    // One verbatim-exact window + an indented decoy. The exact tier wins outright.
    const original =
      ["foo", "bar", "baz", "MID", "  foo", "  bar", "  baz"].join("\n") + "\n"
    const file = join(dir, "code.txt")
    writeFileSync(file, original)

    const patch = [
      "*** Begin Patch",
      "*** Update File: code.txt",
      "@@",
      " foo",
      " bar",
      "-baz",
      "+BAZ",
      "*** End Patch",
    ].join("\n")

    const r = await run(patch, dir)
    expect(r.ok).toBe(true)
    expect(readFileSync(file, "utf8")).toBe(
      ["foo", "bar", "BAZ", "MID", "  foo", "  bar", "  baz"].join("\n") + "\n",
    )
  })
})
