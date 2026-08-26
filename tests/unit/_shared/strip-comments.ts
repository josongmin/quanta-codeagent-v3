/**
 * Remove comments from TypeScript source WITHOUT eating string literals OR
 * REGEX LITERALS.
 *
 * Source-scanning guards need this, and the naive forms are wrong in a way that
 * DEFEATS the guard rather than annoying it. Two spellings do it:
 *
 *   const A = "/*"          // a string holding a comment opener
 *   <the violation>
 *   const B = "*​/"
 *
 *   const A = /[/*]/        // a REGEX CLASS holding one
 *   <the violation>
 *   const B = /[*​/]/
 *
 * Either way everything between the two lines is deleted before the scan and
 * the guard reports clean. MEASURED against 24 guards in this repo, including
 * two that fence security boundaries.
 *
 * And no attacker is needed for the first shape: 80 files under `src/` already
 * contain a `/*` inside ordinary prose — a permission rule that documents the
 * glob `/*`, a doc line naming `resources/*` — hiding 2,533 real code lines
 * from every naive-regex guard today.
 *
 * This implementation is LIFTED from `tests/unit/_arch/repo-path-anchor-
 * ratchet.test.ts`, which had it right before any of this: quoting-aware AND
 * regex-literal-aware, with `[...]`-class tracking and the classic
 * previous-token heuristic for telling a regex from a division. An earlier
 * version of this module was a fresh scanner that handled quotes only — the
 * weaker of the two implementations the repo already had, extracted without
 * noticing the better one existed, and still defeated by the second shape above.
 */
/** From the opening quote to its match, escapes carried through verbatim. */
const readStringLiteral = (src: string, open: number): string => {
  const quote = src[open] as string
  let out = quote
  let i = open + 1
  while (i < src.length) {
    const ch = src[i] as string
    if (ch === "\\") {
      out += ch + (src[i + 1] ?? "")
      i += 2
      continue
    }
    out += ch
    i++
    if (ch === quote) break
  }
  return out
}

/**
 * A `/` here opens a REGEX LITERAL rather than a division.
 *
 * Needed because a regex literal is allowed to contain quote characters, and
 * this repo has them: `tools/feature-catalog/test-audit.ts` holds
 * `/readFile(?:Sync)?\s*\(\s*["'`](?:\.\.\/)*src\//`. A scanner that took that
 * `"` for the start of a string desynced for the rest of the file and reported
 * the `readFileSync("src/...")` inside the JSDoc BELOW it as live code — a false
 * positive, in the one directory this campaign is not allowed to touch.
 *
 * The classic previous-token heuristic: after an operator, a punctuator or one of
 * the keywords, a `/` is a regex; after an identifier, a literal, `)` or `]` it is
 * division. Only the last 32 characters are inspected, so this stays O(1) per
 * slash.
 */
const REGEX_PRECEDERS = "(,=:[!&|?{};+-*%~^"
const REGEX_KEYWORDS =
  /\b(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/

const opensRegexLiteral = (emitted: string): boolean => {
  const tail = emitted.slice(-32).replace(/\s+$/, "")
  if (tail === "") return true
  return REGEX_PRECEDERS.includes(tail[tail.length - 1] as string) || REGEX_KEYWORDS.test(tail)
}

/**
 * From the opening `/` to its match, honouring `\` escapes and `[...]` classes.
 * A newline means it was not a regex after all, so only the `/` is consumed.
 */
const readRegexLiteral = (src: string, open: number): string => {
  let i = open + 1
  let inClass = false
  while (i < src.length) {
    const ch = src[i] as string
    if (ch === "\\") {
      i += 2
      continue
    }
    if (ch === "\n") return "/"
    if (ch === "[") inClass = true
    else if (ch === "]") inClass = false
    else if (ch === "/" && !inClass) return src.slice(open, i + 1)
    i++
  }
  return "/"
}

/** The index just past a comment opening at `i`, or -1 if none opens there. */
const skipComment = (src: string, i: number, atLineStart: boolean): number => {
  if (src[i] !== "/") return -1
  if (src[i + 1] === "*") {
    const end = src.indexOf("*/", i + 2)
    return end === -1 ? src.length : end + 2
  }
  // Only a LINE-LEADING `//`, matching the shared helper: a mid-line `//` inside
  // a URL or a regex literal must survive.
  if (src[i + 1] === "/" && atLineStart) {
    const end = src.indexOf("\n", i)
    return end === -1 ? src.length : end
  }
  return -1
}

export const stripComments = (src: string): string => {
  let out = ""
  let i = 0
  let atLineStart = true
  while (i < src.length) {
    const past = skipComment(src, i, atLineStart)
    if (past !== -1) {
      i = past
      continue
    }
    const c = src[i] as string
    const token =
      c === '"' || c === "'" || c === "`"
        ? readStringLiteral(src, i)
        : c === "/" && opensRegexLiteral(out)
          ? readRegexLiteral(src, i)
          : ""
    if (token !== "") {
      out += token
      i += token.length
      atLineStart = false
      continue
    }
    out += c
    atLineStart = c === "\n" || (atLineStart && (c === " " || c === "\t"))
    i++
  }
  return out
}
