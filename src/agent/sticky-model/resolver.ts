/**
 * Sticky model resolver (ADR-0212).
 *
 * The single composition point for "which modelId does this mode use?".
 * Precedence is enforced HERE, not at every caller, so a downstream
 * surface (CLI flag, slash command, daemon RPC) cannot drift from the
 * spec by accident.
 *
 * Precedence (highest first):
 *   1. `explicitOverride`  — caller-supplied (CLI `--model`, slash arg)
 *   2. sticky store entry  — what the user picked last time for this mode
 *   3. `globalDefault`     — the env / project default
 *
 * Pure-by-contract once a store is wired: the resolver makes ONE store
 * read per call, falls back to the global default on any error, and
 * never throws.
 */

import type { AgentMode } from "../prompt"
import type { StickyModelResolver, StickyModelStore } from "./port"

/** Construct a {@link StickyModelResolver} backed by `store`. The store is
 *  injected (not constructed inside) so callers control fs-vs-memory at
 *  the composition root and tests can inject hand-rolled stores. */
export const stickyModelResolver = (store: StickyModelStore): StickyModelResolver => {
  return {
    async resolve(input: {
      mode: AgentMode
      globalDefault: string
      explicitOverride?: string
    }): Promise<string> {
      if (input.explicitOverride !== undefined && input.explicitOverride.length > 0) {
        return input.explicitOverride
      }
      const sticky = await store.get({ mode: input.mode })
      if (sticky !== undefined && sticky.length > 0) return sticky
      return input.globalDefault
    },
  }
}
