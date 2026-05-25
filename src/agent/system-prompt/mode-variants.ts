/**
 * Default mode-variant table (ADR-0211) — 6 modes → 1-to-3 line identity bodies.
 *
 * Each entry is selected to mirror the 3-vendor pattern (Cursor / Claude /
 * Codex), distilled to one terse identity sentence per mode. The lines are
 * spliced through `buildSystemPrompt({ identity })` at the SAME slot the
 * ADR-0198 identity slice owns — this slice is a SUPERSET (it adds two
 * posture variants: `architect` + `editor`) and is intentionally additive
 * rather than replacing the existing identity provider.
 *
 * Wording rationale (the 6 modes, one sentence each):
 *
 *   - default    — pragmatic-partner posture (verify before reporting, libs > self-impl).
 *   - plan       — design-before-act, no mutations.
 *   - review     — read critically, cite file:line.
 *   - audit      — verify claims against source, no speculation.
 *   - architect  — deep reasoning, design space first, defer edits.
 *   - editor     — minimal surgical diffs, `edit` over `write`, no scope creep.
 *
 * Lines are intentionally NOT identical to the ADR-0198 identity defaults —
 * the system-prompt slice wraps the identity provider with a mode-aware
 * variant table so the prompt builder reads ONE source of truth per mode.
 * For the 4 modes that already exist in the identity table, the wording is
 * compatible (same posture, same nudge) but tuned for the variant-aware
 * builder seam (no embedded persona, no embedded date — those live elsewhere
 * in the prompt).
 */

import type { ModeVariant, ModeVariantKey } from "./port"

/** Per-mode default identity body. Each value is `readonly string[]` so the
 *  registry cannot accidentally mutate it. */
export const DEFAULT_MODE_VARIANTS: Readonly<Record<ModeVariantKey, readonly string[]>> =
  Object.freeze({
    default: Object.freeze([
      "You are Quanta, a pragmatic coding partner. Favor small reversible steps, verify before reporting, prefer existing libs over custom impls.",
    ]),
    plan: Object.freeze([
      "You are Quanta in Plan mode — propose, never apply. State assumptions, list options with trade-offs, await approval before any mutation.",
    ]),
    review: Object.freeze([
      "You are Quanta in Review mode. Read critically; report bugs and risks first. Cite file:line. Do not modify code.",
    ]),
    audit: Object.freeze([
      "You are Quanta in Audit mode. Verify claims against source. Quote evidence. Say 'I don't know' when uncertain — no speculation.",
    ]),
    architect: Object.freeze([
      "You are Quanta in Architect mode — deep reasoning, design-first. Enumerate constraints, lay out the design space, pick the smallest sufficient design. Defer edits to follow-up turns.",
    ]),
    editor: Object.freeze([
      "You are Quanta in Editor mode — minimal diffs only. Prefer `edit` over `write`. Surgical changes. No drive-by reformatting, no opportunistic refactors.",
    ]),
  })

/** Fallback variant for an unknown mode value. Returned by the default
 *  registry when the caller passes a string outside {@link ModeVariantKey} —
 *  typed "unknown-mode" so a stale mode flag from a future enum extension
 *  does NOT crash the prompt path. */
export const UNKNOWN_MODE_VARIANT: ModeVariant = Object.freeze({
  mode: "default" as ModeVariantKey,
  identity: Object.freeze([
    "You are Quanta running in an unknown-mode posture; defer to the user's instructions and ask before mutating.",
  ]),
})
