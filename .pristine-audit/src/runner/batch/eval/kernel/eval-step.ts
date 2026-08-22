/**
 * SOTA architecture spine — Pillar B impl: the eval-CONCRETE pipeline context.
 *
 * `pipeline.ts` is the GENERIC kernel (`Step<C, G>` / `runPipeline`). This file
 * pins the two generic parameters for the bench eval:
 *
 *   - `C` = {@link EvalCtx} — the accumulating eval state bag the steps thread.
 *   - `G` = `BenchPosture`  — the resolved config the step gates read.
 *
 * `EvalStep = Step<EvalCtx, BenchPosture>` is therefore the SOLE shape every
 * migrated phase implements. The driver, once fully strangled, becomes a thin
 * `runPipeline(EVAL_STEPS, ctx0, posture)` that knows ZERO feature names — each
 * `if (posture.reproTest…)` moves INTO the corresponding step's `gate`.
 *
 * Why phase deps live ON the context (not imported by each step):
 *   The live phases (localize / repro generation / repair rounds) are composed
 *   inside the god-driver against its private closures (sandbox handles, the LLM
 *   port, exec, the agent-once runner). Re-importing them into a step would drag
 *   the whole god-module back in (circular) and re-name the features. Instead the
 *   driver INJECTS the already-bound phase callables into `EvalCtx.deps`; each
 *   step adapter just GATES + DELEGATES to `ctx.deps.<phase>`. This keeps the
 *   step modules feature-agnostic of HOW a phase is built, and lets the parity
 *   test swap the same `deps` slot for spies (proving order/gating, not re-running
 *   the real phases). The real wiring is a follow-up driver change — additive, so
 *   nothing here is referenced by the live driver yet.
 *
 * Loose typing is deliberate where the real type is the god-driver's private
 * shape: `sandbox` is the sandbox dir path (a string today), and `deps` members
 * are typed by their DELEGATION CONTRACT (the args/result the step forwards),
 * NOT by importing the driver's internal dep bundles. The one place a real type
 * is cheap — repair — uses the actual `runRepairRounds` arg/result types from the
 * leaf `../repair` slice (which has no god-driver dependency).
 */

import type { Instance } from "@/runner/batch/types"
import type { EnvPrepResult } from "../env-prep"
import type { BenchPosture } from "../knobs-bench"
import type { RunRepairRoundsArgs, RunRepairRoundsResult } from "../repair/types"
import type { Step } from "./pipeline"

/**
 * The localize phase delegate: rank the candidate fault files for the instance.
 * Typed by its delegation contract only (a thunk yielding ranked candidate file
 * paths) so a step never needs the driver's private localizer composition. The
 * real driver binds this over its LLM port + sandbox; the parity test binds a
 * spy. Returns the candidate paths the downstream phases consume.
 */
export type LocalizeDelegate = () => Promise<readonly string[]>

/**
 * The reproduction-test phase delegate: generate + select + (caller) install a
 * reproducer. Typed by its delegation contract (a thunk yielding the selected
 * reproducer source, or `undefined` when none reproduced). The real driver binds
 * this over `prepareReproTest`; the parity test binds a spy.
 */
export type ReproDelegate = () => Promise<string | undefined>

/**
 * The repair-rounds phase delegate. This IS `runRepairRounds` (or a binding of
 * it): the step forwards the already-composed args and folds the result. Typed
 * with the REAL repair arg/result so the delegation is exact — the repair slice
 * is a leaf (no god-driver import), so this stays circular-free.
 */
export type RepairDelegate = (args: RunRepairRoundsArgs) => Promise<RunRepairRoundsResult>

/**
 * The env-prep phase delegate. This IS `runEnvPrep` (or a binding of it): the
 * step forwards `(instance, sandbox, timeoutMs)` and folds the result. Typed by
 * the REAL `runEnvPrep` arg/result because `../env-prep` is a leaf slice (it
 * imports only `exec` + types, never the god-driver), so direct delegation stays
 * circular-free. Returns `{ok:true}` when there is no `setupCmd` OR setup exits 0
 * — the byte-identical no-op outcome — and `{ok:false, code, stderr}` on a
 * fail-fast env-prep failure the caller shapes into `env_prep_failed`.
 */
export type EnvPrepDelegate = (
  instance: Instance,
  sandbox: string,
  timeoutMs: number,
) => Promise<EnvPrepResult>

/**
 * The MAIN agent phase delegate (`runMainPhase` / `runAppMainPhase`). Typed by
 * its delegation contract ONLY — a thunk yielding the opaque driver `Phase`
 * (the agent's terminal phase outcome) — because the real main-phase fns are
 * module-private to the god-drivers and take their private `RunInstanceDeps` /
 * `Wiring` / `PreparedAttemptContext` shapes. The driver binds this over those
 * closures (exactly as it does `localize`); the parity test binds a spy. The
 * step never inspects the result beyond folding it, so the opaque `unknown`
 * payload is sufficient for the engine's gating/ordering contract.
 */
export type MainPhaseDelegate = () => Promise<unknown>

/**
 * The terminal-result validation delegate (`maybeValidateTerminalResult`). Typed
 * by its delegation contract: a thunk yielding the terminal `InstanceResult`, or
 * `undefined` when the phase has no terminal result to validate (the documented
 * no-op outcome). The driver binds this over its `maybeValidateTerminalResult`
 * call (which folds gold-validation + late-failure artifacts onto the result);
 * the parity test binds a spy. Opaque payload for the same reason as main-phase.
 */
