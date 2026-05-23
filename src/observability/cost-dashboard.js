import { costUsd } from "./pricing";
import { GEN_AI_ATTRS } from "./vocabulary";
/**
 * Cost & cache dashboard (ADR-0085) — a PURE aggregator over a
 * {@link MetricsSnapshot} (RFC §8 / ADR-0074 span tree feeds the same
 * registry). Answers "how much did this session cost, how well did the prompt
 * cache hit, where did the wall time go?" with NO new data collection — it
 * reads the counters/timers the `AgentRecorder` + shell-exec OTel observer
 * already populate.
 *
 * Three render formats share one computed model:
 *   - {@link renderDashboardText}     compact terminal block
 *   - {@link renderDashboardMarkdown} PR-comment / docs table
 *   - the {@link CostDashboard} object itself is the JSON form
 *
 * Cost is `null` when the model id is unknown to `pricing.ts` (no silent $0).
 */
// Canonical token-counter keys (shared with `agent/metrics.ts` METRIC).
const K_IN = GEN_AI_ATTRS.usage.inputTokens;
const K_OUT = GEN_AI_ATTRS.usage.outputTokens;
const K_CACHE = GEN_AI_ATTRS.usage.cacheReadInputTokens;
/** Sum every counter whose key starts with `${prefix}.` into a `{suffix: n}`
 *  map (e.g. `agent.tool_calls.read` → `{read: n}`). */
const byPrefix = (counters, prefix) => {
    const out = {};
    const head = `${prefix}.`;
    for (const [k, v] of Object.entries(counters)) {
        if (k.startsWith(head))
            out[k.slice(head.length)] = v;
    }
    return out;
};
export const buildCostDashboard = (snapshot, opts = {}) => {
    const c = snapshot.counters;
    const input = c[K_IN] ?? 0;
    const output = c[K_OUT] ?? 0;
    const cacheRead = c[K_CACHE] ?? 0;
    const denom = input + cacheRead;
    return {
        model: opts.model,
        tokens: {
            input,
            output,
            cacheRead,
            cacheHitRate: denom > 0 ? cacheRead / denom : null,
        },
        estimatedCostUsd: opts.model !== undefined ? costUsd(opts.model, input, output, cacheRead) : null,
        turns: c["agent.turns"] ?? 0,
        toolCalls: {
            total: c["agent.tool_calls"] ?? 0,
            byTool: byPrefix(c, "agent.tool_calls"),
        },
        stopReasons: byPrefix(c, "agent.stop_reason"),
        latency: {
            llmStream: snapshot.timers["agent.llm_stream"],
            toolExec: snapshot.timers["agent.tool_exec"],
        },
        shell: {
            runs: c["shell.exec.runs"] ?? 0,
            stdoutBytes: c["shell.exec.stdout.bytes"] ?? 0,
            stderrBytes: c["shell.exec.stderr.bytes"] ?? 0,
        },
    };
};
// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------
const fmtTok = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const fmtPct = (r) => (r === null ? "n/a" : `${(r * 100).toFixed(0)}%`);
const fmtUsd = (u) => u === null ? "n/a (unknown model)" : `$${u.toFixed(4)}`;
const fmtTimer = (t) => t === undefined ? "—" : `n=${t.count} p50=${t.p50.toFixed(0)}ms p95=${t.p95.toFixed(0)}ms`;
/** Compact terminal block (for a CLI session-end summary). */
export const renderDashboardText = (d) => {
    const tools = Object.entries(d.toolCalls.byTool)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
    const stops = Object.entries(d.stopReasons)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
    return [
        "── cost & cache ──────────────────────────",
        `model:     ${d.model ?? "(unknown)"}`,
        `tokens:    ${fmtTok(d.tokens.input)} in / ${fmtTok(d.tokens.output)} out · cache ${fmtTok(d.tokens.cacheRead)} (hit ${fmtPct(d.tokens.cacheHitRate)})`,
        `cost:      ${fmtUsd(d.estimatedCostUsd)}`,
        `turns:     ${d.turns}`,
        `tools:     ${d.toolCalls.total}${tools ? ` · ${tools}` : ""}`,
        ...(stops ? [`stop:      ${stops}`] : []),
        `latency:   llm ${fmtTimer(d.latency.llmStream)} · tool ${fmtTimer(d.latency.toolExec)}`,
        ...(d.shell.runs > 0
            ? [
                `shell:     ${d.shell.runs} runs · ${fmtTok(d.shell.stdoutBytes)}B out / ${fmtTok(d.shell.stderrBytes)}B err`,
            ]
            : []),
        "──────────────────────────────────────────",
    ].join("\n");
};
/** Markdown table — for a PR comment or docs snapshot. */
export const renderDashboardMarkdown = (d) => [
    "| metric | value |",
    "|---|---|",
    `| model | ${d.model ?? "(unknown)"} |`,
    `| tokens in / out | ${d.tokens.input} / ${d.tokens.output} |`,
    `| cache read (hit rate) | ${d.tokens.cacheRead} (${fmtPct(d.tokens.cacheHitRate)}) |`,
    `| est. cost | ${fmtUsd(d.estimatedCostUsd)} |`,
    `| turns | ${d.turns} |`,
    `| tool calls | ${d.toolCalls.total} |`,
    `| llm p50/p95 | ${fmtTimer(d.latency.llmStream)} |`,
].join("\n");
