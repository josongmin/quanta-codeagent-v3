/**
 * Ticket 14 (§11.6) — `/model` interactive picker, PURE core.
 *
 * Three pure functions the `/model` command (`model-cmd.ts`) composes. Keeping
 * them here (a) makes them unit-testable without a SlashContext, and (b) mirrors
 * the `/effort` split where the render helper (`formatEffortLine`) is a pure fn
 * the command body calls per candidate.
 *
 * Leaf discipline: type-only imports. `EffortLevel` is the CANONICAL effort
 * vocabulary from `@/agent`; `ModelEffortSupport` is the per-model metadata SSOT
 * from `@/llm/provider-metadata`. Assigning `provider-metadata`'s structural
 * `ReasoningEffort` slugs into `EffortLevel` here is the UNIFICATION point — a
 * tier added to one union but not the other is a compile error in this file.
 *
 * SOTA reference (plan §14, `.extracted_source/`):
 *   - Claude Code CLI picker (`_cli-symbols.txt:145230`): per-model context
 *     window inline + "Default (recommended)" badge + capability blurb
 *     ("most capable" / "fastest") → `formatModelLine` mirrors this, degrading
 *     gracefully when a field's metadata is absent.
 *   - Codex `validateEffort` (`use-model-settings-DhE-8qP1.js:106`): switching
 *     model re-validates/clamps the reasoning effort into the new model's
 *     `supportedReasoningEfforts` → `clampEffortForModel` is our mirror, the
 *     real correctness fix this ticket lands.
 */

import type { EffortLevel } from "@/agent"
import type { ModelEffortSupport, ReasoningEffort } from "@/llm/provider-metadata"
import { escapeBodyForLine, sanitizeLogText } from "@/shared"

/**
 * The structural metadata a single candidate line renders from. Every field
 * except `id` is optional — `formatModelLine` omits a missing field rather than
 * printing a placeholder (graceful degrade, plan §14: "omit a field when
 * metadata absent"). The adapter (`model-adapter.ts`) projects this from
 * `MODEL_CONTEXT_WINDOWS` + `MODEL_EFFORT_SUPPORT`; a test can hand-build it.
 */
export interface ModelLineMeta {
  /** The exact provider model slug. The only required field. */
  readonly id: string
  /** Total input+output token budget the provider accepts. */
  readonly contextWindow?: number | undefined
  /** Max tokens the model can GENERATE in one response. */
  readonly maxOutput?: number | undefined
  /** Render the "(recommended)" badge (the surface's default/sticky model). */
  readonly recommended?: boolean | undefined
  /** One-line capability/cost hint ("most capable" / "fastest" / "lower cost").
   *  Absent ⇒ no hint segment. */
  readonly hint?: string | undefined
}

/** Compact `1,000,000 → "1M"`, `400,000 → "400k"`, small numbers verbatim. Pure
 *  display helper; mirrors the CC picker's "1M context" inline rendering. */
