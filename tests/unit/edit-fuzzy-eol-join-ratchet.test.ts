/**
 * ★ PERMANENT GUARD — FUZZY-SPLICE BYTE-PRESERVATION RATCHET (D6, RFC jun-7
 * Phase-2-FINAL W2 / R-D6; HARDENED jun-25 for the MIXED-EOL fix).
 *
 * THE BUG CLASS THIS LOCKS DOWN:
 *   The fuzzy edit ladder (`src/tool/edit/fuzzy.ts`) compares lines EOL-agnostically
 *   (it splits on `/\r?\n/` and `.trim()`s, so a CRLF file's `"foo\r"` matches a
 *   needle `"foo"`). The ORIGINAL D6 fix re-assembled the WHOLE file with
 *   `next.join(detectEol(source))` after a matched splice. That worked for a
 *   UNIFORM file but SILENTLY CORRUPTED a MIXED-EOL file: every untouched line's
 *   terminator was coerced to the strict-majority EOL — hundreds of lines the
 *   model never touched, rewritten. The exact path (`exact.ts`) never had this
 *   bug: it splices byte-literally with `source.slice(...)`, preserving every
 *   byte outside the matched span.
 *
 * THE FIX THIS GUARD ENFORCES (byte-preserving splice):
 *   The fuzzy splice must map the matched LINE window to its CHARACTER span in
 *   the ORIGINAL `source` and splice there with `source.slice(...)` — exactly
 *   like the exact path. There must be NO whole-file re-assembly: a
 *   `.join(detectEol(...))` (or a bare `.join("\n")`) that rebuilds the entire
 *   line array is the regression and is a RED TEST here. The ONLY remaining
 *   `.join` is for the REPLACEMENT region's internal newlines, joined with the
 *   WINDOW's local terminator (`windowEol(...)`), never the whole file.
 *
 * WHY A SOURCE RATCHET (not just the behavioral edit-eol.test.ts):
 *   A future refactor that "simplifies" the byte-splice back to a whole-file
 *   `next.join(...)` re-opens the mixed-EOL corruption, and depending on the
 *   fixtures might slip past a green behavioral suite. This guard makes the
 *   regression STRUCTURAL.
 *
 * RED-ON-INJECTION PROOF (below): a synthetic body that whole-file-rejoins with
 * `.join(detectEol(source))` OR `.join("\n")` is FLAGGED by the predicates; the
 * real byte-splice form is clean. Then GREEN on the current source.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join as pathJoin } from "node:path"

const FUZZY_SRC = pathJoin(import.meta.dir, "..", "..", "src", "tool", "edit", "fuzzy.ts")

/**
 * Pure predicate: return every WHOLE-FILE-REASSEMBLY `.join(...)` snippet — the
 * forms that re-open the D6 / mixed-EOL corruption by coercing untouched lines'
 * terminators. Two violation shapes:
 *   - a bare lone-LF reassembly: `.join("\n")` / `.join('\n')`
 *   - a native-EOL whole-file reassembly: `.join(detectEol(...))`
 * Both rebuild the ENTIRE file from a split array (the old buggy mechanism).
 * The byte-splice fix uses `source.slice(...)` and joins ONLY the replacement
 * region with the window-local EOL (`windowEol(...)`), which is NOT flagged.
 */
export const wholeFileReassemblyJoins = (text: string): string[] => {
  const hits: string[] = []
  const bareLf = /\.join\(\s*(["'])\\n\1\s*\)/g
  for (const m of text.matchAll(bareLf)) hits.push(m[0])
  const detectEolJoin = /\.join\(\s*detectEol\(/g
  for (const m of text.matchAll(detectEolJoin)) hits.push(m[0])
  return hits
}

/**
 * Pure predicate: does `text` perform the byte-preserving splice against the
 * ORIGINAL source? The exact path's signature splice is `source.slice(0, ...) +
 * ... + source.slice(...)`. We assert the fuzzy source contains a
 * `source.slice(0,` AND a `source.slice(` tail — proof the untouched prefix and
 * suffix are copied VERBATIM rather than re-joined.
 */
export const usesByteSplice = (text: string): boolean =>
  /source\.slice\(\s*0\s*,/.test(text) && /source\.slice\(\s*charEnd/.test(text)

describe("R-D6 — fuzzy-splice byte-preservation ratchet (mixed-EOL fix)", () => {
  const src = readFileSync(FUZZY_SRC, "utf8")

  test("fuzzy.ts contains NO whole-file reassembly join (would re-open D6 / mixed-EOL)", () => {
    expect(wholeFileReassemblyJoins(src)).toEqual([])
  })

  test("fuzzy.ts splices byte-literally into the ORIGINAL source (like the exact path)", () => {
    expect(usesByteSplice(src)).toBe(true)
  })

  test("the ONLY `.join(...)` left joins the replacement region (not the whole file)", () => {
    // Every `.join(` in the source must be the replacement-region join keyed on
    // the window-local EOL, never a whole-file `detectEol`/`"\n"` reassembly.
    const joins = [...src.matchAll(/\.join\([^)]*\)/g)].map((m) => m[0])
    expect(joins.length).toBeGreaterThan(0)
    for (const j of joins) {
      expect(j).not.toContain("detectEol")
      expect(j).not.toMatch(/\.join\(\s*["']\\n["']\s*\)/)
    }
  })

  // -- RED-ON-INJECTION ----------------------------------------------------
  test('RED: a synthetic body whole-file-rejoining with `.join("\\n")` is FLAGGED', () => {
    const injected = `return [...before, ...repl, ...after].join("\\n")`
    expect(wholeFileReassemblyJoins(injected).length).toBeGreaterThan(0)
  })

  test("RED: a whole-file `.join(detectEol(source))` reassembly is FLAGGED", () => {
    expect(wholeFileReassemblyJoins("next: next.join(detectEol(source)),").length).toBeGreaterThan(0)
  })

  test("GREEN: the replacement-region `splitLines(repl).join(eol)` form is NOT flagged", () => {
    expect(wholeFileReassemblyJoins("const replText = splitLines(repl).join(eol) + lastEol")).toEqual(
      [],
    )
  })

  test("RED: removing the byte-splice (no `source.slice`) is detected by usesByteSplice", () => {
    expect(usesByteSplice("const next = lines.join(detectEol(source))")).toBe(false)
  })
})
