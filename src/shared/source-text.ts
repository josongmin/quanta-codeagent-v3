/** Quote-, template-, and regex-literal-aware TypeScript comment remover. */
export interface StripCommentsOptions {
  readonly preservePositions?: boolean
}

const REGEX_PRECEDERS = "(,=:[!&|?{};+-*%~^>"
const REGEX_KEYWORDS =
  /\b(?:return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else|yield|await)$/

const opensRegexLiteral = (emitted: string): boolean => {
  const tail = emitted.slice(-32).replace(/\s+$/, "")
  if (tail === "") return true
  return REGEX_PRECEDERS.includes(tail[tail.length - 1] as string) || REGEX_KEYWORDS.test(tail)
}

const readPlainString = (src: string, open: number): string => {
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
    i += 1
    if (ch === quote) break
  }
  return out
}

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
    i += 1
  }
  return "/"
}

const readSubstitution = (src: string, open: number): string => {
  let out = "${"
  let i = open + 2
  let depth = 1
  while (i < src.length && depth > 0) {
    const ch = src[i] as string
    if (ch === '"' || ch === "'" || ch === "`") {
      const nested = readStringLiteral(src, i)
      out += nested
      i += nested.length
      continue
    }
    if (ch === "/" && opensRegexLiteral(out)) {
      const regex = readRegexLiteral(src, i)
      out += regex
      i += regex.length
      continue
    }
    if (ch === "{") depth += 1
    else if (ch === "}") depth -= 1
    out += ch
    i += 1
  }
  return out
}

const readTemplate = (src: string, open: number): string => {
  let out = "`"
  let i = open + 1
  while (i < src.length) {
    const ch = src[i] as string
    if (ch === "\\") {
      out += ch + (src[i + 1] ?? "")
      i += 2
      continue
    }
    if (ch === "$" && src[i + 1] === "{") {
      const substitution = readSubstitution(src, i)
      out += substitution
      i += substitution.length
      continue
    }
    out += ch
    i += 1
    if (ch === "`") break
  }
  return out
}

const readStringLiteral = (src: string, open: number): string =>
  src[open] === "`" ? readTemplate(src, open) : readPlainString(src, open)

const skipComment = (src: string, index: number): number => {
  if (src[index] !== "/") return -1
  if (src[index + 1] === "*") {
    const end = src.indexOf("*/", index + 2)
    return end === -1 ? src.length : end + 2
  }
  if (src[index + 1] === "/") {
    const end = src.indexOf("\n", index)
    return end === -1 ? src.length : end
  }
  return -1
}

const readLiteral = (src: string, index: number, emitted: string): string => {
  const ch = src[index] as string
  if (ch === '"' || ch === "'" || ch === "`") return readStringLiteral(src, index)
  if (ch === "/" && opensRegexLiteral(emitted)) return readRegexLiteral(src, index)
  return ""
}

const blank = (text: string): string => text.replace(/[^\n]/g, " ")

export const stripComments = (src: string, options: StripCommentsOptions = {}): string => {
  const preservePositions = options.preservePositions !== false
  let out = ""
  let i = 0
  while (i < src.length) {
    const past = skipComment(src, i)
    if (past !== -1) {
      out += preservePositions ? blank(src.slice(i, past)) : ""
      i = past
      continue
    }
    const literal = readLiteral(src, i, out)
    if (literal !== "") {
      out += literal
      i += literal.length
      continue
    }
    out += src[i] as string
    i += 1
  }
  return out
}
