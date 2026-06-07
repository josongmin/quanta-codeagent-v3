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
import { runtimeConfig } from "@/shared"
import { normalizeSkillFrontmatter } from "./manifest-compat"
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
    // ADR-0493 — thin-client dispatch route tag (kebab key). Optional/additive:
    // a pre-0493 SKILL.md without it parses byte-identical. The `.strict()`
    // schema would otherwise REJECT a SKILL.md that declares it.
    "thin-client-dispatch": z.enum(["local", "post-text", "control-request"]).optional(),
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

/**
 * jun-7-misc 02 — codex-shape ingest variant of {@link SkillFrontmatterSchema}.
 *
 * Differs from the strict schema in exactly two SAFE-BY-CONSTRUCTION ways:
 *   1. OUTER `.strict()` → `.strip()`: genuinely-unknown frontmatter keys
 *      (codex's `license`, future extensions) are DROPPED, never interpreted.
 *   2. `userInvocable: z.boolean().default(false)` — codex treats it optional
 *      (absent in `briefing`); absent ⇒ `false` (conservative "not user-
 *      invocable unless declared"; a `true` default would auto-expose every
 *      ingested codex skill as a `/slash` command — the riskier choice).
 *
 * The SECURITY-load-bearing `allowedTools` element schema is UNCHANGED
 * (`z.array(z.string().min(1))`) — the normalizer may RENAME the kebab key but
 * the VALUE is still strictly validated, so a renamed key can never carry a
 * non-string / wildcard the schema rejects. The admin-scope `superRefine` is
 * preserved verbatim.
 *
 * Used ONLY when `runtimeConfig().manifestCompat` is armed (strict `=== "1"`).
 * Default-OFF callers use {@link SkillFrontmatterSchema} ⇒ byte-identical. */
export const SkillFrontmatterCompatSchema = z
  .object({
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9-]*$/, "name must be kebab-case"),
    description: z.string().min(1),
    userInvocable: z.boolean().default(false),
    // Codex's frontmatter SSOT is `{name, description, license, allowed-tools,
    // metadata}` (quick_validate.py:40) — `category`/`stability`/`allowedTools`
    // are quanta-only. For foreign INGEST we default them conservatively rather
    // than reject: a tool-less codex skill (briefing) gets `allowedTools: []`
    // (NO tools, the safe scoping), `category: "skill"` (it IS LLM-callable),
    // and `stability: "experimental"` (foreign ingest is never "stable" by fiat).
    // A quanta-native SKILL.md ALWAYS declares all three, so this never changes
    // a native parse. The element shape stays strict (`z.string().min(1)`).
    allowedTools: z.array(z.string().min(1)).default([]),
    category: SkillCategorySchema.default("skill"),
    stability: SkillStabilitySchema.default("experimental"),
    scope: SkillScopeSchema.optional(),
    installState: SkillInstallStateSchema.optional(),
    adminInstalledBy: z.string().min(1).optional(),
    "argument-hint": z.string().min(1).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    "thin-client-dispatch": z.enum(["local", "post-text", "control-request"]).optional(),
  })
  .strip()
  .superRefine((v, ctx) => {
    if (v.scope === "admin" && v.installState !== undefined && v.installState !== "required") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "admin scope requires installState='required' (or omit it)",
        path: ["installState"],
      })
    }
    if (v.adminInstalledBy !== undefined && v.scope !== "admin") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "adminInstalledBy is only valid when scope='admin'",
        path: ["adminInstalledBy"],
      })
    }
  })
export type SkillFrontmatterCompat = z.infer<typeof SkillFrontmatterCompatSchema>

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
  /** jun-7-misc 02 (compat-only) — key of a top-level `key:` (empty value)
   *  whose following indented `- item` lines form a YAML block-list (codex's
   *  `allowed-tools:` shape). null unless a block-list header was just opened.
   *  ONLY ever set when the manifest-compat knob is armed; in the default-OFF
   *  path this stays null so parsing is byte-identical. */
  blockListParent: string | null
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

