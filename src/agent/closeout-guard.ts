/**
 * Closeout guard (SOTA++ CloseoutLens — Codex App agent loop doc §4 mirror).
 * Pure, deterministic policy: no LLM, no I/O. Addresses an observed gap —
 * v3 has NO finish-time self-check, so the agent can produce overclaims at
 * the moment of completion ("verified" when no verification ran, fact mixed
 * with inference, ignoring requested reporting shape).
 *
 * Mechanism mirrors verify-guard (one-shot nudge via the existing recovery
 * machinery) but at a DIFFERENT trigger point (finish-intent, content-agnostic)
 * and with DIFFERENT content (the closeout reminder). Intentionally simpler
 * than verify-guard: no history inspection (works on finish-intent + state
 * alone), no `maxTrips` knob — closeout is single-shot by design (multiple
 * closeout nudges would just thrash; one nudge is the entire value), no
 * tool-name semantics. Absent config ⇒ guard fully OFF (byte-identical loop).
 */

/** Per-session closeout budget. One instance per agent run. Single-shot cap
 *  is enforced by the policy (`trips >= 1` ⇒ no block), not by a knob. */
export interface CloseoutGuardState {
  trips: number
}

/** Fresh state for a session — zero closeout nudges spent. */
export const createCloseoutGuardState = (): CloseoutGuardState => ({ trips: 0 })

/** The closeout nudge (legacy single-line). Compresses the four CloseoutLens
 *  directives into one sentence: keep only defended claims, state explicitly
 *  if verification was not run, separate fact from inference, match the
 *  requested reporting shape. Retained for callers using `closeoutGuard:
 *  { enabled:true }` without the new `fourRule` flag. */
export const CLOSEOUT_REMINDER =
  "Before finishing: keep only defended claims, state explicitly if verification was not run, separate fact from inference, and match the requested reporting shape. Then stop only if those hold."

/** SOTA++ defended-claim 4-rule (Codex `response-assembly-and-closeout.md §5.2`
 *  verbatim absorption). Each rule names a recoverable failure mode and the
 *  fix; the model is expected to walk the four rules over the claims in its
 *  draft before emitting the final answer. The verification-report cue points
 *  at the scaffold defined in the system prompt (performed / rail / verdict /
 *  failure / skipped because). */
export const CLOSEOUT_4RULE_REMINDER = [
  "Before finishing, run the defended-claim filter on every claim in your",
  "answer:",
  "  R1 Read-source  — if you did not read the source surface, do NOT promote",
  "                    it to owner truth. Downgrade to inference, or read it.",
  "  R2 Run-verify   — if you did not run verification, do NOT call the change",
  "                    green. State 'verification: not run' (with reason) or",
  "                    run it now.",
  "  R3 Grep-proof   — a grep hit is presence evidence only. Do NOT close",
  "                    'unused' / 'complete' / 'correct' on grep alone — use",
  "                    source + runtime as the proof.",
  "  R4 Stale-memory — recalled memory hints are routing, never proof.",
  "                    Downgrade any claim whose only support is a memory",
  "                    snippet to inference, or fetch the real source.",
  "Then attach the Verification report named in the system prompt:",
  "  performed: <yes|no>  rail: <…>  verdict: <green|red>",
  "  failure: <…>  skipped because: <…>",
  "Stop only if R1-R4 hold and the report is honest.",
].join("\n")

/**
 * Phase 4 SOTA++ absorption — code-modification surface-alignment reminder.
 * Codex's `agent-loop-deep-dive.md §7` surface-alignment loop walks four truth
 * surfaces after an owner fix: type / owner / wire / test. This constant is a
 * SUPPLEMENT to {@link CLOSEOUT_REMINDER} / {@link CLOSEOUT_4RULE_REMINDER},
 * not a replacement — {@link decideCloseoutGuard} picks which to inject based
 * on whether the session contains a mutating tool call (see
 * {@link isCodeModificationSession}); a code-modification session ALWAYS
 * receives this four-surface reminder, taking precedence over `cfg.fourRule`.
 * Keeping the prior reminders untouched preserves Phase 2's contract.
 */
