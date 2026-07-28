/**
 * OPC-07 — shared pure text/collection utilities for the LLM evidence packet
 * modules. No domain types; purely string/array helpers so every packet concern
 * can dedupe/bound text identically. Internal to the packet split — not part of
 * the public barrel surface.
 */

export const uniqueLines = (values: readonly string[]): string[] => {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of values) {
    const value = raw.trim()
    if (value === "" || seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

export const uniqueObjects = <T>(values: readonly T[]): T[] => {
  const seen = new Set<string>()
  const out: T[] = []
  for (const v of values) {
    const key = JSON.stringify(v)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(v)
  }
  return out
}

export const firstNonEmptyLine = (text: string): string | undefined =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0)

export const boundHead = (text: string, max = 220): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1))}…`

export const boundTail = (text: string, max = 220): string =>
  text.length <= max ? text : `…${text.slice(-Math.max(0, max - 1))}`

export const fmtList = (values: readonly string[], empty = "<none>"): string =>
  values.length === 0 ? empty : values.join(", ")

export const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * Heuristic-free binary/non-source probe: a NUL byte never appears in legitimate
 * UTF-8 source text, so its presence means the "source" is not inspectable as
 * Python. (We deliberately do NOT guess by extension or content patterns — only
 * the unambiguous NUL signal, which has zero false positives in real source.)
 */
const NUL_CHAR = String.fromCharCode(0)
export const looksNonSource = (source: string): boolean => source.includes(NUL_CHAR)
