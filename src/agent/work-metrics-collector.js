/**
 * Per-turn work-metrics collector (absorb #6, ADR-0064 wiring).
 *
 * A small mutable accumulator the loop pokes during a turn:
 *   - {@link recordToolCall}   bumps `agentActions`
 *   - {@link recordRead}       bumps `linesRead` when a `read` tool result lands
 *   - {@link recordUsage}      sums LLM input/output/cacheRead tokens
 *   - {@link recordDiff}       folds `git diff --numstat` rows into `diffMap`
 *   - {@link finalize}         returns a frozen {@link WorkMetrics} snapshot via
 *                              {@link buildWorkMetrics} (cost derived when the
 *                              caller supplies a known model)
 *
 * Why this lives in `@/agent`, not `@/observability`:
 * The slice rule (`biome.noRestrictedImports`) lets `@/agent` import
 * `@/observability/work-metrics` but NOT vice versa, AND the collector needs
 * the loop's tool/usage signals — which are agent-loop concepts. So the pure
 * observable module stays in `@/observability` and the wiring surface lives
 * here. The collector itself imports ONLY from `@/observability/work-metrics`.
 *
 * Default-OFF contract (RFC §1.2): the loop only instantiates a collector when
 * `AgentConfig.workMetricsSink !== undefined`. With the sink absent, this
 * module is unreferenced at runtime and the loop is byte-identical to the
 * pre-absorption path.
 */
import { buildWorkMetrics, parseNumstat, } from "@/observability";
/** Mutable per-turn accumulator. One instance per turn; finalize at turn end.
 *
 * Pure logic (no clock, no IO). Fields are private and only touched through
 * the `recordX` / `finalize` methods so the contract is easy to audit. */
export class TurnWorkMetricsCollector {
    agentActions = 0;
    linesRead = 0;
    tokensInput = 0;
    tokensOutput = 0;
    cacheReadTokens = undefined;
    // Per-file running totals. Indexed by path so a same-file second emit
    // (e.g. a numstat row landing twice via two `git diff` calls) accumulates
    // rather than duplicates.
    diffByFile = new Map();
    /** A tool call completed (success OR error — actions count work attempted,
     *  same as the pre-wired `agent.tool_calls` counter). `result` is accepted
     *  to keep the call-site uniform with `recordRead`; the value is unused for
     *  generic tools so the loop can pipe ALL dispatch results through one
     *  collector method. */
    recordToolCall(_name, _result) {
        this.agentActions += 1;
    }
    /** When the tool is `read`, count the lines returned and add to `linesRead`.
     *  Detection is duck-typed by name (no `@/tool` import — preserves the
     *  collector's lone dependency on `@/observability`). `output` may be the
     *  full string returned by the tool OR an `{output:string}` envelope; both
     *  shapes are accepted because dispatch sites carry either. Lines are
     *  counted by `\n` splits — empty/whitespace-only outputs yield 0. */
    recordRead(name, output) {
        if (name !== "read")
            return;
        const text = this.extractText(output);
        if (text === undefined)
            return;
        // An empty string is 0 lines; one line of content with no trailing newline
        // is 1 line; n newlines + non-empty tail is n+1 lines. `split("\n")` gives
        // the natural count and we drop the trailing empty when the text ended in
        // `\n` so `"a\nb\n"` reports 2 lines, not 3.
        if (text === "")
            return;
        const parts = text.split("\n");
        const last = parts[parts.length - 1];
        const lines = last === "" ? parts.length - 1 : parts.length;
        this.linesRead += lines;
    }
    /** Fold one usage report from a model stream. `cacheReadTokens` is summed
     *  lazily — when never observed it stays `undefined` (preserves the
     *  optional contract on the emitted {@link WorkMetrics}). */
    recordUsage(u) {
        this.tokensInput += u.tokensInput;
        this.tokensOutput += u.tokensOutput;
        if (u.cacheReadTokens !== undefined) {
            this.cacheReadTokens = (this.cacheReadTokens ?? 0) + u.cacheReadTokens;
        }
    }
    /** Fold `git diff --numstat` stdout into the per-file running totals. Empty
     *  / malformed input is silently skipped (matches `parseNumstat`). */
    recordDiff(numstatStdout) {
        for (const row of parseNumstat(numstatStdout)) {
            const prev = this.diffByFile.get(row.file);
            if (prev) {
                prev.addedLines += row.addedLines;
                prev.removedLines += row.removedLines;
            }
            else {
                this.diffByFile.set(row.file, {
                    file: row.file,
                    addedLines: row.addedLines,
                    removedLines: row.removedLines,
                });
            }
        }
    }
    /** Snapshot the accumulator as a {@link WorkMetrics}. When `model` is a
     *  known pricing-table entry, `estimatedCostUsd` is derived; unknown / absent
     *  model ⇒ left undefined. Idempotent: the collector is NOT reset, so
     *  repeated finalize() calls observe the same state and yield equal
     *  snapshots (the loop instantiates one collector per turn, so resetting is
     *  unnecessary; idempotency only matters for accidental double-finalize). */
    finalize(model) {
        // Copy the per-file map to a fresh array so the returned snapshot does
        // NOT alias internal state — a subsequent recordDiff() would otherwise
        // mutate a previously-returned snapshot.
        const diffMap = [...this.diffByFile.values()].map((d) => ({
            file: d.file,
            addedLines: d.addedLines,
            removedLines: d.removedLines,
        }));
        if (model === undefined) {
            // No model ⇒ buildWorkMetrics would still derive cost off an empty
            // table lookup, which returns null → undefined. We could call it with
            // `model:""` but constructing the WorkMetrics directly here keeps the
            // intent obvious and avoids an unnecessary `""` lookup.
            const out = {
                diffMap,
                agentActions: this.agentActions,
                linesRead: this.linesRead,
                tokensInput: this.tokensInput,
                tokensOutput: this.tokensOutput,
            };
            if (this.cacheReadTokens !== undefined)
                out.cacheReadTokens = this.cacheReadTokens;
            return out;
        }
        return buildWorkMetrics({
            diffMap,
            agentActions: this.agentActions,
            linesRead: this.linesRead,
            model,
            tokensInput: this.tokensInput,
            tokensOutput: this.tokensOutput,
            ...(this.cacheReadTokens !== undefined ? { cacheReadTokens: this.cacheReadTokens } : {}),
        });
    }
    /** Best-effort extraction of the text payload from a tool result. Tool
     *  results land here in two shapes:
     *    - the raw `ToolResultBlock.content` string (when the loop pipes the
     *      block content directly);
     *    - an `{output:string}` envelope (when the loop pipes the dispatch
     *      result). Anything else returns `undefined` (skip). */
    extractText(output) {
        if (typeof output === "string")
            return output;
        if (output !== null && typeof output === "object" && "output" in output) {
            const inner = output.output;
            if (typeof inner === "string")
                return inner;
        }
        return undefined;
    }
}
