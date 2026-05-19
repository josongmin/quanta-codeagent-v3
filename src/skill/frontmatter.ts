import type { ParsedFrontmatter } from "./types"

/**
 * Dependency-free, intentionally tiny YAML-ish frontmatter parser. We support
 * exactly the subset CC skill frontmatter uses (analysis §3.3):
 *
 *   ---
 *   name: my-skill
 *   description: short desc
 *   tools: ["Read", "Bash(git *)"]      # inline list
 *   paths:                               # block list
 *     - "src/**\/*.ts"
 *     - "**\/*.tf"
 *   model: inherit
 *   effort: high
 *   ---
 *   <markdown body>
 *
 * Anything fancier than `key: scalar` and simple string lists is out of scope
 * by design — do NOT pull in a yaml dependency. Unknown keys are kept as-is so
 * callers can decide what to do with them.
 */

const FENCE = "---"

/** Strip a single matching pair of wrapping quotes. */
const unquote = (s: string): string => {
  const t = s.trim()
  if (t.length >= 2) {
    const a = t[0]
    const b = t[t.length - 1]
    if ((a === '"' && b === '"') || (a === "'" && b === "'")) return t.slice(1, -1)
  }
  return t
}

/** Parse an inline flow list: `[a, "b c", 'd']` → ["a","b c","d"]. */
const parseInlineList = (raw: string): string[] => {
  const inner = raw.trim().slice(1, -1) // drop [ ]
  if (inner.trim() === "") return []
  const out: string[] = []
  let buf = ""
  let quote: '"' | "'" | null = null
  for (const ch of inner) {
    if (quote) {
      if (ch === quote) quote = null
      else buf += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === ",") {
      out.push(buf.trim())
      buf = ""
      continue
    }
    buf += ch
  }
  if (buf.trim() !== "") out.push(buf.trim())
  return out.map((s) => unquote(s)).filter((s) => s !== "")
}

/** Index of the closing fence among `lines` (search starts at 1), or -1. */
const findClosingFence = (lines: string[]): number => {
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FENCE) return i
  }
  return -1
}

type FrontmatterData = Record<string, string | string[]>

/**
 * Apply a single frontmatter line to `data`. Returns the list key that a
 * subsequent block-list `- item` should append to (or null), given the
 * `pendingListKey` carried from the previous line.
 */
const applyFrontmatterLine = (
  line: string,
  data: FrontmatterData,
  pendingListKey: string | null,
): string | null => {
  if (line.trim() === "" || line.trim().startsWith("#")) return pendingListKey

  // Block-list item: `  - value` belonging to the previous key.
  const itemMatch = line.match(/^\s*-\s+(.*)$/)
  if (itemMatch && pendingListKey) {
    const cur = data[pendingListKey]
    const val = unquote(itemMatch[1] ?? "")
    if (Array.isArray(cur)) cur.push(val)
    else data[pendingListKey] = [val]
    return pendingListKey
  }

  const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
  if (!kv) return pendingListKey
  const key = kv[1] ?? ""
  const rawValue = (kv[2] ?? "").trim()

  if (rawValue === "") {
    // Either an empty scalar or the header of a block list — assume list,
    // seed an empty array; it stays [] if no `-` items follow.
    data[key] = []
    return key
  }

  if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
    data[key] = parseInlineList(rawValue)
    return null
  }

  data[key] = unquote(rawValue)
  return null
}

/**
 * Split frontmatter (between leading `---` fences) from the markdown body.
 * If there is no leading fence, the whole input is treated as body.
 */
export const parseFrontmatter = (text: string): ParsedFrontmatter => {
  const normalized = text.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")

  if (lines[0]?.trim() !== FENCE) {
    return { data: {}, body: normalized.replace(/^\n+/, "") }
  }

  const end = findClosingFence(lines)
  if (end === -1) {
    // Unterminated frontmatter: treat everything after the first fence as body.
    return { data: {}, body: lines.slice(1).join("\n").replace(/^\n+/, "") }
  }

  const data: FrontmatterData = {}
  let pendingListKey: string | null = null
  for (let i = 1; i < end; i++) {
    pendingListKey = applyFrontmatterLine(lines[i] ?? "", data, pendingListKey)
  }

  const body = lines
    .slice(end + 1)
    .join("\n")
    .replace(/^\n+/, "")

  return { data, body }
}
