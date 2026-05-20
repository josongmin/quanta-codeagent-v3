/**
 * Phase 4 SOTA++ absorption — edit-strategy hints. Codex's edit-strategy state
 * machine (`agent-loop-deep-dive.md §7`, `tool-routing-and-triggering.md`)
 * teaches the model to SWITCH strategies on patch-context mismatch instead of
 * spinning on the same patch. We surface a structured `nextStrategy` plus a
 * one-line suggestion as a suffix on the existing error message — exit
 * semantics are unchanged (still ok:false); only the text grows.
 *
 * CR2 follow-up: the edit slice now emits a STRUCTURAL `EditMismatchKind` tag
 * on each failure path. The dispatcher's error text still carries a stable
 * `[edit-mismatch:<kind>]` marker as a fallback so callers without typed
 * evidence can still recover the kind, but the in-process producer/consumer
 * pair (`applyExactEdit` / `applyFuzzyEdit` → `classifyMismatch`) is now a
 * compile-checked switch instead of a substring sniff.
 */

/** Stable error codes the edit tool emits for failure classes the
 *  strategy-hint formatter understands. Adding a new failure class
 *  requires updating BOTH this union AND `classifyMismatch`. The
 *  TypeScript exhaustiveness check catches the mismatch at compile time. */
export type EditMismatchKind =
  | "not-found" // old_string didn't match any span
  | "ambiguous" // old_string matched multiple spans (not-unique)
  | "fuzzy-no-confident" // fuzzy fallback found nothing acceptable

/** Next-strategy categories the LLM can route on:
 *   - `scripted_replace` — duplicated blocks / bulk substitution.
 *   - `read_then_patch`  — context drift; re-read the current span first.
 *   - `ambiguous`        — neither path is obviously better; surface a hedged
 *                          suggestion (LLM decides). */
export type NextStrategy = "scripted_replace" | "read_then_patch" | "ambiguous"

/** Stable structural marker so callers/tests can parse-spot the hint without
 *  pattern-matching a free-form sentence. */
export const STRATEGY_HINT_PREFIX = "Strategy hint:"

/** Stable in-text marker that carries an {@link EditMismatchKind} across the
 *  text-only `ToolResult.output` channel. Format: `[edit-mismatch:<kind>]`.
 *  This is the FALLBACK contract for callers that only see the dispatcher's
 *  string output (e.g. transcripts, downstream LLM steps). In-process callers
 *  with direct access to the `EditOutcome.kind` field should prefer that. */
export const EDIT_MISMATCH_MARKER_PREFIX = "[edit-mismatch:"
const EDIT_MISMATCH_MARKER_RE = /\[edit-mismatch:([a-z-]+)\]/

/** Render the in-text marker for a given kind. */
export const formatEditMismatchMarker = (kind: EditMismatchKind): string =>
  `${EDIT_MISMATCH_MARKER_PREFIX}${kind}]`

/** Recover an {@link EditMismatchKind} from a message string. Used as the
 *  fallback when the caller only has the dispatcher's text output. Prefers
 *  the structural marker; falls back to legacy substring sniffs so
 *  pre-existing transcripts (or any caller that hand-formats a message
 *  without the marker) still classify cleanly. */
export const parseKindFromText = (message: string): EditMismatchKind | undefined => {
  const m = EDIT_MISMATCH_MARKER_RE.exec(message)
  if (m) {
    const tag = m[1]
    if (tag === "not-found" || tag === "ambiguous" || tag === "fuzzy-no-confident") return tag
  }
  // Legacy substring fallback. Order matters: "no confident match" is more
  // specific than "not found", and "not unique" is a stronger "ambiguous"
  // signal than the literal word "ambiguous".
  const lower = message.toLowerCase()
  if (lower.includes("no confident match")) return "fuzzy-no-confident"
  if (lower.includes("not found")) return "not-found"
  if (lower.includes("not unique") || lower.includes("ambiguous")) return "ambiguous"
  return undefined
}

/** Classify why a patch attempt failed. Accepts either:
 *   - a structural `{ kind }` from an in-process producer (preferred — the
 *     TypeScript compiler enforces exhaustiveness here), or
 *   - a raw message string (fallback for callers that only have the
 *     dispatcher's text output).
 *
 *  Returns the {@link NextStrategy} the LLM should route on. Unrecognized
 *  strings fall back to `"ambiguous"` so we always emit *some* hint on
 *  every failure — but in-process producers should never trigger that path:
 *  adding a new {@link EditMismatchKind} fails to compile here. */
export const classifyMismatch = (failure: { kind: EditMismatchKind } | string): NextStrategy => {
  const kind = typeof failure === "string" ? parseKindFromText(failure) : failure.kind
  if (kind === undefined) return "ambiguous"
  switch (kind) {
    case "not-found":
      // Context drifted out from under the patch; re-reading is the right
      // next step.
      return "read_then_patch"
    case "ambiguous":
      // Duplication is the symptom; scripted_replace is purpose-built for it.
      return "scripted_replace"
    case "fuzzy-no-confident":
      // The fuzzy ladder couldn't find an acceptable window — most likely
      // the file has drifted; re-read before re-patching.
      return "read_then_patch"
  }
  // TypeScript exhaustiveness: future EditMismatchKind addition fails here
  // because the `switch` above won't cover the new case, and TS narrows
  // `kind` to `never` only when every member is handled.
}

/** One-line operator hint, prefixed with {@link STRATEGY_HINT_PREFIX} so the
 *  block is greppable in transcripts and tests. */
export const formatStrategyHint = (next: NextStrategy): string => {
  switch (next) {
    case "scripted_replace":
      return `${STRATEGY_HINT_PREFIX} this file's context is unstable for patch (duplicate / ambiguous match) — consider \`scripted_replace\` (bulk substitution) or add disambiguating context. nextStrategy: scripted_replace`
    case "read_then_patch":
      return `${STRATEGY_HINT_PREFIX} the surrounding context appears to have drifted — read the current span first and re-patch with the fresh context. nextStrategy: read_then_patch`
    case "ambiguous":
      return `${STRATEGY_HINT_PREFIX} switch strategies instead of re-trying the same patch — either \`scripted_replace\` (bulk substitution) or read the file then re-patch with fresh context. nextStrategy: ambiguous`
  }
}
