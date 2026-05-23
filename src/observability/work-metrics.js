/**
 * Per-turn cost/work transparency (absorb #6, v0.dev `workMetrics`).
 *
 * A pure, dependency-light module that captures "what did this turn cost?" as
 * structured evidence: which files changed and by how many lines, how many
 * agent actions ran, how many lines were read, and the token/USD cost. It is
 * intentionally NOT wired into the live loop yet — see the TODO seam below.
 *
 * Cost reuses {@link costUsd} from `./pricing` (best-effort: unknown model ⇒
 * `estimatedCostUsd` stays undefined). Everything here is pure and
 * deterministic so it can be unit-tested without a runtime.
 *
 * TODO(absorb #6): emit workMetrics per-turn from loop — fold `accumulateWorkMetrics`
 * into the per-session total and emit `workMetricsAttrs(m)` on turn close.
 */
import { costUsd } from "./pricing";
/**
 * Parse `git diff --numstat` stdout into per-file diff stats.
 *
 * Each line is `added\tremoved\tpath`. Binary files report `-\t-\tpath`; those
 * counts collapse to 0 (numstat has no line concept for binaries). Blank lines
 * and malformed rows are skipped. Rename rows (`old => new`) keep the path
 * verbatim as git emits it — callers needing the new path can post-process.
 */
export const parseNumstat = (gitDiffNumstatStdout) => {
    const out = [];
    for (const raw of gitDiffNumstatStdout.split("\n")) {
        const line = raw.trimEnd();
        if (!line)
            continue;
        const parts = line.split("\t");
        if (parts.length < 3)
            continue;
        const [addedRaw, removedRaw, ...pathParts] = parts;
        const file = pathParts.join("\t").trim();
        if (!file)
            continue;
        const toCount = (s) => {
            if (s === undefined || s === "-")
                return 0;
            const n = Number(s);
            return Number.isFinite(n) && n >= 0 ? n : 0;
        };
        out.push({ file, addedLines: toCount(addedRaw), removedLines: toCount(removedRaw) });
    }
    return out;
};
/** Render a token count in compact thousands notation (e.g. `1.2k`, `0.8k`).
 *  Counts under 100 stay verbatim so tiny turns don't collapse to `0.0k`. */
const compactTokens = (n) => {
    if (n < 100)
        return String(n);
    return `${(n / 1000).toFixed(1)}k`;
};
const sumLines = (diffMap) => {
    let added = 0;
    let removed = 0;
    for (const d of diffMap) {
        added += d.addedLines;
        removed += d.removedLines;
    }
    return { added, removed };
};
/**
 * Compact, single-block human summary of a turn's work, e.g.
 *   `3 files (+42 -7) · 5 actions · 312 lines read · 1.2k in / 0.8k out · ~$0.03`
 * The cost segment is omitted when `estimatedCostUsd` is undefined.
 */
export const summarizeWorkMetrics = (m) => {
    const { added, removed } = sumLines(m.diffMap);
    const fileWord = m.diffMap.length === 1 ? "file" : "files";
    const actionWord = m.agentActions === 1 ? "action" : "actions";
    const segments = [
        `${m.diffMap.length} ${fileWord} (+${added} -${removed})`,
        `${m.agentActions} ${actionWord}`,
        `${m.linesRead} lines read`,
        `${compactTokens(m.tokensInput)} in / ${compactTokens(m.tokensOutput)} out`,
    ];
    if (m.estimatedCostUsd !== undefined) {
        segments.push(`~$${m.estimatedCostUsd.toFixed(2)}`);
    }
    return segments.join(" · ");
};
/** Merge two per-file diff lists, summing counts for the same path. */
const mergeDiffMaps = (base, delta) => {
    const byFile = new Map();
    for (const d of [...base, ...delta]) {
        const prev = byFile.get(d.file);
        if (prev) {
            prev.addedLines += d.addedLines;
            prev.removedLines += d.removedLines;
        }
        else {
            byFile.set(d.file, { file: d.file, addedLines: d.addedLines, removedLines: d.removedLines });
        }
    }
    return [...byFile.values()];
};
/**
 * Pure fold of a per-turn `delta` into a running `base` total. Neither input
 * is mutated; per-file diff stats are summed by path. `cacheReadTokens` and
 * `estimatedCostUsd` are summed only when present on either side (otherwise
 * left undefined, preserving the optional contract).
 */
export const accumulateWorkMetrics = (base, delta) => {
    const out = {
        diffMap: mergeDiffMaps(base.diffMap, delta.diffMap),
        agentActions: base.agentActions + delta.agentActions,
        linesRead: base.linesRead + delta.linesRead,
        tokensInput: base.tokensInput + delta.tokensInput,
        tokensOutput: base.tokensOutput + delta.tokensOutput,
    };
    if (base.cacheReadTokens !== undefined || delta.cacheReadTokens !== undefined) {
        out.cacheReadTokens = (base.cacheReadTokens ?? 0) + (delta.cacheReadTokens ?? 0);
    }
    if (base.estimatedCostUsd !== undefined || delta.estimatedCostUsd !== undefined) {
        out.estimatedCostUsd = (base.estimatedCostUsd ?? 0) + (delta.estimatedCostUsd ?? 0);
    }
    return out;
};
/**
 * Build a {@link WorkMetrics} for a turn, deriving `estimatedCostUsd` from the
 * pricing table when the model is known (unknown model ⇒ left undefined).
 * Convenience constructor so the loop wiring (TODO above) stays a one-liner.
 */
export const buildWorkMetrics = (args) => {
    const cost = costUsd(args.model, args.tokensInput, args.tokensOutput, args.cacheReadTokens ?? 0);
    const out = {
        diffMap: args.diffMap,
        agentActions: args.agentActions,
        linesRead: args.linesRead,
        tokensInput: args.tokensInput,
        tokensOutput: args.tokensOutput,
    };
    if (args.cacheReadTokens !== undefined)
        out.cacheReadTokens = args.cacheReadTokens;
    if (cost !== null)
        out.estimatedCostUsd = cost;
    return out;
};
