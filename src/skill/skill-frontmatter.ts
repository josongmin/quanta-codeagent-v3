/**
 * SKILL.md frontmatter — Cluster E / F14, ADR-0040.
 *
 * Distinguishes Skills (LLM-callable, optionally user-invocable) from
 * Extensions (system-level, never auto-invoked by the model). The 6-field
 * frontmatter is intentionally narrow:
 *
 *   ---
 *   name: my-skill              # kebab-case canonical id
 *   description: <short>        # model-facing
 *   userInvocable: true         # `/my-skill` slash command available
 *   allowedTools: ["Read"]      # explicit whitelist (empty = none)
 *   category: skill             # 'skill' | 'extension'
 *   stability: stable           # 'experimental' | 'stable' | 'deprecated'
 *   ---
 *
 * The existing `./frontmatter.ts` parser is intentionally lenient (it accepts
 * unknown keys and silently coerces shapes). For the SKILL.md frontmatter
 * contract we want loud failure on every malformed input — drift in this
 * frontmatter equates to drift in the LLM-callable surface, which is exactly
 * what we cannot quietly tolerate. So this module ships its OWN tiny
 * splitter + restricted scalar/bool/list parser.
 *
 * NO dependency on `js-yaml`. NO heuristic recovery. Failures carry a 1-based
 * line number so authors can find the offending line in the raw SKILL.md.
 */
import { z } from "zod"

export const SkillCategorySchema = z.enum(["skill", "extension"])
export type SkillCategory = z.infer<typeof SkillCategorySchema>

export const SkillStabilitySchema = z.enum(["experimental", "stable", "deprecated"])
export type SkillStability = z.infer<typeof SkillStabilitySchema>

export const SkillFrontmatterSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "name must be kebab-case"),
    description: z.string().min(1),
    userInvocable: z.boolean(),
    allowedTools: z.array(z.string().min(1)),
    category: SkillCategorySchema,
    stability: SkillStabilitySchema,
  })
  .strict()
export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>

export class FrontmatterParseError extends Error {
  override readonly name = "FrontmatterParseError"
  constructor(
    message: string,
    /** 1-based line number where the failure was detected. */
    readonly line: number,
  ) {
    super(`SKILL.md frontmatter parse error (line ${line}): ${message}`)
  }
}

/** Result discriminator — explicit rather than throwing so callers can
 *  surface the line number in tool output without try/catch noise. */
export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: FrontmatterParseError }

const FENCE = "---"

/** Recognised scalar types in this restricted YAML subset. */
type ScalarValue = string | boolean | string[]

/** Parse a single right-hand-side value. Supports:
 *   - `true` / `false`              → boolean
 *   - `"quoted string"` / `'q'`     → string (no escapes beyond `\\` `\"`)
 *   - `[a, "b c", d]`               → string[]
 *   - bareword                      → string
 *  Anything else (numbers, null, nested mappings, flow maps, anchors, etc.)
 *  is rejected with a line number. */
const parseRhs = (raw: string, line: number): ScalarValue => {
  const v = raw.trim()
  if (v === "") {
    throw new FrontmatterParseError("empty value", line)
  }
  if (v === "true") return true
  if (v === "false") return false
  // Bool-like surface forms are rejected — frontmatter is strict booleans only.
  if (v === "True" || v === "False" || v === "yes" || v === "no") {
    throw new FrontmatterParseError(`booleans must be 'true' or 'false', got '${v}'`, line)
  }
  if (v === "null" || v === "~") {
    throw new FrontmatterParseError("null is not supported", line)
  }
  if (/^-?\d+(\.\d+)?$/.test(v)) {
    throw new FrontmatterParseError("numeric scalars are not supported in SKILL.md", line)
  }
  if (v.startsWith("{")) {
    throw new FrontmatterParseError("flow mappings are not supported", line)
  }
  if (v.startsWith("&") || v.startsWith("*") || v.startsWith("!")) {
    throw new FrontmatterParseError("anchors / aliases / tags are not supported", line)
  }
  if (v.startsWith("[")) {
    return parseFlowList(v, line)
  }
  if (v.startsWith('"')) {
    return parseDoubleQuoted(v, line)
  }
  if (v.startsWith("'")) {
    return parseSingleQuoted(v, line)
  }
  // Bareword — accept as plain string. Disallow embedded `:` to catch
  // accidental key-in-value pasting (common authoring mistake).
  if (v.includes(": ")) {
    throw new FrontmatterParseError("unexpected ': ' in unquoted scalar", line)
  }
  return v
}

const DOUBLE_QUOTED_ESCAPE: Readonly<Record<string, string>> = Object.freeze({
  "\\": "\\",
  '"': '"',
  n: "\n",
  t: "\t",
})

const resolveEscape = (nx: string | undefined, line: number): string => {
  if (nx === undefined) {
    throw new FrontmatterParseError("dangling escape in double-quoted string", line)
  }
  const mapped = DOUBLE_QUOTED_ESCAPE[nx]
  if (mapped === undefined) {
    throw new FrontmatterParseError(`unknown escape '\\${nx}'`, line)
  }
  return mapped
}

