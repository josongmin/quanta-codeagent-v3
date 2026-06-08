/**
 * SSOT for the system prompt's exploration ladder AND the skill-scope
 * navigation base (ADR-0512 P0 / L2).
 *
 * The `✕ file_tree_summary skill-scoped` bug came from two places naming the
 * same set independently: the system prompt (`prompt-body.ts`) tells the model
 * to ORIENT with `file_tree_summary → glob → ls → read` FIRST, while a scoped
 * skill's `allowed-tools` allowlist could omit those tools — so the gate denied
 * the very tool the harness's own prompt mandates. Centralizing the list here
 * makes that self-contradiction structurally impossible: the gate's nav-base is
 * DERIVED from these names, and `exploration-ladder-prompt-drift` ratchets that
 * the prompt's ladder line still names exactly {@link EXPLORATION_LADDER} (so a
 * future prompt edit that drifts the ladder fails CI until the constant — and
 * therefore the nav-base — is updated in lock-step).
 *
 * Membership here is NOT arbitrary: every entry is a READ-ONLY tool the system
 * prompt explicitly names as an exploration primitive. {@link EXPLORATION_LADDER}
 * is the verbatim ORIENT→NARROW ladder; `grep` is the CONFIRM-step primitive
 * ("read/grep the candidates directly", same prompt block). No mutating / exec /
 * network tool is in this set — those remain subject to the skill's allowlist.
 */

/** The verbatim analysis ladder from `prompt-body.ts` ("Canonical analysis
 *  ladder: file_tree_summary → glob → ls → read"). Order is load-bearing for the
 *  drift ratchet (it asserts the prompt joins these in THIS order). */
export const EXPLORATION_LADDER = ["file_tree_summary", "glob", "ls", "read"] as const

/** The full read-only exploration set always granted regardless of skill scope:
 *  the ladder + `grep` (the CONFIRM-step primitive). Consumed by the skill gate
 *  as the nav-base; never includes a mutating tool. */
export const READ_ONLY_EXPLORATION = [...EXPLORATION_LADDER, "grep"] as const
