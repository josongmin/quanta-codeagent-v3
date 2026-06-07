/**
 * ★ PERMANENT GUARD — FUZZY-SPLICE EOL-JOIN RATCHET (D6, RFC jun-7 Phase-2-FINAL
 * W2 / R-D6).
 *
 * THE BUG CLASS THIS LOCKS DOWN:
 *   The fuzzy edit ladder (`src/tool/edit/fuzzy.ts`) compares lines EOL-agnostically
 *   (it splits on `/\r?\n/` and `.trim()`s, so a CRLF file's `"foo\r"` matches a
 *   needle `"foo"`). When a matched window is spliced back in, the result MUST be
 *   reassembled with the file's NATIVE terminator — `next.join(detectEol(source))`.
 *   The naive `\n`-only reassembly (`next.join("\n")`) silently rewrites a CRLF
 *   file's edited region (and unchanged neighbours, since the whole array is
 *   re-joined) to lone-LF = MIXED-EOL CORRUPTION. That is exactly the D6 bug.
 *
 * WHY A SOURCE RATCHET (not just the behavioral edit-eol.test.ts):
 *   The behavioral tests prove TODAY's joins are EOL-correct, but a future refactor
 *   that "simplifies" a rejoin back to `.join("\n")` would re-open the corruption,
 *   and depending on the fixtures might slip past a green behavioral suite. This
 *   guard makes the regression STRUCTURAL: every line-REASSEMBLY join in
 *   `fuzzy.ts` must route through `detectEol(...)`, and a bare `.join("\n")` /
 *   `.join('\n')` reassembly is a RED TEST.
 *
 * PRECISION (no false-positives on unrelated `\n` joins): the predicate scans
 * ONLY `.join(...)` calls (the line-reassembly primitive used to rebuild the
 * spliced source). Message rendering in this file uses template strings, not
 * `.join`, so it is never in scope. A `.join(...)` whose argument is `detectEol(...)`
 * is the CORRECT pattern (clean); a `.join("\n")` / `.join('\n')` is the
 * VIOLATION. `splitLines`/`spliceLines` rebuild via the spread operator (no
 * `.join`), so they are correctly out of scope too.
 *
 * RED-ON-INJECTION PROOF (below): a synthetic `spliceLines`-style body that
 * rejoins with `.join("\n")` is shown to be FLAGGED by the same predicate; the
 * real `join(detectEol(source))` form is clean. Then GREEN on the current source.
 */

import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join as pathJoin } from "node:path"

const FUZZY_SRC = pathJoin(import.meta.dir, "..", "..", "src", "tool", "edit", "fuzzy.ts")

/**
 * Pure predicate: return the line-REASSEMBLY `.join(...)` snippets in `text`
 * whose argument is a BARE `"\n"` / `'\n'` string literal (the VIOLATIONS). A
 * `.join(detectEol(...))` (the correct native-EOL rejoin) is NOT a violation.
 *
 * We match `.join(` followed (ignoring inner whitespace) by a single- or
 * double-quoted `\n` literal up to the closing `)`. This deliberately does NOT
 * flag `.join(detectEol(source))` (the argument is a call, not a string literal)
 * nor `.join(" ")`-style unrelated joins (only the lone-`\n` reassembly re-opens
 * the D6 corruption).
 */
export const bareLfReassemblyJoins = (text: string): string[] => {
  const hits: string[] = []
  // `.join(` then optional whitespace, then a quote, then exactly a `\n` escape,
  // then the same quote, then optional whitespace, then `)`.
  const re = /\.join\(\s*(["'])\\n\1\s*\)/g
  for (const m of text.matchAll(re)) hits.push(m[0])
  return hits
}

/**
 * Pure predicate: return every line-reassembly `.join(...)` snippet in `text`
 * (any argument). Used to assert that ALL of them route through `detectEol(` —
 * the positive side of the ratchet (a future join with some OTHER non-`detectEol`
 * argument that still corrupts EOL would be caught here even if it isn't the
 * exact `"\n"` literal form).
 */
export const allJoinCalls = (text: string): string[] => {
  const hits: string[] = []
  const re = /\.join\([^)]*\)?/g
  for (const m of text.matchAll(re)) hits.push(m[0])
  return hits
}

describe("R-D6 — fuzzy-splice EOL-join ratchet", () => {
  const src = readFileSync(FUZZY_SRC, "utf8")

  test('fuzzy.ts contains NO bare `.join("\\n")` reassembly (would re-open D6)', () => {
    expect(bareLfReassemblyJoins(src)).toEqual([])
  })

  test("EVERY `.join(...)` reassembly in fuzzy.ts routes through `detectEol(`", () => {
    const joins = allJoinCalls(src)
    // There IS at least one rejoin (the splice path must reassemble lines); if a
    // refactor removed them entirely this would also flag, prompting a re-audit.
    expect(joins.length).toBeGreaterThan(0)
    for (const j of joins) {
      expect(j).toContain("join(detectEol(")
    }
  })

  test("the source actually uses `join(detectEol(` (the correct pattern is present)", () => {
    expect(src).toContain("join(detectEol(")
  })

  // -- RED-ON-INJECTION ----------------------------------------------------
  test('RED: a synthetic spliceLines body rejoining with `.join("\\n")` is FLAGGED', () => {
    const injected = `
      const spliceLines = (lines, span, repl) => {
        const before = lines.slice(0, span.start)
        const after = lines.slice(span.end)
        return [...before, ...repl, ...after].join("\\n")
      }
    `
    expect(bareLfReassemblyJoins(injected).length).toBeGreaterThan(0)
  })

  test("RED: a single-quoted `.join('\\n')` reassembly is also FLAGGED", () => {
    expect(bareLfReassemblyJoins("next.join('\\n')").length).toBeGreaterThan(0)
  })

  test("GREEN: the correct `next.join(detectEol(source))` form is NOT flagged", () => {
    expect(bareLfReassemblyJoins("next: next.join(detectEol(source)),")).toEqual([])
  })

  test('NOT a false-positive: an unrelated message `.join(", ")` is NOT flagged as a bare-LF violation', () => {
    // Only the lone-`\n` reassembly re-opens the D6 corruption; a comma-join (or
    // any other separator) used for message rendering is out of scope.
    expect(bareLfReassemblyJoins('parts.join(", ")')).toEqual([])
  })
})