/** jun-7-misc 02 — true when `raw` is an indented YAML block-list item
 *  (`  - value`). Compat-only; reused for the codex `allowed-tools:` shape. */
const isBlockListItem = (raw: string): boolean => /^\s+-\s+.+$/.test(raw)

/** jun-7-misc 02 (compat-only) — append an indented `- value` block-list item
 *  to the pending block-list parent. The element VALUE reuses {@link parseRhs}
 *  and MUST resolve to a string (the tool allowlist is a string[]); a non-
 *  string element is rejected loudly. Returns true when consumed. */
const tryBlockListItem = (
  raw: string,
  lineno: number,
  data: Record<string, ScalarValue>,
  parent: string,
): boolean => {
  const item = raw.match(/^\s+-\s+(.*)$/)
  if (!item) return false
  const value = parseRhs((item[1] ?? "").trim(), lineno)
  if (typeof value !== "string") {
    throw new FrontmatterParseError(`block-list '${parent}' items must be string scalars`, lineno)
  }
  const cur = data[parent]
  const list = Array.isArray(cur) ? cur : []
  list.push(value)
  data[parent] = list
  return true
}

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
    // jun-7-misc 02 (compat-only): an indented `- item` under a pending block-
    // list parent. `blockListParent` is ONLY non-null when the compat knob is
    // armed, so the default-OFF path never reaches here (byte-identical).
    if (
      state.blockListParent !== null &&
      tryBlockListItem(raw, lineno, data, state.blockListParent)
    ) {
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
  return { nestedParent: null, blockListParent: null }
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

/**
 * jun-7-misc 02 (compat-only) lookahead: if `line` is a top-level `key:` with
 * an empty value AND the next content line is an indented `- item`, return that
 * key (opening a YAML block-list parent). Mirrors {@link nestedMapHeaderKey}
 * for the codex `allowed-tools:` block-list shape. Returns null otherwise.
 * The caller ONLY invokes this when the manifest-compat knob is armed.
 */
const blockListHeaderKey = (
  line: string,
  data: Record<string, ScalarValue>,
  lines: readonly string[],
  i: number,
  end: number,
): string | null => {
  if (isBlankOrComment(line) || /^\s/.test(line)) return null
  if (!/^[A-Za-z][A-Za-z0-9_-]*\s*:\s*$/.test(line)) return null
  const nxt = nextContentLine(lines, i + 1, end)
  if (nxt === -1 || !isBlockListItem(lines[nxt] ?? "")) return null
  const key = (line.match(/^([A-Za-z][A-Za-z0-9_-]*)/)?.[1] ?? "").trim()
  if (key in data) {
    throw new FrontmatterParseError(`duplicate key '${key}'`, i + 1)
  }
  // Seed an empty array so a header with zero following items resolves to [].
  data[key] = []
  return key
}

/** Process one frontmatter line, returning the next {@link CollectState}.
 *  Extracted from {@link splitAndCollect} so the loop stays flat. `compat`
 *  (jun-7-misc 02, default-OFF ⇒ BYTE-IDENTICAL) arms the codex block-list
 *  lookahead + top-level reset; with it false this is the original behavior. */
const stepFrontmatterLine = (
  data: Record<string, ScalarValue>,
  lines: readonly string[],
  i: number,
  end: number,
  state: CollectState,
  compat: boolean,
): CollectState => {
  const line = lines[i] ?? ""
  // Default-OFF byte-identity: `idle` is exactly `nestedParent === null` (the
  // original guard) because `blockListParent` is ALWAYS null unless `compat`.
  // jun-7-misc 02 (compat-only): a TOP-LEVEL (non-indented) line terminates any
  // pending block-list/nested parent, so a new header lookahead can fire even
  // when a previous block is still pending (e.g. `metadata:` right after an
  // `allowed-tools:` block-list). The widened reset is gated to `compat`.
  const topLevelReset = compat && !/^\s/.test(line) && !isBlankOrComment(line)
  const idle = (state.nestedParent === null && state.blockListParent === null) || topLevelReset
  const header = idle ? nestedMapHeaderKey(line, data, lines, i, end) : null
  if (header !== null) return { nestedParent: header, blockListParent: null }
  // jun-7-misc 02 (compat-only): block-list header lookahead. Inert unless
  // `compat` is armed, so default-OFF parsing is byte-identical (never called).
  const blockHeader = compat && idle ? blockListHeaderKey(line, data, lines, i, end) : null
  if (blockHeader !== null) return { nestedParent: null, blockListParent: blockHeader }
  // jun-7-misc 02 (compat-only): a top-level line that did NOT open a new
  // header clears any pending parent so a stale `blockListParent` does not
  // swallow the next top-level key.
  const base = topLevelReset ? { nestedParent: null, blockListParent: null } : state
  return collectOneFrontmatterLine(line, i + 1, data, base)
}

/** Split frontmatter (must start with `---` on line 1) from the markdown body
 *  and parse every key/value pair into the restricted scalar/bool/list set.
 *  `compat` (jun-7-misc 02, default false ⇒ BYTE-IDENTICAL) additionally
 *  recognises the codex `allowed-tools:` YAML block-list shape. */
const splitAndCollect = (text: string, compat = false): SplitResult => {
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
  let state: CollectState = { nestedParent: null, blockListParent: null }
  for (let i = 1; i < end; i++) {
    state = stepFrontmatterLine(data, lines, i, end, state, compat)
  }
  const body = lines
    .slice(end + 1)
    .join("\n")
    .replace(/^\n+/, "")
  return { rawData: data, body }
}

/**
 * ADR-0476 — lift a skill's raw `dependencies` block out of SKILL.md.
 *
 * The strict frontmatter contract above (`parseSkillMarkdown`) deliberately
 * REJECTS block-list-of-maps syntax (an indented `- type: mcp` line trips the
 * "indented continuation lines are not supported" guard), so the skill→MCP
 * `dependencies.tools[]` declaration cannot ride the main schema without
 * widening that loud-failure contract. Instead this helper scans the raw
 * frontmatter region INDEPENDENTLY for a single top-level `dependencies:`
 * block and parses ONLY that sub-tree into the
 * `{ tools: [ {type,value,transport,command?,args?,url?}, ... ] }` shape that
 * `@/skill/skill-mcp-deps` `parseSkillMcpDeps` validates.
 *
 * It NEVER throws and NEVER touches `parseSkillMarkdown`'s behaviour:
 *   - no `dependencies:` block  ⇒ returns `undefined` (byte-identical: the
 *     caller passes `undefined` to the resolver, which is a no-op skill).
 *   - malformed sub-tree        ⇒ best-effort partial / `undefined`; the
 *     downstream validator is the loud-failure authority for MCP deps.
 *
 * Scope of the mini block-parser (intentionally narrow — NOT a YAML engine):
 *   dependencies:
 *     tools:
 *       - type: mcp
 *         value: my-server
 *         transport: stdio
 *         command: my-mcp-binary
 *         args: ["--flag"]
 * Each `- ` opens a new tool map; subsequent deeper-indented `key: value`
 * lines attach to it. Values reuse {@link parseRhs} (bareword / quoted /
 * flow-list). Anything outside this shape is ignored (validator decides).
 */
const indentOf = (raw: string): number => raw.length - raw.trimStart().length

const KV_RE = /^([A-Za-z][A-Za-z0-9_-]*)\s*:\s*(.*)$/

/** Best-effort set a `key: value` field on a tool map; malformed values are
 *  skipped (the downstream validator is the loud-failure authority). */
const setToolField = (
  target: Record<string, unknown>,
  kv: RegExpMatchArray,
  lineno: number,
): void => {
  try {
    target[kv[1] ?? ""] = parseRhs((kv[2] ?? "").trim(), lineno)
  } catch {
    /* skip malformed field; validator surfaces it */
  }
}

/** Apply one already-significant (non-blank, in-block) tool-list line. Opens a
 *  new tool map on a `- ` dash line (pushing it onto `tools`) and returns it as
 *  the new `current`; otherwise sets a `key: value` field on `current`. */
const applyToolLine = (
  trimmed: string,
  tools: Record<string, unknown>[],
  current: Record<string, unknown> | null,
  lineno: number,
): Record<string, unknown> | null => {
  if (trimmed.startsWith("- ")) {
    const next: Record<string, unknown> = {}
    tools.push(next)
    const inline = trimmed.slice(2).trim().match(KV_RE) // `- key: value`
    if (inline) setToolField(next, inline, lineno)
    return next
  }
  if (current !== null) {
    const kv = trimmed.match(KV_RE)
    if (kv) setToolField(current, kv, lineno)
  }
  return current
}

/** Parse the `tools:` block-list under `dependencies:` into raw tool records.
 *  `start` is the index of the `tools:` line; `baseIndent` its indentation. */
const collectToolList = (
  lines: readonly string[],
  start: number,
  end: number,
  baseIndent: number,
): Record<string, unknown>[] => {
  const tools: Record<string, unknown>[] = []
  let current: Record<string, unknown> | null = null
  for (let i = start + 1; i < end; i++) {
    const raw = lines[i] ?? ""
    if (isBlankOrComment(raw)) continue
    if (indentOf(raw) <= baseIndent) break // dedented out of the tools block
    current = applyToolLine(raw.trim(), tools, current, i + 1)
  }
  return tools
}

/** Find the top-level `dependencies:` line index in the frontmatter region,
 *  or -1. */
const findDependenciesLine = (lines: readonly string[], end: number): number => {
  for (let i = 1; i < end; i++) {
    const raw = lines[i] ?? ""
    if (indentOf(raw) === 0 && /^dependencies\s*:\s*$/.test(raw)) return i
  }
  return -1
}

export const liftRawDependenciesBlock = (content: string): { tools: unknown[] } | undefined => {
  try {
    const lines = content.replace(/\r\n/g, "\n").split("\n")
    if (lines[0]?.trim() !== FENCE) return undefined
    const end = findClosingFence(lines)
    if (end === -1) return undefined
    const depIdx = findDependenciesLine(lines, end)
    if (depIdx === -1) return undefined
    // Find the `tools:` line nested under `dependencies:`.
    const depIndent = indentOf(lines[depIdx] ?? "")
    for (let i = depIdx + 1; i < end; i++) {
      const raw = lines[i] ?? ""
      if (isBlankOrComment(raw)) continue
      const ind = indentOf(raw)
      if (ind <= depIndent) break // dedented out of dependencies block
      if (/^tools\s*:\s*$/.test(raw.trim())) return { tools: collectToolList(lines, i, end, ind) }
    }
    // A `dependencies:` block with no `tools:` ⇒ legal, no MCP deps.
    return { tools: [] }
  } catch {
    // NO-THROW: any scan failure ⇒ treat as no declared deps.
    return undefined
  }
}

/** Public entry point. Returns a discriminated union so callers can plug the
 *  error line into tool output without try/catch. */
export const parseSkillMarkdown = (
  content: string,
): ParseResult<{ frontmatter: SkillFrontmatter; body: string }> => {
  // jun-7-misc 02 — codex-shape ingest. Strict `=== "1"` opt-in. Default-OFF ⇒
  // `compat` is false, the block-list lookahead is never armed, no normalizer
  // runs, and the strict schema is used ⇒ BYTE-IDENTICAL to pre-ticket behavior.
  const compat = runtimeConfig().manifestCompat
  let split: SplitResult
  try {
    split = splitAndCollect(content, compat)
  } catch (e) {
    if (e instanceof FrontmatterParseError) return { ok: false, error: e }
    throw e
  }
  // Compat: rename the two enumerated kebab keys (native camel wins on conflict)
  // BEFORE validation, then validate against the relaxed (strip + default)
  // schema. The grant-bearing `allowedTools` element shape is unchanged.
  const rawData = compat ? normalizeSkillFrontmatter(split.rawData) : split.rawData
  const schema = compat ? SkillFrontmatterCompatSchema : SkillFrontmatterSchema
  const parsed = schema.safeParse(rawData)
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
