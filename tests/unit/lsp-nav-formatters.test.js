import { describe, expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import { formatHover, formatLocations, formatRenamePreview, formatSymbols, } from "@/tool/lsp_nav/formatters";
const loc = (path, line, character, endLine = line, endChar = character + 1) => ({
    uri: pathToFileURL(path).toString(),
    range: {
        start: { line, character },
        end: { line: endLine, character: endChar },
    },
});
const sym = (over = {}) => ({
    name: "doStuff",
    kind: "function",
    range: { start: { line: 0, character: 0 }, end: { line: 5, character: 1 } },
    selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 16 } },
    ...over,
});
describe("formatLocations (pure)", () => {
    test("null ⇒ not supported here", () => {
        expect(formatLocations("definition", null)).toBe("definition: not supported here");
    });
    test("[] ⇒ no results", () => {
        expect(formatLocations("references", [])).toBe("references: no results");
    });
    test("emits a header and 1-based path:line:col rows", () => {
        const out = formatLocations("definition", [loc("/abs/a.ts", 4, 7), loc("/abs/b.ts", 0, 0)]);
        const lines = out.split("\n");
        expect(lines[0]).toBe("definition: 2 result(s)");
        expect(lines[1]).toBe("/abs/a.ts:5:8");
        expect(lines[2]).toBe("/abs/b.ts:1:1");
    });
    test("singular result(s) wording is stable for 1 result", () => {
        const out = formatLocations("references", [loc("/abs/a.ts", 2, 3)]);
        expect(out.split("\n")[0]).toBe("references: 1 result(s)");
    });
});
describe("formatHover (pure)", () => {
    test("null ⇒ no hover at coords", () => {
        expect(formatHover("/abs/a.ts", 3, 4, null)).toBe("/abs/a.ts:3:4: no hover");
    });
    test("renders contents under a header", () => {
        const hover = { contents: "function doStuff(): void" };
        const out = formatHover("/abs/a.ts", 5, 9, hover);
        const lines = out.split("\n");
        expect(lines[0]).toBe("/abs/a.ts:5:9: hover");
        expect(lines[1]).toBe("function doStuff(): void");
    });
    test("preserves multi-line hover content verbatim", () => {
        const hover = { contents: "line a\nline b" };
        const out = formatHover("/abs/a.ts", 1, 1, hover);
        expect(out).toBe("/abs/a.ts:1:1: hover\nline a\nline b");
    });
});
describe("formatSymbols (pure)", () => {
    test("null ⇒ not supported here", () => {
        expect(formatSymbols("document /abs/a.ts", null)).toBe("document /abs/a.ts: not supported here");
    });
    test("[] ⇒ no results", () => {
        expect(formatSymbols("workspace 'foo'", [])).toBe("workspace 'foo': no results");
    });
    test("renders kind name path:line:col, with optional containerName", () => {
        const uri = pathToFileURL("/abs/m.ts").toString();
        const out = formatSymbols("workspace 'do'", [
            sym({ uri, name: "doA" }),
            sym({ uri, name: "doB", containerName: "ClassX", kind: "method" }),
        ]);
        const lines = out.split("\n");
        expect(lines[0]).toBe("workspace 'do': 2 result(s)");
        expect(lines[1]).toBe("function doA /abs/m.ts:1:10");
        expect(lines[2]).toBe("method ClassX.doB /abs/m.ts:1:10");
    });
    test("falls back to selectionRange coords when uri is absent (document scope)", () => {
        const out = formatSymbols("document /abs/a.ts", [sym({ name: "topLevel", kind: "class" })]);
        expect(out.split("\n")[1]).toBe("class topLevel :1:10");
    });
});
describe("formatRenamePreview (pure)", () => {
    test("null ⇒ rename not available", () => {
        expect(formatRenamePreview("/abs/a.ts", 4, 7, null)).toBe("/abs/a.ts:4:7: rename not available");
    });
    test("renders placeholder and 1-based range", () => {
        const preview = {
            placeholder: "oldName",
            range: { start: { line: 4, character: 6 }, end: { line: 4, character: 13 } },
        };
        const out = formatRenamePreview("/abs/a.ts", 5, 7, preview);
        expect(out).toBe("Renameable identifier 'oldName' at /abs/a.ts:5:7 (range 5:7..5:14)");
    });
});
