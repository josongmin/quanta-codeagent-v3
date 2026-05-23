import { describe, expect, test } from "bun:test";
import { DEFAULT_PROTECTED_BRANCHES, decideBranchOnly, } from "@/../src/permission/branch-only";
describe("decideBranchOnly — git push", () => {
    test("push refspec to protected branch is denied", () => {
        const v = decideBranchOnly("git push origin main");
        expect(v.allowed).toBe(false);
        if (!v.allowed)
            expect(v.reason).toContain("main");
    });
    test("push refspec to feature branch is allowed", () => {
        const v = decideBranchOnly("git push origin feature/x");
        expect(v.allowed).toBe(true);
    });
    test("push with local:remote refspec — remote side checked", () => {
        const v = decideBranchOnly("git push origin feature/x:main");
        expect(v.allowed).toBe(false);
    });
    test("push refspec to feature:feature allowed", () => {
        const v = decideBranchOnly("git push origin feature/x:feature/x");
        expect(v.allowed).toBe(true);
    });
    test("bare `git push` from main is denied (uses currentBranch)", () => {
        const v = decideBranchOnly("git push", DEFAULT_PROTECTED_BRANCHES, "main");
        expect(v.allowed).toBe(false);
    });
    test("bare `git push` from feature branch is allowed", () => {
        const v = decideBranchOnly("git push", DEFAULT_PROTECTED_BRANCHES, "feature/x");
        expect(v.allowed).toBe(true);
    });
    test("push to refs/heads/main fully-qualified is denied", () => {
        const v = decideBranchOnly("git push origin refs/heads/main");
        expect(v.allowed).toBe(false);
    });
});
describe("decideBranchOnly — git commit / merge / rebase on protected branch", () => {
    test("commit on main denied", () => {
        const v = decideBranchOnly("git commit -m 'x'", DEFAULT_PROTECTED_BRANCHES, "main");
        expect(v.allowed).toBe(false);
    });
    test("commit on feature branch allowed", () => {
        const v = decideBranchOnly("git commit -m 'x'", DEFAULT_PROTECTED_BRANCHES, "feature/x");
        expect(v.allowed).toBe(true);
    });
    test("merge on master denied", () => {
        const v = decideBranchOnly("git merge feature/x", DEFAULT_PROTECTED_BRANCHES, "master");
        expect(v.allowed).toBe(false);
    });
    test("rebase on develop denied", () => {
        const v = decideBranchOnly("git rebase upstream/x", DEFAULT_PROTECTED_BRANCHES, "develop");
        expect(v.allowed).toBe(false);
    });
});
describe("decideBranchOnly — git reset --hard to protected ref", () => {
    test("reset to origin/main denied", () => {
        const v = decideBranchOnly("git reset --hard origin/main");
        expect(v.allowed).toBe(false);
    });
    test("reset to a feature ref allowed", () => {
        const v = decideBranchOnly("git reset --hard origin/feature/x");
        expect(v.allowed).toBe(true);
    });
});
describe("decideBranchOnly — non-git commands pass through", () => {
    test("bash unrelated command is allowed", () => {
        expect(decideBranchOnly("ls -la").allowed).toBe(true);
        expect(decideBranchOnly("pytest -q").allowed).toBe(true);
        expect(decideBranchOnly("echo 'hello'").allowed).toBe(true);
    });
    test("git read commands allowed (status/log/diff)", () => {
        expect(decideBranchOnly("git status").allowed).toBe(true);
        expect(decideBranchOnly("git log --oneline").allowed).toBe(true);
        expect(decideBranchOnly("git diff HEAD").allowed).toBe(true);
    });
});
describe("decideBranchOnly — custom protected list", () => {
    test("operator can extend protected branches", () => {
        const custom = ["main", "release-1.0"];
        const v = decideBranchOnly("git push origin release-1.0", custom);
        expect(v.allowed).toBe(false);
    });
});
describe("DEFAULT_PROTECTED_BRANCHES", () => {
    test("includes main/master/develop/production", () => {
        expect(DEFAULT_PROTECTED_BRANCHES).toContain("main");
        expect(DEFAULT_PROTECTED_BRANCHES).toContain("master");
        expect(DEFAULT_PROTECTED_BRANCHES).toContain("develop");
        expect(DEFAULT_PROTECTED_BRANCHES).toContain("production");
    });
    test("frozen", () => {
        expect(Object.isFrozen(DEFAULT_PROTECTED_BRANCHES)).toBe(true);
    });
});
