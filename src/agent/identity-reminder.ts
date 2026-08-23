import type { AgentMode } from "./prompt"
import type { AgentConfig } from "./types"

/**
 * Per-turn IDENTITY REMINDER (ADR-0240 §C).
 *
 * ONE responsibility: decide whether this turn gets an identity
 * `<system-reminder>` and render it. The decision half
 * (`shouldSpliceIdentityReminder`) owns the tri-state knob — default-OFF with
 * no slot, mode-conditional auto-ON for the modes in `REMINDER_AUTO_ON_MODES`
 * when the knob is unset, explicit `true`/`false` overriding every mode — and
 * the render half (`buildIdentityReminderText`) resolves the active variant
 * through the registry, degrading OBSERVABLY (never throwing) when it fails.
 *
 * The two halves share the auto-ON mode set and must stay in lockstep — a
 * render that disagreed with the decision would splice a reminder nobody asked
 * for — so they are one module.
 *
 * Split out of `loop-helpers.ts` (god-module ratchet) — pure move, no logic
 * change; every name stays re-exported from there.
 */

// ─── ADR-0240 §C — Identity per-turn reminder ──────────────────────────

const REMINDER_AUTO_ON_MODES: ReadonlySet<AgentMode> = new Set([
  "architect" as AgentMode,
  "editor" as AgentMode,
])

/** Decide whether the per-turn identity reminder should be spliced for the
 *  given `mode`. Default-OFF when the slot is absent. Mode-conditional
 *  auto-ON for `architect | editor` when `perTurnReminderEnabled` is
 *  `undefined`. Explicit `true` enables every mode; explicit `false`
 *  disables every mode. */
export const shouldSpliceIdentityReminder = (cfg: AgentConfig, mode: AgentMode): boolean => {
  const slot = cfg.identityModeVariant
  if (slot === undefined) return false
  const knob = slot.perTurnReminderEnabled
  if (knob === false) return false
  if (knob === true) return true
  return REMINDER_AUTO_ON_MODES.has(mode)
}

/** Render the per-turn identity reminder text for the given `mode`. Returns
 *  `undefined` when the splice should not fire (knob off / slot absent /
 *  empty identity / registry throw). The text is wrapped in
 *  `<system-reminder>...</system-reminder>` markers; body is the variant's
 *  `identity` lines joined by `\n`. Pure given the registry.
 *
 *  ALBB-14 — the registry-throw branch USED to swallow silently (bare
 *  `catch { return undefined }`), so a knob-ON splice whose `variantFor` threw
 *  vanished with no trace (the knob-on-but-inert failure class). The optional
 *  `onRegistryThrow` observer makes that path observable WITHOUT changing the
 *  return contract: when `shouldSpliceIdentityReminder` said "yes" but the
 *  registry throws, the observer fires with the error. Absent observer ⇒
 *  byte-identical to the prior swallow (still returns `undefined`, never
 *  throws) — the §C unit tests that call this with 2 args are unaffected. */
export const buildIdentityReminderText = (
  cfg: AgentConfig,
  mode: AgentMode,
  onRegistryThrow?: (e: unknown) => void,
): string | undefined => {
  if (!shouldSpliceIdentityReminder(cfg, mode)) return undefined
  const slot = cfg.identityModeVariant
  if (slot === undefined) return undefined
  let identity: readonly string[] | undefined
  try {
    const activeMode = slot.activeMode?.() ?? mode
    const variant = slot.registry.variantFor(activeMode)
    identity = variant.identity
  } catch (e) {
    // Observable-drop: the splice was requested (knob true / mode auto-ON) but
    // the registry blew up. Surface it so an opted-in operator sees WHY the
    // reminder disappeared instead of a silent no-op. Never rethrows.
    onRegistryThrow?.(e)
    return undefined
  }
  if (identity === undefined || identity.length === 0) return undefined
  return `<system-reminder>\n${identity.join("\n")}\n</system-reminder>`
}
