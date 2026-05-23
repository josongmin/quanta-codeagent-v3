import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StructuredLogger } from "@/observability";
import { runShell } from "@/runtime";
import { archivedFilePath, listSessions, loadSessionById, saveSessionById, sessionFilePath, } from "@/session";
import { __resetRuntimeConfig } from "@/shared";
import { resolveResume } from "../../src/apps/cli/internal";
import { runSessionCommand } from "../../src/apps/cli/session-commands";
/**
 * End-to-end UX integration for `quanta session` and the conflict-error path
 * in `--new-session --resume <id>`. Drives the dispatcher (not the binary) so
 * we get fast, deterministic coverage with no subprocess flakiness.
 *
 * What this locks in (audit IDs in []):
 *   - [HIGH-5] `--new-session --resume <id>` → resolveResume returns
 *     `conflictError: "cannot combine --new-session with --resume"`.
 *   - [HIGH-6] `session delete` of a worktree-backed fork removes the
 *     worktree dir + branch BEFORE deleting the session record.
 *   - [MEDIUM-7] `ls --ids` prints one id per line, no header.
 *   - [MEDIUM-9] `show --json` emits the full SavedSession envelope.
 *   - [MEDIUM-8] trailing positional args are rejected (unexpected argument).
 *   - [MEDIUM-11] `rename <id> "   "` is rejected before mutating.
 *   - [LOW] empty active list with archived hidden gets a `(use --archived ...)` hint.
 *   - The full lifecycle: save → ls → show → rename → archive → unarchive →
 *     fork → fork --worktree → delete (worktree-aware) → path.
 *
 * Note: this file is in `tests/integration/` and is allowlisted in `biome.json`
 * for `src/apps/cli/**` imports — same pattern as `cli-session-commands` /
 * `cli-resume-heuristic` unit tests. NO production code was changed for it.
 */
