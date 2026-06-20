/**
 * Verify-guard (Tier 0 safety hardening). Pure, deterministic policy: no LLM, no
 * I/O. Addresses an observed bench failure where the agent edits a source file
 * then declares "done" WITHOUT running any test or reproduction (0 verification
 * calls after the edit) → a wrong fix ships. When the model tries to finish
 * right after a mutating tool with no verification since, the loop forces one
 * more turn (up to `maxTrips`, default 1 — less forcing; empirically 0-trip on
 * Easy-5 gpt-4o and ADR-0014 repair-rounds측정에서 과도 강제가 over-correction
 * 유발). Absent config ⇒ guard fully OFF (byte-identical loop).
 *
 * The "is this a real test/repro run?" recognition lives in `./verify-signal`
 * (a pure per-ecosystem registry); this module owns only the gating state
 * machine. The signal symbols are re-exported below for back-compat.
 */

import { isTestLikeCommand, isVerifyOutputFailing, isVerifySignalCommand } from "./verify-signal"

export {
  isTestLikeCommand,
  isVerifyOutputFailing,
  isVerifySignalCommand,
  matchesExactVerifyCommand,
  matchVerifyCommand,
  OUTCOME_FAILURE_MATCHERS,
  type OutcomeFailureMatcher,
  TEST_LIKE_RE,
  type VerifyMatcher,
} from "./verify-signal"

/** Per-session forcing budget. One instance per agent run. */
export interface VerifyGuardState {
  trips: number
}

/** Fresh state for a session — zero forcings spent. */
export const createVerifyGuardState = (): VerifyGuardState => ({ trips: 0 })

/** The forcing nudge injected when the model finishes after an unverified edit. */
export const VERIFY_FORCE_MESSAGE =
  "You edited source but ran no test or reproduction afterward. Do NOT finish yet. Construct the exact failing scenario the issue describes, run it to confirm your fix makes it pass, AND run the repository's existing test(s) nearest the changed code to confirm no regression. Only stop once those pass."

/**
 * The forcing nudge injected when the model finishes after a verify call that
 * FAILED (mustPass-only). Distinct from {@link VERIFY_FORCE_MESSAGE} because
 * the corrective action differs: here a verify DID run — the model must read
 * the failure, locate the cause, edit, and re-run. This is the outcome-gate
 * that closes the "ran pytest → ok:false → declared done" loophole observed
 * in skills/subagent-ON sanity runs.
 */
export const VERIFY_PASS_FORCE_MESSAGE =
  "Your last verification (test/repro) FAILED. Do NOT finish — fix the regression first. Read the failure output, locate the root cause, edit, then re-run the same verification. Only stop once the test passes."

/** Tools that mutate source — an edit that must be verified before finishing. */
const MUTATING = new Set(["edit", "write"])

/** History-entry shape with the optional outcome fields the mustPass branch
 *  consults. Kept as a local widening of the public {@link ToolHistoryEntry}
 *  so this module imports nothing from session-resources (avoids the import
 *  cycle that already pinches the agent ring). */
type GuardHistoryEntry = {
  name: string
  arg?: string
  id?: string
  ok?: boolean
  output?: string
}

/**
 * A history entry counts as verification iff it is the dedicated verify tool,
 * or a `bash` call whose command string looks like an actual test/repro run
 * (see {@link isTestLikeCommand} — the soundness contract lives there).
 */
const isVerify = (
  entry: GuardHistoryEntry,
  exactCommands: readonly string[] | undefined,
): boolean => {
  if (entry.name === "test_runner") return true
  if (entry.name === "bash") {
    return (
      typeof entry.arg === "string" &&
      entry.arg.length > 0 &&
      isVerifySignalCommand(entry.arg, exactCommands)
    )
  }
  return false
}

/**
 * Determine whether a verify-classified history entry FAILED.
 *
 * Conservative contract (matches the policy in `verify-signal.ts`):
 *   - `ok === false` ⇒ failed (dispatch reports failure).
 *   - `ok === true` BUT the output contains an explicit failure marker ⇒
 *     failed (the runner exited 0 but the report says some tests failed —
 *     e.g. `pytest --continue-on-collection-errors` patterns).
 *   - `ok === undefined` (legacy push-only-on-start path, dispatch not yet
 *     resolved, or any other "outcome unknown") ⇒ NOT failed. The mustPass
 *     branch treats unknown as "do not over-block".
 *   - `ok === true` and no failure markers ⇒ NOT failed (passed).
 *
 * Pure: no I/O, no clock; reads only the entry's own fields.
 */
const isVerifyFailing = (entry: GuardHistoryEntry): boolean => {
  if (entry.ok === false) return true
  if (entry.ok === true) {
    return isVerifyOutputFailing(entry.name, entry.arg, entry.output ?? "")
  }
  return false
}

