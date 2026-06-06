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
 * Carried parse state between lines. `pendingKey` is the most-recent key whose
 * value was empty (`key:`) — a subsequent `- item` line appends to it as a
 * block list, OR (ADR-0457) a subsequent INDENTED `child: scalar` line is
 * captured as a nested-map entry under the dotted key `parent.child`.
 */
interface LineState {
  /** Last empty-value key (block-list head or nested-map parent), or null. */
  pendingKey: string | null
}

/**
 * ADR-0457 — nested one-level mapping capture for codex's `metadata:` block:
 *
 *   metadata:
 *     short-description: "..."
 *
 * Stored as a flat dotted key `metadata.short-description` so the existing
 * `Record<string, string | string[]>` data shape is unchanged. Only fires for
 * an INDENTED `key: scalar` line directly under an empty-value parent that has
 * NOT yet received a `- ` block-list item (the seed is still the empty `[]`).
 * Returns true when it consumed the line. Quietly does nothing on deeper / list
 * shapes (those are out of this tiny parser's scope by design).
 */
const tryNestedMapEntry = (
  line: string,
  data: FrontmatterData,
  pendingKey: string | null,
): boolean => {
  if (pendingKey === null) return false
  // Parent must still be the empty-array seed (no `- ` items appended).
  const seed = data[pendingKey]
  if (!Array.isArray(seed) || seed.length > 0) return false
  // Indented `child: scalar` (NOT a `- ` list item — that path is handled first).
  // Key regex requires a LEADING LETTER to match the strict schema's key shape
  // (skill-frontmatter.ts) — keeps lenient discovery + strict validation from
  // diverging on odd keys like `-foo:` (lenient must not accept what strict rejects).
  const child = line.match(/^\s+([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.+)$/)
  if (!child) return false
  const childKey = child[1] ?? ""
  const childVal = (child[2] ?? "").trim()
  if (childVal === "") return false
  data[`${pendingKey}.${childKey}`] = unquote(childVal)
  return true
}

/**
 * Apply a single frontmatter line to `data`. Returns the updated {@link
 * LineState} carried to the next line.
 */
const applyFrontmatterLine = (line: string, data: FrontmatterData, state: LineState): LineState => {
  if (line.trim() === "" || line.trim().startsWith("#")) return state

  // Block-list item: `  - value` belonging to the previous key.
  const itemMatch = line.match(/^\s*-\s+(.*)$/)
  if (itemMatch && state.pendingKey) {
    const cur = data[state.pendingKey]
    const val = unquote(itemMatch[1] ?? "")
    if (Array.isArray(cur)) cur.push(val)
    else data[state.pendingKey] = [val]
    return state
  }

  // ADR-0457: indented `child: scalar` under an empty-value parent ⇒ nested map.
  if (tryNestedMapEntry(line, data, state.pendingKey)) return state

  // Leading-letter key shape, aligned with the strict schema (see child regex
  // above) so lenient discovery never accepts a key strict validation rejects.
  const kv = line.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
  if (!kv) return state
  const key = kv[1] ?? ""
  const rawValue = (kv[2] ?? "").trim()

  if (rawValue === "") {
    // Either an empty scalar or the header of a block list / nested map —
    // assume list, seed an empty array; it stays [] if nothing follows.
    data[key] = []
    return { pendingKey: key }
  }

  if (rawValue.startsWith("[") && rawValue.endsWith("]")) {
    data[key] = parseInlineList(rawValue)
    return { pendingKey: null }
  }

  data[key] = unquote(rawValue)
  return { pendingKey: null }
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
  let state: LineState = { pendingKey: null }
  for (let i = 1; i < end; i++) {
    state = applyFrontmatterLine(lines[i] ?? "", data, state)
  }

  const body = lines
    .slice(end + 1)
    .join("\n")
    .replace(/^\n+/, "")

  return { data, body }
}

export { SkillCategorySchema, SkillStabilitySchema } from "./skill-frontmatter"
