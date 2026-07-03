/**
 * `@/agent/converge/loop` — the SURFACE-NEUTRAL bounded converge-to-green policy.
 *
 * WHAT. While a FAIR fail signal says the deliverable is not yet green, feed the failure back as a
 * follow-up turn and let the agent re-edit + re-run — until green OR a hard bound is hit. This is the
 * "oracle-repair loop" hoisted out of the terminal brain (jul-3 architecture audit found it was one
 * of THREE independent "converge-to-green" implementations). It is a PURE policy over injected ports,
 * so any surface (terminal container_exec, or a future bench adapter) instantiates the SAME loop and
 * only differs in how it runs a turn / constructs its fair fail signal.
 *
 * STRUCTURAL OVER-PERSIST BOUNDS (the R2 revert lesson — a blanket "keep going" steer 3×-over-persisted
 * and was reverted): TWO independent bounds — at most `maxRounds` (clamped by the caller) AND a
 * turn-budget watchdog (never spends past `maxTurns`). A `reason` records WHICH bound stopped it
 * (B's honest cost accounting), so telemetry never conflates "converged" with "ran out of budget".
 *
 * NO-LEAK BY CONTRACT: the loop reads NO hidden oracle. Its only inputs are the injected `inspect()`
 * (the surface's own taint-clean receipt) and `fairFail()` (a feedback string built ONLY from the
 * agent's own output). The port TYPES expose no gold/hidden-test field — the loop physically cannot
 * ask for one (the same type-level no-leak posture as the bench repair contract).
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 * BENCH-ADOPTION NOTES (jul-3 comparative audit — do NOT regress when a bench adapter lands later):
 *  1. The bench ENV/EXECUTION corpus (withGitSnapshot / specEra dep-pins / pytest `-rA` / P2P
 *     truncated-id / git-config identity / cache-pathspec pruning) is ADAPTER-OWNED. It is real-world
 *     execution noise-handling, NOT generalizable policy — it must stay behind the bench ExecPort and
 *     NEVER be folded into this neutral loop.
 *  2. Bench's repro-VOTE sets false-red/green ≈0 BY CONSTRUCTION — that is a measurement contract, not
 *     a bug. A bench `fairFail` adapter must keep its own telemetry names; do not reuse this loop's
 *     `reason` as if it were a false-red rate.
 *  3. The convergence SIGNAL is surface-specific and must stay a PORT: terminal = agent-authored
 *     self-test (the only legal signal when the hidden verifier is off-limits); bench = driver-
 *     orchestrated repro-vote (stronger, needs a fair fail constructible from public inputs). Do NOT
 *     hardcode either — forcing one surface through the other's regime regresses it.
 * ─────────────────────────────────────────────────────────────────────────────────────────────────
 *
 * PURE over its ports (no IO of its own; the only await is the injected `runFollowUpTurn`).
 */

import type { Message } from "@/llm"
import type { SelfTestReceipt } from "./self-test"

/** A FAIR fail signal source — the pluggable convergence regime. Given the current receipt, either a
 *  feedback string to feed back (built ONLY from the agent's own output — NO hidden oracle), or null
 *  when there is nothing fair to say (stop). Terminal binds this to the agent's own self-test failure;
 *  a bench adapter would bind it to a driver-orchestrated repro-vote. */
export type FairFailSource = (receipt: SelfTestReceipt) => { readonly feedback: string } | null

/** The injected ports the loop drives. No gold/hidden field by construction (type-level no-leak). */
export interface ConvergePorts {
  /** The surface's own taint-clean receipt over the CURRENT trajectory (re-read each round). */
  readonly inspect: () => SelfTestReceipt
  /** The pluggable fair fail signal (see {@link FairFailSource}). */
  readonly fairFail: FairFailSource
  /** Run one follow-up turn with `text`; returns the turns it consumed + the new message log. */
  readonly runFollowUpTurn: (
    text: string,
  ) => Promise<{ readonly turns: number; readonly messages: readonly Message[] }>
}

/** The two independent over-persist bounds. */
export interface ConvergeBounds {
  /** Hard round cap (the caller clamps this, e.g. K∈[1,4]). */
  readonly maxRounds: number
  /** Turn-budget watchdog — the loop never spends past this cumulative turn count. */
  readonly maxTurns: number
}

/** Why the loop stopped — B's honest cost accounting (never conflate "converged" with "out of budget"). */
export type ConvergeReason = "green" | "rounds-exhausted" | "watchdog" | "no-signal"

export interface ConvergeResult {
  /** True iff the FINAL receipt is green (the deliverable converged). */
  readonly converged: boolean
  /** How many follow-up rounds actually ran. */
  readonly rounds: number
  /** Cumulative turns after the loop (the caller's starting count + the loop's follow-ups). */
  readonly turnsConsumed: number
  /** The (possibly-updated) message log after the loop. */
  readonly messages: readonly Message[]
  /** Which bound / condition stopped the loop. */
  readonly reason: ConvergeReason
}

/**
 * Run the bounded converge-to-green loop. PURE over `ports`. Stops on the FIRST of:
 *   - the receipt is green (converged) → `reason: "green"`;
 *   - no self-test executed, or the fair-fail source returns null (nothing to converge) → `"no-signal"`;
 *   - the turn-budget watchdog trips → `"watchdog"`;
 *   - `maxRounds` follow-ups ran → `"rounds-exhausted"` (the default if no earlier stop fired).
 * A surface with the loop OFF simply never calls this (byte-identical to no loop).
 */
export const runConvergeLoop = async (
  ports: ConvergePorts,
  bounds: ConvergeBounds,
  init: { readonly turnsConsumed: number; readonly messages: readonly Message[] },
): Promise<ConvergeResult> => {
  let turnsConsumed = init.turnsConsumed
  let messages = init.messages
  let rounds = 0
  // Default: the loop ran its full round budget without an earlier stop. Overwritten by any break.
  let reason: ConvergeReason = "rounds-exhausted"
  while (rounds < bounds.maxRounds) {
    const receipt = ports.inspect()
    // Nothing to converge: no agent-authored self-test ran (the surface's steer is what makes the
    // agent write one), or it already went green.
    if (!receipt.executed) {
      reason = "no-signal"
      break
    }
    if (receipt.green) {
      reason = "green"
      break
    }
    // Watchdog: never spend past the turn budget (structural over-persist bound, independent of rounds).
    if (turnsConsumed >= bounds.maxTurns) {
      reason = "watchdog"
      break
    }
    const ff = ports.fairFail(receipt)
    if (ff === null) {
      // Executed-red but no fair signal to feed back — never loop blind.
      reason = "no-signal"
      break
    }
    const turn = await ports.runFollowUpTurn(ff.feedback)
    turnsConsumed += turn.turns
    messages = turn.messages
    rounds += 1
  }
  return { converged: ports.inspect().green, rounds, turnsConsumed, messages, reason }
}
