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
import { SKILL_INSTALL_STATES, SKILL_SCOPES } from "./types"

export const SkillCategorySchema = z.enum(["skill", "extension"])
export type SkillCategory = z.infer<typeof SkillCategorySchema>

export const SkillStabilitySchema = z.enum(["experimental", "stable", "deprecated"])
export type SkillStability = z.infer<typeof SkillStabilitySchema>

/** ADR-0134 — scope enum mirrored for frontmatter parsing. The runtime SSOT
 *  (closed union + literals array) lives in `./types.ts`; here we just
 *  re-narrow it into a Zod enum so the strict schema rejects unknown scope
 *  tokens at the same loud-failure point as every other field. */
export const SkillScopeSchema = z.enum(
  SKILL_SCOPES as readonly [string, ...string[]] as readonly [
    "builtIn",
    "system",
    "admin",
    "team",
    "repo",
    "user",
    "personal",
  ],
)

/** ADR-0134 — install state enum mirrored for frontmatter parsing. */
export const SkillInstallStateSchema = z.enum(
  SKILL_INSTALL_STATES as readonly [string, ...string[]] as readonly [
    "required",
    "recommended",
    "optional",
  ],
)

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
    // ADR-0134 — all optional; absent values fall to discovery-time inference
    // (scope from sourcePath, installState ⇒ undefined unless admin scope).
    scope: SkillScopeSchema.optional(),
    installState: SkillInstallStateSchema.optional(),
    adminInstalledBy: z.string().min(1).optional(),
    // ADR-0457 — codex skill ECOSYSTEM frontmatter (gaps A+B). Both optional /
    // additive: a pre-0457 SKILL.md (with neither field) parses byte-identical.
    // Without these the `.strict()` schema would REJECT a codex SKILL.md that
    // declares `argument-hint` / `metadata`, so they must be modelled here even
    // though discovery reads them via the lenient parser. `metadata` is an open
    // record (codex puts `short-description` under it; future keys allowed).
    "argument-hint": z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    // Admin scope MUST be "required" — Codex parity (admin install policy is
    // non-negotiable by definition). Authors can omit installState entirely
    // (we backfill to "required") or set it to "required" explicitly, but
    // declaring "recommended"/"optional" on admin scope is a contradiction.
    if (v.scope === "admin" && v.installState !== undefined && v.installState !== "required") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "admin scope requires installState='required' (or omit it)",
        path: ["installState"],
      })
    }
    // adminInstalledBy only makes sense when scope === "admin".
    if (v.adminInstalledBy !== undefined && v.scope !== "admin") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "adminInstalledBy is only valid when scope='admin'",
        path: ["adminInstalledBy"],
      })
    }
  })
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

/** Recognised scalar types in this restricted YAML subset. ADR-0457 adds a
 *  one-level nested string mapping (for codex's `metadata:` block) — still no
 *  arbitrary nesting, just `key:` followed by indented `child: scalar` lines. */
type ScalarValue = string | boolean | string[] | Record<string, string>

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

/**
 * Carried collect state: `nestedParent` is the key of a top-level `key:` that
 * had an EMPTY value and is therefore a candidate to receive ADR-0457 indented
 * `child: scalar` nested-map lines (codex's `metadata:` block). null otherwise.
 */
interface CollectState {
  nestedParent: string | null
}

/** ADR-0457 — attach an indented `child: scalar` line to the pending nested-map
 *  parent. Returns true when consumed. Only flat (non-quoted-aware beyond the
 *  shared scalar parser) `key: value` children are supported — deeper nesting
 *  or block lists inside the map are rejected by the normal indentation guard.
 *  Child values reuse {@link parseRhs} but must resolve to a string (the codex
 *  `metadata` block is string-valued); a non-string child is rejected loudly. */
