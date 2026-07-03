/**
 * Identity-mode adapter (ADR-0291 — REPL slash-surface ctx mega-wire;
 * ADR-0302 — optional `onChange` hook for mid-session prompt rebuild).
 *
 * Adapts `AgentConfig.identityModeVariant.registry` (ADR-0211 mode-
 * variant registry) onto the `SlashContext.identity` shape `/identity`
 * consumes. The adapter never owns its own mutable cell; `get/set` read and
 * mutate the authoritative session-owned state. ADR-0302 keeps the optional
 * `onChange(newMode)` callback so the surface can refresh derived prompt
 * sources after the shared state flips.
 */

import {
  MODE_VARIANT_KEYS,
  type ModeVariantKey,
  type SystemPromptVariantRegistry,
} from "@/agent/system-prompt"

/** B1 (jul-03) — the identity-only virtual mode token. `onboarding` lives in
 *  `IdentityMode` (superset of `AgentMode`) but is NOT a `ModeVariantKey`, so it
 *  is targeted through a DEDICATED hook (`onOnboarding`), never the mode-variant
 *  registry (`buildSystemPromptForMode` is `ModeVariantKey`-typed and would
 *  type-error). Kept as a string literal here so the adapter can offer it as a
 *  reachable `/identity` / `/onboard` target without widening `ModeVariantKey`. */
export const ONBOARDING_IDENTITY_KEY = "onboarding" as const

export interface IdentityModeAdapter {
  readonly get: () => string
  readonly set: (
    mode: string,
  ) => "ok" | { readonly kind: "unknown"; readonly known: readonly string[] }
  readonly list: () => readonly string[]
}

export interface IdentityModeAdapterArgs {
  readonly registry: SystemPromptVariantRegistry
  readonly getActive?: () => ModeVariantKey
  readonly setActive?: (mode: ModeVariantKey) => void
  readonly defaultMode?: ModeVariantKey
  /** ADR-0302 — fired exactly once AFTER a successful `set(mode)` swap.
   *  The surface uses this to trigger `SystemPromptRebuilderPort.rebuild()`
   *  and update its `SystemSource` so the next turn's `AgentConfig.system`
   *  reflects the new mode. NEVER fired on rejected (unknown) modes.
   *  Absent ⇒ adapter behavior is byte-identical to ADR-0291 ship. */
  readonly onChange?: (mode: ModeVariantKey) => void
  /** B1 (jul-03) — hook fired when the caller targets the identity-only
   *  `onboarding` virtual mode (via `/identity onboarding` or `/onboard`). When
   *  supplied, the adapter accepts `onboarding` as a valid target and offers it in
   *  `list()`; absent ⇒ `onboarding` is rejected as unknown (byte-identical to the
   *  ADR-0291 ship, which only knew `ModeVariantKey`s). The surface routes this
   *  through the identity provider's onboarding branch + a prompt rebuild. */
  readonly onOnboarding?: () => void
}

const isModeVariantKey = (s: string): s is ModeVariantKey =>
  (MODE_VARIANT_KEYS as readonly string[]).includes(s)

/** Build the adapter over the AgentConfig.identityModeVariant block. */
export const buildIdentityModeAdapter = (args: IdentityModeAdapterArgs): IdentityModeAdapter => {
  let active: ModeVariantKey | typeof ONBOARDING_IDENTITY_KEY = args.defaultMode ?? "default"
  const onChange = args.onChange
  const onOnboarding = args.onOnboarding
  // B1 — the reachable target list: the mode-variant keys PLUS the onboarding
  // virtual mode when its hook is wired.
  const knownTargets = (): readonly string[] =>
    onOnboarding !== undefined ? [...MODE_VARIANT_KEYS, ONBOARDING_IDENTITY_KEY] : MODE_VARIANT_KEYS
  return {
    get: (): string => args.getActive?.() ?? active,
    set: (mode: string): "ok" | { readonly kind: "unknown"; readonly known: readonly string[] } => {
      // B1 — the identity-only onboarding virtual mode routes through its dedicated
      // hook (NOT the ModeVariantKey registry). Only reachable when wired.
      if (mode === ONBOARDING_IDENTITY_KEY) {
        if (onOnboarding === undefined) {
          return { kind: "unknown", known: knownTargets() }
        }
        active = ONBOARDING_IDENTITY_KEY
        onOnboarding()
        return "ok"
      }
      if (!isModeVariantKey(mode)) {
        return { kind: "unknown", known: knownTargets() }
      }
      if (args.setActive !== undefined) args.setActive(mode)
      else active = mode
      // ADR-0302 — onChange fires AFTER the cell update so a callback
      // that reads `adapter.get()` synchronously already sees the new
      // value. The callback is no-throw by contract (the surface wraps
      // its rebuilder); a misbehaving callback that throws would bubble
      // straight back to the slash handler, so wrap defensively.
      if (onChange !== undefined) {
        try {
          onChange(mode)
        } catch {
          // Swallow — `/identity` MUST NOT regress to an error exit just
          // because the rebuilder threw. The rebuilder itself owns its
          // own no-throw fallback (SYSTEM_PROMPT_REBUILD_FALLBACK_PREFIX);
          // this catch is the belt for the suspenders.
        }
      }
      return "ok"
    },
    list: (): readonly string[] => knownTargets(),
  }
}
