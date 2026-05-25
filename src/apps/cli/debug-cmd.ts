/**
 * `/debug` slash-command handler — runtime toggle for the developer-mode
 * debug tracer (Track D). Pure / DI-friendly: caller owns the
 * {@link DebugCmdState} ref and re-applies it (e.g. swap the live tracer
 * in/out of the stream tee) based on the returned `state`.
 *
 * Subcommands:
 *   - `/debug`                ⇒ toggle enabled (carry categories)
 *   - `/debug on`             ⇒ force on  (carry categories)
 *   - `/debug off`            ⇒ force off (preserve categories so a later
 *                                toggle restores the prior filter)
 *   - `/debug status`         ⇒ print current state (no mutation)
 *   - `/debug tools,llm`      ⇒ set categories AND force on
 *   - `/debug bogus`          ⇒ error message (return state unchanged)
 *
 * Defensive posture: never throws. Unknown args / unknown categories
 * produce a clean `message` and the returned `state` equals `prev`
 * (referential — verified by the immutability hellgate). All branches
 * keep this contract so the caller can blindly assign `state` back.
 *
 * Slice discipline (Track D):
 *   - Lives in `src/apps/cli/`.
 *   - Imports ONLY `./debug-tracer` (Track C interface). Touches no
 *     stream / agent / permission internals.
 *   - `parseDebugCategories` is the canonical tokeniser for both the
 *     env-boot path (when extended) and the runtime slash — keeps a
 *     single source of truth for the closed category union.
 */

import type { DebugCategory } from "./debug-tracer"

const KNOWN_CATEGORIES: ReadonlySet<DebugCategory> = new Set<DebugCategory>([
  "tools",
  "decisions",
  "llm",
  "memory",
  "plan",
  "stream",
  "other",
])

const isDebugCategory = (s: string): s is DebugCategory =>
  (KNOWN_CATEGORIES as ReadonlySet<string>).has(s)

/** State threaded across `/debug` invocations. Surface owns the ref;
 *  the handler is pure (no module-scope mutables). Optional
 *  `categories` ⇒ no filter (all categories pass through). */
export interface DebugCmdState {
  readonly enabled: boolean
  readonly categories?: ReadonlySet<DebugCategory>
}

/** Handler outcome. `state` is what the surface should adopt (may be
 *  `prev` by reference when the input was a no-op / error). `message`
 *  is a one-line user-visible string with a trailing newline. */
export interface DebugCmdResult {
  readonly state: DebugCmdState
  readonly message: string
}

const formatCategories = (cats: ReadonlySet<DebugCategory> | undefined): string => {
  if (cats === undefined || cats.size === 0) return "all"
  return [...cats].sort().join(",")
}

const renderStatus = (state: DebugCmdState): string => {
  const status = state.enabled ? "on" : "off"
  return `debug: ${status} (categories: ${formatCategories(state.categories)})\n`
}

/** Parse a comma-separated category list. Returns `null` (with the
 *  offending token in `bad`) when ANY token is unrecognised — the
 *  caller surfaces a clean error and the prev state is preserved. */
const parseDebugCategories = (
  raw: string,
): { kind: "ok"; categories: ReadonlySet<DebugCategory> } | { kind: "bad"; token: string } => {
  const tokens = raw
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
  if (tokens.length === 0) return { kind: "bad", token: raw }
  const next = new Set<DebugCategory>()
  for (const t of tokens) {
    if (!isDebugCategory(t)) return { kind: "bad", token: t }
    next.add(t)
  }
  return { kind: "ok", categories: next }
}

/** Pure handler — see file header for subcommand grammar. */
export const runDebugCmd = (args: string, prev: DebugCmdState): DebugCmdResult => {
  const trimmed = args.trim()

  // /debug — bare toggle (preserve categories)
  if (trimmed === "") {
    const next: DebugCmdState = {
      enabled: !prev.enabled,
      ...(prev.categories !== undefined ? { categories: prev.categories } : {}),
    }
    return { state: next, message: renderStatus(next) }
  }

  // /debug status — no mutation
  if (trimmed === "status") {
    return { state: prev, message: renderStatus(prev) }
  }

  // /debug on — force enabled
  if (trimmed === "on") {
    const next: DebugCmdState = {
      enabled: true,
      ...(prev.categories !== undefined ? { categories: prev.categories } : {}),
    }
    return { state: next, message: renderStatus(next) }
  }

  // /debug off — force disabled (preserve categories so a later toggle
  // restores the prior filter)
  if (trimmed === "off") {
    const next: DebugCmdState = {
      enabled: false,
      ...(prev.categories !== undefined ? { categories: prev.categories } : {}),
    }
    return { state: next, message: renderStatus(next) }
  }

  // /debug <category-list> — parse + enable
  const parsed = parseDebugCategories(trimmed)
  if (parsed.kind === "bad") {
    const known = [...KNOWN_CATEGORIES].sort().join(", ")
    return {
      state: prev,
      message: `/debug: unknown argument '${parsed.token}' (use: on | off | status | <categories>; known categories: ${known})\n`,
    }
  }
  const next: DebugCmdState = { enabled: true, categories: parsed.categories }
  return { state: next, message: renderStatus(next) }
}

export const __test = { parseDebugCategories, KNOWN_CATEGORIES }