const parseDoubleQuoted = (v: string, line: number): string => {
  if (!v.endsWith('"') || v.length < 2) {
    throw new FrontmatterParseError("unterminated double-quoted string", line)
  }
  const body = v.slice(1, -1)
  let out = ""
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch === "\\") {
      out += resolveEscape(body[i + 1], line)
      i++
    } else {
      out += ch
    }
  }
  return out
}

const parseSingleQuoted = (v: string, line: number): string => {
  if (!v.endsWith("'") || v.length < 2) {
    throw new FrontmatterParseError("unterminated single-quoted string", line)
  }
  return v.slice(1, -1).replace(/''/g, "'")
}

interface FlowSplitState {
  parts: string[]
  buf: string
  q: '"' | "'" | null
  i: number
}

/** Process one character in the flow-list raw-split. Returns the mutated
 *  state; designed to keep the loop body in `splitFlowList` flat. */
const stepFlowChar = (s: FlowSplitState, inner: string, line: number): void => {
  const ch = inner[s.i] ?? ""
  if (s.q !== null) {
    if (s.q === '"' && ch === "\\") {
      const nx = inner[s.i + 1]
      if (nx === undefined) {
        throw new FrontmatterParseError("dangling escape in list element", line)
      }
      s.buf += ch + nx
      s.i++
      return
    }
    if (ch === s.q) s.q = null
    s.buf += ch
    return
  }
  if (ch === '"' || ch === "'") {
    s.q = ch as '"' | "'"
    s.buf += ch
    return
  }
  if (ch === ",") {
    s.parts.push(s.buf)
    s.buf = ""
    return
  }
  s.buf += ch
}

const splitFlowList = (inner: string, line: number): string[] => {
  const s: FlowSplitState = { parts: [], buf: "", q: null, i: 0 }
  while (s.i < inner.length) {
    stepFlowChar(s, inner, line)
    s.i++
  }
  if (s.q !== null) throw new FrontmatterParseError("unterminated string in list", line)
  if (s.buf.trim() !== "" || s.parts.length > 0) s.parts.push(s.buf)
  return s.parts
}

const unwrapListElement = (raw: string, line: number): string => {
  const t = raw.trim()
  if (t.startsWith('"')) return parseDoubleQuoted(t, line)
  if (t.startsWith("'")) return parseSingleQuoted(t, line)
  if (t === "") throw new FrontmatterParseError("empty list element", line)
  return t
}

const parseFlowList = (v: string, line: number): string[] => {
  if (!v.endsWith("]")) {
    throw new FrontmatterParseError("unterminated flow list", line)
  }
  const inner = v.slice(1, -1)
  if (inner.trim() === "") return []
  return splitFlowList(inner, line).map((p) => unwrapListElement(p, line))
}

interface SplitResult {
  rawData: Record<string, ScalarValue>
  body: string
}

const findClosingFence = (lines: readonly string[]): number => {
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FENCE) return i
  }
  return -1
}

const collectOneFrontmatterLine = (
  raw: string,
  lineno: number,
  data: Record<string, ScalarValue>,
): void => {
  if (raw.trim() === "" || raw.trim().startsWith("#")) return
  if (/^\s/.test(raw)) {
    throw new FrontmatterParseError("indented continuation lines are not supported", lineno)
  }
  const m = raw.match(/^([A-Za-z][A-Za-z0-9_]*)\s*:\s*(.*)$/)
  if (!m) {
    throw new FrontmatterParseError(`malformed key/value line: "${raw}"`, lineno)
  }
  const key = m[1] ?? ""
  const rhs = (m[2] ?? "").trim()
  if (key in data) {
    throw new FrontmatterParseError(`duplicate key '${key}'`, lineno)
  }
  data[key] = parseRhs(rhs, lineno)
}

/** Split frontmatter (must start with `---` on line 1) from the markdown body
 *  and parse every key/value pair into the restricted scalar/bool/list set. */
const splitAndCollect = (text: string): SplitResult => {
  const normalized = text.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")
  if (lines[0]?.trim() !== FENCE) {
    throw new FrontmatterParseError("SKILL.md must begin with '---' fence", 1)
  }
  const end = findClosingFence(lines)
  if (end === -1) {
    throw new FrontmatterParseError("unterminated frontmatter (missing closing '---')", 1)
  }
  const data: Record<string, ScalarValue> = {}
  for (let i = 1; i < end; i++) {
    collectOneFrontmatterLine(lines[i] ?? "", i + 1, data)
  }
  const body = lines
    .slice(end + 1)
    .join("\n")
    .replace(/^\n+/, "")
  return { rawData: data, body }
}

/** Public entry point. Returns a discriminated union so callers can plug the
 *  error line into tool output without try/catch. */
export const parseSkillMarkdown = (
  content: string,
): ParseResult<{ frontmatter: SkillFrontmatter; body: string }> => {
  let split: SplitResult
  try {
    split = splitAndCollect(content)
  } catch (e) {
    if (e instanceof FrontmatterParseError) return { ok: false, error: e }
    throw e
  }
  const parsed = SkillFrontmatterSchema.safeParse(split.rawData)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    const path = first?.path.join(".") || "<root>"
    const msg = first?.message ?? "schema validation failed"
    return {
      ok: false,
      error: new FrontmatterParseError(`field '${path}': ${msg}`, 1),
    }
  }
  return { ok: true, value: { frontmatter: parsed.data, body: split.body } }
}
