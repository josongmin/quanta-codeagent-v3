/**
 * Default in-tree implementation of the Windsurf-style `{{ variable }}`
 * template-literal expander (ADR-0252).
 *
 * Pure string-to-string. Linear character walk — NO regex sentinels (mirrors
 * the ADR-0203 macro dispatcher posture, which also avoids regex to dodge the
 * `noControlCharactersInRegex` / `noMisleadingCharacterClass` biome rules).
 *
 * Grammar:
 *
 *   template     := ( escape | substitution | char )*
 *   escape       := "\{\{"                        → literal "{{"
 *   substitution := "{{" ws? identifier ws? "}}"  → context lookup
 *   identifier   := [A-Za-z_$][\w$]* ("." identifier)*
 *
 * One-pass. The expansion of `{{ x }}` is NOT re-scanned. Unmatched `{{`
 * passes through verbatim (defensive — an author writing about the syntax in
 * prose must not be penalised). First unknown variable short-circuits the
 * scan and returns `ok: false`.
 */

import type { TemplateExpander } from "./port"
import type { ExpandContext, ExpandError, ExpandResult, ExpandValue, NestedContext } from "./types"

/** True if `c` is a valid first char of an identifier. */
const isIdentStart = (c: string | undefined): boolean => {
  if (c === undefined) return false
  return /[A-Za-z_$]/.test(c)
}

/** True if `c` is a valid continuation char of an identifier (incl. digit). */
const isIdentCont = (c: string | undefined): boolean => {
  if (c === undefined) return false
  return /[\w$]/.test(c)
}

/** True if `c` is whitespace tolerated inside `{{ ... }}` braces. */
const isInnerWs = (c: string | undefined): boolean => {
  if (c === undefined) return false
  return c === " " || c === "\t"
}

/**
 * Result of {@link parseSubstitution}. `ok: false` means the candidate `{{`
 * is NOT a substitution (no identifier, no closing `}}`, etc.) — emit the
 * literal `{` and advance by one char so the caller can re-scan the second
 * `{` independently.
 */
type ParseSubstitution =
  | { readonly ok: true; readonly name: string; readonly nextIndex: number }
  | { readonly ok: false }

/**
 * Try to parse a substitution starting at `template[i]` (which is the first
 * `{` of a candidate `{{`). Returns the parsed identifier and the index just
 * past the closing `}}`, or `ok: false` to signal "not a substitution".
 */
const parseSubstitution = (template: string, i: number): ParseSubstitution => {
  if (template[i] !== "{" || template[i + 1] !== "{") return { ok: false }
  let j = i + 2
  while (isInnerWs(template[j])) j++
  // Identifier with dotted-path continuations.
  if (!isIdentStart(template[j])) return { ok: false }
  let name = ""
  while (true) {
    if (!isIdentStart(template[j])) return { ok: false }
    name += template[j]
    j++
    while (isIdentCont(template[j])) {
      name += template[j]
      j++
    }
    if (template[j] === ".") {
      name += "."
      j++
      continue
    }
    break
  }
  while (isInnerWs(template[j])) j++
  if (template[j] !== "}" || template[j + 1] !== "}") return { ok: false }
  return { ok: true, name, nextIndex: j + 2 }
}

/**
 * Resolve a dotted-path identifier against the context. Returns the leaf
 * `ExpandValue` (which may be a `NestedContext` — caller distinguishes), or
 * `undefined` to signal "not found".
 */
const resolvePath = (ctx: ExpandContext, dotted: string): ExpandValue | undefined => {
  const segments = dotted.split(".")
  let cursor: ExpandValue | undefined
  let isFirst = true
  for (const seg of segments) {
    if (isFirst) {
      cursor = ctx[seg]
      isFirst = false
      continue
    }
    if (cursor === null || cursor === undefined) return undefined
    if (typeof cursor !== "object") return undefined
    cursor = (cursor as NestedContext)[seg]
  }
  return cursor
}

/**
 * Coerce a leaf `ExpandValue` to its string emission. Returns `undefined`
 * when the value is a `NestedContext` — bare-object lookups MUST surface
 * as `unknown-variable` (the public contract).
 */
