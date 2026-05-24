/**
 * 3-layer rule store with explicit precedence.
 *
 * Layer precedence at match time is FIXED and ordered:
 *   project > user > system
 *
 * Within a layer, longest-prefix-match wins (see `matcher.ts`). BETWEEN
 * layers, the higher-precedence layer ALWAYS wins, even if its match is a
 * shorter prefix than a lower-layer match. This is intentional — a project
 * override of `git push` should beat a system rule for `git push --force`.
 *
 * Concurrency: this module assumes single-threaded execution (Bun /
 * Node main loop). It is NOT safe to mutate a `RulesStore` instance from
 * multiple event-loop turns interleaved with `match()` calls without
 * external synchronisation. The store carries no implicit locking — the
 * caller owns the lifecycle.
 *
 * Determinism: every public method is a total function of inputs + current
 * state. No clocks, no fallbacks, no silent error recovery.
 */

import { matchPreparedCommand, prepareRulesForMatch } from "./matcher"
import { parseRules } from "./parser"
import type { MatchOutcome, Rule, RuleLayer } from "./types"

/** Layers in DESCENDING precedence order — `match()` iterates this exact
 *  sequence. Kept as a module constant so there is one SSOT for ordering. */
const LAYER_PRECEDENCE: readonly RuleLayer[] = ["project", "user", "system"]

/** Snapshot returned by `RulesStore.snapshot()` — a frozen, deep-immutable
 *  view of the store contents at call time. Useful for diagnostics and
 *  trajectory recording. */
export interface RulesSnapshot {
  readonly system: readonly Rule[]
  readonly user: readonly Rule[]
  readonly project: readonly Rule[]
}

/**
 * 3-layer prefix-rule store. Each layer holds an independently-parsed rule
 * list. `match()` walks layers in precedence order and returns the first
 * matched rule.
 */
export class RulesStore {
  // Per-layer rule arrays. Replaced wholesale by `loadLayer` / `clear`
  // (never mutated in-place), so cached external references remain valid
  // snapshots.
  private system: readonly Rule[] = []
  private user: readonly Rule[] = []
  private project: readonly Rule[] = []
  // Per-layer prepared match order. Kept separate so `snapshot()` preserves
  // source order while the hot path scans longest-prefix order directly.
  private systemPrepared: readonly Rule[] = []
  private userPrepared: readonly Rule[] = []
  private projectPrepared: readonly Rule[] = []

  /**
   * Parse `text` and install the result as the entire contents of `layer`.
   * Replaces any previously-loaded rules for that layer (no merge — caller
   * concatenates source text if they want to compose multiple files within
   * one layer).
   *
   * @throws RuleParseError on malformed input. The store state is NOT
   * mutated when parsing fails (atomic install).
   */
  public loadLayer(layer: RuleLayer, text: string, sourceFile: string): void {
    // Parse FIRST. If `parseRules` throws, the store is untouched —
    // callers see all-or-nothing semantics.
    const parsed = parseRules(text, layer, sourceFile)
    this.assignLayer(layer, parsed)
  }

  /** Match `command` against all layers in precedence order. Returns the
   *  first matching rule, or `{ kind: "no_match" }` if no layer fires. */
  public match(command: string): MatchOutcome {
    for (const layer of LAYER_PRECEDENCE) {
      const rules = this.getPreparedLayer(layer)
      const outcome = matchPreparedCommand(command, rules)
      if (outcome.kind === "matched") {
        return outcome
      }
    }
    return { kind: "no_match" }
  }

  /** Remove all rules from `layer`. Other layers are untouched. */
  public clear(layer: RuleLayer): void {
    this.assignLayer(layer, [])
  }

  /** Frozen snapshot of all layers. The returned arrays are the live
   *  internal arrays; they are frozen at install time and never mutated
   *  in-place, so the snapshot is safe to hold past subsequent
   *  `loadLayer` / `clear` calls (which install new arrays rather than
   *  mutating these). */
  public snapshot(): RulesSnapshot {
    return Object.freeze({
      system: this.system,
      user: this.user,
      project: this.project,
    })
  }

  // ─── internals ───────────────────────────────────────────────────────

  private getLayer(layer: RuleLayer): readonly Rule[] {
    switch (layer) {
      case "system":
        return this.system
      case "user":
        return this.user
      case "project":
        return this.project
    }
  }

  private assignLayer(layer: RuleLayer, rules: readonly Rule[]): void {
    // The parser already freezes its return value, but `clear()` passes an
    // empty literal — freeze defensively so the invariant holds for both
    // entry points (no `Object.isFrozen` branching needed downstream).
    const frozen = Object.isFrozen(rules) ? rules : Object.freeze([...rules])
    const prepared = prepareRulesForMatch(frozen)
    switch (layer) {
      case "system":
        this.system = frozen
        this.systemPrepared = prepared
        return
      case "user":
        this.user = frozen
        this.userPrepared = prepared
        return
      case "project":
        this.project = frozen
        this.projectPrepared = prepared
        return
    }
  }

  private getPreparedLayer(layer: RuleLayer): readonly Rule[] {
    switch (layer) {
      case "system":
        return this.systemPrepared
      case "user":
        return this.userPrepared
      case "project":
        return this.projectPrepared
    }
  }
}
