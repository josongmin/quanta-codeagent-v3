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

import { MUTATING_FS_EDIT_TOOLS as MUTATING } from "./mutating-tools"
import {
  isTestLikeCommand,
  isVerifyOutputFailing,
  isVerifySignalCommand,
  verifyOutputFailureMarkerId,
} from "./verify-signal"

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
  verifyOutputFailureMarkerId,
} from "./verify-signal"

/** Per-session forcing budget. One instance per agent run. */
export interface VerifyGuardState {
  trips: number
}

/** Fresh state for a session — zero forcings spent. */
export const createVerifyGuardState = (): VerifyGuardState => ({ trips: 0 })

/**
 * The forcing nudge injected when no verify-classified call is detected after
 * the latest edit. EVIDENTIAL, not asserted: the detector is a heuristic over
 * the command STRING (per-ecosystem registry in `verify-signal`), so a custom
 * or unrecognized runner can produce a FALSE no-verify reading. The wording
 * therefore acknowledges the detector is heuristic and HANDS the judgment back
 * to the model (it can answer "I verified via <cmd>") instead of asserting a
 * falsehood. Mechanics (when it fires, the trip cap, the tool_choice routing)
 * are unchanged — only the framing moved from asserted verdict to evidence +
 * question.
 */
export const VERIFY_FORCE_MESSAGE =
  "I didn't detect a test or reproduction run after your last edit (detection is heuristic — it matches a registry of known runner commands and may MISS a custom or unrecognized runner). If you already verified the fix, say HOW (which command and what it showed) and proceed. Otherwise, do NOT finish yet: construct the exact failing scenario the issue describes, run it to confirm your fix makes it pass, AND run the repository's existing test(s) nearest the changed code to confirm no regression."

/**
 * The forcing nudge injected when the model finishes after a verify call whose
 * outcome LOOKED like a failure (mustPass-only). Distinct from
 * {@link VERIFY_FORCE_MESSAGE} because here a verify DID run.
 *
 * EVIDENTIAL, not asserted: the "failed?" reading is a heuristic — either the
 * dispatch `ok:false` flag OR a REGEX match of an ecosystem failure summary in
 * the captured stdout (see `OUTCOME_FAILURE_MATCHERS`). A custom runner whose
 * summary happens to match (e.g. `pytest --continue-on-collection-errors`, or a
 * project runner that prints a "N failed" line for a passing run) can flip this
 * reading. So the message SURFACES the evidence (the matched marker id, when
 * the output regex is what fired) and HANDS the judgment to the model rather
 * than asserting a categorical "FAILED". The model can say "that run actually
 * passed" and proceed. Mechanics (firing condition, trip cap, tool_choice
 * routing) are unchanged — only the framing moved from asserted verdict to
 * evidence + question.
 *
 * @param marker - the `id` of the failure matcher that fired on the output
 *   (from {@link verifyOutputFailureMarkerId}), or `undefined` when the reading
 *   came from the dispatch `ok:false` flag (no stdout regex available).
 */
export const verifyPassForceMessage = (marker?: string): string => {
  const evidence =
    marker !== undefined
      ? `The output of your last verification (test/repro) matched a known failure pattern (\`${marker}\`).`
      : "Your last verification (test/repro) was reported as failing by the tool runner."
  return `${evidence} If that is a REAL failure, do NOT finish — read the failure output, locate the root cause, edit, then re-run the same verification and stop only once it passes. If the run actually PASSED (e.g. a custom runner whose summary only LOOKS like a failure), say so and proceed.`
}

/**
 * Sticky-red forcing nudge — used ONLY by the stickyRed branch. Unlike
 * {@link verifyPassForceMessage}, it NAMES the specific unresolved command
 * whose latest run failed, and explicitly closes the escape hatch the generic
 * message left open: a DIFFERENT check (e.g. a narrow reproduction) passing
 * does NOT clear this red. Observed failure (django-11141 gpt-5.4): the model
 * read the generic "test/repro failed" nudge, pointed at its green repro, and
 * proceeded — never realizing a broad regression test was still red. The fix
 * is detection (stickyRed) AND messaging (this): only re-running THIS command
 * green clears the block.
 *
 * @param command - the exact command string of the unresolved failing verify
 *   (the bash `arg`), or `undefined` for a non-bash verify (e.g. test_runner).
 * @param marker - the matched output failure id, when the regex (not the
 *   dispatch `ok:false` flag) is what fired.
 */
