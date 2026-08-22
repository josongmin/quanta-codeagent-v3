/**
 * ADR-0221 — Git directive types (`::git-*` 5-directive emit protocol).
 *
 * Sibling to ADR-0220 (wire/serdes layer at `src/agent/git-directives/`).
 * This slice is the BEHAVIORAL-protocol layer: it adds a phase guard so
 * mutating git tool handlers can only emit directives in the `final-answer`
 * phase — never in `commentary` / `intermediate` phases — matching Codex's
 * `::git-*` emission discipline (after successful mutation, final phase only).
 *
 * The directive shape here is intentionally distinct from ADR-0220's wire
 * shape (e.g. `push.ref/force`, `stage.files`) because this slice models the
 * *call-site* intent (the tool that just succeeded), not the *UI-tail* shape.
 * Conversion to the wire form (if a host wants stderr emission) is the
 * caller's responsibility (`@/agent/git-directives` provides the serializer).
 */

/** Discriminated union of the 5 supported git directives. */
export type GitDirective =
  | { readonly kind: "create-branch"; readonly name: string }
  | { readonly kind: "stage"; readonly files: readonly string[] }
  | { readonly kind: "commit"; readonly sha: string; readonly message: string }
  | { readonly kind: "push"; readonly ref: string; readonly force: boolean }
  | { readonly kind: "create-pr"; readonly url: string; readonly isDraft: boolean }

/** Closed enum of directive kinds (matches the user-facing protocol prefix). */
export const GIT_DIRECTIVE_KINDS = [
  "create-branch",
  "stage",
  "commit",
  "push",
  "create-pr",
] as const

export type GitDirectiveKind = (typeof GIT_DIRECTIVE_KINDS)[number]

/**
 * LLM/agent phase at the moment of emission attempt.
 *
 * - `final-answer`: the only phase where directives are accepted. Maps to
 *   Codex's `final_answer` boundary — the tool mutation has succeeded and
 *   the model is committing to the user-visible reply.
 * - `commentary`: side-channel commentary stream. MUST NOT emit (would
 *   leak ahead of confirmed final commit).
 * - `intermediate`: in-loop scratchpad / tool-result interleave. MUST NOT
 *   emit (mutation may still be rolled back by a later step).
 */
export type EmitPhase = "final-answer" | "commentary" | "intermediate"

/** Typed error returned by `emit` — no-throw public surface. */
export type EmitError =
  | { readonly kind: "wrong-phase"; readonly phase: Exclude<EmitPhase, "final-answer"> }
  | { readonly kind: "invalid-directive"; readonly reason: string }
