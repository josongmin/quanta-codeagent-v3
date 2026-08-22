/**
 * Closeout guard (closeout reminder — Codex App agent loop doc §4 mirror).
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

/**
 * The default closeout nudge — the UNION self-check. Two parts:
 *
 *   1. The general defended-claim guidance (keep only defended claims, state
 *      explicitly if verification was not run, separate fact from inference,
 *      match the requested reporting shape).
 *   2. A self-select code-modification section: the four-truth-surface walk
 *      (type / owner / wire / test), gated by an explicit "If you modified
 *      code, also:" clause so the model applies it iff it actually changed
 *      source — no harness-side guess required.
 *
 * Why a UNION instead of routing by a tool-name scan: the prior design picked
 * between this general checklist and a code-mod-only one via a heuristic that
 * scanned tool history for mutating-tool NAMES. That scan was both over-
 * inclusive (a stray scratch-file write looked like a code change) and
 * under-inclusive (files mutated via `bash sed -i` / redirection were
 * invisible). Injecting the full self-check every time and
 * letting the model self-select the code-mod portion removes the interpretive
 * guess while keeping every directive the model previously could have seen.
 * Retained name for callers using `closeoutGuard: { enabled:true }` without
 * the `fourRule` flag.
 */
export const CLOSEOUT_REMINDER = [
  "Before finishing: keep only defended claims, state explicitly if",
  "verification was not run, separate fact from inference, and match the",
  "requested reporting shape.",
  "If you modified code, also walk the four truth surfaces:",
  "  type  — signatures + exported types still align with all uses.",
  "  owner — the file that OWNS the changed contract is itself fixed,",
  "          not just a caller patched into agreement.",
  "  wire  — every caller / import / config / wiring point referencing",
  "          the changed surface compiles and matches the new shape.",
  "  test  — the failing scenario the issue describes now passes AND",
  "          nearest existing tests still pass (no regression).",
  "Then stop only if those hold.",
].join("\n")

/** Defended-claim 4-rule (Codex `response-assembly-and-closeout.md §5.2`
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
 * Decide whether to block a finish attempt and inject the closeout reminder.
 * Pure: the only side effect is incrementing `state.trips` when it blocks
 * (the loop owns the state object). Routing (after the OFF / single-shot
 * checks) is now a single explicit switch — NO interpretive guess:
 *
 *   1. `cfg.fourRule === true` ⇒ inject {@link CLOSEOUT_4RULE_REMINDER}
 *      (the defended-claim R1–R4 + Verification report scaffold). This is an
 *      EXPLICIT caller opt-in (knob value `"4rule"`), not a heuristic.
 *   2. else ⇒ inject the default UNION self-check {@link CLOSEOUT_REMINDER},
 *      which already carries BOTH the general defended-claim guidance AND the
 *      self-select code-modification four-surface walk. The model applies the
 *      code-mod portion iff it actually changed source.
 *
 * Removed in this revision: the tool-name history scan that used to route
 * between a code-mod-only reminder and the general one. That scan was over-
 * and under-inclusive (a stray scratch write looked like a code change;
 * `bash sed -i` mutations were invisible), so it handed the model the wrong
 * checklist on a guess. The union reminder removes the guess entirely while
 * preserving every directive.
 *
 * OFF rules (short-circuit before any of the above):
 *   - `cfg === undefined`        ⇒ guard OFF, byte-identical.
 *   - `cfg.enabled !== true`     ⇒ off unless explicitly enabled.
 *   - `state.trips >= 1`         ⇒ already tripped this run (single-shot cap).
 */
/**
 * ADR-0079 — when this returns `{block:true}` the loop ALSO sets
 * `ToolChoiceTurnState.closeoutAttempted = true` so the NEXT turn's
 * `resolveToolChoice` emits `{kind:"none"}` and forbids any further tool
 * calls — the model MUST produce a text terminal turn (it cannot keep
 * calling tools to delay the closeout). The flag is consumed at the next
 * turn's entry and cleared in the same step; it never carries across more
 * than one turn.
 */
export const decideCloseoutGuard = (args: {
  state: CloseoutGuardState
  cfg: { enabled?: boolean; fourRule?: boolean } | undefined
}): { block: boolean; text?: string } => {
  const { cfg, state } = args
  if (cfg === undefined) return { block: false }
  if (cfg.enabled !== true) return { block: false }
  if (state.trips >= 1) return { block: false }
  state.trips += 1
  // Explicit `fourRule:true` opt-in (knob value "4rule") ⇒ the 4-rule
  // discipline. Otherwise the default UNION reminder, which already includes
  // the self-select code-modification four-surface walk — no history scan.
  if (cfg.fourRule === true) return { block: true, text: CLOSEOUT_4RULE_REMINDER }
  return { block: true, text: CLOSEOUT_REMINDER }
}
