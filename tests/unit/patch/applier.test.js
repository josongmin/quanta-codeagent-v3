import { describe, expect, test } from "bun:test";
import { applyPatch, PatchAnchorNotFoundError, PatchApplyError, parsePatch, } from "../../../src/patch/index.js";
// ---------------------------------------------------------------------------
// In-memory PatchFileSystemPort — pure, deterministic test double.
// ---------------------------------------------------------------------------
class MemFs {
    files = new Map();
    constructor(seed = {}) {
        for (const [k, v] of Object.entries(seed))
            this.files.set(k, v);
    }
    async readFile(path) {
        const v = this.files.get(path);
        if (v === undefined)
            throw new Error(`MemFs: no such file '${path}'`);
        return v;
    }
    async writeFile(path, content) {
        this.files.set(path, content);
    }
    async deleteFile(path) {
        if (!this.files.has(path))
            throw new Error(`MemFs: cannot delete missing '${path}'`);
        this.files.delete(path);
    }
    async renameFile(from, to) {
        const v = this.files.get(from);
        if (v === undefined)
            throw new Error(`MemFs: cannot rename missing '${from}'`);
        this.files.delete(from);
        this.files.set(to, v);
    }
    async exists(path) {
        return this.files.has(path);
    }
    snapshot() {
        return Object.fromEntries(this.files.entries());
    }
}
// ---------------------------------------------------------------------------
// Add / Delete happy paths.
// ---------------------------------------------------------------------------
describe("applyPatch — Add File", () => {
    test("creates a new file with the patch contents", async () => {
        const fs = new MemFs();
        const p = parsePatch("*** Begin Patch\n*** Add File: a.txt\n+hi\n+bye\n*** End Patch\n");
        const r = await applyPatch(p, fs);
        expect(r.filesAdded).toEqual(["a.txt"]);
        expect(fs.snapshot()).toEqual({ "a.txt": "hi\nbye" });
    });
    test("creates an empty file when Add File has zero body lines", async () => {
        const fs = new MemFs();
        const p = parsePatch("*** Begin Patch\n*** Add File: empty.txt\n*** End Patch\n");
        const r = await applyPatch(p, fs);
        expect(r.filesAdded).toEqual(["empty.txt"]);
        expect(fs.snapshot()).toEqual({ "empty.txt": "" });
    });
    test("rejects Add File when destination already exists", async () => {
        const fs = new MemFs({ "a.txt": "exists" });
        const p = parsePatch("*** Begin Patch\n*** Add File: a.txt\n+new\n*** End Patch\n");
        await expect(applyPatch(p, fs)).rejects.toBeInstanceOf(PatchApplyError);
    });
});
describe("applyPatch — Delete File", () => {
    test("removes an existing file", async () => {
        const fs = new MemFs({ "a.txt": "content" });
        const p = parsePatch("*** Begin Patch\n*** Delete File: a.txt\n*** End Patch\n");
        const r = await applyPatch(p, fs);
        expect(r.filesDeleted).toEqual(["a.txt"]);
        expect(fs.snapshot()).toEqual({});
    });
    test("rejects Delete File when target missing", async () => {
        const fs = new MemFs();
        const p = parsePatch("*** Begin Patch\n*** Delete File: nope.txt\n*** End Patch\n");
        await expect(applyPatch(p, fs)).rejects.toBeInstanceOf(PatchApplyError);
    });
});
// ---------------------------------------------------------------------------
// Update File: exact match.
// ---------------------------------------------------------------------------
describe("applyPatch — Update File (exact match)", () => {
    test("applies a single-hunk replacement", async () => {
        const fs = new MemFs({ "a.txt": "line1\nline2\nline3\n" });
        const text = [
            "*** Begin Patch",
            "*** Update File: a.txt",
            "@@",
            " line1",
            "-line2",
            "+LINE2",
            " line3",
            "*** End Patch",
        ].join("\n");
        const r = await applyPatch(parsePatch(text), fs);
        expect(r.filesUpdated).toEqual(["a.txt"]);
        expect(fs.snapshot()["a.txt"]).toBe("line1\nLINE2\nline3\n");
    });
    test("applies pure insertion (no deletes)", async () => {
        const fs = new MemFs({ "a.txt": "a\nb\nc\n" });
        const text = [
            "*** Begin Patch",
            "*** Update File: a.txt",
            "@@",
            " a",
            "+inserted",
            " b",
            "*** End Patch",
        ].join("\n");
        await applyPatch(parsePatch(text), fs);
        expect(fs.snapshot()["a.txt"]).toBe("a\ninserted\nb\nc\n");
    });
    test("applies pure deletion (no inserts)", async () => {
        const fs = new MemFs({ "a.txt": "a\nb\nc\n" });
        const text = [
            "*** Begin Patch",
            "*** Update File: a.txt",
            "@@",
            " a",
            "-b",
            " c",
            "*** End Patch",
        ].join("\n");
        await applyPatch(parsePatch(text), fs);
        expect(fs.snapshot()["a.txt"]).toBe("a\nc\n");
    });
    test("applies multi-hunk patch sequentially", async () => {
        const fs = new MemFs({ "f.txt": "alpha\nbeta\ngamma\ndelta\n" });
        const text = [
            "*** Begin Patch",
            "*** Update File: f.txt",
            "@@",
            "-alpha",
            "+ALPHA",
            "@@",
            "-delta",
            "+DELTA",
            "*** End Patch",
        ].join("\n");
        await applyPatch(parsePatch(text), fs);
        expect(fs.snapshot()["f.txt"]).toBe("ALPHA\nbeta\ngamma\nDELTA\n");
    });
    test("preserves absence of trailing newline", async () => {
        const fs = new MemFs({ "a.txt": "x\ny\nz" }); // no trailing \n
        const text = [
            "*** Begin Patch",
            "*** Update File: a.txt",
            "@@",
            " x",
            "-y",
            "+Y",
            " z",
            "*** End Patch",
        ].join("\n");
        await applyPatch(parsePatch(text), fs);
        expect(fs.snapshot()["a.txt"]).toBe("x\nY\nz");
    });
});
// ---------------------------------------------------------------------------
// Update File: deterministic fuzzy (whitespace-tolerant) match.
// ---------------------------------------------------------------------------
describe("applyPatch — Update File (whitespace-tolerant match)", () => {
    test("matches when file has extra leading whitespace per line", async () => {
        const fs = new MemFs({ "a.txt": "  line1\n  line2\n  line3\n" });
        // Patch context has NO leading whitespace; file has 2-space indent.
        // Tier B (trimmed) matches the WHOLE oldBlock. Per ADR-0028 trade-off,
        // replacement uses the PATCH's literal lines — original indentation on
        // matched lines is stripped. Documented; matches Codex behavior.
        const text = [
            "*** Begin Patch",
            "*** Update File: a.txt",
            "@@",
            " line1",
            "-line2",
            "+LINE2",
            " line3",
            "*** End Patch",
        ].join("\n");
        await applyPatch(parsePatch(text), fs);
        expect(fs.snapshot()["a.txt"]).toBe("line1\nLINE2\nline3\n");
    });
    test("ambiguous exact match (multiple candidates) throws PatchApplyError", async () => {
        const fs = new MemFs({ "a.txt": "dup\nx\ndup\ny\n" });
        const text = [
            "*** Begin Patch",
            "*** Update File: a.txt",
            "@@",
            "-dup",
            "+REPLACED",
            "*** End Patch",
        ].join("\n");
        await expect(applyPatch(parsePatch(text), fs)).rejects.toBeInstanceOf(PatchApplyError);
    });
    test("anchor not found at all throws PatchAnchorNotFoundError", async () => {
        const fs = new MemFs({ "a.txt": "alpha\nbeta\n" });
        const text = [
            "*** Begin Patch",
            "*** Update File: a.txt",
            "@@",
            " alpha",
            "-NOTHERE",
            "+REPLACED",
            "*** End Patch",
        ].join("\n");
        await expect(applyPatch(parsePatch(text), fs)).rejects.toBeInstanceOf(PatchAnchorNotFoundError);
    });
});
// ---------------------------------------------------------------------------
// End-of-File anchor.
// ---------------------------------------------------------------------------
describe("applyPatch — End-of-File anchor", () => {
    test("matches the trailing lines of the file", async () => {
        const fs = new MemFs({ "a.txt": "head\nmid\ntail\n" });
        const text = [
            "*** Begin Patch",
            "*** Update File: a.txt",
            "@@",
            " mid",
            "-tail",
            "+TAIL",
            "*** End of File",
            "*** End Patch",
        ].join("\n");
        await applyPatch(parsePatch(text), fs);
        expect(fs.snapshot()["a.txt"]).toBe("head\nmid\nTAIL\n");
    });
    test("EOF hunk with no oldBlock appends pure insert at end", async () => {
        const fs = new MemFs({ "a.txt": "a\nb\n" });
        const text = [
            "*** Begin Patch",
            "*** Update File: a.txt",
            "@@",
            "+appended-1",
            "+appended-2",
            "*** End of File",
            "*** End Patch",
        ].join("\n");
        await applyPatch(parsePatch(text), fs);
        expect(fs.snapshot()["a.txt"]).toBe("a\nb\nappended-1\nappended-2\n");
    });
    test("EOF anchor mismatch throws PatchAnchorNotFoundError", async () => {
        const fs = new MemFs({ "a.txt": "a\nb\nc\n" });
        const text = [
            "*** Begin Patch",
            "*** Update File: a.txt",
            "@@",
            " a",
            "-DOES-NOT-MATCH",
            "+x",
            "*** End of File",
            "*** End Patch",
        ].join("\n");
        await expect(applyPatch(parsePatch(text), fs)).rejects.toBeInstanceOf(PatchAnchorNotFoundError);
    });
});
// ---------------------------------------------------------------------------
// Move to: rename + edit atomic.
// ---------------------------------------------------------------------------
describe("applyPatch — Move to", () => {
    test("renames file and applies edits atomically", async () => {
        const fs = new MemFs({ "src/app.py": "def greet():\n    print('Hi')\n" });
        const text = [
            "*** Begin Patch",
            "*** Update File: src/app.py",
            "*** Move to: src/main.py",
            "@@ def greet():",
            "-    print('Hi')",
            "+    print('Hello, world!')",
            "*** End Patch",
        ].join("\n");
        const r = await applyPatch(parsePatch(text), fs);
        expect(r.filesMoved).toEqual([["src/app.py", "src/main.py"]]);
        expect(fs.snapshot()).toEqual({ "src/main.py": "def greet():\n    print('Hello, world!')\n" });
    });
    test("rejects Move to when destination already exists", async () => {
        const fs = new MemFs({
            "src/app.py": "x\n",
            "src/main.py": "occupied\n",
        });
        const text = [
            "*** Begin Patch",
            "*** Update File: src/app.py",
            "*** Move to: src/main.py",
            "@@",
            "-x",
            "+X",
            "*** End Patch",
        ].join("\n");
        await expect(applyPatch(parsePatch(text), fs)).rejects.toBeInstanceOf(PatchApplyError);
        // Source untouched.
        expect(fs.snapshot()["src/app.py"]).toBe("x\n");
    });
});
// ---------------------------------------------------------------------------
// Pure-insert hunks without anchor / EOF marker — must reject.
// ---------------------------------------------------------------------------
describe("applyPatch — guard rails on ambiguous insertions", () => {
    test("rejects an Update hunk with only insert lines and no EOF marker", async () => {
        const fs = new MemFs({ "a.txt": "x\ny\n" });
        const text = [
            "*** Begin Patch",
            "*** Update File: a.txt",
            "@@",
            "+inserted",
            "*** End Patch",
        ].join("\n");
        await expect(applyPatch(parsePatch(text), fs)).rejects.toBeInstanceOf(PatchApplyError);
    });
    test("rejects Update on a missing target file", async () => {
        const fs = new MemFs();
        const text = [
            "*** Begin Patch",
            "*** Update File: nope.txt",
            "@@",
            "-x",
            "+y",
            "*** End Patch",
        ].join("\n");
        await expect(applyPatch(parsePatch(text), fs)).rejects.toBeInstanceOf(PatchApplyError);
    });
});
