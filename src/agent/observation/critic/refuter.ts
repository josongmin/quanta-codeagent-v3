/**
 * Observation kernel — the OwnerCritic ENGINE-ADAPTER seam (jul-6, Stream S1).
 * Design SSOT: docs/plans/jul-6-observation-providers/README.md §5.
 *
 * `OwnerRefuter` is the port a static engine (semantica callgraph / def-use)
 * implements to feed the critic. It is deliberately THIN: given the symbol the
 * model is about to edit, return the graph facts the critic needs to decide the
 * 3-way verdict — OR `null` when the engine has no facts for that target.
 *
 * This file ships ONLY the seam + a deterministic table-driven FAKE for tests.
 * The real semantica adapter is a follow-up (do NOT integrate the MCP engine
 * here). The critic (`owner-critic.ts`) consumes this port and never talks to
 * an engine directly.
 *
 * HARD invariant (audit — incompleteness leak): the engine MUST report its own
 * blind spots via `staticallyComplete=false` + `incompletenessReasons` (dynamic
 * dispatch / reflection). The critic uses that to DOWNGRADE a would-be proof to
 * `inconclusive` — a static "no path" is only a PROOF when the engine had full
 * visibility. Adapters must never claim completeness they cannot back.
 */

import type { EditTarget } from "../critic"
import type { TaskContext } from "../port"

/**
 * Graph facts the engine reports for ONE edit target. Every field is an OBSERVED
 * engine fact, never a verdict — the critic derives the verdict. `null` from
 * `query` (target unknown to the engine) is distinct from these facts and maps
 * to `inconclusive`, so absence-of-facts is never mistaken for a clean result.
 */
export interface GraphFacts {
  /** The target these facts describe (echoed for provenance / fake table match). */
  readonly target: EditTarget
  /**
   * Does the callgraph have ANY path from a known entrypoint to the edited
   * symbol? `false` is only a PROOF of unreachability when `staticallyComplete`.
   */
  readonly reachableFromEntrypoints: boolean
  /**
   * Is the edited symbol shadowed by an override that runs instead (so the
   * edited definition never executes on the runtime path)?
   */
  readonly shadowedByOverride: boolean
  /** The overriding symbol, when `shadowedByOverride` — named in the refutation. */
  readonly shadowingSymbol?: string
  /**
   * Did the engine have FULL static visibility for this target? `false` when
   * dynamic dispatch / reflection / other blind spots were detected — in which
   * case NO negative fact above can be treated as proof.
   */
  readonly staticallyComplete: boolean
  /** Human-readable blind-spot reasons, present iff `!staticallyComplete`. */
  readonly incompletenessReasons?: readonly string[]
}

/**
 * The engine-adapter SEAM real semantica must implement.
 *
 * Contract:
 *   - `query(edited, ctx)` returns the graph facts for `edited`, or `null` when
 *     the engine has NO facts for that target (unknown symbol / not indexed).
 *   - MUST be deterministic for a fixed repo state (replay/cassette safety).
 *   - MUST NOT fabricate completeness: report blind spots via
 *     `staticallyComplete=false` + `incompletenessReasons`.
 */
export interface OwnerRefuter {
  query(edited: EditTarget, ctx: TaskContext): Promise<GraphFacts | null>
}

/** Canonical table key: file + symbol (undefined symbol ⇒ file-level entry).
 *  JSON-encoded so no file path / symbol can forge a collision (unlike a raw
 *  separator char). File-level (`symbol` undefined) and symbol-level entries key
 *  distinctly. */
const factsKey = (t: EditTarget): string => JSON.stringify([t.file, t.symbol ?? null])

/**
 * Deterministic, table-driven fake `OwnerRefuter` for unit tests. Looks up facts
 * by exact (file, symbol) identity; an unregistered target returns `null` (the
 * fake invents no facts). Pure — no IO, no engine.
 */
export const makeFakeOwnerRefuter = (facts: readonly GraphFacts[]): OwnerRefuter => {
  const table = new Map<string, GraphFacts>()
  for (const f of facts) table.set(factsKey(f.target), f)
  return {
    query: async (edited) => table.get(factsKey(edited)) ?? null,
  }
}
