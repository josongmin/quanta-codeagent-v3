/**
 * Identity-mode adapter (ADR-0291 — REPL slash-surface ctx mega-wire;
 * ADR-0302 — optional `onChange` hook for mid-session prompt rebuild).
 *
 * Adapts `AgentConfig.identityModeVariant.registry` (ADR-0211 mode-
 * variant registry) onto the `SlashContext.identity` shape `/identity`
 * consumes. The active mode lives in a tiny mutable cell owned by THIS
 * adapter. ADR-0302 adds an OPTIONAL `onChange(newMode)` callback the
 * surface uses to refresh the per-turn system prompt — absent ⇒ behavior
 * is byte-identical to ADR-0291 (state-only swap, stale prompt). No-
 * throw; unknown modes return `{ kind: "unknown", known }` and never
 * fire `onChange`.
 */

import {
  MODE_VARIANT_KEYS,
  type ModeVariantKey,
  type SystemPromptVariantRegistry,
} from "@/agent/system-prompt"

export interface IdentityModeAdapter {
  readonly get: () => string
  readonly set: (
    mode: string,
  ) => "ok" | { readonly kind: "unknown"; readonly known: readonly string[] }
  readonly list: () => readonly string[]
}

export interface IdentityModeAdapterArgs {
  readonly registry: SystemPromptVariantRegistry
  readonly defaultMode?: ModeVariantKey
  /** ADR-0302 — fired exactly once AFTER a successful `set(mode)` swap.
   *  The surface uses this to trigger `SystemPromptRebuilderPort.rebuild()`
   *  and update its `SystemSource` so the next turn's `AgentConfig.system`
   *  reflects the new mode. NEVER fired on rejected (unknown) modes.
   *  Absent ⇒ adapter behavior is byte-identical to ADR-0291 ship. */
  readonly onChange?: (mode: ModeVariantKey) => void
}

const isModeVariantKey = (s: string): s is ModeVariantKey =>
  (MODE_VARIANT_KEYS as readonly string[]).includes(s)

/** Build the adapter over the AgentConfig.identityModeVariant block. */
export const buildIdentityModeAdapter = (args: IdentityModeAdapterArgs): IdentityModeAdapter => {
  let active: ModeVariantKey = args.defaultMode ?? "default"
  // Capture registry for future surfaces that may want to re-introspect
  // the variant at query time. Not consumed by `/identity` today.
  void args.registry
  const onChange = args.onChange
  return {
    get: (): string => active,
    set: (mode: string): "ok" | { readonly kind: "unknown"; readonly known: readonly string[] } => {
      if (!isModeVariantKey(mode)) {
        return { kind: "unknown", known: MODE_VARIANT_KEYS }
      }
      active = mode
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
    list: (): readonly string[] => MODE_VARIANT_KEYS,
  }
}
