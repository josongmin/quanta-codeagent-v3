import { byteCompare } from "@/shared";
import { safeRun, stderrReason } from "./_shared";
import { gitChurnInputSchema } from "./types";
/** Build `git log --name-only` args for the churn window. We emit a blank
 *  format so stdout is purely the changed-file paths (one per line, blank
 *  lines between commits), then aggregate frequency in JS. */
const buildArgs = (since, path) => {
    const args = ["log", "--name-only", "--format="];
    if (since !== undefined)
        args.push(`--since=${since}`);
    else
        args.push("-n", "200");
    if (path !== undefined)
        args.push("--", path);
    return args;
};
/** Count file occurrences across the log output, return top-N by frequency
 *  (ties broken by path for determinism). Exported pure for unit tests. */
export const rankChurn = (stdout, topN) => {
    const counts = new Map();
    for (const raw of stdout.split("\n")) {
        const file = raw.trim();
        if (file.length === 0)
            continue;
        counts.set(file, (counts.get(file) ?? 0) + 1);
    }
    return [...counts.entries()]
        .map(([file, count]) => ({ file, count }))
        .sort((a, b) => (b.count !== a.count ? b.count - a.count : byteCompare(a.file, b.file)))
        .slice(0, topN);
};
const formatBody = (rows) => {
    if (rows.length === 0)
        return "(no churn in window)";
    return rows.map((r) => `${String(r.count).padStart(4)}  ${r.file}`).join("\n");
};
export const gitChurnTool = (runner) => ({
    name: "git_churn",
    description: "Rank files by change frequency in a recent window (churn hotspots). " +
        "Stage-1 fault-localization signal — frequently-changed files are " +
        "disproportionately where bugs live. Read-only.",
    inputSchema: gitChurnInputSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async *execute(input, ctx) {
        const parsed = gitChurnInputSchema.safeParse(input);
        if (!parsed.success) {
            yield {
                type: "result",
                result: { ok: false, output: `invalid input: ${parsed.error.message}` },
            };
            return;
        }
        const { since, path, n } = parsed.data;
        const topN = n ?? 20;
        const args = buildArgs(since, path);
        yield { type: "progress", message: `git churn${since ? ` --since=${since}` : " (last 200)"}` };
        const out = await safeRun(runner, args, ctx.cwd, "git churn", ctx.signal);
        if (out.kind === "spawn-error") {
            yield { type: "result", result: { ok: false, output: out.message } };
            return;
        }
        const r = out.result;
        if (r.exitCode !== 0) {
            yield {
                type: "result",
                result: { ok: false, output: stderrReason(r.stderr, r.exitCode, "git churn") },
            };
            return;
        }
        yield { type: "result", result: { ok: true, output: formatBody(rankChurn(r.stdout, topN)) } };
    },
});
