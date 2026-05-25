/**
 * Tool-profile adapter (ADR-0291 — REPL slash-surface ctx mega-wire).
 *
 * Adapts `AgentConfig.toolProfile` (ADR-0213 `ToolProfileResolver` +
 * default name) onto the `SlashContext.profile` shape `/profile`
 * consumes. The active profile name lives in a tiny mutable cell owned
 * by THIS adapter — surfaces that want a multi-process source-of-truth
 * (Tauri) can replace the cell with their own getter/setter pair. No-
 * throw; unknown names return `{ kind: "unknown", known }`.
 */

import {
  ALL_TOOL_PROFILE_NAMES,
  isToolProfileName,
  type ToolProfileName,
  type ToolProfileResolver,
} from "@/agent/tool-profile"

export interface ToolProfileAdapter {
  readonly get: () => string
  readonly set: (
    name: string,
  ) => "ok" | { readonly kind: "unknown"; readonly known: readonly string[] }
  readonly list: () => readonly string[]
}

export interface ToolProfileAdapterArgs {
  readonly resolver: ToolProfileResolver
  readonly defaultName?: ToolProfileName
}

/** Build the adapter over the AgentConfig.toolProfile block. The
 *  `resolver` is captured but never re-called by the adapter — the
 *  CLI slash only mutates the active NAME; the resolver's policy is
 *  consumed downstream by the admissibility gate. */
export const buildToolProfileAdapter = (args: ToolProfileAdapterArgs): ToolProfileAdapter => {
  let active: ToolProfileName = args.defaultName ?? "write"
  // Silence the resolver-unused warning while keeping it captured for a
  // future audit lens that asserts the adapter knows its resolver.
  void args.resolver
  return {
    get: (): string => active,
    set: (name: string): "ok" | { readonly kind: "unknown"; readonly known: readonly string[] } => {
      if (!isToolProfileName(name)) {
        return { kind: "unknown", known: ALL_TOOL_PROFILE_NAMES }
      }
      active = name
      return "ok"
    },
    list: (): readonly string[] => ALL_TOOL_PROFILE_NAMES,
  }
}
