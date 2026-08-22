// Minimal YAML parser for GitHub Actions workflows we author.
//
// The repo has no `yaml` package and we're explicitly avoiding adding one for a
// single concern. We only emit a tightly-constrained subset of YAML in
// .github/workflows/agent-*.yml: mappings (2-space indent), strings (bare /
// single- / double-quoted), lists (`- item` or `[a, b]`), `|` block scalars,
// and `#` line comments. This parser handles exactly that subset. If a future
// workflow uses anchors/aliases or other features, the tests will fail loudly.

export type YamlValue = string | number | boolean | null | YamlValue[] | { [k: string]: YamlValue }
export type YamlMap = { [k: string]: YamlValue }

interface Line {
  indent: number
  text: string
  raw: string
}

const KEY_VALUE = /^([A-Za-z0-9_.-]+):\s*(.*)$/

const tokenize = (src: string): Line[] => {
  const out: Line[] = []
  for (const raw of src.split(/\r?\n/)) {
    const stripped = raw.replace(/^\s*#.*$/, "")
    if (stripped.trim() === "") continue
    const match = stripped.match(/^( *)(.*)$/)
    if (!match) continue
    const indent = match[1]?.length ?? 0
    const text = (match[2] ?? "").replace(/\s+#.*$/, "").trimEnd()
    if (text === "") continue
    out.push({ indent, text, raw })
  }
  return out
}

const parseScalar = (s: string): YamlValue => {
  const t = s.trim()
  if (t === "" || t === "~" || t === "null") return null
  if (t === "true") return true
  if (t === "false") return false
  if (/^-?\d+$/.test(t)) return Number(t)
  if (/^-?\d+\.\d+$/.test(t)) return Number(t)
  if (t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1)
  if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1)
  if (t.startsWith("[") && t.endsWith("]")) {
    const inner = t.slice(1, -1).trim()
    if (inner === "") return []
    return inner.split(",").map((p) => parseScalar(p.trim()))
  }
  return t
}

const readBlockScalar = (
  lines: Line[],
  start: number,
  parentIndent: number,
): { value: string; next: number } => {
  const buf: string[] = []
  let i = start
  while (i < lines.length) {
    const ln = lines[i]
    if (!ln) break
    if (ln.indent <= parentIndent) break
    buf.push(ln.raw.slice(parentIndent + 2))
    i += 1
  }
  return { value: buf.join("\n"), next: i }
}

// Assign one `key: rest` mapping entry. Returns the next line index.
const assignMappingEntry = (
  lines: Line[],
  i: number,
  indent: number,
  obj: YamlMap,
  key: string,
  rest: string,
): number => {
  if (rest === "") {
    const r = parseBlock(lines, i + 1, indent)
    obj[key] = r.value
    return r.next
  }
  if (rest === "|" || rest === ">") {
    const r = readBlockScalar(lines, i + 1, indent)
    obj[key] = r.value
    return r.next
  }
  obj[key] = parseScalar(rest)
  return i + 1
}

// Parse a list item that is itself a `key: value` inline-map (with possibly
// more sibling keys at innerIndent). Returns the new line index.
const parseListItemMap = (
  lines: Line[],
  start: number,
  outerIndent: number,
  firstKey: string,
  firstVal: string,
  out: YamlValue[],
): number => {
  const obj: YamlMap = {}
  let i = assignMappingEntry(lines, start, outerIndent, obj, firstKey, firstVal)
  const innerIndent = outerIndent + 2
  while (i < lines.length) {
    const nxt = lines[i]
    if (!nxt || nxt.indent !== innerIndent) break
    if (nxt.text.startsWith("- ")) break
    const m = nxt.text.match(KEY_VALUE)
    if (!m) break
    i = assignMappingEntry(lines, i, innerIndent, obj, m[1] ?? "", m[2] ?? "")
  }
  out.push(obj)
  return i
}

const parseListItem = (lines: Line[], i: number, indent: number, arr: YamlValue[]): number => {
  const ln = lines[i]
  if (!ln) return i
  const itemRest = ln.text === "-" ? "" : ln.text.slice(2)
  if (itemRest === "") {
    const r = parseBlock(lines, i + 1, indent)
    arr.push(r.value)
    return r.next
  }
  const kv = itemRest.match(KEY_VALUE)
  if (kv) return parseListItemMap(lines, i, indent, kv[1] ?? "", kv[2] ?? "", arr)
  arr.push(parseScalar(itemRest))
  return i + 1
}

const parseList = (
  lines: Line[],
  start: number,
  indent: number,
): { value: YamlValue[]; next: number } => {
  const arr: YamlValue[] = []
  let i = start
  while (i < lines.length) {
    const ln = lines[i]
    if (!ln || ln.indent !== indent) break
    if (!ln.text.startsWith("- ") && ln.text !== "-") break
    i = parseListItem(lines, i, indent, arr)
  }
  return { value: arr, next: i }
}

const parseMapping = (
  lines: Line[],
  start: number,
  indent: number,
): { value: YamlMap; next: number } => {
  const obj: YamlMap = {}
  let i = start
  while (i < lines.length) {
    const ln = lines[i]
    if (!ln || ln.indent !== indent) break
    if (ln.text.startsWith("- ")) break
    const m = ln.text.match(KEY_VALUE)
    if (!m) break
    i = assignMappingEntry(lines, i, indent, obj, m[1] ?? "", m[2] ?? "")
  }
  return { value: obj, next: i }
}

const parseBlock = (
  lines: Line[],
  start: number,
  parentIndent: number,
): { value: YamlValue; next: number } => {
  if (start >= lines.length) return { value: null, next: start }
  const first = lines[start]
  if (!first) return { value: null, next: start }
  const indent = first.indent
  if (indent <= parentIndent) return { value: null, next: start }
  if (first.text.startsWith("- ") || first.text === "-") {
    return parseList(lines, start, indent)
  }
  return parseMapping(lines, start, indent)
}

export const parseWorkflowYaml = (src: string): YamlValue => {
  const lines = tokenize(src)
  const { value } = parseBlock(lines, 0, -1)
  return value
}

export const asObject = (v: YamlValue): YamlMap => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error("expected mapping")
  }
  return v
}

export const asArray = (v: YamlValue): YamlValue[] => {
  if (!Array.isArray(v)) throw new Error("expected list")
  return v
}

export const asString = (v: YamlValue): string => {
  if (typeof v !== "string") throw new Error(`expected string, got ${typeof v}`)
  return v
}
