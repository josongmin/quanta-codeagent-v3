/**
 * Playbook dispatcher (ADR-0203) — procedure resolution + macro lookup.
 *
 * The dispatcher's job is the smallest possible one:
 *
 *   1. Given a procedure step body, find every `!macro-name` reference.
 *   2. Resolve each reference against the macro registry.
 *   3. Return either the fully-expanded step text, or a typed
 *      {@link MacroLookupResult} when a macro is missing.
 *
 * It does NOT:
 *   - decide what to actually DO with the step (that is the agent loop).
 *   - render UI for the dispatch.
 *   - touch the filesystem.
 *
 * Macro reference grammar (Devin-compatible):
 *   - `!name`           — bare macro reference, kebab-case, anchored at a
 *                         non-word boundary on the left
 *   - `\!name`          — escaped — NOT a macro reference; the `\` is
 *                         stripped and the literal `!name` is preserved
 *   - everything else   — passes through unchanged
 *
 * Idempotency: expanding an already-expanded step is a no-op (no macro
 * markers remain). Recursive expansion is NOT performed — an expansion that
 * itself contains `!other` is treated as literal text. This avoids ad-hoc
 * graph traversal AND mirrors Devin's "expand once" contract.
 */

import type { MacroDefinition, MacroLookupResult } from "./types"

/** O(1) lookup wrapper around a {@link MacroDefinition} list. */
export interface MacroRegistry {
  readonly lookup: (name: string) => MacroLookupResult
  readonly has: (name: string) => boolean
  readonly size: () => number
}

/** Build a registry from a frontmatter-declared macro list. */
export const buildMacroRegistry = (
  macros: readonly MacroDefinition[] | undefined,
): MacroRegistry => {
  const map = new Map<string, string>()
  if (macros !== undefined) {
    for (const m of macros) {
      // Last-wins on intra-list collision. The parser already rejects
      // duplicate keys via the YAML mapping shape, so this is defensive.
      map.set(m.name, m.expansion)
    }
  }
  return {
    lookup: (name) => {
      const expansion = map.get(name)
      if (expansion === undefined) {
        return { ok: false, reason: "not-found", name }
      }
      return { ok: true, expansion }
    },
    has: (name) => map.has(name),
    size: () => map.size,
  }
}

/**
 * Result of expanding a procedure step against a macro registry. We surface
 * EVERY missing reference (not just the first) so the host can render a
 * single error listing all unresolved macros for an authoring fix.
 */
export interface StepExpansion {
  /** The fully expanded text. Unresolved macros are LEFT IN PLACE verbatim. */
  readonly text: string
  /**
   * Macros that were referenced but not found. Empty ⇒ fully resolved. The
   * order matches first-occurrence order in the source step.
   */
  readonly missing: readonly string[]
  /** Macros that were resolved (de-duped, first-occurrence order). */
  readonly resolved: readonly string[]
}

// Kebab-case name fragment shared by both the macro grammar and the escape
// recognizer. Anchored so the captured group is exactly `[a-z0-9][a-z0-9-]*`.
const NAME_RE = /^[a-z0-9][a-z0-9-]*/

/** True if `prev` is the LEFT boundary char for a macro reference — i.e. it
 *  is undefined (start of input), or it is NOT a word-class char. The `\` is
 *  handled separately by the escape detector. */
const isLeftBoundary = (prev: string | undefined): boolean => {
  if (prev === undefined) return true
  return !/[\w\\]/.test(prev)
}

/**
 * Expand all macro references in `step` against `registry`. Performs ONE
 * pass — expansions are not re-scanned for further macros (cf. the
 * non-recursive contract in the module-header doc).
 *
 * Implementation: linear character-walk scanner. Avoids regex sentinels
 * (and the control-character regex biome lint flagged) by tracking the
 * "previous char" state directly. Three cases per character:
 *   1. `\!name`  → emit literal `!name`, consume both
 *   2. `!name`   at a non-word boundary → look up + emit expansion
 *   3. anything else → emit verbatim
 */
/** Accumulator threaded through the scan; mutated in-place by helpers. */
interface ScanState {
  out: string
  i: number
  readonly seenResolved: Set<string>
  readonly seenMissing: Set<string>
  readonly resolved: string[]
  readonly missing: string[]
}

/** Try to consume an `\!name` escape at `state.i`. Returns true if consumed. */
const tryConsumeEscape = (step: string, state: ScanState): boolean => {
  if (step[state.i] !== "\\" || step[state.i + 1] !== "!") return false
  const tail = step.slice(state.i + 2)
  const m = tail.match(NAME_RE)
  if (m === null) {
    // Lone `\!` not followed by a kebab name → pass `\` through.
    state.out += "\\"
    state.i++
    return true
  }
  state.out += `!${m[0]}`
  state.i += 2 + m[0].length
  return true
}

/** Try to consume a `!name` macro reference at `state.i`. Returns true on hit. */
const tryConsumeMacro = (step: string, state: ScanState, registry: MacroRegistry): boolean => {
  if (step[state.i] !== "!") return false
  const prev = state.i === 0 ? undefined : step[state.i - 1]
  if (!isLeftBoundary(prev)) return false
  const tail = step.slice(state.i + 1)
  const m = tail.match(NAME_RE)
  if (m === null) return false
  const name = m[0]
  const verdict = registry.lookup(name)
  if (verdict.ok) {
    if (!state.seenResolved.has(name)) {
      state.seenResolved.add(name)
      state.resolved.push(name)
    }
    state.out += verdict.expansion
  } else {
    if (!state.seenMissing.has(name)) {
      state.seenMissing.add(name)
      state.missing.push(name)
    }
    // Unresolved ⇒ leave verbatim so the authoring error is visible.
    state.out += `!${name}`
  }
  state.i += 1 + name.length
  return true
}

export const expandStep = (step: string, registry: MacroRegistry): StepExpansion => {
  const state: ScanState = {
    out: "",
    i: 0,
    seenResolved: new Set(),
    seenMissing: new Set(),
    resolved: [],
    missing: [],
  }
  while (state.i < step.length) {
    if (tryConsumeEscape(step, state)) continue
    if (tryConsumeMacro(step, state, registry)) continue
    state.out += step[state.i]
    state.i++
  }
  return {
    text: state.out,
    missing: Object.freeze(state.missing),
    resolved: Object.freeze(state.resolved),
  }
}

/**
 * Expand every step in a procedure list. Aggregates missing macros across
 * all steps (de-duped, first-occurrence order). Useful as a one-shot
 * authoring lint when the host first loads a playbook.
 */
export interface ProcedureExpansion {
  readonly steps: readonly StepExpansion[]
  readonly missing: readonly string[]
}

export const expandProcedure = (
  procedure: readonly string[] | undefined,
  registry: MacroRegistry,
): ProcedureExpansion => {
  if (procedure === undefined || procedure.length === 0) {
    return { steps: Object.freeze([]), missing: Object.freeze([]) }
  }
  const steps: StepExpansion[] = []
  const seenMissing = new Set<string>()
  const missing: string[] = []
  for (const step of procedure) {
    const exp = expandStep(step, registry)
    steps.push(exp)
    for (const m of exp.missing) {
      if (!seenMissing.has(m)) {
        seenMissing.add(m)
        missing.push(m)
      }
    }
  }
  return { steps: Object.freeze(steps), missing: Object.freeze(missing) }
}
