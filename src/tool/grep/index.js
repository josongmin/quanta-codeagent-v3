import { z } from "zod";
import { runShell } from "@/runtime";
import { FsJailError, resolveJailed } from "@/storage";
import { defineTool } from "../factory";
const schema = z.object({
    pattern: z.string().describe("Regex pattern (ripgrep syntax)"),
    path: z.string().optional().describe("File or directory to search (default cwd)"),
    glob: z.string().optional().describe("Filter files by glob, e.g. '*.ts'"),
});
const sq = (s) => `'${s.replace(/'/g, "'\\''")}'`;
const MAX_LINES = 200;
export const grepTool = defineTool({
    name: "grep",
    description: "Search file contents with ripgrep. Returns `path:line:match` rows. " +
        "Row output is capped at 200 lines. If you hit the cap, NARROW with a more " +
        "specific pattern or restrict the `path` (e.g. `src/agent/`) before switching " +
        "to a different tool or asking the user (ADR-0062).",
    inputSchema: schema,
    isReadOnly: () => true,
    // Read-only content search (rg has no side effects); safe to parallelize.
    isConcurrencySafe: () => true,
    async *execute(input, ctx) {
        yield { type: "progress", message: `searching for ${input.pattern}…` };
        // S14: jail-validate the model-supplied path BEFORE building argv.
        // Without this, `path: "/etc"` would escape the workspace via the
        // ripgrep subprocess; the storage seam's `resolveJailed` is the only
        // legitimate way to construct a `JailedPath`.
        let jailedPath;
        if (input.path !== undefined) {
            try {
                jailedPath = resolveJailed(input.path, ctx.cwd);
            }
            catch (e) {
                if (e instanceof FsJailError) {
                    yield { type: "result", result: { ok: false, output: e.message } };
                    return;
                }
                throw e;
            }
        }
        const parts = ["rg", "--line-number", "--no-heading", "--color=never"];
        if (input.glob)
            parts.push("-g", sq(input.glob));
        parts.push("-e", sq(input.pattern));
        if (jailedPath !== undefined)
            parts.push(sq(jailedPath));
        const r = await runShell(parts.join(" "), { cwd: ctx.cwd, signal: ctx.signal });
        if (r.exitCode === 1 && !r.stdout) {
            yield { type: "result", result: { ok: true, output: "(no matches)" } };
            return;
        }
        if (r.exitCode > 1 || r.timedOut) {
            yield {
                type: "result",
                result: { ok: false, output: r.stderr.trim() || `ripgrep failed (exit ${r.exitCode})` },
            };
            return;
        }
        const lines = r.stdout.trimEnd().split("\n");
        const shown = lines.slice(0, MAX_LINES).join("\n");
        const more = lines.length > MAX_LINES ? `\n… (${lines.length - MAX_LINES} more matches)` : "";
        yield { type: "result", result: { ok: true, output: shown + more } };
    },
});
