import { describe, expect, test } from "bun:test";
import { nullLspNavProvider } from "@/tool/lsp_nav";
import { emptyTrace, fakeProvider, findTool, loc, run } from "./lsp-nav-fixtures";
describe("lsp_references", () => {
    test("forwards includeDeclaration with default true", async () => {
        const trace = emptyTrace();
        const t = findTool("lsp_references", fakeProvider({
            references: async (fp, p, inc) => {
                trace.filePath = fp;
                trace.pos = p;
                trace.includeDeclaration = inc;
                return [loc("/abs/a.ts", 1, 2), loc("/abs/b.ts", 3, 0)];
            },
        }, trace));
        const { result } = await run(t, { path: "a.ts", line: 2, character: 3 });
        expect(trace.includeDeclaration).toBe(true);
        expect(result.ok).toBe(true);
        expect(result.output).toContain("references: 2 result(s)");
    });
    test("explicit includeDeclaration:false is honored", async () => {
        const trace = emptyTrace();
        const t = findTool("lsp_references", fakeProvider({}, trace));
        await run(t, { path: "a.ts", line: 1, character: 1, includeDeclaration: false });
        expect(trace.includeDeclaration).toBe(false);
    });
    test("null ⇒ ok:true / not supported", async () => {
        const t = findTool("lsp_references", fakeProvider({ references: async () => null }, emptyTrace()));
        const { result } = await run(t, { path: "a.ts", line: 1, character: 1 });
        expect(result.output).toBe("references: not supported here");
    });
    test("unavailable + spawn error", async () => {
        const nullT = findTool("lsp_references", nullLspNavProvider);
        const r1 = await run(nullT, { path: "a.ts", line: 1, character: 1 });
        expect(r1.result.ok).toBe(false);
        const errT = findTool("lsp_references", {
            unavailableReason: () => "n/a",
            open: async () => {
                throw new Error("boom");
            },
        });
        const r2 = await run(errT, { path: "a.ts", line: 1, character: 1 });
        expect(r2.result.output).toBe("lsp_references unavailable: boom");
    });
});
