/**
 * Playbook frontmatter parser (ADR-0203).
 *
 * The lenient {@link parseFrontmatter} in `../frontmatter.ts` covers the
 * Claude Code 6-field subset; the strict {@link parseSkillMarkdown} in
 * `../skill-frontmatter.ts` covers a small subset with loud failure. NEITHER
 * accepts the nested `trigger:` mapping, the `macros:` mapping, or richer
 * list shapes the user-authored playbook contract needs.
 *
 * This parser:
 *   - delegates SPLITTING + GENERAL YAML to the `yaml` library (already a dep
 *     for `yaml_read`) — battle-tested, anchor-aware, error-locations,
 *   - applies STRICT TYPE NARROWING with explicit fail-closed checks for
 *     every supported field. Unknown keys are ignored (forward-compatibility),
 *     but PRESENT keys MUST have the right shape or we surface a typed
 *     `PlaybookParseError` with the line number from the YAML parser.
 *
 * The parser is intentionally agnostic about whether the SKILL.md ALSO
 * carries the canonical 6-field frontmatter — it reads ONLY the four new
 * fields + `trigger`. The host calls both parsers in sequence and merges.
 */

import { parse, YAMLParseError } from "yaml"
import {
  type InlineTriggerConfig,
  type MacroDefinition,
  PLAYBOOK_MAX_BYTES,
  type PlaybookFrontmatter,
  PlaybookParseError,
  type PlaybookParseResult,
} from "./types"

const FENCE = "---"

/** Public entry point. Accepts the full SKILL.md text. */
export const parsePlaybookFrontmatter = (text: string): PlaybookParseResult => {
  if (text.length > PLAYBOOK_MAX_BYTES) {
    return {
      ok: false,
      error: new PlaybookParseError(
        `file exceeds ${PLAYBOOK_MAX_BYTES}-byte playbook cap (got ${text.length} bytes)`,
        1,
      ),
    }
  }
  const split = splitFrontmatter(text)
  if (!split.ok) return { ok: false, error: split.error }
  if (split.frontmatter === "") {
    // No frontmatter at all — every field absent. Byte-identical posture per
    // ADR-0203: an empty playbook frontmatter is indistinguishable from the
    // pre-0203 lenient skill.
    return { ok: true, value: {} }
  }
  let raw: unknown
  try {
    raw = parse(split.frontmatter, { strict: false })
  } catch (e) {
    const line = e instanceof YAMLParseError ? (e.linePos?.[0]?.line ?? 1) : 1
    const msg = e instanceof Error ? e.message : "yaml parse failure"
    return { ok: false, error: new PlaybookParseError(msg, line) }
  }
  if (raw === null || raw === undefined) return { ok: true, value: {} }
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      error: new PlaybookParseError("frontmatter must be a mapping", 1),
    }
  }
  return narrowFrontmatter(raw as Record<string, unknown>)
}

interface SplitOk {
  readonly ok: true
  readonly frontmatter: string
}
interface SplitErr {
  readonly ok: false
  readonly error: PlaybookParseError
}
type SplitResult = SplitOk | SplitErr

const splitFrontmatter = (text: string): SplitResult => {
  const normalized = text.replace(/\r\n/g, "\n")
  const lines = normalized.split("\n")
  // No leading fence ⇒ no frontmatter at all (legal — file is pure markdown).
  if (lines[0]?.trim() !== FENCE) return { ok: true, frontmatter: "" }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === FENCE) {
      return { ok: true, frontmatter: lines.slice(1, i).join("\n") }
    }
  }
  return {
    ok: false,
    error: new PlaybookParseError("unterminated frontmatter (missing closing '---')", 1),
  }
}

