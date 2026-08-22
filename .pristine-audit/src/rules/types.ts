/**
 * Prefix-rule allowlist DSL — types (SSOT for the rules slice).
 *
 * Inspired by Codex's `~/.codex/rules/default.rules` (1060 `allow` prefix
 * rules, 100% allow, default-deny). We extend Codex's model along three
 * deliberate axes:
 *
 * 1. `deny` rule support — Codex is allow-only; we allow explicit blocking
 *    so security policies can be expressed positively.
 * 2. `ask` action — escalates to the ADR-0029 reviewer 3-tier system instead
 *    of auto-allowing or auto-denying.
 * 3. 3-layer (system / user / project) precedence — project > user > system,
 *    with longest-prefix-match WITHIN a layer. Codex is single-file; we
 *    separate layers so vendor / operator / repo policy compose cleanly.
 *
 * Determinism contract: this module has no I/O, no randomness, no clocks,
 * and no heuristics. All decisions are total functions of (rules, command).
 * Errors are named (`RuleParseError`, `RuleConflictError`) — never silent
 * fallthrough, never best-effort recovery (RFC §"no fallback").
 */

/** Closed enum of admissibility verdicts a rule can encode.
 *
 *  - `allow` — admit the command, no further review.
 *  - `deny`  — reject the command outright (terminal).
 *  - `ask`   — escalate to the ADR-0029 reviewer (HITL or guardian subagent).
 *
 *  Any other token in the DSL source produces `RuleParseError` — there is no
 *  "default" or fallback action. */
export type RuleAction = "allow" | "deny" | "ask"

/** Closed enum of provenance layers. Precedence at match time is
 *  `project > user > system`; this is enforced explicitly by `RulesStore`
 *  (no heuristic, no implicit ordering). */
export type RuleLayer = "system" | "user" | "project"

/** A single parsed rule. Immutable by convention — callers MUST NOT mutate
 *  fields after parsing (the parser freezes return arrays). */
export interface Rule {
  readonly action: RuleAction
  /** The verbatim command prefix the rule matches against, with leading and
   *  trailing whitespace stripped but internal whitespace preserved.
   *  Guaranteed non-empty by the parser. For an argv-array rule (see
   *  {@link argv}) this mirrors the joined token vector so existing
   *  diagnostics / ruleId derivation keep working unchanged. */
  readonly prefix: string
  /**
   * §10.2 — Codex `prefix_rule(pattern=[...])` parity. When present, the
   * matcher uses TOKEN-PREFIX matching over the command's argv vector
   * (each pattern token must equal the corresponding command token; the last
   * token may end with `*` as a literal-prefix glob) instead of byte-prefix
   * matching on {@link prefix}. ABSENT for every legacy string-prefix rule
   * (no bracketed `[...]` in the source) ⇒ byte-identical legacy matching.
   * The parser populates this ONLY for bracketed token-array lines.
   */
  readonly argv?: readonly string[]
  readonly layer: RuleLayer
  /** 1-indexed line number in `sourceFile` where the rule was defined.
   *  Used for diagnostics (e.g. `RuleParseError.lineNumber`). */
  readonly sourceLine: number
  /** Free-form identifier of the source (file path, logical name, etc.).
   *  Surfaced in error messages so callers can locate offending lines. */
  readonly sourceFile: string
}

/** Result of `matchCommand` / `RulesStore.match`. `no_match` is NOT an error
 *  — it signals "no rule fired"; the caller (admissibility-gate, per
 *  ADR-0031) decides whether to default-deny or fall through to the
 *  reviewer prompt. */
export type MatchOutcome =
  | { readonly kind: "matched"; readonly rule: Rule }
  | { readonly kind: "no_match" }

/** Parser-level error. Raised on malformed lines and on conflicting actions
 *  for the same prefix within a single layer. NEVER silently dropped. */
export class RuleParseError extends Error {
  public readonly sourceFile: string
  public readonly lineNumber: number

  public constructor(message: string, sourceFile: string, lineNumber: number) {
    super(`${sourceFile}:${lineNumber}: ${message}`)
    this.name = "RuleParseError"
    this.sourceFile = sourceFile
    this.lineNumber = lineNumber
  }
}

/** Cross-layer / merge-time conflict. Reserved for future multi-source
 *  ingestion that wants to surface the conflicting rules to the caller
 *  rather than silently picking a winner. The matcher itself uses explicit
 *  precedence (layer + longest-prefix) and does NOT raise this — but
 *  callers ingesting external rule bundles may want to.
 *
 *  The `conflicts` array is informational; carrying it preserves the
 *  caller's ability to render a remediation message without re-parsing. */
export class RuleConflictError extends Error {
  public readonly conflicts: readonly Rule[]

  public constructor(message: string, conflicts: readonly Rule[]) {
    super(message)
    this.name = "RuleConflictError"
    this.conflicts = conflicts
  }
}
