/**
 * Effort dimension (Tier-0 absorption #0-5, Claude Desktop 1.7196.3 build).
 *
 * Distinct from `SkillEffort` (`src/skill/types.ts`) which is a per-skill
 * advisory hint. This module owns the SESSION-level effort axis — one of five
 * named tiers consulted by the loop (and, when wired, the LLM adapter) to
 * derive a `max_output_tokens` ceiling and a reasoning-mode hint.
 *
 * Resolution precedence (caller's responsibility, not enforced here):
 *   skill (named string) > session > DEFAULT_EFFORT
 *
 * Slice discipline (RFC §1.2 + biome boundaries):
 *   - Pure leaf module. No imports from any other slice.
 *   - Numeric SkillEffort values are advisory token budgets — NOT mapped onto
 *     the named tier axis. `resolveEffort` falls through to the session value
 *     when the skill side provides a number (or is absent).
 *
 * The five named tiers are exhaustive and ordered by intensity. Adding a tier
 * must extend EFFORT_LEVELS, EffortLevel, and effortToTokenBudget together —
 * the unit test asserts the exhaustiveness budget mapping covers every literal.
 */

export type EffortLevel = "default" | "max" | "high" | "medium" | "low"

export const EFFORT_LEVELS = [
  "default",
  "max",
  "high",
  "medium",
  "low",
] as const satisfies readonly EffortLevel[]

export const DEFAULT_EFFORT: EffortLevel = "default"

const EFFORT_LEVEL_SET: ReadonlySet<string> = new Set<string>(EFFORT_LEVELS)

/** Skill effort can be either a named tier (interpreted as an axis vote) OR a
 *  raw token-budget number (advisory only — does NOT vote on the tier axis).
 *  Imported structurally to keep `@/agent` from importing `@/skill`. */
export type SkillEffortAdvisory = EffortLevel | number

/** Parse a free-form env/string into a named tier. Returns `undefined` when
 *  the value is absent, empty, or not a recognised literal — callers preserve
 *  "user did not set" vs "user set default" by acting on `undefined` themselves
 *  (e.g. omit the field instead of writing `"default"`). Case-insensitive on
 *  the literal match because env values frequently arrive uppercase. */
export const parseEffort = (raw: string | undefined): EffortLevel | undefined => {
  if (raw === undefined) return undefined
  const trimmed = raw.trim().toLowerCase()
  if (trimmed === "") return undefined
  return EFFORT_LEVEL_SET.has(trimmed) ? (trimmed as EffortLevel) : undefined
}

/** Resolve the effective tier for THIS turn given the session value and the
 *  active skill's advisory. Precedence: a named skill tier wins; a numeric
 *  skill advisory does NOT vote (returns session ?? default); an absent skill
 *  defers to the session, and an absent session defers to DEFAULT_EFFORT. */
export const resolveEffort = (
  session: EffortLevel | undefined,
  skill: SkillEffortAdvisory | undefined,
): EffortLevel => {
  if (typeof skill === "string" && EFFORT_LEVEL_SET.has(skill)) return skill as EffortLevel
  return session ?? DEFAULT_EFFORT
}

/** Suggested `max_output_tokens` ceiling per tier. `undefined` for `default`
 *  signals "no override — use the provider/model default". These numbers are
 *  starting points; adapters may clamp to model-specific limits. */
export const effortToTokenBudget = (level: EffortLevel): number | undefined => {
  switch (level) {
    case "default":
      return undefined
    case "low":
      return 1024
    case "medium":
      return 4096
    case "high":
      return 16384
    case "max":
      return 64000
  }
}

/** Mutable per-session effort holder. The store is intentionally tiny — the
 *  loop reads `get()` once per turn, the CLI/REPL surface writes via `set()`
 *  in response to a `/effort` command or a config flag. */
export interface EffortStore {
  get(): EffortLevel
  set(level: EffortLevel): void
  snapshot(): EffortLevel
}

export const createEffortStore = (initial: EffortLevel = DEFAULT_EFFORT): EffortStore => {
  let current: EffortLevel = initial
  return {
    get: () => current,
    set: (level) => {
      current = level
    },
    snapshot: () => current,
  }
}