export const stickyRedForceMessage = (command?: string, marker?: string): string => {
  const which =
    command !== undefined && command !== ""
      ? `the command \`${command}\``
      : "an earlier verification command"
  const evidence =
    marker !== undefined ? ` Its output matched a known failure pattern (\`${marker}\`).` : ""
  return (
    `The LATEST run of ${which} after your last edit FAILED and has not been re-run green.${evidence} ` +
    `A DIFFERENT check passing (e.g. a narrow reproduction script) does NOT clear this — it is a separate test. ` +
    `Do NOT finish: read THAT failure, fix the root cause, then re-run THAT SAME command and stop only once IT passes. ` +
    `Only claim a false positive if THAT exact command actually passed.`
  )
}

/**
 * Back-compat constant: the marker-less evidential message. Equal to
 * `verifyPassForceMessage()` (the dispatch-`ok:false` phrasing). The guard
 * computes the marker dynamically and prefers {@link verifyPassForceMessage};
 * this constant is the value emitted when no output marker is available.
 */
export const VERIFY_PASS_FORCE_MESSAGE = verifyPassForceMessage()

/** Tools that mutate source — an edit that must be verified before finishing. */
// MUTATING (FS-edit tool set) is imported at the top from ./mutating-tools — the
// SSOT shared with localize-phase-guard so the two guards can't drift. Was
// {edit,write} here, which silently MISSED apply_patch/scripted_replace/
// apply_patch_structured (a source fix via apply_patch then "done" was un-gated).

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
  /** Opt-in (gated on `mustPass:true`). When set, a failing verify after the
   *  latest edit is STICKY — only a later passing run of the SAME command
   *  clears it; a green run of a different (narrower) command does not. Closes
   *  the "narrow repro green washes out broad regression red" gap. Default
   *  absent ⇒ byte-identical latest-verify-only behavior. */
  stickyRed?: boolean
}

/** Parsed `must-pass` knob value shape (mirrors `mustPassSchema`). */
export interface VerifyGuardOverride {
  readonly mustPass: boolean
  readonly maxTrips?: number
  readonly stickyRed?: boolean
}

/**
 * SINGLE constructor for a {@link VerifyGuardConfig} from a parsed must-pass
 * value (+ optional instance `exactCommands`). Shared by the bench driver
 * (`reconcileBenchGuards`) and the non-bench must-pass apply-binding so the
 * field shape lives in ONE place — `exactCommands`/`maxTrips`/`stickyRed` are
 * each included only when present (exactOptionalPropertyTypes-friendly).
 */
export const buildVerifyGuard = (
  value: VerifyGuardOverride,
  exactCommands?: readonly string[],
): VerifyGuardConfig => ({
  mustPass: value.mustPass,
  ...(value.maxTrips !== undefined ? { maxTrips: value.maxTrips } : {}),
  ...(value.stickyRed === true ? { stickyRed: true } : {}),
  ...(exactCommands !== undefined ? { exactCommands } : {}),
})

/**
 * Read a config field as an OWN property only. The `Object.hasOwn` guard is a
 * prototype-pollution defense — NOT dead indirection: callers may pass a `cfg`
 * whose `mustPass`/`maxTrips`/`exactCommands` lives on the PROTOTYPE
 * (`Object.create({ mustPass: true })`), and a plain `cfg.field` read would
 * traverse the chain and silently activate guard behavior from an injected
 * proto. Reading own-only treats a proto-injected field as ABSENT. See the
 * `verify-guard-must-pass-hellgate` "HELLGATE — adversarial inputs" prototype
 * tests, which go RED if this is replaced with a direct `cfg.field ?? DEFAULT`.
 */
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

