import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runShell } from "../../src/runtime";
import { createPersistentWorktree, removeWorktree, WorktreeForkError, } from "../../src/runtime/worktree-fork";
const gitAvailable = async () => {
    try {
        const r = await runShell("git --version");
        return r.exitCode === 0;
    }
    catch {
        return false;
    }
};
// Probe git ONCE at module load (top-level await is allowed in Bun test files)
// so `test.skipIf(!HAS_GIT)` makes the runner emit a real `skipped` count when
// git is absent. The prior pattern (`if (!gitAvailable) return`) silently
// PASSED — making the suite green in environments where git was missing was
// indistinguishable from an actually-green suite.
const HAS_GIT = await gitAvailable();
/** Init a throwaway git repo with one commit; returns its absolute path. */
const makeRepo = async () => {
    const dir = mkdtempSync(join(tmpdir(), "wt-fork-"));
    const sh = (c) => runShell(c, { cwd: dir });
    await sh("git init -q");
    await sh("git config user.email t@t.t && git config user.name t");
    await writeFile(join(dir, "README.md"), "hello\n");
    await sh("git add -A && git commit -q -m init");
    return dir;
};
// Slow path: every test spawns multiple `git` subprocesses; stay clear of the
// default 5s timeout under parallel suite load.
const GIT_TEST_TIMEOUT = 30_000;
describe("createPersistentWorktree / removeWorktree", () => {
    const cleanups = [];
    afterEach(() => {
        while (cleanups.length > 0) {
            const dir = cleanups.pop();
            if (dir)
                rmSync(dir, { recursive: true, force: true });
        }
    });
    test.skipIf(!HAS_GIT)("creates the worktree directory + branch on a real git repo", async () => {
        const repo = await makeRepo();
        cleanups.push(repo);
        const wt = await createPersistentWorktree("fork1", repo);
        expect(existsSync(wt.worktreePath)).toBe(true);
        const list = await runShell("git worktree list", { cwd: repo });
        expect(list.stdout).toContain(wt.worktreePath);
        const branches = await runShell("git branch --list", { cwd: repo });
        expect(branches.stdout).toContain("fork-fork1");
    }, GIT_TEST_TIMEOUT);
    test.skipIf(!HAS_GIT)("places the worktree under .quanta/worktrees/<safeId>", async () => {
        const repo = await makeRepo();
        cleanups.push(repo);
        const wt = await createPersistentWorktree("place1", repo);
        expect(wt.worktreePath).toBe(`${repo}/.quanta/worktrees/place1`);
        expect(existsSync(`${repo}/.quanta/worktrees/place1`)).toBe(true);
    }, GIT_TEST_TIMEOUT);
    test.skipIf(!HAS_GIT)("default branch name follows fork-<safeId>", async () => {
        const repo = await makeRepo();
        cleanups.push(repo);
        const wt = await createPersistentWorktree("branchdef", repo);
        expect(wt.branch).toBe("fork-branchdef");
    }, GIT_TEST_TIMEOUT);
    test.skipIf(!HAS_GIT)("custom branch override is respected", async () => {
        const repo = await makeRepo();
        cleanups.push(repo);
        const wt = await createPersistentWorktree("custom1", repo, { branch: "my-custom-branch" });
        expect(wt.branch).toBe("my-custom-branch");
        const branches = await runShell("git branch --list", { cwd: repo });
        expect(branches.stdout).toContain("my-custom-branch");
    }, GIT_TEST_TIMEOUT);
    test.skipIf(!HAS_GIT)("removeWorktree cleans up and returns true on success", async () => {
        const repo = await makeRepo();
        cleanups.push(repo);
        const wt = await createPersistentWorktree("rm1", repo);
        const ok = await removeWorktree(wt.worktreePath, repo, { branch: wt.branch });
        expect(ok).toBe(true);
        expect(existsSync(wt.worktreePath)).toBe(false);
        const list = await runShell("git worktree list", { cwd: repo });
        expect(list.stdout).not.toContain(wt.worktreePath);
        const branches = await runShell("git branch --list", { cwd: repo });
        expect(branches.stdout).not.toContain("fork-rm1");
    }, GIT_TEST_TIMEOUT);
    test.skipIf(!HAS_GIT)("removeWorktree on an already-removed worktree is idempotent (returns true, no throw)", async () => {
        // Idempotency contract: callers depend on "worktree dir is gone" as
        // success. A second remove on a missing path therefore must also
        // succeed — the desired state is already reached. (See audit MEDIUM-4:
        // partial-failure orchestration relies on this primitive being safe to
        // retry.)
        const repo = await makeRepo();
        cleanups.push(repo);
        const wt = await createPersistentWorktree("rm2", repo);
        const first = await removeWorktree(wt.worktreePath, repo, { branch: wt.branch });
        expect(first).toBe(true);
        const second = await removeWorktree(wt.worktreePath, repo, { branch: wt.branch });
        expect(second).toBe(true);
    }, GIT_TEST_TIMEOUT);
    test.skipIf(!HAS_GIT)("throws WorktreeForkError on a non-git directory", async () => {
        const dir = mkdtempSync(join(tmpdir(), "wt-fork-nogit-"));
        cleanups.push(dir);
        await expect(createPersistentWorktree("x", dir)).rejects.toBeInstanceOf(WorktreeForkError);
    }, GIT_TEST_TIMEOUT);
    test.skipIf(!HAS_GIT)("sanitizes weird ids containing `/` or `;`", async () => {
        const repo = await makeRepo();
        cleanups.push(repo);
        // `foo/bar;rm` → safeId("foo/bar;rm") = "foo-bar-rm".
        const wt = await createPersistentWorktree("foo/bar;rm", repo);
        expect(wt.worktreePath).toBe(`${repo}/.quanta/worktrees/foo-bar-rm`);
        expect(wt.branch).toBe("fork-foo-bar-rm");
        expect(existsSync(wt.worktreePath)).toBe(true);
        // Confirm no stray `rm` artifact was executed at repo root.
        expect(existsSync(`${repo}/README.md`)).toBe(true);
    }, GIT_TEST_TIMEOUT);
});
