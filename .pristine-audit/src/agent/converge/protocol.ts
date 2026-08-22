/**
 * `@/agent/converge/protocol` — the SSOT abstraction of "converge-to-green".
 *
 * jul-3 architecture audit: the terminal oracle-loop and the bench repair-rounds looked like two
 * different algorithms, but their BOUNDED-CONVERGENCE ESSENCE is one four-hook protocol:
 *
 *     generate(feedback) → judge() → verdict.green ? stop(converged)
 *                                  : feedback(verdict) → next generate      (+ over-persist bounds)
 *
 *   TERMINAL instance:  generate = one follow-up turn      judge = inspectSelfTest (re-read trajectory)
 *                       feedback = the agent's own self-test failure text  (carry = message log)
 *   BENCH  instance:    generate = one agent run (+select) judge = validate (repro-vote / primary-rail)
 *                       feedback = buildContext(prev diff + fail evidence)  (carry = cumulative patch)
 *
 * This file owns ONLY the surface-neutral policy: the loop skeleton + the two independent over-persist
 * bounds (`maxRounds` AND a turn-budget watchdog — the R2 revert lesson) + the honest stop `reason`.
 * The verdict/feedback/generate are PORTS, so each surface supplies its own regime without the core
 * ever learning surface vocabulary (no patch/pytest and no trajectory/self-test in THIS file).
 *
 * NO-LEAK BY CONTRACT: `feedback` returns a string built ONLY from the agent's own output; the port
 * types expose no gold/hidden-test field, so the loop physically cannot read a hidden oracle.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * BENCH-ADOPTION MAPPING (the bench repair-rounds is the SAME protocol; its body is NOT ported here —
 * jul-3 comparative audit: bench repro efficacy is UNMEASURED and its env corpus is the top regression
 * risk, so the actual code migration waits behind a bench A/B gate. This mapping is the design SSOT
 * the migration will follow; the three regression flags below MUST survive it):
 *   generate ≙ RunRepairRoundsArgs.runOnce (+ runCandidates/selectCandidates for the breadth fan-out —
 *              breadth is a GENERATE extension, not a different algorithm);
 *   judge    ≙ RunRepairRoundsArgs.validate (the false-green/false-red telemetry is a JUDGE by-product);
 *   feedback ≙ RunRepairRoundsArgs.buildContext (prev diff + validator failure evidence);
 *   bounds   ≙ config.maxRounds (bench has no turn-watchdog today — grafting one STRENGTHENS it).
 *   1. bench ENV/EXECUTION corpus (withGitSnapshot / specEra / -rA / P2P / git-config / cache-pathspec)
 *      is ADAPTER-OWNED — never folded into this neutral policy.
 *   2. bench repro-VOTE's ≈0 false-red/green is a MEASUREMENT CONTRACT, not this loop's `reason`.
 *   3. the convergence SIGNAL stays a PORT (terminal self-test vs bench repro-vote) — never hardcoded.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * PURE over its ports (no IO of its own; the only await is the injected `generate`).
 */

/** A surface's verdict on the CURRENT state. `green` = converged (stop, success). `actionable` = a
 *  fair fail signal CAN be produced (terminal: a self-test executed; bench: the validator ran) — when
 *  false there is nothing to converge and the loop stops with `no-signal`. Surfaces extend this with
 *  their own fields (the terminal verdict also carries the self-test receipt for `feedback`). */
export interface ConvergeVerdict {
  readonly green: boolean
  readonly actionable: boolean
}

/** The two independent over-persist bounds. */
export interface ConvergeBounds {
  /** Hard round cap (the caller clamps this, e.g. K∈[1,4]). */
  readonly maxRounds: number
  /** Turn-budget watchdog — the loop never spends past this cumulative turn count. */
  readonly maxTurns: number
}

/** Why the loop stopped — honest cost accounting (never conflate "converged" with "out of budget"). */
export type ConvergeReason = "green" | "rounds-exhausted" | "watchdog" | "no-signal"

/** The four-hook convergence protocol. `V` is the surface verdict; `C` is the surface's carried state
 *  (terminal = message log; bench = cumulative patch) threaded through and returned. */
export interface ConvergeProtocol<V extends ConvergeVerdict, C> {
  /** Judge the CURRENT state (terminal: re-inspect the trajectory; bench: the last validator verdict). */
  readonly judge: () => V
  /** Build the fair fail feedback from a non-green verdict, or null when nothing fair to feed back. */
  readonly feedback: (verdict: V) => { readonly feedback: string } | null
  /** Run ONE generation step with the feedback; returns the turns it spent + the new carried state. */
  readonly generate: (feedback: string) => Promise<{ readonly turns: number; readonly carry: C }>
}

export interface ConvergeOutcome<C> {
  /** True iff the FINAL verdict is green (converged). */
  readonly converged: boolean
  /** How many generation rounds actually ran. */
  readonly rounds: number
  /** Cumulative turns after the loop (starting count + the loop's generations). */
  readonly turnsConsumed: number
  /** The (possibly-updated) carried state after the loop. */
  readonly carry: C
  /** Which bound / condition stopped the loop. */
  readonly reason: ConvergeReason
}

/**
 * Run the bounded converge-to-green protocol. PURE over `proto`. Stops on the FIRST of:
 *   - `judge().green` (converged) → `reason: "green"`;
 *   - `!judge().actionable`, or `feedback()` returns null (nothing to converge) → `"no-signal"`;
 *   - the turn-budget watchdog trips → `"watchdog"`;
 *   - `maxRounds` generations ran → `"rounds-exhausted"` (the default if no earlier stop fired).
 */
export const runConvergeProtocol = async <V extends ConvergeVerdict, C>(
  proto: ConvergeProtocol<V, C>,
  bounds: ConvergeBounds,
  init: { readonly turnsConsumed: number; readonly carry: C },
): Promise<ConvergeOutcome<C>> => {
  let turnsConsumed = init.turnsConsumed
  let carry = init.carry
  let rounds = 0
  // Default: the loop ran its full round budget without an earlier stop. Overwritten by any break.
  let reason: ConvergeReason = "rounds-exhausted"
  while (rounds < bounds.maxRounds) {
    const verdict = proto.judge()
    // Nothing to converge: the surface produced no actionable signal (terminal: no self-test ran).
    if (!verdict.actionable) {
      reason = "no-signal"
      break
    }
    if (verdict.green) {
      reason = "green"
      break
    }
    // Watchdog: never spend past the turn budget (structural over-persist bound, independent of rounds).
    if (turnsConsumed >= bounds.maxTurns) {
      reason = "watchdog"
      break
    }
    const ff = proto.feedback(verdict)
    if (ff === null) {
      // Actionable but no fair signal to feed back — never loop blind.
      reason = "no-signal"
      break
    }
    const step = await proto.generate(ff.feedback)
    turnsConsumed += step.turns
    carry = step.carry
    rounds += 1
  }
  // ALBB-21 — derive BOTH `converged` and `reason` from the ONE terminal judge.
  // A RED→green repair on the LAST allowed round exits via the `while` bound
  // (`rounds < maxRounds` false) BEFORE the in-loop `verdict.green` break can
  // fire, so the loop-body `reason` is stale ("rounds-exhausted") even though
  // the final judge is green. Reading both from `finalGreen` makes it impossible
  // to telemetry a converged run as "out of budget"; the not-green paths keep
  // the loop's honest `watchdog`/`no-signal`/`rounds-exhausted` reason.
  const finalGreen = proto.judge().green
  return {
    converged: finalGreen,
    rounds,
    turnsConsumed,
    carry,
    reason: finalGreen ? "green" : reason,
  }
}
