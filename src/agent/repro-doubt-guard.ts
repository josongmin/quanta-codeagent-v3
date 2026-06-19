/**
 * repro-doubt guard — breaks the `verify_loop_stuck` churn with a one-shot steer
 * that redirects the agent's suspicion from its PATCH to its REPRO TEST.
 *
 * MEASURED failure mode (jun-20, bon3 full-remote run; see
 * jun-20-bestofn-wrong-repro-oracle-root): on the synthesis-heavy fails the agent
 * edits the RIGHT site (owner_recall@1 = 1.0), but the repro oracle is
 * false-negative (`repro_red_but_unresolved_rate` ≈ 0.75) — it keeps the test red
 * even for a correct/near-correct fix. The agent then re-runs the test 5..N times
 * with NO intervening edit, churning until the turn budget is exhausted
 * (`verify_loop_stuck`, 124 turns → FAIL). `failure-classifier.ts` only DETECTS
 * this post-hoc; this guard INTERVENES.
 *
 * Intervention: once the agent has actually attempted a fix (≥1 edit) and then runs
 * the test `stuckRuns` times in a row without editing, inject {@link REPRO_DOUBT_STEER}
 * ONCE. The steer reframes the impasse — a red test after a right-site edit is at
 * least as likely to be a wrong/over-specific REPRO TEST as a wrong patch — and gives
 * an exit (re-derive the test from the issue, or submit if the fix is sound). This is
 * the agentless analog of Prometheus's repro-fail → re-analyze loop, but targeted at
 * the false-negative-oracle stall rather than blind retry.
 *
 * Pure reducer over the tool-call stream. DEFAULT-OFF: no/invalid `stuckRuns` ⇒
 * every step returns `{ steer: undefined }` (byte-identical to the pre-feature loop).
 * Fires at most once per stuck streak; every edit opens a fresh streak.
 */
import { MUTATING_TOOL_NAMES } from "./localize-phase-guard"

/** Tools that constitute a "test re-run" for stuck detection. Mirrors the
 *  `failure-classifier` stuck signal (trailing run of bash/test_runner with no
 *  edit). `bash` dominates because the Agentless repro is executed via a shell. */
export const TEST_TOOL_NAMES: ReadonlySet<string> = new Set(["bash", "test_runner"])

export interface ReproDoubtConfig {
  /** Consecutive test re-runs (after an edit, no intervening edit) that trip the
   *  steer. Integer ≥ 1. Anything else ⇒ guard OFF. */
  readonly stuckRuns?: number
}

export interface ReproDoubtState {
  /** Test re-runs since the last edit (reset to 0 on every edit). */
  readonly runsSinceEdit: number
  /** Has the agent made at least one edit in the current streak? Until it has,
   *  repeated test runs are exploration, not a stuck-on-fix stall. */
  readonly hasEdited: boolean
  /** Already steered in the current streak? (one-shot per streak). */
  readonly steered: boolean
}

export const createReproDoubtState = (): ReproDoubtState => ({
  runsSinceEdit: 0,
  hasEdited: false,
  steered: false,
})

/** The one-shot doubt steer. Kept as an exported const so tests pin the exact text
 *  and a future A/B can diff trajectories on its presence. */
export const REPRO_DOUBT_STEER =
  "You have re-run the test several times since your last edit without it turning green. STOP retrying the same way. A test that stays RED after you have already edited the correct location is at least as likely to be a WRONG or OVER-SPECIFIC reproduction test as a wrong fix: re-read the issue and confirm your repro asserts the ACTUAL described behavior (not an incidental string/format), or — if your fix genuinely resolves the issue as described — stop re-running and submit it. Do not burn the remaining budget re-running an unchanged test."

const isPositiveInt = (n: number | undefined): n is number =>
  typeof n === "number" && Number.isInteger(n) && n >= 1

/**
 * One step of the guard over a single tool dispatch.
 *  - edit/write (∈ MUTATING_TOOL_NAMES) ⇒ reset the streak (progress was made).
 *  - test re-run (∈ TEST_TOOL_NAMES) ⇒ advance; trip the steer at `stuckRuns` if the
 *    agent has already edited and we have not steered this streak.
 *  - anything else (read/grep/glob/…) ⇒ neither advances nor resets (investigation).
 * Returns the (possibly unchanged) next state and the steer to inject this step.
 */
export const reproDoubtStep = (
  state: ReproDoubtState,
  toolName: string,
  cfg: ReproDoubtConfig | undefined,
): { steer: string | undefined; state: ReproDoubtState } => {
  if (cfg === undefined || !isPositiveInt(cfg.stuckRuns)) {
    return { steer: undefined, state }
  }
  if (MUTATING_TOOL_NAMES.has(toolName)) {
    return { steer: undefined, state: { runsSinceEdit: 0, hasEdited: true, steered: false } }
  }
  if (!TEST_TOOL_NAMES.has(toolName)) {
    return { steer: undefined, state }
  }
  const runsSinceEdit = state.runsSinceEdit + 1
  const tripped = state.hasEdited && !state.steered && runsSinceEdit >= cfg.stuckRuns
  return {
    steer: tripped ? REPRO_DOUBT_STEER : undefined,
    state: { runsSinceEdit, hasEdited: state.hasEdited, steered: state.steered || tripped },
  }
}
