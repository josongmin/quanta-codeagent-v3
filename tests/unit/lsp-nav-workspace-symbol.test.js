import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { nullLspNavProvider } from "@/tool/lsp_nav";
import { emptyTrace, fakeProvider, findTool, run } from "./lsp-nav-fixtures";
describe("lsp_workspace_symbol", () => {
    test("golden: query forwarded to session.workspaceSymbol", async () => {
        const trace = emptyTrace();
        const t = findTool("lsp_workspace_symbol", fakeProvider({
            workspaceSymbol: async (q) => {
                trace.query = q;
                return [
                    {
                        name: "MyClass",
                        kind: "class",
                        range: { start: { line: 0, character: 0 }, end: { line: 1, character: 0 } },
                        selectionRange: {
                            start: { line: 0, character: 6 },
                            end: { line: 0, character: 13 },
                        },
                        uri: pathToFileURL("/abs/m.ts").toString(),
                    },
                ];
            },
        }, trace));
        const { result } = await run(t, { path: "src/a.ts", query: "MyCl" });
        expect(trace.query).toBe("MyCl");
        expect(result.output).toContain("workspace 'MyCl': 1 result(s)");
        expect(result.output).toContain("class MyClass /abs/m.ts:1:7");
    });
    test("null ⇒ ok:true / not supported", async () => {
        const t = findTool("lsp_workspace_symbol", fakeProvider({ workspaceSymbol: async () => null }, emptyTrace()));
        const { result } = await run(t, { path: "a.ts", query: "x" });
        expect(result.output).toBe("workspace 'x': not supported here");
    });
    test("unavailable", async () => {
        const r = await run(findTool("lsp_workspace_symbol", nullLspNavProvider), {
            path: "a.ts",
            query: "Foo",
        });
        expect(r.result.ok).toBe(false);
    });
});
