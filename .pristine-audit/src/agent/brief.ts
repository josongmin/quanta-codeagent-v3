/**
 * Brief-mode session posture (C3, jun-4-brief-mode RFC).
 *
 * A toggleable SESSION-level posture that, when ON, instructs the model to
 * produce condensed FINAL prose — short answers, no preamble, no recap — while
 * leaving correctness reporting (verification block, error reporting, the
 * honesty/claim ladder, file:line evidence) intact. It is ORTHOGONAL to the
 * `effort` axis (`./effort.ts`): effort caps `max_output_tokens` + reasoning
 * depth (a wire clamp); brief shapes the *prose verbosity* the model CHOOSES to
 * emit (a behavioral directive). Both compose ("think deeply, answer tersely").
 *
 * The mechanism is a PROMPT DIRECTIVE: `BRIEF_NOTICE` (`./prompt-body.ts`) is
 * spliced into the per-turn DYNAMIC `<system-reminder>` slot when the posture is
 * ON, never into the static cached prefix — so flipping the toggle mid-session
 * never invalidates the provider cache prefix, and default-OFF is byte-identical
 * (the dynamic tail is unchanged). This is NOT a render-layer transform and NOT
 * a token-truncator (see the RFC §4/§8 for why those were rejected).
 *
 * Slice discipline: pure leaf module, no cross-slice imports — mirrors
 * `createEffortStore` in shape so the loop reads `get()` once per turn and the
 * CLI/REPL surface writes via `set()` in response to `/brief` or a `set_brief`
 * control-op.
 */

/** Parse a boolean knob value (`QUANTA_BRIEF`, the `/brief` arg, etc.) into a
 *  strict boolean. Mirrors the env-side `parseBool` (`runtime-config.ts`):
 *  `"1"` / `"true"` / `"on"` (case-insensitive) ⇒ true; `undefined`, empty,
 *  or any other value ⇒ false. Keeps "unset / not-a-truthy-value" defaulting
 *  to OFF so the absent toggle is byte-identical. */
export const parseBoolKnob = (raw: string | undefined): boolean => {
  if (raw === undefined) return false
  const trimmed = raw.trim().toLowerCase()
  return trimmed === "1" || trimmed === "true" || trimmed === "on"
}

/** Mutable per-session brief-mode holder. Intentionally tiny — the loop reads
 *  `get()` once per turn; the CLI/REPL surface writes via `set()` in response to
 *  a `/brief` command, a `set_brief` control-op, or the `QUANTA_BRIEF` knob
 *  seed. Shaped like {@link EffortStore} so the two postures plumb identically. */
export interface BriefStore {
  get(): boolean
  set(on: boolean): void
  snapshot(): boolean
}

export const createBriefStore = (initial = false): BriefStore => {
  let current = initial
  return {
    get: () => current,
    set: (on) => {
      current = on
    },
    snapshot: () => current,
  }
}