/** Compose the supported-field narrowers, short-circuiting on first error. */
const narrowFrontmatter = (raw: Record<string, unknown>): PlaybookParseResult => {
  const result: {
    procedure?: readonly string[]
    successCriteria?: readonly string[]
    forbiddenActions?: readonly string[]
    macros?: readonly MacroDefinition[]
    trigger?: InlineTriggerConfig
  } = {}

  // procedure
  if ("procedure" in raw) {
    const r = narrowStringList(raw.procedure, "procedure")
    if (!r.ok) return r
    result.procedure = r.value
  }
  // success-criteria (kebab → camel)
  if ("success-criteria" in raw) {
    const r = narrowStringList(raw["success-criteria"], "success-criteria")
    if (!r.ok) return r
    result.successCriteria = r.value
  }
  // forbidden-actions
  if ("forbidden-actions" in raw) {
    const r = narrowStringList(raw["forbidden-actions"], "forbidden-actions")
    if (!r.ok) return r
    result.forbiddenActions = r.value
  }
  // macros — mapping { name: expansion }
  if ("macros" in raw) {
    const r = narrowMacros(raw.macros)
    if (!r.ok) return r
    result.macros = r.value
  }
  // trigger — { comment-marker, watch-glob }
  if ("trigger" in raw) {
    const r = narrowTrigger(raw.trigger)
    if (!r.ok) return r
    result.trigger = r.value
  }

  return { ok: true, value: result }
}

type NarrowOk<T> = { readonly ok: true; readonly value: T }
type NarrowErr = { readonly ok: false; readonly error: PlaybookParseError }
type Narrowed<T> = NarrowOk<T> | NarrowErr

const narrowStringList = (v: unknown, field: string): Narrowed<readonly string[]> => {
  if (!Array.isArray(v)) {
    return {
      ok: false,
      error: new PlaybookParseError(`'${field}' must be a list of strings`, 1),
    }
  }
  const out: string[] = []
  for (let i = 0; i < v.length; i++) {
    const entry = v[i]
    if (typeof entry !== "string" || entry.trim() === "") {
      return {
        ok: false,
        error: new PlaybookParseError(
          `'${field}[${i}]' must be a non-empty string (got ${typeof entry})`,
          1,
        ),
      }
    }
    out.push(entry)
  }
  return { ok: true, value: Object.freeze(out) }
}

const MACRO_NAME_RE = /^[a-z0-9][a-z0-9-]*$/

const narrowMacros = (v: unknown): Narrowed<readonly MacroDefinition[]> => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    return {
      ok: false,
      error: new PlaybookParseError("'macros' must be a mapping of name → expansion", 1),
    }
  }
  const out: MacroDefinition[] = []
  for (const [name, expansion] of Object.entries(v as Record<string, unknown>)) {
    if (!MACRO_NAME_RE.test(name)) {
      return {
        ok: false,
        error: new PlaybookParseError(
          `macro name '${name}' must be kebab-case (lowercase, digits, dashes)`,
          1,
        ),
      }
    }
    if (typeof expansion !== "string" || expansion.trim() === "") {
      return {
        ok: false,
        error: new PlaybookParseError(`macro '${name}' must have a non-empty string expansion`, 1),
      }
    }
    out.push({ name, expansion })
  }
  return { ok: true, value: Object.freeze(out) }
}

const narrowTrigger = (v: unknown): Narrowed<InlineTriggerConfig> => {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    return {
      ok: false,
      error: new PlaybookParseError("'trigger' must be a mapping", 1),
    }
  }
  const obj = v as Record<string, unknown>
  const marker = obj["comment-marker"]
  const glob = obj["watch-glob"]
  if (typeof marker !== "string" || marker.trim() === "") {
    return {
      ok: false,
      error: new PlaybookParseError("'trigger.comment-marker' must be a non-empty string", 1),
    }
  }
  if (typeof glob !== "string" || glob.trim() === "") {
    return {
      ok: false,
      error: new PlaybookParseError("'trigger.watch-glob' must be a non-empty string", 1),
    }
  }
  return {
    ok: true,
    value: { commentMarker: marker, watchGlob: glob },
  }
}

/** Convenience predicate — does the parsed frontmatter carry ANY 0203 slot? */
export const isPlaybookExtended = (fm: PlaybookFrontmatter): boolean =>
  fm.procedure !== undefined ||
  fm.successCriteria !== undefined ||
  fm.forbiddenActions !== undefined ||
  fm.macros !== undefined ||
  fm.trigger !== undefined
