/**
 * Decode the two list encodings used by SWE-bench datasets:
 * standard JSON arrays and SWE-bench Pro's Python-literal string arrays.
 *
 * This accepts only a list of quoted strings. It never evaluates expressions,
 * identifiers, calls, interpolation, or other Python syntax.
 */

interface ParsedString {
  readonly value: string
  readonly next: number
}

const hexEscape = (input: string, at: number, hexLength: number): ParsedString | undefined => {
  const digits = input.slice(at + 1, at + 1 + hexLength)
  if (digits.length !== hexLength || !/^[0-9a-f]+$/i.test(digits)) return undefined
  const codePoint = Number.parseInt(digits, 16)
  if (codePoint > 0x10ffff) return undefined
  return { value: String.fromCodePoint(codePoint), next: at + 1 + hexLength }
}

const octalEscape = (input: string, at: number): ParsedString | undefined => {
  const digits = input.slice(at).match(/^[0-7]{1,3}/)?.[0]
  if (digits === undefined) return undefined
  return {
    value: String.fromCodePoint(Number.parseInt(digits, 8)),
    next: at + digits.length,
  }
}

const pythonEscape = (input: string, at: number): ParsedString | undefined => {
  const escaped = input[at]
  if (escaped === undefined) return undefined
  const simple: Readonly<Record<string, string>> = {
    "\\": "\\",
    "'": "'",
    '"': '"',
    a: "\u0007",
    b: "\b",
    f: "\f",
    n: "\n",
    r: "\r",
    t: "\t",
    v: "\u000b",
  }
  const mapped = simple[escaped]
  if (mapped !== undefined) return { value: mapped, next: at + 1 }
  if (escaped === "\n") return { value: "", next: at + 1 }

  const hexLength = escaped === "x" ? 2 : escaped === "u" ? 4 : escaped === "U" ? 8 : 0
  if (hexLength > 0) return hexEscape(input, at, hexLength)
  if (/^[0-7]$/.test(escaped)) return octalEscape(input, at)

  // Python preserves unknown escapes. This matters for regex-like test ids.
  return { value: `\\${escaped}`, next: at + 1 }
}

const parseQuotedPythonString = (input: string, at: number): ParsedString | undefined => {
  const quote = input[at]
  if (quote !== "'" && quote !== '"') return undefined
  let value = ""
  let cursor = at + 1
  while (cursor < input.length) {
    const ch = input[cursor]
    if (ch === quote) return { value, next: cursor + 1 }
    if (ch === "\\") {
      const decoded = pythonEscape(input, cursor + 1)
      if (decoded === undefined) return undefined
      value += decoded.value
      cursor = decoded.next
      continue
    }
    if (ch === "\n" || ch === "\r") return undefined
    value += ch
    cursor += 1
  }
  return undefined
}

const skipWhitespace = (input: string, at: number): number => {
  let cursor = at
  while (/\s/.test(input[cursor] ?? "")) cursor += 1
  return cursor
}

type ListStep =
  | { readonly kind: "done"; readonly next: number }
  | { readonly kind: "continue"; readonly next: number }

const listStepAfterItem = (input: string, at: number): ListStep | undefined => {
  let cursor = skipWhitespace(input, at)
  if (input[cursor] === "]") {
    cursor = skipWhitespace(input, cursor + 1)
    return cursor === input.length ? { kind: "done", next: cursor } : undefined
  }
  if (input[cursor] !== ",") return undefined
  cursor = skipWhitespace(input, cursor + 1)
  if (input[cursor] === "]") {
    cursor = skipWhitespace(input, cursor + 1)
    return cursor === input.length ? { kind: "done", next: cursor } : undefined
  }
  return { kind: "continue", next: cursor }
}

const parsePythonStringList = (input: string): readonly string[] | undefined => {
  let cursor = skipWhitespace(input, 0)
  if (input[cursor] !== "[") return undefined
  cursor = skipWhitespace(input, cursor + 1)
  const values: string[] = []
  if (input[cursor] === "]") {
    cursor = skipWhitespace(input, cursor + 1)
    return cursor === input.length ? values : undefined
  }

  while (cursor < input.length) {
    const parsed = parseQuotedPythonString(input, cursor)
    if (parsed === undefined) return undefined
    values.push(parsed.value)
    const step = listStepAfterItem(input, parsed.next)
    if (step === undefined) return undefined
    if (step.kind === "done") return values
    cursor = step.next
  }
  return undefined
}

const nonEmptyStrings = (value: unknown): readonly string[] | undefined => {
  if (!Array.isArray(value)) return undefined
  const items = value.filter(
    (entry): entry is string => typeof entry === "string" && entry.trim() !== "",
  )
  return items.length > 0 ? items : undefined
}

export const parseSerializedStringList = (value: unknown): readonly string[] | undefined => {
  if (typeof value !== "string") return nonEmptyStrings(value)
  try {
    return nonEmptyStrings(JSON.parse(value))
  } catch {
    return nonEmptyStrings(parsePythonStringList(value))
  }
}
