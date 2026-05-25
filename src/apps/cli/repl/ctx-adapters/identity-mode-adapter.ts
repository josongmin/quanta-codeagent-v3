/**
 * Identity-mode adapter (ADR-0291 — REPL slash-surface ctx mega-wire).
 *
 * Adapts `AgentConfig.identityModeVariant.registry` (ADR-0211 mode-
 * variant registry) onto the `SlashContext.identity` shape `/identity`
 * consumes. The active mode lives in a tiny mutable cell owned by THIS
 * adapter — the slash mutation does NOT rebuild the system prompt (the
 * registry feeds prompt assembly at session-start; mid-session switches
 * are surface-state only until a follow-up ADR re-wires hot-swap). No-
 * throw; unknown modes return `{ kind: "unknown", known }`.
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
}

const isModeVariantKey = (s: string): s is ModeVariantKey =>
  (MODE_VARIANT_KEYS as readonly string[]).includes(s)

/** Build the adapter over the AgentConfig.identityModeVariant block. */
export const buildIdentityModeAdapter = (args: IdentityModeAdapterArgs): IdentityModeAdapter => {
  let active: ModeVariantKey = args.defaultMode ?? "default"
  // Capture registry for future surfaces that may want to re-introspect
  // the variant at query time. Not consumed by `/identity` today.
  void args.registry
  return {
    get: (): string => active,
    set: (mode: string): "ok" | { readonly kind: "unknown"; readonly known: readonly string[] } => {
      if (!isModeVariantKey(mode)) {
        return { kind: "unknown", known: MODE_VARIANT_KEYS }
      }
      active = mode
      return "ok"
    },
    list: (): readonly string[] => MODE_VARIANT_KEYS,
  }
}
