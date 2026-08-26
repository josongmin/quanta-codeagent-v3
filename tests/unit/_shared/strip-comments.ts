/**
 * Remove comments from TypeScript source WITHOUT eating string literals.
 *
 * Source-scanning guards need this, and the obvious form — two regexes over the
 * raw text — is wrong in a way that DEFEATS the guard rather than annoying it.
 * A file holding a comment-opener and a comment-closer as ordinary string
 * literals loses everything between them, so a suppression written on the line
 * in the middle disappears from the scan and the guard reports clean. MEASURED
 * against the port-contract guard: two string literals bought an unchecked
 * `as any` inside the port directory.
 *
 * It lives here because it was COPIED. A copied scanner is a scanner fixed in
 * one place: the leak guard got the quoting-aware version and the port-contract
 * guard kept the regex, which is how that evasion survived the very commit that
 * claimed to have closed it.
 */

/** How far a quoted run starting at `start` extends, past backslash escapes. */
const endOfQuote = (src: string, start: number): number => {
  const quote = src[start]
  let i = start + 1
  while (i < src.length) {
    if (src[i] === "\\") {
      i += 2
      continue
    }
    if (src[i] === quote) return i + 1
    i += 1
  }
  return i
}

/** How far a comment starting at `i` extends. `-1` when `i` starts no comment. */
const endOfComment = (src: string, i: number): number => {
  if (src[i] !== "/") return -1
  if (src[i + 1] === "/") {
    const nl = src.indexOf("\n", i)
    return nl === -1 ? src.length : nl
  }
  if (src[i + 1] === "*") {
    const close = src.indexOf("*/", i + 2)
    return close === -1 ? src.length : close + 2
  }
  return -1
}

export const stripComments = (src: string): string => {
  let out = ""
  let i = 0
  while (i < src.length) {
    const c = src[i] as string
    if (c === '"' || c === "'" || c === "`") {
      const end = endOfQuote(src, i)
      out += src.slice(i, end)
      i = end
      continue
    }
    const commentEnd = endOfComment(src, i)
    if (commentEnd !== -1) {
      i = commentEnd
      continue
    }
    out += c
    i += 1
  }
  return out
}