const tryNestedChild = (
  raw: string,
  lineno: number,
  data: Record<string, ScalarValue>,
  parent: string,
): boolean => {
  const child = raw.match(/^\s+([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
  if (!child) return false
  const childKey = child[1] ?? ""
  const rhs = (child[2] ?? "").trim()
  const value = parseRhs(rhs, lineno)
  if (typeof value !== "string") {
    throw new FrontmatterParseError(
      `nested '${parent}.${childKey}' must be a string scalar`,
      lineno,
    )
  }
  const cur = data[parent]
  const map = cur && typeof cur === "object" && !Array.isArray(cur) ? cur : {}
  if (childKey in map) {
    throw new FrontmatterParseError(`duplicate key '${parent}.${childKey}'`, lineno)
  }
  map[childKey] = value
  data[parent] = map
  return true
}

/** True when `raw` is an indented `child: scalar` mapping line (ADR-0457). */
const isIndentedChild = (raw: string): boolean => /^\s+[A-Za-z][A-Za-z0-9_-]*\s*:\s*.+$/.test(raw)

/** True when `raw` is blank or a full-line comment (skippable). */
const isBlankOrComment = (raw: string): boolean => raw.trim() === "" || raw.trim().startsWith("#")

const collectOneFrontmatterLine = (
  raw: string,
  lineno: number,
  data: Record<string, ScalarValue>,
  state: CollectState,
): CollectState => {
  if (isBlankOrComment(raw)) return state
  if (/^\s/.test(raw)) {
    // ADR-0457: an indented line is allowed ONLY as a nested-map child directly
    // under a pending empty-value parent. Anything else stays unsupported.
    if (state.nestedParent !== null && tryNestedChild(raw, lineno, data, state.nestedParent)) {
      return state
    }
    throw new FrontmatterParseError("indented continuation lines are not supported", lineno)
  }
  // ADR-0457: allow kebab-case keys (e.g. `argument-hint`) at top level, in
  // addition to the original `[A-Za-z][A-Za-z0-9_]*` snake/camel set.
  const m = raw.match(/^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/)
  if (!m) {
    throw new FrontmatterParseError(`malformed key/value line: "${raw}"`, lineno)
  }
  const key = m[1] ?? ""
  const rhs = (m[2] ?? "").trim()
  if (key in data) {
    throw new FrontmatterParseError(`duplicate key '${key}'`, lineno)
  }
  // A top-level empty value reaches parseRhs("") and fails loudly with "empty
  // value" — identical to pre-0457. (An empty value that opens a nested-map
  // parent is intercepted by lookahead in `splitAndCollect` and never lands
  // here.)
  data[key] = parseRhs(rhs, lineno)
  return { nestedParent: null }
}

/** Find the next non-blank/comment line index at-or-after `from`, or -1. */
const nextContentLine = (lines: readonly string[], from: number, end: number): number => {
  for (let j = from; j < end; j++) {
    if (!isBlankOrComment(lines[j] ?? "")) return j
  }
  return -1
}

/**
 * ADR-0457 lookahead: if `line` is a top-level `key:` with an empty value AND
 * the next content line is an indented child, return that key (opening a
 * nested-map parent). Returns null when the line is not such a header — the
 * caller then processes it normally. Throws on a duplicate top-level key.
 */
const nestedMapHeaderKey = (
  line: string,
  data: Record<string, ScalarValue>,
  lines: readonly string[],
  i: number,
  end: number,
): string | null => {
  if (isBlankOrComment(line) || /^\s/.test(line)) return null
  if (!/^[A-Za-z][A-Za-z0-9_-]*\s*:\s*$/.test(line)) return null
  const nxt = nextContentLine(lines, i + 1, end)
  if (nxt === -1 || !isIndentedChild(lines[nxt] ?? "")) return null
  const key = (line.match(/^([A-Za-z][A-Za-z0-9_-]*)/)?.[1] ?? "").trim()
  if (key in data) {
    throw new FrontmatterParseError(`duplicate key '${key}'`, i + 1)
  }
  return key
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
  let state: CollectState = { nestedParent: null }
  for (let i = 1; i < end; i++) {
    const line = lines[i] ?? ""
    const header =
      state.nestedParent === null ? nestedMapHeaderKey(line, data, lines, i, end) : null
    if (header !== null) {
      state = { nestedParent: header }
      continue
    }
    state = collectOneFrontmatterLine(line, i + 1, data, state)
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
  // ADR-0134 backfill: admin scope without explicit installState ⇒ "required".
  // This is the loud half of the superRefine guard above (which rejects
  // contradictory values) — together they make admin scope ⇒ required an
  // invariant the registry can rely on without re-checking.
  const fm =
    parsed.data.scope === "admin" && parsed.data.installState === undefined
      ? { ...parsed.data, installState: "required" as const }
      : parsed.data
  return { ok: true, value: { frontmatter: fm, body: split.body } }
}
