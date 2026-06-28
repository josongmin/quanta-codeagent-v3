/**
 * A2 — Typed ValidationDecision + adopt-clear SSOT (jun-28 oracle-first RFC).
 *
 * Two surfaces, kept STRICTLY separate (mixing them breaks byte-identical
 * default-OFF):
 *
 *  - `repairCandidateClears` — THE single live adopt/clear gate. Bit-identical
 *    to the pre-refactor `clearedAsValidated` (repair/index.ts). Every finish
 *    gate AND the breadth selector calls THIS one function (one SSOT, no drift).
 *    Default path (no rail, no strong-oracle) still clears an exit-0 agent-verify
 *    round, exactly as today.
 *
 *  - `decideAdoption` — OBSERVE-ONLY typed authority decision for report/
 *    telemetry. `adoptable` is fail-closed (canonical-sidecar resolved ONLY) but
 *    NOTHING in the orchestrator reads it: it never gates adopt/clear/select.
 *    Promoting `adoptable` to a live gate is a separate, measured RFC (B3).
 *
 * No-leak fence: imports ONLY `./types` + `./strong-oracle` (both local repair
 * helpers). `RepairCandidateKind` is re-declared locally — never imported from
 * `@/agent/repro-test` — so the structural fence (no `@/agent`, no hidden field)
 * holds. Pure + deterministic: no I/O, no clock/random.
 */

import { isStrongOracleFalseGreen } from "./strong-oracle"
import type { RunRepairRoundsArgs, ValidatorResult } from "./types"

/**
 * A round CLEARED on exit code yet its typed rail predicate was EVALUABLE and did
 * NOT match — the false green a predicate-aware gate catches. Fail-open: an
 * absent/unevaluable predicate is NOT a false green. SSOT shared with
 * repair/index.ts's false-green telemetry (one definition, no drift).
 */
export const isFalseGreen = (v: ValidatorResult): boolean =>
  v.ok && v.predicate?.evaluable === true && v.predicate.matched === false

/**
 * THE live adopt/clear gate (replaces `clearedAsValidated`). Bit-identical to the
 * legacy decision:
 *   - `!v.ok`                              ⇒ never clears.
 *   - strong-oracle ON + false green       ⇒ withholds (precision-raising).
 *   - no primary rail                       ⇒ `v.ok` clears (legacy default-OFF).
 *   - primary rail set + false green        ⇒ withholds (rail unproven).
 * Each strengthening can ONLY withhold a clear the legacy gate would grant
 * (monotone). Keep in sync with the closure primary-rail finish decider.
 */
export const repairCandidateClears = (args: RunRepairRoundsArgs, v: ValidatorResult): boolean => {
  if (!v.ok) return false
  if (args.config.strongOracle === true && isStrongOracleFalseGreen(v)) return false
  if (args.primaryRailStep === undefined) return true
  return !isFalseGreen(v)
}

// ── observe-only typed decision ──────────────────────────────────────────────

/**
 * Where the adopt verdict's AUTHORITY came from. Only `canonical-sidecar` can be
 * adoptable; everything else is non-authoritative or verification-impossible.
 */
export type ValidatorAuthority =
  | "canonical-sidecar"
  | "agent-verify-cmd"
  | "advisory-hardening"
  | "missing"
  | "execution-failed"
  | "inconclusive"

/** Locally re-declared (fence: NO `@/agent/repro-test` import). Mirrors
 *  `ReproTestKind` — the canonical/hardening split. */
export type RepairCandidateKind = "canonical" | "hardening"

/** Context the validator result alone cannot supply: the SOURCE of the gate.
 *  `ValidatorResult` carries `ok`/`reproOutcome`/`consensus` but NOT "was this a
 *  controlled sidecar vs an agent verify-cmd vs a hardening repro" — that lives
 *  at the ValidateArgs/validationSource level (repair/index.ts). Without it,
 *  `missing` (canonical expected, none reproduced) cannot be told apart from
 *  `agent-verify-cmd` (no oracle requested). */
export interface ValidationDecisionContext {
  /** Which gate the round ran (primary_rail | verify_cmd | repro | none). */
  validationSource: "primary_rail" | "verify_cmd" | "repro" | "none"
  /** The gate was decided by the controlled pytest sidecar (repro authority). */
  reproAuthority: boolean
  /** When the gated repro carried a kind, the canonical/hardening tag. */
  kind?: RepairCandidateKind
}

