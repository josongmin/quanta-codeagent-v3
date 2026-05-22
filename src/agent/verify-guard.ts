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

import { isTestLikeCommand } from "./verify-signal"

export {
  isTestLikeCommand,
  matchVerifyCommand,
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

/** Tools that mutate source — an edit that must be verified before finishing. */
const MUTATING = new Set(["edit", "write"])

/**
 * A history entry counts as verification iff it is the dedicated verify tool,
 * or a `bash` call whose command string looks like an actual test/repro run
 * (see {@link isTestLikeCommand} — the soundness contract lives there).
 */
const isVerify = (entry: { name: string; arg?: string }): boolean => {
  if (entry.name === "test_runner") return true
  if (entry.name === "bash") {
    return typeof entry.arg === "string" && entry.arg.length > 0 && isTestLikeCommand(entry.arg)
  }
  return false
}

const DEFAULT_MAX_TRIPS = 1

/**
 * Decide whether to block a finish attempt and force one more turn. Pure: the
 * only side effect is incrementing `state.trips` when it blocks (the loop owns
 * the state object). `cfg === undefined` ⇒ guard OFF.
 *
 * ADR-0079 — when this returns `{block:true}` the loop ALSO sets
 * `ToolChoiceTurnState.verifyGuardViolated = true` so the NEXT turn's
 * `resolveToolChoice` emits `{kind:"any"}` and forces the model to call a tool
 * (typically a verify). The flag is consumed at the next turn's entry and
 * cleared in the same step; it never carries across more than one turn.
 */
export const decideVerifyGuard = (args: {
  history: readonly { name: string; arg?: string }[]
  cfg: { maxTrips?: number } | undefined
  state: VerifyGuardState
}): { block: boolean; text?: string } => {
  const { history, cfg, state } = args
  if (cfg === undefined) return { block: false }

  let lastMut = -1
  for (let i = 0; i < history.length; i++) {
    const entry = history[i]
    if (entry !== undefined && MUTATING.has(entry.name)) lastMut = i
  }
  if (lastMut === -1) return { block: false }

  for (let j = lastMut + 1; j < history.length; j++) {
    const entry = history[j]
    if (entry !== undefined && isVerify(entry)) return { block: false }
  }

  if (state.trips < (cfg.maxTrips ?? DEFAULT_MAX_TRIPS)) {
    state.trips += 1
    return { block: true, text: VERIFY_FORCE_MESSAGE }
  }
  return { block: false }
}
