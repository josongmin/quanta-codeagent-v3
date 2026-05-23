// Shared fixtures for the lsp-nav per-tool test suites.
// Extracted from `lsp-nav-tools.test.ts` as part of refactor C (split 500+ line
// multi-concern test files into focused suites). Pure helpers — no describe/test.
import { pathToFileURL } from "node:url";
import { lspNavTools } from "@/tool/lsp_nav";
export const ctx = () => ({ cwd: "/repo", signal: new AbortController().signal });
export const run = async (tool, input) => {
    const progress = [];
    let result;
    for await (const ev of tool.execute(input, ctx())) {
        if (ev.type === "progress")
            progress.push(ev.message);
        else
            result = ev.result;
    }
    if (!result)
        throw new Error("tool produced no result");
    return { progress, result };
};
export const findTool = (name, provider) => {
    const tools = lspNavTools(provider);
    const t = tools.find((x) => x.name === name);
    if (!t)
        throw new Error(`tool '${name}' not registered`);
    return t;
};
export const loc = (path, line, character) => ({
    uri: pathToFileURL(path).toString(),
    range: {
        start: { line, character },
        end: { line, character: character + 1 },
    },
});
/** Build a provider whose session methods can be selectively overridden. */
export const fakeProvider = (overrides, trace) => ({
    unavailableReason: () => "no language server configured",
    open: async (filePath, cwd) => {
        trace.opened = { filePath, cwd };
        const session = {
            definition: async (fp, p) => {
                trace.filePath = fp;
                trace.pos = p;
                return [];
            },
            references: async (fp, p, inc) => {
                trace.filePath = fp;
                trace.pos = p;
                trace.includeDeclaration = inc;
                return [];
            },
            hover: async (fp, p) => {
                trace.filePath = fp;
                trace.pos = p;
                return null;
            },
            typeDefinition: async (fp, p) => {
                trace.filePath = fp;
                trace.pos = p;
                return [];
            },
            implementation: async (fp, p) => {
                trace.filePath = fp;
                trace.pos = p;
                return [];
            },
            documentSymbol: async (fp) => {
                trace.filePath = fp;
                return [];
            },
            workspaceSymbol: async (q) => {
                trace.query = q;
                return [];
            },
            prepareRename: async (fp, p) => {
                trace.filePath = fp;
                trace.pos = p;
                return null;
            },
            stop: async () => {
                trace.stopped = true;
            },
            ...overrides,
        };
        return session;
    },
});
export const emptyTrace = () => ({ stopped: false, opened: {} });
export const TOOL_NAMES = [
    "lsp_definition",
    "lsp_references",
    "lsp_hover",
    "lsp_type_definition",
    "lsp_implementation",
    "lsp_document_symbol",
    "lsp_workspace_symbol",
    "lsp_rename_preview",
];
