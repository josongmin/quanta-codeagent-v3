/**
 * RFC-08 BUILD-1 — bindable `effort-cycle` key action, PURE core.
 *
 * ONE pure leaf: `nextSupportedEffort(current, support)`. It owns NO state, NO
 * store, NO model table. The keybinding-dispatch branch (`raw-line-reader/
 * keymap.ts`) calls the composed `onCycleEffort` callback, which reads the
 * EXISTING session `EffortStore` and slash model wire's `current()` /
 * `effortSupport()`, computes the next supported tier via this leaf, and calls
 * the EXISTING `effort.set(next)`. There is no `EffortCycleStore` and no second
 * effort/model cell (README single-owner matrix: reasoning effort state =
 * `EffortStore` + slash model wire).
 *
 * Cycle semantics (RFC-08 §"Cycle semantics"):
 *   - Advance through the model's `supportedEfforts` in the order they are
 *     declared, wrapping from the last element back to the first
 *     (`default → low → medium → high → max → default` on a five-tier model).
 *   - A non-reasoning model with `supportedEfforts:["default"]` is a fixpoint
 *     (the single element wraps to itself).
 *   - If the CURRENT tier is not in `supportedEfforts`, recover to the model's
 *     `defaultEffort` (NOT the next tier) — the next press then advances from
 *     there. This never emits an unsupported tier.
 *   - UNKNOWN model metadata (`support === undefined`) follows the conservative
 *     model-picker posture: use the canonical five tiers in ascending order,
 *     NOT a guessed family classifier. This mirrors `clampEffortForModel`'s
 *     "unknown ⇒ all supported" fallback so the two never disagree.
 *
 * Leaf discipline: type-only cross-slice imports. `EffortLevel` is the CANONICAL
 * effort vocabulary from `@/agent`; `ModelEffortSupport` / `ReasoningEffort` are
 * the per-model metadata SSOT from `@/llm/provider-metadata`. Assigning the
 * metadata slugs into `EffortLevel` here is a compile-checked unification point
 * (a tier added to one union but not the other is a build error in this file).
 */

import type { EffortLevel } from "@/agent"
import {
  ALL_REASONING_EFFORTS,
  type ModelEffortSupport,
  type ReasoningEffort,
} from "@/llm/provider-metadata"

/**
 * Compile-checked unification of provider-metadata `ReasoningEffort` slugs into
 * the canonical `@/agent` `EffortLevel`, parallel to the picker's
 * `REASONING_EFFORT_TO_LEVEL`. A `Record<ReasoningEffort, EffortLevel>` is
 * EXHAUSTIVE (TS requires an entry for every slug) AND value-typed (each value
 * must be a real `EffortLevel`) — so a dropped/renamed tier is a build error
 * here rather than a silent `as` cast.
 */
const REASONING_EFFORT_TO_LEVEL: Record<ReasoningEffort, EffortLevel> = {
  default: "default",
  low: "low",
  medium: "medium",
  high: "high",
  max: "max",
}

const toEffortLevel = (e: ReasoningEffort): EffortLevel => REASONING_EFFORT_TO_LEVEL[e]

/**
 * Compute the next reasoning-effort tier for a bound `effort-cycle` press.
 *
 *   - `support === undefined` (UNKNOWN model) ⇒ cycle the canonical five tiers
 *     (`ALL_REASONING_EFFORTS`, ascending) — the conservative model-picker
 *     posture. Never invents a family classifier.
 *   - `current` IS in the supported list ⇒ advance to the NEXT element,
 *     wrapping the last back to the first.
 *   - `current` is NOT supported ⇒ recover to `support.defaultEffort` (the
 *     model's declared fallback), NOT the next tier. The following press then
 *     advances from there. Never emits a tier outside the supported list.
 *
 * Pure — no I/O, no store mutation. The caller applies the returned tier via the
 * EXISTING `effort.set` path.
 */
export const nextSupportedEffort = (
  current: EffortLevel,
  support: ModelEffortSupport | undefined,
): EffortLevel => {
  // Unknown model ⇒ conservative canonical five-tier cycle (ascending order).
  const slugs: readonly ReasoningEffort[] =
    support === undefined ? ALL_REASONING_EFFORTS : support.supportedEfforts
  const supported = slugs.map(toEffortLevel)
  // A model with no declared tiers cannot cycle — degrade to the current value
  // (defensive; the metadata SSOT always lists at least `"default"`).
  if (supported.length === 0) return current
  const idx = supported.indexOf(current)
  if (idx === -1) {
    // Current tier is unsupported: recover to the model's declared default
    // (which MUST be a member of supportedEfforts). Never advance to a tier the
    // model does not accept. When support is undefined the canonical list
    // always contains `current` for a real EffortLevel, so this branch is the
    // unsupported-on-a-known-model recovery.
    // `supported[0]` is in-bounds (length > 0 above); `?? current` satisfies the
    // no-unchecked-index guard without changing the proven behavior.
    return support === undefined ? (supported[0] ?? current) : toEffortLevel(support.defaultEffort)
  }
  // Advance, wrapping the last element back to the first (single-element list is
  // a fixpoint: (0 + 1) % 1 === 0). In-bounds by construction; `?? current`
  // satisfies the no-unchecked-index guard.
  return supported[(idx + 1) % supported.length] ?? current
}