/** OBSERVE-ONLY typed adopt decision. `adoptable` NEVER gates the loop in A2. */
export interface ValidationDecision {
  authority: ValidatorAuthority
  /** true = canonical sidecar says resolved; false = still reproduces; null =
   *  verification impossible (missing / exec-failed / inconclusive / no oracle). */
  issueResolved: boolean | null
  /** true = a regression rail went red; false = observed clean; null = unobserved
   *  inside the no-leak fence (the regression baseline is hidden). null fails OPEN. */
  regressionFailed: boolean | null
  adoptable: boolean
  reason: string
}

const sidecarResolved = (v: ValidatorResult): boolean =>
  v.consensus === "resolved" || v.reproOutcome === "resolved"
const sidecarReproduced = (v: ValidatorResult): boolean =>
  v.consensus === "reproduced" || v.reproOutcome === "reproduced"

const mk = (
  authority: ValidatorAuthority,
  issueResolved: boolean | null,
  regressionFailed: boolean | null,
  adoptable: boolean,
  reason: string,
): ValidationDecision => ({ authority, issueResolved, regressionFailed, adoptable, reason })

/** Sidecar-authority branch: the controlled pytest sidecar (repro authority)
 *  decided this round. Split out of {@link decideAdoption} so each stays simple. */
const decideSidecar = (
  v: ValidatorResult,
  regressionFailed: boolean | null,
): ValidationDecision => {
  // exec crash is verification-IMPOSSIBLE, not candidate-wrong (ranked first so an
  // all-crashed inconclusive vote reads as execution-failed).
  if (v.reproOutcome === "exec_failed") {
    return mk(
      "execution-failed",
      null,
      regressionFailed,
      false,
      "repro execution failed — verification impossible",
    )
  }
  if (v.consensus === "inconclusive") {
    return mk(
      "inconclusive",
      null,
      regressionFailed,
      false,
      "repro vote inconclusive — no decisive consensus",
    )
  }
  if (sidecarResolved(v)) {
    const adoptable = regressionFailed !== true
    return mk(
      "canonical-sidecar",
      true,
      regressionFailed,
      adoptable,
      adoptable ? "canonical sidecar resolved" : "canonical resolved but regression failed",
    )
  }
  if (sidecarReproduced(v)) {
    return mk(
      "canonical-sidecar",
      false,
      regressionFailed,
      false,
      "canonical sidecar still reproduces the bug",
    )
  }
  // sidecar authority but no decisive signal (empty sources / unknown).
  return mk("missing", null, regressionFailed, false, "no decisive canonical sidecar signal")
}

/**
 * Fold a `ValidatorResult` + source context into the typed authority decision.
 *
 * Regression is UNOBSERVED inside the fence (no hidden regression baseline) ⇒ `regressionFailed`
 * is `null` (fail-open). `adoptable` is therefore `canonical-sidecar` authority
 * AND `issueResolved === true` AND not a known regression — i.e. exactly the
 * canonical-resolved rows.
 */
export const decideAdoption = (
  v: ValidatorResult,
  ctx: ValidationDecisionContext,
): ValidationDecision => {
  const regressionFailed: boolean | null = null

  // Hardening is advisory by construction — NEVER an adopt authority, even green.
  if (ctx.kind === "hardening") {
    const resolved = sidecarResolved(v) ? true : sidecarReproduced(v) ? false : null
    return mk(
      "advisory-hardening",
      resolved,
      regressionFailed,
      false,
      "hardening repro is advisory-only; never an adopt gate",
    )
  }

  // The controlled pytest sidecar decided this round (repro authority).
  if (ctx.reproAuthority === true || ctx.validationSource === "repro") {
    return decideSidecar(v, regressionFailed)
  }

  if (ctx.validationSource === "verify_cmd") {
    // Legacy exit-code verify command. NOT canonical sidecar authority ⇒ never
    // adoptable under the oracle-first gate (it may still clear the live gate).
    return mk(
      "agent-verify-cmd",
      v.ok,
      regressionFailed,
      false,
      "agent verify-cmd exit code — not canonical sidecar authority",
    )
  }

  // validationSource "none" / non-repro primary rail / anything else: no oracle.
  return mk("missing", null, regressionFailed, false, "no repro oracle available")
}
