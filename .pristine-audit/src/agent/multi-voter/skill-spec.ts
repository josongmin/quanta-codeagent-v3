/**
 * Per-surface verifier skill spec + generator stub (ADR-0433, Claude
 * `init-verifiers` parity). A `VerifierSkillSpec` describes a verifier skill
 * for ONE surface (cli / api / playwright) — the surface to drive, the
 * adversarial intent, and the votes-per-bug fan-out. The generator turns a
 * spec into a SKILL.md-shaped artefact; full skill-file emission is optional
 * and intentionally left as a stub (`generateVerifierSkill` returns the
 * markdown string; persisting it is a wiring step).
 */

/** Closed set of verifier surfaces. */
export type VerifierSurface = "cli" | "api" | "playwright"

export interface VerifierSkillSpec {
  /** Human name, e.g. "cli-login-flow". */
  readonly name: string
  readonly surface: VerifierSurface
  /** What the verifier must adversarially check (folded into the refute prompt). */
  readonly intent: string
  /** Votes per bug — the N independent voters this skill fans out to. Mirrors
   *  Claude `init-verifiers` VOTES_PER_BUG. */
  readonly votesPerBug: number
  /** Optional surface-specific entry hint (command / endpoint / URL). */
  readonly target?: string
  /** Optional diverse-lens labels (one per voter, cycled). */
  readonly lenses?: ReadonlyArray<string>
}

const SURFACE_HOWTO: Readonly<Record<VerifierSurface, string>> = Object.freeze({
  cli: "Drive the CLI surface (spawn the command, assert on exit code + stdout/stderr).",
  api: "Drive the API surface (issue the request, assert on status + response body).",
  playwright: "Drive the browser surface with Playwright (navigate, act, assert on DOM/visual).",
})

/** Generator stub — render a `VerifierSkillSpec` to a SKILL.md-shaped string.
 *  Pure; the caller decides whether/where to persist it. */
export const generateVerifierSkill = (spec: VerifierSkillSpec): string => {
  const lensLine = spec.lenses && spec.lenses.length > 0 ? spec.lenses.join(", ") : "(generic)"
  return [
    "---",
    `name: ${spec.name}`,
    `surface: ${spec.surface}`,
    `votes-per-bug: ${spec.votesPerBug}`,
    spec.target ? `target: ${spec.target}` : "target: (unset)",
    "---",
    "",
    `# Adversarial verifier — ${spec.name}`,
    "",
    `Surface: **${spec.surface}**. ${SURFACE_HOWTO[spec.surface]}`,
    "",
    `## Intent`,
    spec.intent,
    "",
    `## Protocol`,
    `Fan out to ${spec.votesPerBug} independent voter(s). Each voter REFUTES the`,
    `claim and defaults to FAIL under uncertainty. Aggregate by quorum.`,
    "",
    `Lenses: ${lensLine}`,
  ].join("\n")
}
