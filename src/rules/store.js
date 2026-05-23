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
import { matchCommand } from "./matcher";
import { parseRules } from "./parser";
/** Layers in DESCENDING precedence order — `match()` iterates this exact
 *  sequence. Kept as a module constant so there is one SSOT for ordering. */
const LAYER_PRECEDENCE = ["project", "user", "system"];
/**
 * 3-layer prefix-rule store. Each layer holds an independently-parsed rule
 * list. `match()` walks layers in precedence order and returns the first
 * matched rule.
 */
export class RulesStore {
    // Per-layer rule arrays. Replaced wholesale by `loadLayer` / `clear`
    // (never mutated in-place), so cached external references remain valid
    // snapshots.
    system = [];
    user = [];
    project = [];
    /**
     * Parse `text` and install the result as the entire contents of `layer`.
     * Replaces any previously-loaded rules for that layer (no merge — caller
     * concatenates source text if they want to compose multiple files within
     * one layer).
     *
     * @throws RuleParseError on malformed input. The store state is NOT
     * mutated when parsing fails (atomic install).
     */
    loadLayer(layer, text, sourceFile) {
        // Parse FIRST. If `parseRules` throws, the store is untouched —
        // callers see all-or-nothing semantics.
        const parsed = parseRules(text, layer, sourceFile);
        this.assignLayer(layer, parsed);
    }
    /** Match `command` against all layers in precedence order. Returns the
     *  first matching rule, or `{ kind: "no_match" }` if no layer fires. */
    match(command) {
        for (const layer of LAYER_PRECEDENCE) {
            const rules = this.getLayer(layer);
            const outcome = matchCommand(command, rules);
            if (outcome.kind === "matched") {
                return outcome;
            }
        }
        return { kind: "no_match" };
    }
    /** Remove all rules from `layer`. Other layers are untouched. */
    clear(layer) {
        this.assignLayer(layer, []);
    }
    /** Frozen snapshot of all layers. The returned arrays are the live
     *  internal arrays; they are frozen at install time and never mutated
     *  in-place, so the snapshot is safe to hold past subsequent
     *  `loadLayer` / `clear` calls (which install new arrays rather than
     *  mutating these). */
    snapshot() {
        return Object.freeze({
            system: this.system,
            user: this.user,
            project: this.project,
        });
    }
    // ─── internals ───────────────────────────────────────────────────────
    getLayer(layer) {
        switch (layer) {
            case "system":
                return this.system;
            case "user":
                return this.user;
            case "project":
                return this.project;
        }
    }
    assignLayer(layer, rules) {
        // The parser already freezes its return value, but `clear()` passes an
        // empty literal — freeze defensively so the invariant holds for both
        // entry points (no `Object.isFrozen` branching needed downstream).
        const frozen = Object.isFrozen(rules) ? rules : Object.freeze([...rules]);
        switch (layer) {
            case "system":
                this.system = frozen;
                return;
            case "user":
                this.user = frozen;
                return;
            case "project":
                this.project = frozen;
                return;
        }
    }
}
