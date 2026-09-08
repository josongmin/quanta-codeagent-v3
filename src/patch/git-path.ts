// Git unified-diff path decoding for the V4A converter.
// Quoted paths use git's C-escape (`"foo bar.py"`, octal bytes, `\"`).
// Unquote happens BEFORE a/ b/ prefix strip so `"a/old file.py"` becomes
// `old file.py` rather than a quoted token the strip never matches.

import { PatchConvertError } from "./types"

const OCTAL_DIGIT = /[0-7]/

const escapedByteOf = (esc: string): number => {
  switch (esc) {
    case "a":
      return 0x07
    case "b":
      return 0x08
    case "f":
      return 0x0c
    case "n":
      return 0x0a
    case "r":
      return 0x0d
    case "t":
      return 0x09
    case "v":
      return 0x0b
    default:
      return esc.charCodeAt(0)
  }
}

const readOctalEscape = (body: string, i: number): { byte: number; length: number } | null => {
  const a = body[i]
  if (a === undefined || !OCTAL_DIGIT.test(a)) return null
  const b = body[i + 1]
  const c = body[i + 2]
  const octal = `${a}${b !== undefined && OCTAL_DIGIT.test(b) ? b : ""}${c !== undefined && OCTAL_DIGIT.test(c) ? c : ""}`
  return { byte: Number.parseInt(octal, 8), length: octal.length }
}

/** Unquote a git C-escaped `"path"` token. Non-quoted input is returned as-is. */
export const decodeGitPath = (raw: string): string => {
  const trimmed = raw.trim()
  if (!trimmed.startsWith('"')) return trimmed
  if (!(trimmed.endsWith('"') && trimmed.length >= 2)) {
    throw new PatchConvertError(`malformed quoted path: ${raw}`)
  }
  const body = trimmed.slice(1, -1)
  const bytes: number[] = []
  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i]
    if (ch === undefined) break
    if (ch !== "\\") {
      bytes.push(...new TextEncoder().encode(ch))
      continue
    }
    const next = body[i + 1]
    if (next === undefined) {
      throw new PatchConvertError(`unterminated escape in quoted path: ${raw}`)
    }
    const octal = readOctalEscape(body, i + 1)
    if (octal !== null) {
      bytes.push(octal.byte)
      i += octal.length
      continue
    }
    bytes.push(escapedByteOf(next))
    i += 1
  }
  return new TextDecoder().decode(Uint8Array.from(bytes))
}

/** Strip a leading git `a/` or `b/` prefix. `/dev/null` is left intact. */
export const stripGitPrefix = (p: string): string =>
  p.startsWith("a/") || p.startsWith("b/") ? p.slice(2) : p

/** Decode a `--- `/`+++ ` payload (optional tab-timestamp) into a repo path. */
export const normalizeDiffPath = (raw: string): string => {
  const token = (raw.split("\t")[0] ?? "").trimEnd()
  return stripGitPrefix(decodeGitPath(token))
}

/** Path after a `rename from` / `rename to` header. Empty → convert error. */
export const pathAfterGitHeader = (line: string, prefix: string): string | null => {
  if (!line.startsWith(prefix)) return null
  const rest = line.slice(prefix.length).trim()
  if (rest.length === 0) {
    throw new PatchConvertError(`empty path after '${prefix}'`)
  }
  return stripGitPrefix(decodeGitPath(rest))
}
