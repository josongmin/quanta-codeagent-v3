import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StructuredLogger } from "@/observability";
import { defaultUntitled, idModeEnabled, isPathLikeToken, newSessionFlag, resolveResume, resumePath, titleFlag, } from "../../src/apps/cli/internal";
/**
 * `--resume <token>` id-OR-path heuristic + id-mode flag contract.
 *
 * The dispatcher in `src/apps/cli/index.ts` reads `resumePath()` and then
 * branches on `isPathLikeToken()`. We exercise the classifier directly so
 * a regression in the heuristic is caught without spawning the binary.
 */
describe("isPathLikeToken (id-OR-path heuristic)", () => {
    test("tokens containing `/` are path-like", () => {
        expect(isPathLikeToken("/abs/path/session.json")).toBe(true);
        expect(isPathLikeToken("rel/path")).toBe(true);
        expect(isPathLikeToken("./session")).toBe(true);
    });
    test("tokens containing `\\` are path-like (Windows-style)", () => {
        expect(isPathLikeToken("C:\\sessions\\s1.json")).toBe(true);
        expect(isPathLikeToken("dir\\sub")).toBe(true);
    });
    test("tokens ending in `.json` are path-like even without a slash", () => {
        expect(isPathLikeToken("session.json")).toBe(true);
        expect(isPathLikeToken("a-id.json")).toBe(true);
    });
    test("plain id-like tokens are NOT path-like", () => {
        expect(isPathLikeToken("abc")).toBe(false);
        expect(isPathLikeToken("11111111-2222-3333-4444-555555555555")).toBe(false);
        expect(isPathLikeToken("my-session-id")).toBe(false);
        expect(isPathLikeToken("sess_42")).toBe(false);
    });
    // Audit Round 3 §C — pin the current behavior for an EMPTY token. The CLI
    // dispatcher in index.ts must reject `--resume <empty>` before calling
    // resolveResume; this test pins the classifier's current output so a future
    // change to the heuristic is intentional, not silent.
    test("empty token routes to id-mode (caller is expected to reject before resolveResume)", () => {
        // Empty string has no `/`, no `\`, doesn't end in `.json`, so the
        // heuristic classifies it as id-mode. The actual rejection of an empty
        // --resume token must therefore happen up-stack — sessionFilePath's
        // sanitizeId throws on length=0, providing the back-stop.
        expect(isPathLikeToken("")).toBe(false);
    });
    // Audit Round 3 §C — combined `/` AND `.json` token: a single decisive case
    // proving either signal alone is enough to force path-mode.
    test("token containing both `/` and `.json` is path-like", () => {
        expect(isPathLikeToken("foo/bar.json")).toBe(true);
    });
});
describe("resumePath / idModeEnabled / newSessionFlag / titleFlag (argv parsers)", () => {
    let argvSnapshot;
    let envSnapshot;
    let tmp;
    beforeEach(() => {
        argvSnapshot = process.argv.slice();
        envSnapshot = { ...process.env };
        delete process.env.QUANTA_RESUME;
        tmp = mkdtempSync(join(tmpdir(), "cli-resume-arg-"));
        process.argv = ["bun", "quanta"];
    });
    afterEach(() => {
        process.argv = argvSnapshot;
        for (const key of Object.keys(process.env)) {
            if (!(key in envSnapshot))
                delete process.env[key];
        }
        Object.assign(process.env, envSnapshot);
        rmSync(tmp, { recursive: true, force: true });
    });
    test("no flags: idModeEnabled is false (byte-identical default-OFF)", () => {
        expect(resumePath()).toBeUndefined();
        expect(idModeEnabled()).toBe(false);
        expect(newSessionFlag()).toBe(false);
        expect(titleFlag()).toBeUndefined();
    });
    test("--resume <path-like> ⇒ NOT id-mode (path-mode preserved)", () => {
        process.argv = ["bun", "quanta", "--resume", `${tmp}/session.json`];
        expect(resumePath()).toBe(`${tmp}/session.json`);
        expect(idModeEnabled()).toBe(false);
    });
    test("--resume <id-like> ⇒ id-mode", () => {
        process.argv = ["bun", "quanta", "--resume", "abc-id-123"];
        expect(resumePath()).toBe("abc-id-123");
        expect(idModeEnabled()).toBe(true);
    });
    test("--new-session toggles id-mode without a token", () => {
        process.argv = ["bun", "quanta", "--new-session"];
        expect(resumePath()).toBeUndefined();
        expect(newSessionFlag()).toBe(true);
        expect(idModeEnabled()).toBe(true);
    });
    test("--title <t> is read independently of --new-session", () => {
        process.argv = ["bun", "quanta", "--new-session", "--title", "My Session"];
        expect(titleFlag()).toBe("My Session");
    });
    test("QUANTA_RESUME env mirrors --resume token semantics", () => {
        process.env.QUANTA_RESUME = "env-session-id";
        expect(resumePath()).toBe("env-session-id");
        expect(idModeEnabled()).toBe(true);
        process.env.QUANTA_RESUME = "/abs/path.json";
        expect(idModeEnabled()).toBe(false);
    });
});
describe("resolveResume conflict + default-title contract", () => {
    // HIGH-5: `--new-session --resume <id>` is ambiguous; resolveResume returns a
    //   `conflictError` sentinel so the caller can print + exit 1 (instead of
    //   the prior silent-ignore of `--new-session`).
    test("--new-session AND --resume together return a conflictError sentinel", async () => {
        const slog = new StructuredLogger();
        const r = await resolveResume({
            resume: "abc-id-123",
            newSession: true,
            title: undefined,
            cwd: "/tmp",
            initialSessionId: "init-id",
            slog,
        });
        expect(r.conflictError).toBe("cannot combine --new-session with --resume");
        expect(r.idMeta).toBeUndefined();
        expect(r.missingIdError).toBeUndefined();
    });
    // LOW: default title for `--new-session` is now `Untitled YYYY-MM-DD HH:mm`
    //   (16-char compact UTC) instead of the ugly full ISO.
    test("defaultUntitled formats as `Untitled YYYY-MM-DD HH:mm`", () => {
        // 2026-05-21T13:45:00.000Z
        const ts = Date.UTC(2026, 4, 21, 13, 45, 0);
        expect(defaultUntitled(ts)).toBe("Untitled 2026-05-21 13:45");
    });
});