const gitAvailable = async () => {
    try {
        const r = await runShell("git --version");
        return r.exitCode === 0;
    }
    catch {
        return false;
    }
};
const HAS_GIT = await gitAvailable();
const makeRepo = async () => {
    const dir = mkdtempSync(join(tmpdir(), "ux-e2e-repo-"));
    const sh = (c) => runShell(c, { cwd: dir });
    await sh("git init -q");
    await sh("git config user.email t@t.t && git config user.name t");
    await writeFile(join(dir, "README.md"), "hello\n");
    await sh("git add -A && git commit -q -m init");
    return dir;
};
const captureDeps = (confirmAnswer = true) => {
    const c = {
        out: "",
        err: "",
        deps: {
            out: (s) => {
                c.out += s;
            },
            err: (s) => {
                c.err += s;
            },
            confirm: async () => confirmAnswer,
        },
    };
    return c;
};
const mkMeta = (overrides = {}) => {
    const now = Date.now();
    return {
        id: overrides.id ?? "ux-1",
        title: overrides.title ?? "T",
        cwd: overrides.cwd ?? "/tmp/work",
        createdAt: overrides.createdAt ?? now,
        lastTouched: overrides.lastTouched ?? now,
        archived: overrides.archived ?? false,
    };
};
const mkPayload = () => ({
    reason: "completed",
    turns: 1,
    messages: [
        { role: "user", content: [{ type: "text", text: "hi" }] },
        { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ],
});
describe("session UX e2e (non-git lifecycle)", () => {
    let sessionsDir;
    let envSnapshot;
    beforeEach(() => {
        envSnapshot = { ...process.env };
        sessionsDir = mkdtempSync(join(tmpdir(), "ux-e2e-sessions-"));
        process.env.QUANTA_SESSIONS_DIR = sessionsDir;
        __resetRuntimeConfig();
    });
    afterEach(() => {
        rmSync(sessionsDir, { recursive: true, force: true });
        for (const key of Object.keys(process.env)) {
            if (!(key in envSnapshot))
                delete process.env[key];
        }
        Object.assign(process.env, envSnapshot);
        __resetRuntimeConfig();
    });
    test("full lifecycle: ls > save > ls > show > rename > archive > unarchive > fork > delete > path", async () => {
        // 1. Empty `ls`
        {
            const c = captureDeps();
            expect(await runSessionCommand(["ls"], c.deps)).toBe(0);
            expect(c.out).toContain("(no sessions)");
        }
        // 2. Mint a session directly (bypasses --new-session which needs LLM wiring).
        const id = "lifecycle-1";
        await saveSessionById(mkMeta({ id, title: "L1" }), mkPayload());
        // 3. `ls` shows the row.
        {
            const c = captureDeps();
            expect(await runSessionCommand(["ls"], c.deps)).toBe(0);
            expect(c.out).toContain(id);
            expect(c.out).toContain("L1");
        }
        // 4. `ls --json` parses to an array containing the meta.
        {
            const c = captureDeps();
            expect(await runSessionCommand(["ls", "--json"], c.deps)).toBe(0);
            const arr = JSON.parse(c.out);
            expect(arr.find((m) => m.id === id)?.title).toBe("L1");
        }
        // 5. [MEDIUM-7] `ls --ids` prints exactly the id, no header.
        {
            const c = captureDeps();
            expect(await runSessionCommand(["ls", "--ids"], c.deps)).toBe(0);
            expect(c.out.trim()).toBe(id);
            expect(c.out).not.toContain("TITLE");
        }
        // 6. `show <id>` renders header + bodies.
        {
            const c = captureDeps();
            expect(await runSessionCommand(["show", id], c.deps)).toBe(0);
            expect(c.out).toContain(`Session ${id}`);
            expect(c.out).toContain("[user] hi");
            expect(c.out).toContain("[assistant] hello");
        }
        // 7. [MEDIUM-9] `show <id> --json` emits valid SavedSession JSON.
        {
            const c = captureDeps();
            expect(await runSessionCommand(["show", id, "--json"], c.deps)).toBe(0);
            const parsed = JSON.parse(c.out);
            expect(parsed.meta.id).toBe(id);
            expect(parsed.messages.length).toBeGreaterThan(0);
            expect(parsed.version).toBe(2);
        }
        // 8. `rename <id> "new title"` succeeds.
        {
            const c = captureDeps();
            expect(await runSessionCommand(["rename", id, "Lifecycle Two"], c.deps)).toBe(0);
            const reloaded = await loadSessionById(id);
            expect(reloaded?.meta.title).toBe("Lifecycle Two");
        }
        // 9. [MEDIUM-11] `rename <id> "   "` fails.
        {
            const c = captureDeps();
            expect(await runSessionCommand(["rename", id, "   "], c.deps)).toBe(1);
            expect(c.err).toContain("title cannot be empty");
            // And the title was NOT changed.
            const reloaded = await loadSessionById(id);
            expect(reloaded?.meta.title).toBe("Lifecycle Two");
        }
        // 10. `archive <id>` moves to archived.
        {
            const c = captureDeps();
            expect(await runSessionCommand(["archive", id], c.deps)).toBe(0);
            expect(existsSync(archivedFilePath(id))).toBe(true);
            expect(existsSync(sessionFilePath(id))).toBe(false);
        }
        // 11. [LOW] `ls` now empty with archived hint.
        {
            const c = captureDeps();
            expect(await runSessionCommand(["ls"], c.deps)).toBe(0);
            expect(c.out).toContain("(no sessions)");
            expect(c.out).toContain("(use --archived to see archived)");
        }
        // 12. `ls --archived` shows the row.
        {
            const c = captureDeps();
            expect(await runSessionCommand(["ls", "--archived"], c.deps)).toBe(0);
            expect(c.out).toContain(id);
        }
        // 13. `unarchive <id>` restores it.
        {
            const c = captureDeps();
            expect(await runSessionCommand(["unarchive", id], c.deps)).toBe(0);
            expect(existsSync(sessionFilePath(id))).toBe(true);
            expect(existsSync(archivedFilePath(id))).toBe(false);
        }
        // 14. `fork <id>` (non-worktree) — source preserved, fork created.
        let forkId = "";
        {
            const c = captureDeps();
            expect(await runSessionCommand(["fork", id], c.deps)).toBe(0);
            const m = c.out.match(/forked \S+ → (\S+)/);
            forkId = m?.[1] ?? "";
            expect(forkId).not.toBe("");
            expect(forkId).not.toBe(id);
            const forked = await loadSessionById(forkId);
            expect(forked?.meta.title).toBe("Lifecycle Two (fork)");
            // Source title still intact.
            const source = await loadSessionById(id);
            expect(source?.meta.title).toBe("Lifecycle Two");
        }
        // 15. `path <id>` prints the active file path.
        {
            const c = captureDeps();
            expect(await runSessionCommand(["path", id], c.deps)).toBe(0);
            expect(c.out.trim()).toBe(sessionFilePath(id));
        }
        // 16. [MEDIUM-8] trailing positional rejection on ls.
        {
            const c = captureDeps();
            expect(await runSessionCommand(["ls", "extra"], c.deps)).toBe(1);
            expect(c.err).toContain("unexpected argument: extra");
        }
        // 17. `delete <forkId> --force` (non-worktree fork — no worktree to clean).
        {
            const c = captureDeps();
            expect(await runSessionCommand(["delete", forkId, "--force"], c.deps)).toBe(0);
            expect(c.out).toContain(`deleted ${forkId}`);
            expect(existsSync(sessionFilePath(forkId))).toBe(false);
            // The "removed worktree:" line MUST NOT appear because the fork's cwd
            // wasn't a worktree path.
            expect(c.out).not.toContain("removed worktree:");
        }
    });
});
describe("session UX e2e — worktree fork + cleanup", () => {
    let sessionsDir;
    let repoDir;
    let envSnapshot;
    beforeAll(() => {
        envSnapshot = { ...process.env };
    });
    afterAll(() => {
        for (const key of Object.keys(process.env)) {
            if (!(key in envSnapshot))
                delete process.env[key];
        }
        Object.assign(process.env, envSnapshot);
    });
    beforeEach(() => {
        sessionsDir = mkdtempSync(join(tmpdir(), "ux-e2e-sessions-wt-"));
        process.env.QUANTA_SESSIONS_DIR = sessionsDir;
        __resetRuntimeConfig();
    });
    afterEach(() => {
        rmSync(sessionsDir, { recursive: true, force: true });
        if (repoDir) {
            rmSync(repoDir, { recursive: true, force: true });
            repoDir = undefined;
        }
        __resetRuntimeConfig();
    });
    test.skipIf(!HAS_GIT)("fork --worktree creates a worktree; delete --force removes worktree + branch", async () => {
        repoDir = await makeRepo();
        const id = "wt-src";
        await saveSessionById(mkMeta({ id, title: "WTSrc", cwd: repoDir }), mkPayload());
        // Fork via the dispatcher with --worktree.
        const cFork = captureDeps();
        expect(await runSessionCommand(["fork", id, "--worktree"], cFork.deps)).toBe(0);
        expect(cFork.out).toContain("worktree:");
        const m = cFork.out.match(/forked \S+ → (\S+)/);
        const forkId = m?.[1] ?? "";
        expect(forkId).not.toBe("");
        const forked = await loadSessionById(forkId);
        const wtPath = forked?.meta.cwd ?? "";
        expect(wtPath.startsWith(`${repoDir}/.quanta/worktrees/`)).toBe(true);
        expect(existsSync(wtPath)).toBe(true);
        // Delete the fork — worktree dir AND branch must be gone.
        const cDel = captureDeps();
        expect(await runSessionCommand(["delete", forkId, "--force"], cDel.deps)).toBe(0);
        expect(cDel.out).toContain(`removed worktree: ${wtPath}`);
        expect(existsSync(wtPath)).toBe(false);
        const branches = await runShell("git branch -a", { cwd: repoDir });
        const safeSeg = wtPath.split("/").pop() ?? "";
        expect(branches.stdout).not.toContain(`fork-${safeSeg}`);
        // listSessions confirms the fork record is gone.
        const remaining = (await listSessions({ includeArchived: true })).map((m) => m.id);
        expect(remaining).not.toContain(forkId);
        // Source untouched.
        expect(remaining).toContain(id);
    }, 60_000);
});
describe("session UX e2e — top-level conflict error (HIGH-5)", () => {
    test("resolveResume returns conflictError when --new-session + --resume <id>", async () => {
        // The CLI route in index.ts:main() reads (resume, newSession) and calls
        // resolveResume directly; the conflictError sentinel triggers an exit-1
        // with the expected message. We exercise the resolver in isolation so this
        // is deterministic and doesn't need a subprocess.
        const slog = new StructuredLogger();
        const r = await resolveResume({
            resume: "abc-id",
            newSession: true,
            title: undefined,
            cwd: "/tmp",
            initialSessionId: "init",
            slog,
        });
        expect(r.conflictError).toBe("cannot combine --new-session with --resume");
        expect(r.history).toEqual([]);
        expect(r.idMeta).toBeUndefined();
        expect(r.missingIdError).toBeUndefined();
    });
});