export type TerminalValidateDelegate = () => Promise<unknown | undefined>

/**
 * The owner-widening repair-escalation followup delegate
 * (`maybeRunRepairEscalationFollowup`). Typed by its delegation contract: a
 * thunk yielding the followup outcome (`reran` + the widened owners + telemetry,
 * opaque here). The driver binds this over its `maybeRunRepairEscalationFollowup`
 * call (which re-prepares the attempt context against widened owners and re-runs
 * the phase); the parity test binds a spy. When the followup decides NOT to
 * widen (`reran:false`), the step returns ctx unchanged — byte-identical no-op.
 */
export type FollowupDelegate = () => Promise<FollowupOutcome>

/** The shape the followup step folds: only `reran` is load-bearing for the
 *  no-op invariant (false ⇒ ctx unchanged). The opaque payload carries the rest
 *  (widened owners / re-run phase / telemetry) the driver consumes downstream. */
export interface FollowupOutcome {
  readonly reran: boolean
  readonly payload?: unknown
}

/**
 * The injected phase callables. Populated by the driver (real bindings) or by a
 * test (spies). A step reads ONLY the delegate it owns. All optional: a pipeline
 * may include a step whose delegate the caller never bound — but a GATED-IN step
 * with no delegate is a wiring error the step surfaces (it must not silently
 * no-op a feature the posture turned ON). Delegates that ARE present but whose
 * phase is gated OFF are simply never called.
 */
export interface EvalPhaseDeps {
  readonly localize?: LocalizeDelegate
  readonly repro?: ReproDelegate
  readonly repair?: RepairDelegate
  /** The fully-composed `runRepairRounds` args the repair step forwards. Built by
   *  the driver from its private closures; absent ⇒ no repair work to forward. */
  readonly repairArgs?: RunRepairRoundsArgs
  /** The env-prep delegate (default the real `runEnvPrep` when unbound). */
  readonly envPrep?: EnvPrepDelegate
  /** The main agent phase delegate (`runMainPhase` / `runAppMainPhase`). */
  readonly mainPhase?: MainPhaseDelegate
  /** The terminal-result validation delegate (`maybeValidateTerminalResult`). */
  readonly terminalValidate?: TerminalValidateDelegate
  /** The owner-widening repair-escalation followup delegate. */
  readonly followup?: FollowupDelegate
}

/**
 * The accumulating eval state the steps fold forward. A step's `run` returns a
 * NEW ctx with its contribution merged into `state` (or the SAME ctx unchanged on
 * the not-applicable path, preserving the byte-identical no-op invariant). The
 * fields outside `state` are immutable inputs threaded for the steps to read.
 */
export interface EvalCtx {
  /** The instance under eval (real type — cheap, leaf import). */
  readonly instance: Instance
  /** Sandbox working dir (path). Loosely typed: the driver's richer sandbox
   *  handle is its private shape; steps only need the dir to forward. */
  readonly sandbox: string
  /** The injected phase delegates (see {@link EvalPhaseDeps}). */
  readonly deps: EvalPhaseDeps
  /** Cooperative cancellation, threaded to long phases. */
  readonly signal: AbortSignal
  /** Per-phase deadline (ms) the env-prep step forwards to its delegate. Loosely
   *  threaded as an input; absent ⇒ the env-prep step treats it as 0 (the
   *  delegate's `runEnvPrep` no-ops when the instance carries no `setupCmd`). */
  readonly timeoutMs?: number
  /** The accumulating per-phase output. Each step writes its slice; absent ⇒
   *  that phase did not run (gated OFF) or produced nothing. */
  readonly state: EvalState
}

/** The accumulating outputs of the migrated phases. Additive: each step owns one
 *  field and never reads another step's, so steps stay independent. */
export interface EvalState {
  /** Ranked candidate fault files from the localize step. */
  readonly localizeCandidates?: readonly string[]
  /** Selected reproducer source from the repro step (undefined ⇒ none reproduced). */
  readonly reproSource?: string
  /** The repair-rounds result from the repair step. */
  readonly repair?: RunRepairRoundsResult
  /** The env-prep result. Present once the env-prep step ran (always-on); its
   *  `ok:false` outcome is the fail-fast `env_prep_failed` signal the caller
   *  shapes — the step folds it but does NOT abort (the driver decides). */
  readonly envPrep?: EnvPrepResult
  /** The opaque MAIN agent phase outcome (driver `Phase`), folded by main-phase. */
  readonly mainPhase?: unknown
  /** The opaque terminal `InstanceResult` from terminal-validate (undefined ⇒
   *  the phase had no terminal result, the no-op outcome). */
  readonly terminalResult?: unknown
  /** The owner-widening followup outcome (undefined / `reran:false` ⇒ no widen). */
  readonly followup?: FollowupOutcome
}

/** The eval-concrete step alias every migrated phase implements. */
export type EvalStep = Step<EvalCtx, BenchPosture>

/** Fold a partial state patch onto a ctx, returning a NEW ctx. The single helper
 *  steps use so the merge semantics (shallow over `state`) are uniform. */
export const foldState = (ctx: EvalCtx, patch: Partial<EvalState>): EvalCtx => ({
  ...ctx,
  state: { ...ctx.state, ...patch },
})
