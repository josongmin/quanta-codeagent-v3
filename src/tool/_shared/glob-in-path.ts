/**
 * jun-6 exfil-rail (b) — glob-in-write guard (pure leaf).
 *
 * WHAT: a pure, total predicate that detects an UNAMBIGUOUS glob/wildcard
 *       metacharacter in a path that the `write`/`edit` tools accept as a
 *       SINGLE concrete target filename. A glob in a write target is either a
 *       mistake or a fan-out exfil attempt (e.g. a recursive-star path under a
 *       secrets directory), so the tool rejects it with the verbatim cc-cli
 *       message rather than creating /
 *       overwriting one oddly-named literal file.
 * RFC: docs/plans/jun-6-exfil-egress-rails.md §4.2
 * SLICES IMPORTED: none (pure, no I/O, no state).
 * NO-THROW: total over any string input.
 *
 * FALSE-POSITIVE POSTURE (load-bearing — §7).
 * The detector is DELIBERATELY CONSERVATIVE: it fires ONLY on the metacharacters
 * that NEVER appear in a legitimate single-file write target:
 *   - `*`  — the wildcard / `**` recursive star.
 *   - `?`  — the single-char wildcard.
 *   - `{…,…}` — brace EXPANSION (a `{` whose matching `}` encloses at least one
 *     comma — i.e. `{a,b}`). A lone `{` or a brace group WITHOUT a comma is NOT
 *     an expansion and is left as a literal (some real paths embed `{}`).
 *
 * It does NOT fire on a bracket pair `[…]`. A bracket character class IS a glob
 * token, but `file[1].txt` / `arr[0].json` are common, legitimate literal
 * filenames; treating every `[…]` as a glob is a false-positive generator with
 * no security upside (a `[…]` class can only ever match a SINGLE char, so it can
 * never be a directory fan-out the way `*` / `**` / `{a,b}` can). The documented
 * decision (RFC §6 (b) test) is therefore: a literal-bracket filename is ALLOWED.
 */

/** Scan `{` … `}` brace pairs and report whether ANY pair encloses a comma
 *  (brace EXPANSION). A lone unmatched `{`, or a `{}`/`{x}` without a comma, is
 *  NOT an expansion. Linear, depth-tracked so a nested `{a,{b}}` still counts.
 */
const hasBraceExpansion = (path: string): boolean => {
  // Stack of "saw a comma at-or-below this open brace" flags, one per open `{`.
  const sawComma: boolean[] = []
  for (let i = 0; i < path.length; i++) {
    const ch = path[i]
    if (ch === "{") {
      sawComma.push(false)
    } else if (ch === ",") {
      if (sawComma.length > 0) sawComma[sawComma.length - 1] = true
    } else if (ch === "}") {
      const flag = sawComma.pop()
      // A closed brace pair that saw a comma between `{` and `}` is an expansion.
      if (flag === true) return true
    }
  }
  return false
}

/**
 * True IFF `path` contains an UNAMBIGUOUS glob metacharacter that makes it a
 * pattern rather than a single literal write target (`*`, `?`, or a `{a,b}`
 * brace EXPANSION). Conservative by design — see the module doc for the
 * false-positive posture (bracket classes are intentionally allowed). Pure,
 * total, NO-THROW.
 */
export const pathLooksLikeGlob = (path: string): boolean => {
  if (path.includes("*") || path.includes("?")) return true
  // Only pay the brace scan when a `{` is even present (cheap fast path).
  if (path.includes("{") && hasBraceExpansion(path)) return true
  return false
}

/** The verbatim cc-cli user-facing message surfaced when a write/edit target is
 *  a glob pattern. Kept as a single SSOT constant so write + edit emit BYTE-
 *  IDENTICAL text. */
export const GLOB_IN_WRITE_MESSAGE =
  "Glob patterns are not allowed in write operations. Please specify an exact file path."

/** The stable typed `rejected` reason tag for a glob-in-write-path denial. */
export const GLOB_IN_WRITE_REASON = "glob_in_write_path"
