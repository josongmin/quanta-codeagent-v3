import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { __resetRuntimeConfig } from "@/shared";
import { FsJailError, fileExists, parentDir, readFile, resolvePath, statFile, writeFile, } from "@/storage";
const dir = mkdtempSync(join(tmpdir(), "storage-test-"));
afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
});
describe("resolvePath", () => {
    test("returns an absolute path unchanged", () => {
        const abs = join(dir, "abs.txt");
        expect(resolvePath(abs)).toBe(abs);
        expect(isAbsolute(resolvePath(abs))).toBe(true);
    });
    test("resolves a relative path against process.cwd()", () => {
        expect(resolvePath("a/b.txt")).toBe(resolve(process.cwd(), "a/b.txt"));
    });
    test("resolves a relative path against an explicit baseDir", () => {
        expect(resolvePath("a/b.txt", dir)).toBe(resolve(dir, "a/b.txt"));
    });
    // S6 posture change (secure-by-default): with an explicit baseDir, an
    // absolute path is no longer a blind no-op — if it lands OUTSIDE the jail
    // root it is now DENIED (the whole point of the chokepoint: an unguarded
    // absolute `/etc/passwd` must not escape). The pre-jail "absolute wins"
    // no-op only holds for no-baseDir callers or with QUANTA_FS_JAIL=off.
    test("an absolute path outside an explicit baseDir is jailed (S6)", () => {
        const abs = join(dir, "abs.txt");
        expect(() => resolvePath(abs, "/some/other/base")).toThrow(FsJailError);
    });
    test("an absolute path INSIDE the baseDir jail is returned unchanged", () => {
        const abs = join(dir, "abs.txt");
        expect(resolvePath(abs, dir)).toBe(abs);
    });
    test("absolute-over-baseDir no-op is restored with QUANTA_FS_JAIL=off", () => {
        process.env.QUANTA_FS_JAIL = "off";
        __resetRuntimeConfig();
        try {
            const abs = join(dir, "abs.txt");
            expect(resolvePath(abs, "/some/other/base")).toBe(abs);
        }
        finally {
            delete process.env.QUANTA_FS_JAIL;
            __resetRuntimeConfig();
        }
    });
    test("empty baseDir falls back to process.cwd()", () => {
        expect(resolvePath("a/b.txt", "")).toBe(resolve(process.cwd(), "a/b.txt"));
    });
});
describe("parentDir", () => {
    test("returns the directory of a resolved absolute path", () => {
        expect(parentDir(join(dir, "child.txt"))).toBe(dir);
    });
    test("resolves relative input before taking the dirname", () => {
        expect(parentDir("foo/bar.txt")).toBe(resolve(process.cwd(), "foo"));
    });
});
describe("writeFile / readFile round-trip", () => {
    test("writes then reads back identical content", async () => {
        const path = join(dir, "round.txt");
        await writeFile(path, "round-trip ✅ payload");
        expect(await readFile(path)).toBe("round-trip ✅ payload");
    });
    test("writeFile creates missing parent directories", async () => {
        const path = join(dir, "nested", "deep", "file.txt");
        await writeFile(path, "deep");
        expect(await readFile(path)).toBe("deep");
    });
    test("writeFile overwrites existing content", async () => {
        const path = join(dir, "over.txt");
        await writeFile(path, "first");
        await writeFile(path, "second");
        expect(await readFile(path)).toBe("second");
    });
    test("readFile rejects with a 'File not found' error for a missing file", async () => {
        const missing = join(dir, "nope.txt");
        await expect(readFile(missing)).rejects.toThrow(`File not found: ${missing}`);
    });
    test("a relative path is resolved against baseDir, not process.cwd()", async () => {
        await writeFile("rel.txt", "based", dir);
        expect(await fileExists("rel.txt", dir)).toBe(true);
        expect(await readFile("rel.txt", dir)).toBe("based");
        expect((await statFile("rel.txt", dir)).path).toBe(join(dir, "rel.txt"));
        expect(parentDir("sub/rel.txt", dir)).toBe(join(dir, "sub"));
        // The same relative name must NOT exist under process.cwd().
        expect(await fileExists("rel.txt")).toBe(false);
    });
});
describe("fileExists", () => {
    test("true for an existing file, false for a missing one", async () => {
        const path = join(dir, "exists.txt");
        await writeFile(path, "x");
        expect(await fileExists(path)).toBe(true);
        expect(await fileExists(join(dir, "absent.txt"))).toBe(false);
    });
});
describe("FS jail (S6) — only when an explicit baseDir is passed", () => {
    test("with baseDir: `..` climb above the jail root throws FsJailError", () => {
        expect(() => resolvePath("../../etc/hosts", dir)).toThrow(FsJailError);
    });
    test("with baseDir: an absolute path outside the jail throws FsJailError", () => {
        expect(() => resolvePath("/etc/hosts", dir)).toThrow(FsJailError);
    });
    test("with baseDir: in-jail relative paths still resolve normally", () => {
        expect(resolvePath("a/b.txt", dir)).toBe(resolve(dir, "a/b.txt"));
    });
    test("WITHOUT baseDir (state.ts pattern): jail is NOT enforced", () => {
        // Legacy callers must be byte-identical: absolute path returned as-is,
        // a `..`-laden relative path simply resolves against process.cwd().
        expect(resolvePath("/etc/hosts")).toBe("/etc/hosts");
        expect(resolvePath("../up.txt")).toBe(resolve(process.cwd(), "../up.txt"));
    });
    test("QUANTA_FS_JAIL=off disables the jail even with a baseDir", () => {
        process.env.QUANTA_FS_JAIL = "off";
        __resetRuntimeConfig();
        try {
            expect(resolvePath("/etc/hosts", dir)).toBe("/etc/hosts");
            expect(() => resolvePath("../../etc/hosts", dir)).not.toThrow();
        }
        finally {
            delete process.env.QUANTA_FS_JAIL;
            __resetRuntimeConfig();
        }
    });
});
describe("statFile", () => {
    test("reports absolute path, byte size, and non-directory for a file", async () => {
        const path = join(dir, "stat.txt");
        const content = "héllo"; // multibyte → byte size differs from char length
        await writeFile(path, content);
        const info = await statFile(path);
        expect(info.path).toBe(path);
        expect(isAbsolute(info.path)).toBe(true);
        expect(info.size).toBe(Buffer.byteLength(content, "utf8"));
        expect(info.isDirectory).toBe(false);
    });
    test("isDirectory is true for a directory", async () => {
        const info = await statFile(dir);
        expect(info.isDirectory).toBe(true);
        expect(info.path).toBe(dir);
    });
    test("rejects for a non-existent path", async () => {
        await expect(statFile(join(dir, "ghost.txt"))).rejects.toThrow();
    });
});
