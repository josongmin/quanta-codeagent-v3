/**
 * Tool-profile adapter (ADR-0291 — REPL slash-surface ctx mega-wire).
 *
 * Adapts the authoritative session-owned tool-profile state onto the
 * `SlashContext.profile` shape `/profile` consumes. The adapter never owns
 * its own mutable cell; `get/set` read and mutate the same state object the
 * admissibility gate re-reads on the next turn.
 */

import {
  ALL_TOOL_PROFILE_NAMES,
  isToolProfileName,
  type ToolProfileName,
} from "@/agent/tool-profile"

export interface ToolProfileAdapter {
  readonly get: () => string
  readonly set: (
    name: string,
  ) => "ok" | { readonly kind: "unknown"; readonly known: readonly string[] }
  readonly list: () => readonly string[]
}

export interface ToolProfileAdapterArgs {
  readonly getActive?: () => ToolProfileName
  readonly setActive?: (name: ToolProfileName) => void
  readonly defaultName?: ToolProfileName
}

export const buildToolProfileAdapter = (args: ToolProfileAdapterArgs): ToolProfileAdapter => {
  let active: ToolProfileName = args.defaultName ?? "write"
  return {
    get: (): string => args.getActive?.() ?? active,
    set: (name: string): "ok" | { readonly kind: "unknown"; readonly known: readonly string[] } => {
      if (!isToolProfileName(name)) {
        return { kind: "unknown", known: ALL_TOOL_PROFILE_NAMES }
      }
      if (args.setActive !== undefined) args.setActive(name)
      else active = name
      return "ok"
    },
    list: (): readonly string[] => ALL_TOOL_PROFILE_NAMES,
  }
}