/** Index of the FIRST mutating tool in history, or `-1` if none. Pure scan.
 *  The sticky-red scan anchors here (not at the LAST edit): a test that went
 *  red after the work began must be proven green by a same-command RE-RUN —
 *  editing another file (or even the fix itself) is a hypothesis, not proof, and
 *  must NOT drop the red out of the window. Reds BEFORE the first edit are the
 *  expected pre-fix baseline (e.g. the initial failing reproduction) and are
 *  correctly excluded. */
const findFirstMutating = (history: readonly GuardHistoryEntry[]): number => {
  for (let i = 0; i < history.length; i++) {
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

/**
 * Canonicalize a bash command for sticky-red identity matching. Strips ONLY
 * provably-irrelevant leading shell scaffolding so a re-run of the SAME test
 * matches even when the model varies the wrapper between runs:
 *   - a leading `cd <path> &&` / `cd <path>;` prefix (the box cwd, often a
 *     run-random `repo-XXXX` path the model includes inconsistently),
 *   - a leading `env` word and any leading `VAR=value` environment assignments
 *     (e.g. `env PYTEST_ADDOPTS= PYTHONNOUSERSITE=1 ...`),
 *   - surrounding / collapsed whitespace.
 * It does NOT touch the command BODY (interpreter, test target, args), so two
 * genuinely different tests never collapse to one key — only the irrelevant
 * prefix is removed. This is bounded prefix removal, not fuzzy similarity: the
 * false-BLOCK direction (a correct re-run failing to clear its red because the
 * env prefix differed) is closed without opening a false-CLEAR (a different
 * test's green clearing this red), since the body is preserved verbatim.
 */
const canonicalizeBashVerify = (raw: string): string => {
  let s = raw.trim()
  // Fixpoint: peel any leading scaffolding until none remains, so nested or
  // interleaved prefixes are all handled (`cd a && cd b && env FOO=1 cmd`,
  // `FOO=1 cd x && cmd`, etc.). Each pass removes at most one of:
  //   - a `cd <...> &&` / `cd <...>;` segment (note `cd=1` is NOT this — no space),
  //   - a leading `env` launcher word,
  //   - one leading `VAR=value` assignment token (value: empty / quoted / no
  //     unquoted whitespace — the shell tokenization boundary).
  // The loop terminates because every branch strictly shortens `s` or no-ops
  // (then `s === before` breaks). The command BODY is never touched, so two
  // different tests never collapse — only irrelevant prefixes are removed.
  while (true) {
    const before = s
    s = s.replace(/^cd\s+[^&;]+(?:&&|;)\s*/, "")
    s = s.replace(/^env\s+/, "")
    s = s.replace(/^[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+/, "")
    if (s === before) break
  }
  return s.replace(/\s+/g, " ").trim()
}

/** Command-identity key for the sticky-red scan: `<tool>:<canonical arg>`.
 *  Keying on the ARG (canonicalized — irrelevant env/cd prefix stripped) for
 *  EVERY tool, not just bash, prevents two different targets of the same tool
 *  (e.g. `test_runner` on test A vs test B) from collapsing to one key, which
 *  would let a green run of a DIFFERENT target wash out this red. Falls back to
 *  the bare tool name only when no arg is available (nothing to distinguish on).
 *  Two runs share a key iff they are the same command/target — so a later GREEN
 *  clears an earlier RED of the *same* target even when the wrapper differs, but
 *  never clears a different (narrower) one. */
const verifyCommandKey = (entry: GuardHistoryEntry): string =>
  entry.arg !== undefined && entry.arg !== ""
    ? `${entry.name}:${canonicalizeBashVerify(entry.arg)}`
    : entry.name

/**
 * Sticky-red scan (opt-in `stickyRed`). Among verify-classified entries
 * STRICTLY after `from`, the LATEST run of each distinct command decides that
 * command's standing. Returns the most-recent entry whose command's latest run
 * is FAILING, or `undefined` if every command's latest run passed/unknown.
 *
 * This is strictly stronger than {@link findLastVerifyAfter}+{@link
 * isVerifyFailing}: the latest-only check can be defeated by running a DIFFERENT
 * green command after a red (a narrow repro green washing out a broad regression
 * red — the django-11141 gpt-5.4 failure mode). Here a red is sticky until the
 * SAME command is re-run green. Walking backward and taking the first-seen key
 * yields that command's latest run for free.
 */
const findUnresolvedFailingVerify = (
  history: readonly GuardHistoryEntry[],
  from: number,
  exactCommands: readonly string[] | undefined,
): GuardHistoryEntry | undefined => {
  const seen = new Set<string>()
  for (let j = history.length - 1; j > from; j--) {
    const entry = history[j]
    if (entry === undefined || !isVerify(entry, exactCommands)) continue
    // Only a DEFINITIVE outcome (ok true/false) decides a command's standing.
    // An unknown-outcome re-run (`ok === undefined`: push-only / unresolved
    // dispatch) must NOT clear a prior definitive red — a red is cleared by a
    // GREEN, never by "outcome unknown". Skip unknowns so the most recent
    // DEFINITIVE run per command wins.
    if (entry.ok !== true && entry.ok !== false) continue
    const key = verifyCommandKey(entry)
    if (seen.has(key)) continue // an earlier (superseded) definitive run
    seen.add(key)
    if (isVerifyFailing(entry)) return entry // latest definitive run failed
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
 * `ToolChoiceTurnState.verifyGuardViolated = true` (1-turn TTL, consumed and
 * cleared at the next turn's entry). This flag NO LONGER forces tool_choice:
 * `resolveToolChoice` resolves it to `auto`. The steer is carried by the
 * injected evidential nudge ({@link VERIFY_FORCE_MESSAGE}), which invites the
 * model to EITHER answer in text how it already verified OR run a test — a
 * `{kind:"any"}` force would mechanically ban that text answer.
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
  const stickyRed = ownVerifyGuardField(cfg, "stickyRed") === true

  // Presence branch: no verify after the latest edit.
  if (lastVerify === undefined) {
    return spendTrip(state, cap) ? { block: true, text: VERIFY_FORCE_MESSAGE } : { block: false }
  }
  // Sticky-red branch (opt-in; superset of the latest-only must-pass check):
  // an unresolved failing verify — a command whose LATEST run after the edit
  // failed — blocks even if a different command was run green afterwards. Only
  // re-running that same command green clears it.
  if (mustPass && stickyRed) {
    // Anchor at the FIRST edit, not the last: a red since work began stays
    // unresolved across intervening edits until the SAME command is re-run
    // green (an edit is a hypothesis, not proof). Closes the escape where the
    // model edits an unrelated file after a regression red to drop it from the
    // last-edit window, then finishes on a narrow green.
    const firstMut = findFirstMutating(history)
    const unresolved = findUnresolvedFailingVerify(history, firstMut, exactCommands)
    if (unresolved !== undefined && spendTrip(state, cap)) {
      const marker = verifyOutputFailureMarkerId(unresolved.output ?? "") ?? undefined
      // Show the CANONICAL command (env/cd wrapper stripped) — the meaningful
      // command the model must re-run, matching the identity key it is judged on.
      const command =
        unresolved.name === "bash" ? canonicalizeBashVerify(unresolved.arg ?? "") : undefined
      return { block: true, text: stickyRedForceMessage(command, marker) }
    }
    return { block: false }
  }
  // Must-pass branch: presence satisfied, but the latest verify failed.
  // Conservative: unknown outcome (ok absent + output absent) ⇒ no block.
  if (mustPass && isVerifyFailing(lastVerify) && spendTrip(state, cap)) {
    // Thread the matched failure marker (when the OUTPUT regex is what fired)
    // into the EVIDENTIAL message so the model sees WHY the output looked like
    // a failure. When the reading came from the dispatch `ok:false` flag there
    // is no stdout marker ⇒ `undefined` ⇒ the marker-less back-compat phrasing.
    const marker = verifyOutputFailureMarkerId(lastVerify.output ?? "") ?? undefined
    return { block: true, text: verifyPassForceMessage(marker) }
  }
  return { block: false }
}
