/**
 * Types for the Windsurf-style `{{ variable }}` template-literal expander
 * (ADR-0252). Sibling to the ADR-0203 `!macro` one-pass expander — different
 * grammar, different lookup model, different escape, different boundary rules.
 *
 * Slice posture: LEAF. No imports from `@/agent`, `@/tool`, `@/permission`,
 * `node:fs`, or `yaml`. Pure types + a discriminated-union error.
 */

/**
 * A non-leaf node in the expansion context. Reached only via dotted path —
 * a bare `{{ obj }}` whose binding is a `NestedContext` does NOT silently
 * `JSON.stringify`; it surfaces an `unknown-variable` error so the author
 * sees the lookup needs to be more specific.
 */
export interface NestedContext {
  readonly [key: string]: ExpandValue
}

/** A single value bound in an {@link ExpandContext}. */
export type ExpandValue = string | number | boolean | null | NestedContext

/**
 * The context the expander walks. Keys are the identifiers the author
 * references; values are coerced to strings per the type-coercion rules
 * documented on {@link TemplateExpander.expand}.
 */
export type ExpandContext = Readonly<Record<string, ExpandValue>>

/**
 * Discriminated-union expansion error. The host renders the typed error
 * for the author so they can fix the template / context.
 *
 * - `unknown-variable`  — a `{{ name }}` reference did not resolve. The
 *                         `name` carries the original (dotted) identifier
 *                         the template used, and `position` is the
 *                         1-based char index of the opening `{{` for
 *                         editor-friendly error rendering.
 * - `max-iterations`    — reserved for a future recursive expander; the
 *                         default expander is one-pass and never emits
 *                         this. Kept in the union so a swap-in expander
 *                         (nunjucks etc.) can reuse the shape.
 * - `recursive`         — reserved for a future recursive expander that
 *                         detects a cycle. Same rationale as above.
 */
export type ExpandError =
  | {
      readonly kind: "unknown-variable"
      readonly name: string
      readonly position: number
    }
  | {
      readonly kind: "max-iterations"
      readonly iterations: number
    }
  | {
      readonly kind: "recursive"
      readonly name: string
    }

/** Result of a single {@link TemplateExpander.expand} call. */
export type ExpandResult =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly error: ExpandError }
