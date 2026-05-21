/**
 * Prefix-rule allowlist DSL — barrel.
 *
 * This slice is consumed by the admissibility-gate (per ADR-0031). Callers
 * SHOULD import from `./index` (or `@/rules` when the path alias is added)
 * and NOT reach into individual sub-modules — the barrel is the public
 * contract.
 */

export { matchCommand } from "./matcher"
export { parseRules } from "./parser"
export type { RulesSnapshot } from "./store"
export { RulesStore } from "./store"
export type { MatchOutcome, Rule, RuleAction, RuleLayer } from "./types"
export { RuleConflictError, RuleParseError } from "./types"
