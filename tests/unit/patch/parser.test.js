import { describe, expect, test } from "bun:test";
import { PatchParseError, parsePatch } from "../../../src/patch/index.js";
// ---------------------------------------------------------------------------
// Happy path: each op type, alone and combined.
// ---------------------------------------------------------------------------
describe("parsePatch — Add File", () => {
    test("parses a single Add File with multiple lines", () => {
        const text = [
            "*** Begin Patch",
            "*** Add File: hello.txt",
            "+Hello",
            "+world",
            "*** End Patch",
        ].join("\n");
        const p = parsePatch(text);
        expect(p.ops).toEqual([{ kind: "add", path: "hello.txt", lines: ["Hello", "world"] }]);
    });
    test("parses an Add File creating an empty file (zero body lines)", () => {
        const text = ["*** Begin Patch", "*** Add File: empty.txt", "*** End Patch"].join("\n");
        const p = parsePatch(text);
        expect(p.ops).toEqual([{ kind: "add", path: "empty.txt", lines: [] }]);
    });
    test("preserves an empty inserted line ('+' with no content)", () => {
        const text = ["*** Begin Patch", "*** Add File: x.txt", "+a", "+", "+b", "*** End Patch"].join("\n");
        const p = parsePatch(text);
        expect(p.ops).toEqual([{ kind: "add", path: "x.txt", lines: ["a", "", "b"] }]);
    });
});
describe("parsePatch — Delete File", () => {
    test("parses a single Delete File", () => {
        const text = ["*** Begin Patch", "*** Delete File: obsolete.txt", "*** End Patch"].join("\n");
        const p = parsePatch(text);
        expect(p.ops).toEqual([{ kind: "delete", path: "obsolete.txt" }]);
    });
    test("parses multiple Delete File ops", () => {
        const text = [
            "*** Begin Patch",
            "*** Delete File: a.txt",
            "*** Delete File: b.txt",
            "*** End Patch",
        ].join("\n");
        const p = parsePatch(text);
        expect(p.ops).toEqual([
            { kind: "delete", path: "a.txt" },
            { kind: "delete", path: "b.txt" },
        ]);
    });
});
describe("parsePatch — Update File (single hunk)", () => {
    test("parses an Update File with explicit hunk header", () => {
        const text = [
            "*** Begin Patch",
            "*** Update File: src/app.py",
            "@@ def greet():",
            ' print("hi")',
            '-print("Hi")',
            '+print("Hello, world!")',
            "*** End Patch",
        ].join("\n");
        const p = parsePatch(text);
        expect(p.ops).toHaveLength(1);
        const op = p.ops[0];
        if (op?.kind !== "update")
            throw new Error("expected update");
        expect(op.path).toBe("src/app.py");
        expect(op.moveTo).toBeUndefined();
        expect(op.hunks).toHaveLength(1);
        const hunk = op.hunks[0];
        if (hunk === undefined)
            throw new Error("missing hunk");
        expect(hunk.contextHeader).toBe("def greet():");
        expect(hunk.endOfFile).toBe(false);
        // Parser strips the 1-byte prefix (per EBNF `change_line ::= (prefix)
        // /(.*)/`) — context content begins at byte 1.
        expect(hunk.changes).toEqual([
            { kind: "context", line: 'print("hi")' },
            { kind: "delete", line: 'print("Hi")' },
            { kind: "insert", line: 'print("Hello, world!")' },
        ]);
    });
    test("parses an Update File with bare '@@' header (no context)", () => {
        const text = [
            "*** Begin Patch",
            "*** Update File: a.txt",
            "@@",
            "-old",
            "+new",
            "*** End Patch",
        ].join("\n");
        const p = parsePatch(text);
        const op = p.ops[0];
        if (op?.kind !== "update")
            throw new Error("expected update");
        const hunk = op.hunks[0];
        if (hunk === undefined)
            throw new Error("missing hunk");
        expect(hunk.contextHeader).toBeUndefined();
    });
    test("parses Update File with implicit single hunk (no @@ header)", () => {
        const text = [
            "*** Begin Patch",
            "*** Update File: a.txt",
            " keep",
            "-old",
            "+new",
            "*** End Patch",
        ].join("\n");
        const p = parsePatch(text);
        const op = p.ops[0];
        if (op?.kind !== "update")
            throw new Error("expected update");
        expect(op.hunks).toHaveLength(1);
    });
});
describe("parsePatch — Update File (multi-hunk + EOF + Move to)", () => {
    test("parses multiple hunks in one Update File", () => {
        const text = [
            "*** Begin Patch",
            "*** Update File: f.txt",
            "@@ first",
            "-a",
            "+A",
            "@@ second",
            "-b",
            "+B",
            "*** End Patch",
        ].join("\n");
        const p = parsePatch(text);
        const op = p.ops[0];
        if (op?.kind !== "update")
            throw new Error("expected update");
        expect(op.hunks).toHaveLength(2);
        expect(op.hunks[0]?.contextHeader).toBe("first");
        expect(op.hunks[1]?.contextHeader).toBe("second");
    });
    test("parses '*** End of File' marker on a hunk", () => {
        const text = [
            "*** Begin Patch",
            "*** Update File: f.txt",
            "@@",
            " last-context",
            "-old-tail",
            "+new-tail",
            "*** End of File",
            "*** End Patch",
        ].join("\n");
        const p = parsePatch(text);
        const op = p.ops[0];
        if (op?.kind !== "update")
            throw new Error("expected update");
        expect(op.hunks).toHaveLength(1);
        expect(op.hunks[0]?.endOfFile).toBe(true);
    });
    test("parses '*** Move to:' followed by hunk content", () => {
        const text = [
            "*** Begin Patch",
            "*** Update File: src/app.py",
            "*** Move to: src/main.py",
            "@@ def greet():",
            '-print("Hi")',
            '+print("Hello")',
            "*** End Patch",
        ].join("\n");
        const p = parsePatch(text);
        const op = p.ops[0];
        if (op?.kind !== "update")
            throw new Error("expected update");
        expect(op.path).toBe("src/app.py");
        expect(op.moveTo).toBe("src/main.py");
        expect(op.hunks).toHaveLength(1);
    });
});
describe("parsePatch — combined ops", () => {
    test("parses a full Add + Update + Delete patch", () => {
        const text = [
            "*** Begin Patch",
            "*** Add File: hello.txt",
            "+Hello world",
            "*** Update File: src/app.py",
            "*** Move to: src/main.py",
            "@@ def greet():",
            '-print("Hi")',
            '+print("Hello, world!")',
            "*** Delete File: obsolete.txt",
            "*** End Patch",
        ].join("\n");
        const p = parsePatch(text);
        expect(p.ops).toHaveLength(3);
        expect(p.ops[0]?.kind).toBe("add");
        expect(p.ops[1]?.kind).toBe("update");
        expect(p.ops[2]?.kind).toBe("delete");
    });
    test("tolerates a trailing newline after End Patch", () => {
        const text = `*** Begin Patch\n*** Delete File: a\n*** End Patch\n`;
        const p = parsePatch(text);
        expect(p.ops).toEqual([{ kind: "delete", path: "a" }]);
    });
    test("tolerates CRLF line endings", () => {
        const text = "*** Begin Patch\r\n*** Delete File: a\r\n*** End Patch\r\n";
        const p = parsePatch(text);
        expect(p.ops).toEqual([{ kind: "delete", path: "a" }]);
    });
});
// ---------------------------------------------------------------------------
// Error cases — each must throw PatchParseError, never silently repair.
// ---------------------------------------------------------------------------
describe("parsePatch — grammar violations throw PatchParseError", () => {
    test("missing Begin Patch header", () => {
        expect(() => parsePatch("*** Add File: a\n+x\n*** End Patch\n")).toThrow(PatchParseError);
    });
    test("missing End Patch terminator", () => {
        expect(() => parsePatch("*** Begin Patch\n*** Delete File: a\n")).toThrow(PatchParseError);
    });
    test("Add File body with non-'+' line", () => {
        const text = "*** Begin Patch\n*** Add File: a\n+ok\nbad line\n*** End Patch\n";
        expect(() => parsePatch(text)).toThrow(PatchParseError);
    });
    test("Add File body with '-' prefix line", () => {
        const text = "*** Begin Patch\n*** Add File: a\n-bad\n*** End Patch\n";
        expect(() => parsePatch(text)).toThrow(PatchParseError);
    });
    test("Update File body with garbage line (no prefix, no header)", () => {
        const text = "*** Begin Patch\n*** Update File: a\n@@\nbroken-no-prefix\n*** End Patch\n";
        expect(() => parsePatch(text)).toThrow(PatchParseError);
    });
    test("empty Update File (no hunks at all) rejected", () => {
        const text = "*** Begin Patch\n*** Update File: a\n*** End Patch\n";
        expect(() => parsePatch(text)).toThrow(PatchParseError);
    });
    test("duplicate Move to in single Update", () => {
        const text = [
            "*** Begin Patch",
            "*** Update File: a",
            "*** Move to: b",
            "*** Move to: c",
            "@@",
            "-x",
            "+y",
            "*** End Patch",
        ].join("\n");
        expect(() => parsePatch(text)).toThrow(PatchParseError);
    });
    test("Move to AFTER hunk content rejected", () => {
        const text = [
            "*** Begin Patch",
            "*** Update File: a",
            "@@",
            "-x",
            "+y",
            "*** Move to: b",
            "*** End Patch",
        ].join("\n");
        expect(() => parsePatch(text)).toThrow(PatchParseError);
    });
    test("End of File without preceding hunk rejected", () => {
        const text = "*** Begin Patch\n*** Update File: a\n*** End of File\n*** End Patch\n";
        expect(() => parsePatch(text)).toThrow(PatchParseError);
    });
    test("empty Add File path rejected", () => {
        const text = "*** Begin Patch\n*** Add File: \n*** End Patch\n";
        expect(() => parsePatch(text)).toThrow(PatchParseError);
    });
    test("empty Delete File path rejected", () => {
        const text = "*** Begin Patch\n*** Delete File: \n*** End Patch\n";
        expect(() => parsePatch(text)).toThrow(PatchParseError);
    });
    test("content after End Patch rejected", () => {
        const text = "*** Begin Patch\n*** Delete File: a\n*** End Patch\nstray content\n";
        expect(() => parsePatch(text)).toThrow(PatchParseError);
    });
    test("PatchParseError carries the offending 1-based line number", () => {
        const text = "*** Begin Patch\n*** Add File: a\n+ok\nBAD\n*** End Patch\n";
        try {
            parsePatch(text);
            throw new Error("should have thrown");
        }
        catch (e) {
            expect(e).toBeInstanceOf(PatchParseError);
            const err = e;
            expect(err.lineNumber).toBe(4);
        }
    });
});
