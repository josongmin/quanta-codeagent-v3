/**
 * jun-28 STRONG-ORACLE repair-clear gate (knob QUANTA_BENCH_REPAIR_STRONG_ORACLE).
 *
 * THE PROBLEM (audited root cause): the repair loop clears (declares success,
 * stops) the moment the agent's OWN self-generated repro goes GREEN. That oracle
 * is too LENIENT — an over-narrow patch that handles only the issue's happy-path
 * example passes the weak repro (a false green at round 0) while the hidden
 * general-behavior test (which exercises the GENERAL behavior) stays red.
 * closure-repair ties its baseline because of this oracle-adequacy weakness.
 *
 * THE FIX: when the strong-oracle knob is ON, a round clears ONLY when the
 * candidate passes a CONJUNCTION of the AVAILABLE strong, no-leak signals — not
 * the lenient single self-repro green. A round whose self-repro is green but ANY
 * available strong signal is RED is treated as a FALSE GREEN ⇒ does NOT clear ⇒
 * the loop iterates toward a general fix.
 *
 * The conjuncts (each fail-OPEN when its signal is unavailable, so a correct patch
 * is never falsely blocked):
 *   1. base-discrimination — already required: `v.ok` is only true when the
 *      validator's rail was RED on base and GREEN on the patch. This module never
 *      relaxes it (a non-ok round can never clear).
 *   2. declared-expected match (lever #2) — the patch output matches the PUBLIC
 *      issue-declared expected, surfaced as `v.predicate` (evaluable + matched).
 *      A green round whose typed-rail predicate is evaluable AND did NOT match is
 *      the over-narrow false green; ABSENT/unevaluable predicate ⇒ fail-open.
 *   3. repro-vote consensus — when the K-of-N repro-vote ran, `v.consensus`
 *      carries the RESOLVED-side verdict over independently-phrased repros. A
 *      minority-green (the vote did NOT reach a `resolved` consensus) is treated
 *      as a false green; a single repro / no vote ⇒ `v.consensus` absent ⇒
 *      fail-open.
 *
 * NO-LEAK: this module imports ONLY `./types` (the structural repair fence — it
 * cannot name the dataset hidden-test / gold fields or the official report). Every
 * conjunct reads ONLY fields already on `ValidatorResult`, each derived upstream from
 * PUBLIC inputs (issue text / agent-side repros). The repair-validator no-leak
 * FENCE test (tests/unit/repair-validator.test.ts) allow-lists this import.
 *
 * Pure + deterministic: no I/O, no clock/random.
 */

import type { ReproConsensusVerdict, ValidatorResult } from "./types"

/** Declared-expected (lever #2) conjunct verdict. A green round whose typed-rail
 *  predicate is EVALUABLE but did NOT match is the over-narrow false green. An
 *  absent / unevaluable predicate FAILS OPEN (never a false penalty). This is the
 *  SAME shape as `isFalseGreen` in index.ts, factored here so the strong-oracle
 *  conjunction reuses one definition. */
const declaredExpectedRed = (v: ValidatorResult): boolean =>
  v.predicate?.evaluable === true && v.predicate.matched === false

/** Repro-vote consensus conjunct verdict. When the K-of-N vote ran (`consensus`
 *  present), only a `resolved` verdict is consistent with a CLEAR; a `reproduced`
 *  or `inconclusive` consensus on an exit-code-green round is a minority-green
 *  false green. ABSENT consensus (single repro / vote did not run) FAILS OPEN. */
const consensusRed = (v: ValidatorResult): boolean =>
  v.consensus !== undefined && v.consensus !== "resolved"

/**
 * Is an exit-code-GREEN round a STRONG-ORACLE false green? True iff ANY available
 * strong signal is RED (declared-expected mismatch OR a non-resolved repro-vote
 * consensus). All conjuncts fail-OPEN on absence, so this is `false` exactly when
 * the legacy lenient gate would clear AND no available strong signal contradicts
 * it. Caller must have already checked `v.ok` (a non-ok round never reaches here).
 */
export const isStrongOracleFalseGreen = (v: ValidatorResult): boolean =>
  declaredExpectedRed(v) || consensusRed(v)

/**
 * STRONG-ORACLE clear decision for one exit-code-green round.
 *
 * Returns whether the round may clear as VALIDATED under the strengthened gate:
 * `v.ok` AND none of the available strong signals is red. The caller composes
 * this with the existing primary-rail finish gate (`clearedAsValidated`) so the
 * strong-oracle gate can only ever WITHHOLD a clear the legacy gate would grant —
 * never grant one it would withhold (precision-raising, monotone).
 */
export const clearedUnderStrongOracle = (v: ValidatorResult): boolean =>
  v.ok && !isStrongOracleFalseGreen(v)

/** Narrow re-export so a consumer can name the consensus verdict type without
 *  reaching past the repair fence into `@/agent/repro-test`. */
export type { ReproConsensusVerdict }