const formatTokenCount = (n: number): string => {
  if (n >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return `${n}`
}

/**
 * Render ONE candidate row for the `/model` no-arg listing. Shape mirrors
 * `formatEffortLine`: a leading current-marker column, the id, then any present
 * metadata segments, newline-terminated.
 *
 *   ` * gpt-5            400k ctx · 128k out · (recommended) · most capable`
 *   `   gpt-4o-mini      128k ctx · 16k out · lower cost`
 *   `   future-model-xyz `                       ← all metadata absent ⇒ bare id
 *
 * Degrade rules (plan §14): a field whose metadata is `undefined` is OMITTED —
 * never a "unknown"/"0" placeholder. The `·` separators only join the segments
 * that are actually present, so a metadata-less model renders as just its id.
 */
export const formatModelLine = (meta: ModelLineMeta, current: boolean): string => {
  const marker = current ? "*" : " "
  // aug-28 SECURITY — the id can originate from a provider response or from the
  // shared sticky file, and this line goes straight to the terminal. Sanitize +
  // fold newlines so a hostile slug cannot emit CSI/OSC sequences or forge extra
  // rows (a measured PoC printed a fake "* claude-opus-trusted" current-model row).
  // The admission predicate already rejects such ids upstream; this is the
  // defense-in-depth at the seam that actually writes to the tty.
  const safeId = escapeBodyForLine(sanitizeLogText(meta.id))
  const segments: string[] = []
  if (meta.contextWindow !== undefined) segments.push(`${formatTokenCount(meta.contextWindow)} ctx`)
  if (meta.maxOutput !== undefined) segments.push(`${formatTokenCount(meta.maxOutput)} out`)
  if (meta.recommended === true) segments.push("(recommended)")
  if (meta.hint !== undefined && meta.hint.trim() !== "") segments.push(meta.hint.trim())
  const tail = segments.length > 0 ? `  ${segments.join(" · ")}` : ""
  return ` ${marker} ${safeId.padEnd(20)}${tail}\n`
}

/** Thrown by {@link pickModel} when the requested id matches no candidate. The
 *  command body catches this to print a `/effort`-style "unknown model" error
 *  with the known list (exit 1). A typed class lets the caller distinguish it
 *  from any other throw. */
export class UnknownModelError extends Error {
  readonly requested: string
  readonly known: readonly string[]
  constructor(requested: string, known: readonly string[]) {
    super(`unknown model '${requested}'`)
    this.name = "UnknownModelError"
    this.requested = requested
    this.known = known
  }
}

/**
 * Resolve a requested model id against the candidate set. Precedence:
 *   1. EXACT match (returns the candidate verbatim — preserves canonical case);
 *   2. case-insensitive match (returns the CANDIDATE's spelling, not the input);
 *   3. {@link UnknownModelError} (no silent fallback — the user asked for a
 *      specific model, an unknown one is an error, parity with `/effort`).
 *
 * Whitespace on the input is trimmed first (parity with `/effort`'s
 * `.trim().toLowerCase()`). Pure — no I/O.
 */
export const pickModel = (requested: string, candidates: readonly string[]): string => {
  const trimmed = requested.trim()
  const exact = candidates.find((c) => c === trimmed)
  if (exact !== undefined) return exact
  const lower = trimmed.toLowerCase()
  const ci = candidates.find((c) => c.toLowerCase() === lower)
  if (ci !== undefined) return ci
  throw new UnknownModelError(trimmed, candidates)
}

/** Outcome of {@link clampEffortForModel}. `clamped:false` ⇒ `effort` is the
 *  input unchanged and `notice` is absent. `clamped:true` ⇒ `effort` is the
 *  model's default and `notice` is the one-liner the command echoes. */
export interface EffortClampResult {
  readonly effort: EffortLevel
  readonly clamped: boolean
  readonly notice?: string
}

/**
 * Compile-checked unification of the provider-metadata `ReasoningEffort` slugs
 * into the canonical `@/agent` `EffortLevel`. This is the drift-guard the file
 * header promises: a `Record<ReasoningEffort, EffortLevel>` is EXHAUSTIVE (TS
 * requires an entry for every slug) AND value-typed (each value must be a real
 * `EffortLevel`). So removing a tier from one union but not the other is a
 * COMPILE error here — replacing the former `as EffortLevel` casts that silently
 * accepted ANY slug (defeating the guard). `toEffortLevel` reads through this
 * map, making `clampEffortForModel`'s output PROVABLY an `EffortLevel`.
 */
const REASONING_EFFORT_TO_LEVEL: Record<ReasoningEffort, EffortLevel> = {
  default: "default",
  low: "low",
  medium: "medium",
  high: "high",
  max: "max",
}

/** Map a provider-metadata effort slug to the canonical `EffortLevel` via the
 *  compile-checked table (no `as` cast). */
const toEffortLevel = (e: ReasoningEffort): EffortLevel => REASONING_EFFORT_TO_LEVEL[e]

/**
 * SOTA++ CORE (plan §14, Codex `validateEffort` mirror). Reconcile the session
 * reasoning-effort with a newly-picked model's supported set:
 *
 *   - `support === undefined` (UNKNOWN model) ⇒ CONSERVATIVE "all supported":
 *     NEVER clamp, NEVER invent a mismatch. Returns the input effort unchanged.
 *     This is the plan's risk-note fallback — an un-tabled model must not
 *     spuriously downgrade the user's effort.
 *   - current effort IS in `support.supportedEfforts` ⇒ no-op (effort kept).
 *   - current effort is NOT supported ⇒ clamp to `support.defaultEffort` and
 *     emit a one-line notice naming the model, the dropped tier, and the new
 *     tier. This closes the real coherence gap where `/model gpt-4o` would
 *     otherwise leave a `high` reasoning-effort pinned on a non-reasoning model.
 *
 * Pure — no I/O, no store mutation. The COMMAND applies the returned effort via
 * the existing `ctx.effort.set` path and prints the notice.
 */
export const clampEffortForModel = (
  modelId: string,
  currentEffort: EffortLevel,
  support: ModelEffortSupport | undefined,
): EffortClampResult => {
  // Unknown model → conservative all-supported. No metadata ⇒ no mismatch.
  if (support === undefined) return { effort: currentEffort, clamped: false }
  // Map the metadata slugs to canonical EffortLevel through the compile-checked
  // table (no `as` cast — a dropped/renamed tier is a build error).
  const supported = support.supportedEfforts.map(toEffortLevel)
  if (supported.includes(currentEffort)) return { effort: currentEffort, clamped: false }
  const fallback = toEffortLevel(support.defaultEffort)
  return {
    effort: fallback,
    clamped: true,
    notice: `effort '${currentEffort}' is not supported by ${modelId}; clamped to '${fallback}'`,
  }
}
