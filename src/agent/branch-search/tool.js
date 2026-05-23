/**
 * `branch_search` first-class tool (ADR-0084). Agent-level (NOT in
 * `defaultTools`) — the assembly layer registers it ONLY when
 * `AgentConfig.branchSearch` is set, mirroring `memoryTools` / subagent tools.
 *
 * Slice: `@/agent` may import `@/tool` (it is the cross-slice composer). The
 * candidate runner (`RunCandidate` bound to `runAgent`) and the isolator are
 * INJECTED by the assembly so this file stays loop-agnostic and unit-testable.
 */
import { z } from "zod";
import { argmaxSelector, makeScorer } from "./score";
import { runBranchSearch } from "./search";
import { buildSeeds } from "./seed";
import { combineVerifiers, lintVerifier, lspDiagVerifier, testVerifier, tscVerifier, } from "./verify";
const inputSchema = z.object({
    task_description: z.string().min(1).describe("What the N candidates should each attempt"),
    n: z
        .number()
        .int()
        .min(2)
        .max(8)
        .optional()
        .describe("Candidate count (default: config.defaultN)"),
    verifier_kinds: z
        .array(z.enum(["tsc", "test", "lint", "lsp_diag"]))
        .optional()
        .describe("Verifier tier (default: config.defaultVerifierKinds)"),
});
/** Map requested verifier kinds → concrete verifier pipeline. `lsp_diag` is
 *  silently dropped when no `diagnose` port is wired (graceful — the model
 *  shouldn't fail because the host didn't supply LSP). */
const buildVerifier = (kinds, deps) => {
    const vs = [];
    for (const k of kinds) {
        if (k === "tsc")
            vs.push(tscVerifier({ timeoutMs: deps.config.timeoutPerBranchMs }));
        else if (k === "test")
            vs.push(testVerifier({
                timeoutMs: deps.config.timeoutPerBranchMs,
                ...(deps.testPattern ? { pattern: deps.testPattern } : {}),
            }));
        else if (k === "lint")
            vs.push(lintVerifier({ timeoutMs: deps.config.timeoutPerBranchMs }));
        else if (k === "lsp_diag" && deps.diagnose !== undefined)
            vs.push(lspDiagVerifier(deps.diagnose));
    }
    // Always at least tsc — an empty pipeline would score every candidate 0.
    if (vs.length === 0)
        vs.push(tscVerifier({ timeoutMs: deps.config.timeoutPerBranchMs }));
    return combineVerifiers(...vs);
};
const formatWinner = (r) => {
    const lines = [
        `branch_search: winner ${r.winner.id} (score ${r.winnerScore.total.toFixed(2)}, ${r.allScored.length} candidates, ${r.totalWallMs}ms)`,
    ];
    for (const s of r.allScored) {
        const sig = s.score.breakdown.map((b) => `${b.kind}:${b.pass ? "✓" : "✗"}`).join(" ");
        lines.push(`  ${s.cand.id} → ${s.score.total.toFixed(2)} [${sig}] ${s.cand.outcome.kind}`);
    }
    return lines.join("\n");
};
export const branchSearchTool = (deps) => ({
    name: "branch_search",
    description: "Run N parallel attempts at a hard edit in isolated workspaces, score each by " +
        "verifiers (tsc/test/lint), and return the winning candidate's outcome. Use when " +
        "an edit repeatedly fails tsc/tests and a single attempt isn't converging.",
    inputSchema,
    isReadOnly: () => false,
    // Each candidate forks a full agent run in its own workspace — never batch
    // this with other tool calls (it owns heavy concurrency internally).
    isConcurrencySafe: () => false,
    async *execute(input, _ctx) {
        const n = input.n ?? deps.config.defaultN;
        yield { type: "progress", message: `branch_search: spawning ${n} candidates` };
        const kinds = (input.verifier_kinds ?? deps.config.defaultVerifierKinds).filter((k) => k === "tsc" || k === "test" || k === "lint" || k === "lsp_diag");
        const result = await runBranchSearch({
            N: n,
            seeds: buildSeeds(n, deps.modelCandidates ?? []),
            baseLlm: deps.baseLlm,
            task: input.task_description,
            timeoutPerBranchMs: deps.config.timeoutPerBranchMs,
            verifier: buildVerifier(kinds, deps),
            scorer: makeScorer(deps.config.weights),
            selector: argmaxSelector,
            isolator: deps.buildIsolator(),
            runCandidate: deps.runCandidate,
            ...(deps.onTrace ? { onTrace: deps.onTrace } : {}),
        });
        yield {
            type: "result",
            result: {
                ok: result.winnerScore.total > 0,
                output: formatWinner(result),
                structured: result,
            },
        };
    },
});