export const CODE_MOD_CLOSEOUT_REMINDER = [
  "Before finishing a code change, walk the four truth surfaces:",
  "  type  — signatures + exported types still align with all uses.",
  "  owner — the file that OWNS the changed contract is itself fixed,",
  "          not just a caller patched into agreement.",
  "  wire  — every caller / import / config / wiring point referencing",
  "          the changed surface compiles and matches the new shape.",
  "  test  — the failing scenario the issue describes now passes AND",
  "          nearest existing tests still pass (no regression).",
  "Stop only after all four surfaces are clean.",
].join("\n")

/** Tool names that mutate source — the trigger set for the code-modification
 *  closeout reminder. Mirrors `verify-guard`'s mutating set, plus the new
 *  Phase 4 `scripted_replace` tool. Centralized here so any future mutating
 *  tool only needs to be added in one place. */
const CODE_MOD_TOOLS = new Set(["edit", "write", "scripted_replace"])

/**
 * True iff any history entry names a tool that mutates source. Pure: a
 * structural `name`-only inspection, no allocation beyond the loop variable.
 * Accepts the `ToolHistoryEntry` shape from `@/agent/loop` by duck-typing —
 * declared inline so this module stays import-free (the `closeout-guard
 * module purity` test forbids non-`./types` imports). Empty / undefined
 * history ⇒ false.
 */
export const isCodeModificationSession = (
  history: ReadonlyArray<{ name: string }> | undefined,
): boolean => {
  if (history === undefined) return false
  for (const entry of history) {
    if (CODE_MOD_TOOLS.has(entry.name)) return true
  }
  return false
}

/**
 * Decide whether to block a finish attempt and inject the closeout reminder.
 * Pure: the only side effect is incrementing `state.trips` when it blocks
 * (the loop owns the state object). Routing precedence (after the OFF /
 * single-shot checks):
 *
 *   1. code-modification session (any history entry names a mutating tool —
 *      see {@link isCodeModificationSession}) ⇒ inject the Phase 4 four-truth-
 *      surface reminder {@link CODE_MOD_CLOSEOUT_REMINDER} — UNLESS the
 *      caller explicitly opted into `cfg.fourRule: true`, which takes
 *      precedence (the user's explicit choice beats the implicit detector
 *      — standard "explicit-over-implicit" principle from Codex's
 *      response-assembly contract). A caller that wants the 4-rule
 *      checklist even on code-mod sessions opts in; a caller that wants
 *      the four-surface walk on code-mod sessions leaves `fourRule`
 *      unset (the default).
 *   2. `cfg.fourRule === true` ⇒ inject {@link CLOSEOUT_4RULE_REMINDER}
 *      (the Phase 2 defended-claim R1–R4 + VerificationCloseout cue).
 *      This is the explicit-override path that beats #1 too.
 *   3. else ⇒ inject the legacy one-liner {@link CLOSEOUT_REMINDER}.
 *
 * OFF rules (short-circuit before any of the above):
 *   - `cfg === undefined`        ⇒ guard OFF, byte-identical.
 *   - `cfg.enabled !== true`     ⇒ off unless explicitly enabled.
 *   - `state.trips >= 1`         ⇒ already tripped this run (single-shot cap).
 *
 * The `history` parameter is optional and duck-typed inline as
 * `ReadonlyArray<{name: string}>` so this module stays import-free — the loop
 * threads its existing `toolHistory` array straight through without any cross-
 * slice import.
 */
export const decideCloseoutGuard = (args: {
  state: CloseoutGuardState
  cfg: { enabled?: boolean; fourRule?: boolean } | undefined
  history?: ReadonlyArray<{ name: string }>
}): { block: boolean; text?: string } => {
  const { cfg, state } = args
  if (cfg === undefined) return { block: false }
  if (cfg.enabled !== true) return { block: false }
  if (state.trips >= 1) return { block: false }
  state.trips += 1
  // Explicit `fourRule:true` opt-in wins over the implicit code-mod detector
  // (explicit-over-implicit). Caller chose the 4-rule discipline; respect it.
  if (cfg.fourRule === true) return { block: true, text: CLOSEOUT_4RULE_REMINDER }
  // Otherwise: code-mod session (any history entry names a mutating tool)
  // gets the four-truth-surface reminder; non-code-mod falls through to
  // the legacy one-liner below.
  if (isCodeModificationSession(args.history)) {
    return { block: true, text: CODE_MOD_CLOSEOUT_REMINDER }
  }
  // Neither explicit fourRule nor a code-mod session ⇒ legacy one-liner.
  return { block: true, text: CLOSEOUT_REMINDER }
}
