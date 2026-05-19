/**
 * Verify-guard (SOTA++ Tier 0 safety). Pure, deterministic policy: no LLM, no
 * I/O. Addresses an observed bench failure where the agent edits a source file
 * then declares "done" WITHOUT running any test or reproduction (0 verification
 * calls after the edit) → a wrong fix ships. When the model tries to finish
 * right after a mutating tool with no verification since, the loop forces one
 * more turn (up to `maxTrips`, default 2 — capped to avoid infinite forcing /
 * turn-budget burn). Absent config ⇒ guard fully OFF (byte-identical loop).
 */

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
 * Conservative matcher: a `bash` command counts as verification ONLY if it
 * looks like a real test or reproduction invocation. Plain shell noise
 * (`git status`, `ls`, `echo`, `cat`, `grep`) deliberately does NOT match —
 * that loophole is the exact defect this guard exists to close.
 */
export const TEST_LIKE_RE =
  /(?:^|\s|;|&&|\|\||\|)(?:pytest|tox|nox|unittest)\b|python3?\s+-m\s+(?:pytest|unittest)\b|\bbun\s+test\b|\bnode\b[^|]*--test\b|\bnpm\s+(?:test|run\s+\S*test\S*)\b|\byarn\s+test\b|\bgo\s+test\b|\bcargo\s+test\b|\bmake\s+(?:test|check)\b|\bpython3?\s+\S+\.py\b|reproduce|\brepro\b/i

/**
 * A history entry counts as verification iff it is the dedicated verify tool,
 * or a `bash` call whose command string looks like an actual test/repro run.
 */
const isVerify = (entry: { name: string; arg?: string }): boolean => {
  if (entry.name === "test_runner") return true
  if (entry.name === "bash") {
    return typeof entry.arg === "string" && entry.arg.length > 0 && TEST_LIKE_RE.test(entry.arg)
  }
  return false
}

const DEFAULT_MAX_TRIPS = 2

/**
 * Decide whether to block a finish attempt and force one more turn. Pure: the
 * only side effect is incrementing `state.trips` when it blocks (the loop owns
 * the state object). `cfg === undefined` ⇒ guard OFF.
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
