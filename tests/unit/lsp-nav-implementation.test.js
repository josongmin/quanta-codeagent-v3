import { describe, expect, test } from "bun:test";
import { emptyTrace, fakeProvider, findTool, loc, run } from "./lsp-nav-fixtures";
describe("lsp_implementation", () => {
    test("golden + empty + null", async () => {
        const t1 = findTool("lsp_implementation", fakeProvider({ implementation: async () => [loc("/abs/i.ts", 2, 2)] }, emptyTrace()));
        const r1 = await run(t1, { path: "a.ts", line: 1, character: 1 });
        expect(r1.result.output).toContain("implementation: 1 result(s)");
        expect(r1.result.output).toContain("/abs/i.ts:3:3");
        const t2 = findTool("lsp_implementation", fakeProvider({}, emptyTrace()));
        const r2 = await run(t2, { path: "a.ts", line: 1, character: 1 });
        expect(r2.result.output).toBe("implementation: no results");
        const t3 = findTool("lsp_implementation", fakeProvider({ implementation: async () => null }, emptyTrace()));
        const r3 = await run(t3, { path: "a.ts", line: 1, character: 1 });
        expect(r3.result.output).toBe("implementation: not supported here");
    });
    test("spawn error", async () => {
        const r = await run(findTool("lsp_implementation", {
            unavailableReason: () => "n/a",
            open: async () => {
                throw new Error("blew up");
            },
        }), { path: "a.ts", line: 1, character: 1 });
        expect(r.result.output).toBe("lsp_implementation unavailable: blew up");
    });
});