const DEFAULT_MAX_TRIPS = 1

/** Guard configuration. `mustPass:true` enables the outcome-gate branch
 *  (see {@link VERIFY_PASS_FORCE_MESSAGE} + module doc). Absent or `false`
 *  ⇒ presence-only behavior, byte-identical to the pre-extension policy. */
export interface VerifyGuardConfig {
  maxTrips?: number
  mustPass?: boolean
  exactCommands?: readonly string[]
}

const ownVerifyGuardField = <K extends keyof VerifyGuardConfig>(
  cfg: VerifyGuardConfig,
  key: K,
): VerifyGuardConfig[K] | undefined => (Object.hasOwn(cfg, key) ? cfg[key] : undefined)

/** Index of the LAST mutating tool in history, or `-1` if none. Pure scan. */
const findLastMutating = (history: readonly GuardHistoryEntry[]): number => {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]
    if (entry !== undefined && MUTATING.has(entry.name)) return i
  }
  return -1
}

/** Most-recent verify-classified entry STRICTLY after `from`, or `undefined`. */
const findLastVerifyAfter = (
  history: readonly GuardHistoryEntry[],
  from: number,
  exactCommands: readonly string[] | undefined,
): GuardHistoryEntry | undefined => {
  for (let j = history.length - 1; j > from; j--) {
    const entry = history[j]
    if (entry !== undefined && isVerify(entry, exactCommands)) return entry
  }
  return undefined
}

/** Try to spend one trip; return whether the budget was available. */
const spendTrip = (state: VerifyGuardState, cap: number): boolean => {
  if (state.trips < cap) {
    state.trips += 1
    return true
  }
  return false
}

/**
 * Decide whether to block a finish attempt and force one more turn. Pure: the
 * only side effect is incrementing `state.trips` when it blocks (the loop owns
 * the state object). `cfg === undefined` ⇒ guard OFF.
 *
 * Two branches share `state.trips` (one budget for both):
 *
 *   1. PRESENCE (always-on when cfg present) — fires if the latest edit has
 *      no verify-classified call after it. Same as legacy behavior, message
 *      = {@link VERIFY_FORCE_MESSAGE}.
 *
 *   2. MUST-PASS (gated on `cfg.mustPass === true`) — fires when presence is
 *      satisfied but the MOST-RECENT verify-classified call after the latest
 *      edit reports failure ({@link isVerifyFailing}: `ok === false` OR
 *      output matches an {@link OUTCOME_FAILURE_MATCHERS} pattern). Message
 *      = {@link VERIFY_PASS_FORCE_MESSAGE}.
 *
 * The two are exclusive (presence fires only when no verify ran; must-pass
 * fires only when one did). Sharing `state.trips` means the maxTrips cap
 * applies to either branch firing — SWE-bench callers should pass
 * `maxTrips: 2` to allow one of each, but the default stays 1.
 *
 * ADR-0079 — when this returns `{block:true}` the loop ALSO sets
 * `ToolChoiceTurnState.verifyGuardViolated = true` so the NEXT turn's
 * `resolveToolChoice` emits `{kind:"any"}` and forces the model to call a tool
 * (typically a verify). The flag is consumed at the next turn's entry and
 * cleared in the same step; it never carries across more than one turn.
 */
export const decideVerifyGuard = (args: {
  history: readonly GuardHistoryEntry[]
  cfg: VerifyGuardConfig | undefined
  state: VerifyGuardState
}): { block: boolean; text?: string } => {
  const { history, cfg, state } = args
  if (cfg === undefined) return { block: false }

  const lastMut = findLastMutating(history)
  if (lastMut === -1) return { block: false }

  const exactCommands = ownVerifyGuardField(cfg, "exactCommands")
  const lastVerify = findLastVerifyAfter(history, lastMut, exactCommands)
  const cap = ownVerifyGuardField(cfg, "maxTrips") ?? DEFAULT_MAX_TRIPS
  const mustPass = ownVerifyGuardField(cfg, "mustPass") === true

  // Presence branch: no verify after the latest edit.
  if (lastVerify === undefined) {
    return spendTrip(state, cap) ? { block: true, text: VERIFY_FORCE_MESSAGE } : { block: false }
  }
  // Must-pass branch: presence satisfied, but the latest verify failed.
  // Conservative: unknown outcome (ok absent + output absent) ⇒ no block.
  if (mustPass && isVerifyFailing(lastVerify) && spendTrip(state, cap)) {
    return { block: true, text: VERIFY_PASS_FORCE_MESSAGE }
  }
  return { block: false }
}
