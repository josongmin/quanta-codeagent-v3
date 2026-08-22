/**
 * Default mode-variant table (ADR-0211) — 6 modes → identity bodies.
 *
 * SINGLE SOURCE OF TRUTH (jul-13 prompt design-system collapse): the per-mode
 * identity TEXT lives in ONE place — {@link DEFAULT_IDENTITIES} in the `identity`
 * slice (ADR-0198). This module no longer holds an independent copy; it PROJECTS
 * that table onto the {@link ModeVariantKey} sub-enum (`AgentMode`, i.e. every
 * IdentityMode except `onboarding`). This fulfils the ORIGINAL design intent that
 * the doc always claimed but never implemented — "the system-prompt slice wraps
 * the identity provider so the prompt builder reads ONE source of truth per mode"
 * — which had silently drifted into two divergent literal tables (default said
 * "Favor…" vs "You favor…and prefer…", plan said "propose, never apply" vs "You
 * design before you act", architect/editor differed only in `**mode**` emphasis).
 * Deriving here makes that drift unrepresentable.
 *
 * `ModeVariantKey ⊂ IdentityMode`, so every key is guaranteed present in the
 * source table (type-checked). The `onboarding` identity has no mode-variant
 * counterpart and is reached only via the identity provider directly.
 */

import { DEFAULT_IDENTITIES, UNKNOWN_MODE_IDENTITY } from "../identity"
import { MODE_VARIANT_KEYS, type ModeVariant, type ModeVariantKey } from "./port"

/** Per-mode default identity body, PROJECTED from {@link DEFAULT_IDENTITIES}
 *  (the single text SSOT) onto the {@link ModeVariantKey} sub-enum. Frozen so
 *  the registry cannot mutate it. */
export const DEFAULT_MODE_VARIANTS: Readonly<Record<ModeVariantKey, readonly string[]>> =
  Object.freeze(
    Object.fromEntries(
      MODE_VARIANT_KEYS.map((mode) => [mode, DEFAULT_IDENTITIES[mode]] as const),
    ) as Record<ModeVariantKey, readonly string[]>,
  )

/** Fallback variant for an unknown mode value — the SAME text as the identity
 *  slice's {@link UNKNOWN_MODE_IDENTITY} (single SSOT), wrapped in the
 *  {@link ModeVariant} shape the registry returns. */
export const UNKNOWN_MODE_VARIANT: ModeVariant = Object.freeze({
  mode: "default" as ModeVariantKey,
  identity: UNKNOWN_MODE_IDENTITY,
})