const coerceLeaf = (v: ExpandValue): string | undefined => {
  if (typeof v === "string") return v
  if (typeof v === "number") return String(v)
  if (typeof v === "boolean") return v ? "true" : "false"
  if (v === null) return "null"
  // Object — refuse to silently stringify.
  return undefined
}

/** Make an `unknown-variable` error at the given 1-based position. */
const unknownVar = (name: string, position: number): ExpandError => ({
  kind: "unknown-variable",
  name,
  position,
})

/** Try the `\{\{` escape at `template[i]`. Returns the new index, or `-1`.
 *
 * The escape spelled in the spec is `\{\{` — backslash-brace-backslash-brace.
 * Authors picked this so the escape "wraps" each brace symmetrically, which
 * also means a user writing `\{` (a single escaped brace) in prose remains
 * unaffected (we only consume the escape when BOTH braces are escaped). */
const tryConsumeEscape = (template: string, i: number, out: string[]): number => {
  if (template[i] !== "\\") return -1
  if (template[i + 1] !== "{") return -1
  if (template[i + 2] !== "\\") return -1
  if (template[i + 3] !== "{") return -1
  out.push("{{")
  return i + 4
}

/** Per-scan state mutated by the loop body. */
interface ScanState {
  readonly out: string[]
  i: number
  error: ExpandError | undefined
}

/**
 * Handle the `{{ ... }}` substitution case. Mutates `state` in place;
 * returns `true` if a substitution (successful OR error-emitting) was
 * consumed, `false` if the `{{` was not a valid substitution opener.
 */
const tryConsumeSubstitution = (
  template: string,
  context: ExpandContext,
  state: ScanState,
): boolean => {
  const parsed = parseSubstitution(template, state.i)
  if (!parsed.ok) return false
  const resolved = resolvePath(context, parsed.name)
  if (resolved === undefined) {
    state.error = unknownVar(parsed.name, state.i + 1)
    return true
  }
  const text = coerceLeaf(resolved)
  if (text === undefined) {
    state.error = unknownVar(parsed.name, state.i + 1)
    return true
  }
  state.out.push(text)
  state.i = parsed.nextIndex
  return true
}

/** Outcome of a single scan step — what the loop body should do next. */
type StepOutcome = "continue" | "error"

/**
 * Advance the scan by one logical step. Tries (in priority order):
 *   1. `\{\{` escape — consume 4 chars, emit literal `{{`
 *   2. `{{ name }}` substitution — consume identifier, emit value (or set
 *      `state.error` and return "error")
 *   3. Verbatim char — emit one char, advance by 1
 *
 * Returns "error" iff `state.error` was set; otherwise "continue".
 */
const scanStep = (template: string, context: ExpandContext, state: ScanState): StepOutcome => {
  const escNext = tryConsumeEscape(template, state.i, state.out)
  if (escNext >= 0) {
    state.i = escNext
    return "continue"
  }
  if (
    template[state.i] === "{" &&
    template[state.i + 1] === "{" &&
    tryConsumeSubstitution(template, context, state)
  ) {
    return state.error !== undefined ? "error" : "continue"
  }
  // Unmatched `{{` falls through to verbatim — the second `{` will be
  // re-scanned in the next loop turn (no infinite loop since we ALWAYS
  // advance by at least 1).
  const ch = template[state.i]
  if (ch !== undefined) state.out.push(ch)
  state.i++
  return "continue"
}

/**
 * Public expander factory. The returned object is the smallest closure
 * around the scanner — no shared mutable state across calls.
 */
export const createDefaultTemplateExpander = (): TemplateExpander => ({
  expand: (template: string, context: ExpandContext): ExpandResult => {
    const state: ScanState = { out: [], i: 0, error: undefined }
    while (state.i < template.length) {
      const outcome = scanStep(template, context, state)
      if (outcome === "error" && state.error !== undefined) {
        return { ok: false, error: state.error }
      }
    }
    return { ok: true, text: state.out.join("") }
  },
})
