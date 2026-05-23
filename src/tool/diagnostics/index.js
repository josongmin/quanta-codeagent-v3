import { z } from "zod";
import { FsJailError, resolveJailed } from "@/storage";
const schema = z.object({
    path: z.string().describe("File to type-check / lint via its language server"),
});
const SEVERITY_RANK = {
    error: 0,
    warning: 1,
    information: 2,
    hint: 3,
};
/** Format one diagnostic as `path:line:col severity message [source/code]`,
 *  converting zero-based LSP coords to 1-based display coords. */
const formatOne = (path, d) => {
    const line = d.range.start.line + 1;
    const col = d.range.start.character + 1;
    const tag = [d.source, d.code].filter(Boolean).join(" ");
    const suffix = tag ? ` [${tag}]` : "";
    return `${path}:${line}:${col} ${d.severity} ${d.message.replace(/\s+/g, " ").trim()}${suffix}`;
};
/** Pure formatter (exported for unit tests): stable, severity-then-position
 *  ordered, with a one-line error/warning summary header. */
export const formatDiagnostics = (path, diags) => {
    if (diags.length === 0)
        return `${path}: no diagnostics`;
    const sorted = [...diags].sort((a, b) => {
        const s = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
        if (s !== 0)
            return s;
        return a.range.start.line - b.range.start.line;
    });
    const errors = diags.filter((d) => d.severity === "error").length;
    const warnings = diags.filter((d) => d.severity === "warning").length;
    const header = `${path}: ${errors} error(s), ${warnings} warning(s)`;
    return [header, ...sorted.map((d) => formatOne(path, d))].join("\n");
};
/**
 * Default provider used by `defaultTools`: no server is wired, so every file
 * degrades to a clean no-op result. The CLI swaps in the real LSP-backed
 * provider via `src/agent/lsp-bridge.ts` when language servers are present.
 * This keeps `defaultTools` static and slice-isolated while still genuinely
 * registering the tool (RFC-faithful: the agent can always call it).
 */
export const nullDiagnosticsProvider = {
    unavailableReason: () => "no language server configured",
    open: async () => null,
};
/**
 * Build the `diagnostics` tool around a provider. Conservative flags:
 * read-only (it only opens the document, never mutates) and NOT
 * concurrency-safe (each call drives a subprocess language server).
 */
export const diagnosticsTool = (provider) => ({
    name: "diagnostics",
    description: "Report language-server diagnostics (type errors, lint) for a single file. " +
        "Supports Python (pyright) and JS/TS (typescript-language-server). " +
        "Returns a clean message when no server is available — never fails the turn.",
    inputSchema: schema,
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    async *execute(input, ctx) {
        // S14: jail before opening — `path: "/etc/shadow"` would otherwise be
        // opened by the LSP. The branded JailedPath is the only path the LSP
        // provider may receive.
        let abs;
        try {
            abs = resolveJailed(input.path, ctx.cwd);
        }
        catch (e) {
            if (e instanceof FsJailError) {
                yield { type: "result", result: { ok: false, output: e.message } };
                return;
            }
            throw e;
        }
        let session;
        try {
            session = await provider.open(abs, ctx.cwd);
        }
        catch (e) {
            // Spawn/handshake failure must degrade gracefully, not crash the turn.
            yield {
                type: "result",
                result: { ok: false, output: `diagnostics unavailable: ${e.message}` },
            };
            return;
        }
        if (!session) {
            yield {
                type: "result",
                result: {
                    ok: false,
                    output: `diagnostics unavailable: ${provider.unavailableReason(abs)}`,
                },
            };
            return;
        }
        yield { type: "progress", message: `analyzing ${input.path}` };
        try {
            const diags = await session.diagnostics(abs);
            const hasError = diags.some((d) => d.severity === "error");
            yield {
                type: "result",
                result: { ok: !hasError, output: formatDiagnostics(input.path, diags) },
            };
        }
        catch (e) {
            yield {
                type: "result",
                result: { ok: false, output: `diagnostics failed: ${e.message}` },
            };
        }
        finally {
            await session.stop().catch(() => undefined);
        }
    },
});
