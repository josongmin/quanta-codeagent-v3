/**
 * Core tool-use rules — DERIVED from the ADR-0538 instruction-graph atoms.
 *
 * The frozen / owned / default rule sets are no longer three hand-maintained
 * lists whose membership decides applicability. Their SSOT is now the declarative
 * atom graph in `../prompt-graph/atoms.ts`: each rule is an `InstructionAtom`
 * with a `when.envPosture` matcher and (for the owned/default env variants) a
 * `supersedes` edge over the frozen variant. This file DERIVES the legacy
 * `PromptRule[]` shapes (`CORE_RULES` / `OWNED_RULES` / `DEFAULT_BASE`) by
 * selecting the applicable atoms per posture via `matches()` — so the roster,
 * order and text are a projection of the graph, not a parallel source.
 *
 * Why keep the `PromptRule` exports at all: several anti-regression tests pin the
 * frozen/owned/default rosters + object-reference sharing of the universal rails.
 * Deriving them from atoms (memoized so a shared atom yields ONE PromptRule
 * object reused across postures) keeps those invariants exact while the atom
 * graph — not this file — is where applicability lives.
 *
 * NOT externalized (by design): rules are the agent's safety/honesty contract;
 * editing them means editing the atom graph + updating the snapshot tests.
 */

import type { InstructionAtom, PromptContext } from "../prompt-graph"
import { POSTURE_ATOMS, PROMPT_CTX_DEFAULTS, selectAtoms } from "../prompt-graph"

export interface PromptRule {
  /** Stable ID embedded inline (`[R-…]`) — anti-regression tests pin this. */
  readonly id: string
  /** Pre-wrapped lines that render as the existing bullet block. */
  readonly lines: readonly string[]
}

/** Base ctx skeleton — only `envPosture` varies for the posture-base projection;
 *  no posture atom conditions on the other axes, so they hold representative
 *  values (see prompt-graph/contexts.ts for the full reachable enumeration). */
const posCtx = (envPosture: PromptContext["envPosture"]): PromptContext => ({
  ...PROMPT_CTX_DEFAULTS,
  envPosture,
  verifyStrategy: undefined,
})

/**
 * Memoized atom → PromptRule projection. One PromptRule per variantId, reused
 * across postures — so a shared universal rail (same atom in frozen/owned/default)
 * yields the SAME object reference in every derived list (the `ownedObj === coreObj`
 * invariant), while a per-posture variant (frozen vs owned R-NO-SHIM) yields
 * distinct objects (the `ownedShim !== frozenShim` invariant). The rendered `id`
 * is the `[R-…]` TAG parsed from the atom's first line (the display id the model
 * sees) — for env variants that differs from the semantic `atomId` used for
 * supersede grouping (atomId `R-ENV`; owned variant tag `R-ENV-OWNED`). */
const RULE_CACHE = new Map<string, PromptRule>()
/** Extract the `[R-…]` tag from a rule's first line (the anti-regression id). */
const tagOf = (a: InstructionAtom): string => {
  const m = a.lines[0]?.match(/^- \[([^\]]+)\]/)
  if (m === null || m === undefined) {
    throw new Error(`atom ${a.variantId} first line has no [TAG]: ${String(a.lines[0])}`)
  }
  return m[1] as string
}
const toRule = (a: InstructionAtom): PromptRule => {
  const cached = RULE_CACHE.get(a.variantId)
  if (cached !== undefined) return cached
  const rule: PromptRule = { id: tagOf(a), lines: a.lines }
  RULE_CACHE.set(a.variantId, rule)
  return rule
}

/** Derive a posture's PromptRule roster by selecting the applicable atoms
 *  (matcher + supersede resolution + ordering) from the graph. */
const rulesForPosture = (envPosture: PromptContext["envPosture"]): readonly PromptRule[] =>
  selectAtoms(POSTURE_ATOMS, posCtx(envPosture)).map(toRule)

/** The frozen tool-use rules (SWE-bench guardrails, today's default). Derived
 *  from the atom graph — the frozen-posture projection of POSTURE_ATOMS. */
export const CORE_RULES: readonly PromptRule[] = rulesForPosture("frozen")

/** The `owned` posture rule list (TB21-06 TC-6) — install-permitted,
 *  a working env is the graded deliverable. Derived: the owned-posture projection.
 *  Universal rails are the SAME objects as in {@link CORE_RULES}; the env atoms
 *  (R-ENV-OWNED / R-INSTALL-THRASH / R-ENV-DONE) + the owned R-NO-SHIM variant
 *  supersede the frozen env atoms. */
export const OWNED_RULES: readonly PromptRule[] = rulesForPosture("owned")

/** The `default` posture rule list (jul-9 `QUANTA_ENV_DEFAULT`) — install-permitted
 *  local-dev machine, NOT graded. Derived: the default-posture projection (shared
 *  rails + owned R-NO-SHIM variant + R-ENV-LOCAL, no frozen install-prohibition,
 *  no owned grading framing). */
export const DEFAULT_BASE: readonly PromptRule[] = rulesForPosture("default")
