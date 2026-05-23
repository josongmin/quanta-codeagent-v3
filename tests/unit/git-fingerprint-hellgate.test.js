/**
 * ADR-0106 hellgate — captureGitFingerprint
 *
 * 10 adversarial cases. Closed-port (injected GitRunner), so all cases
 * exercise pure state-machine behavior with canned runner replies.
 */
import { describe, expect, test } from "bun:test";
import { captureGitFingerprint } from "@/session/git-fingerprint";
const makeRunner = (responses) => {
    const calls = [];
    return {
        calls,
        async run(args) {
            calls.push([...args]);
            const key = args.join(" ");
            const r = responses[key];
            if (r instanceof Error)
                throw r;
            if (r)
                return r;
            return { stdout: "", stderr: `no canned: ${key}`, exitCode: 128 };
        },
    };
};
const ok = (stdout) => ({ stdout, stderr: "", exitCode: 0 });
const fail = (stderr) => ({ stdout: "", stderr, exitCode: 128 });
describe("ADR-0106 captureGitFingerprint (hellgate)", () => {
    test("HELL-1: full fingerprint when all three queries succeed", async () => {
        const runner = makeRunner({
            "rev-parse HEAD": ok("abc123\n"),
            "rev-parse --abbrev-ref HEAD": ok("main\n"),
            "config --get remote.origin.url": ok("git@github.com:org/repo.git\n"),
        });
        const fp = await captureGitFingerprint(runner, "/tmp/repo");
        expect(fp.sha).toBe("abc123");
        expect(fp.branch).toBe("main");
        expect(fp.originUrl).toBe("git@github.com:org/repo.git");
    });
    test("HELL-2: detached HEAD ⇒ branch absent, SHA present (HEAD literal dropped)", async () => {
        const runner = makeRunner({
            "rev-parse HEAD": ok("deadbeef\n"),
            "rev-parse --abbrev-ref HEAD": ok("HEAD\n"),
            "config --get remote.origin.url": ok("https://github.com/x/y\n"),
        });
        const fp = await captureGitFingerprint(runner, "/tmp/repo");
        expect(fp.sha).toBe("deadbeef");
        expect(fp.branch).toBeUndefined();
        expect(fp.originUrl).toBe("https://github.com/x/y");
    });
    test("HELL-3: local-only repo (no remote) ⇒ originUrl absent", async () => {
        const runner = makeRunner({
            "rev-parse HEAD": ok("abc\n"),
            "rev-parse --abbrev-ref HEAD": ok("feature/x\n"),
            "config --get remote.origin.url": fail("error: no remote"),
        });
        const fp = await captureGitFingerprint(runner, "/tmp/repo");
        expect(fp.sha).toBe("abc");
        expect(fp.branch).toBe("feature/x");
        expect(fp.originUrl).toBeUndefined();
    });
    test("HELL-4: not a git repo ⇒ empty fingerprint (no throw)", async () => {
        const runner = makeRunner({
            "rev-parse HEAD": fail("fatal: not a git repository"),
            "rev-parse --abbrev-ref HEAD": fail("fatal: not a git repository"),
            "config --get remote.origin.url": fail("fatal: not a git repository"),
        });
        const fp = await captureGitFingerprint(runner, "/tmp/notrepo");
        expect(fp).toEqual({});
    });
    test("HELL-5: spawn error on one query does NOT cancel the others", async () => {
        const runner = makeRunner({
            "rev-parse HEAD": ok("abc\n"),
            "rev-parse --abbrev-ref HEAD": new Error("ENOMEM"),
            "config --get remote.origin.url": ok("https://x/y\n"),
        });
        const fp = await captureGitFingerprint(runner, "/tmp/repo");
        expect(fp.sha).toBe("abc");
        expect(fp.branch).toBeUndefined();
        expect(fp.originUrl).toBe("https://x/y");
    });
    test("HELL-6: empty stdout on success ⇒ field undefined", async () => {
        const runner = makeRunner({
            "rev-parse HEAD": ok(""),
            "rev-parse --abbrev-ref HEAD": ok("\n"),
            "config --get remote.origin.url": ok("   \n"),
        });
        const fp = await captureGitFingerprint(runner, "/tmp/repo");
        expect(fp).toEqual({});
    });
    test("HELL-7: trims trailing newline + leading/trailing whitespace", async () => {
        const runner = makeRunner({
            "rev-parse HEAD": ok("  abc123  \n"),
            "rev-parse --abbrev-ref HEAD": ok("  main  \n"),
            "config --get remote.origin.url": ok("  https://x/y  \n"),
        });
        const fp = await captureGitFingerprint(runner, "/tmp/repo");
        expect(fp.sha).toBe("abc123");
        expect(fp.branch).toBe("main");
        expect(fp.originUrl).toBe("https://x/y");
    });
    test("HELL-8: branch name 'HEAD' (the literal) is dropped, not surfaced as branch", async () => {
        // Adversarial: what if a user names a branch "HEAD"? Git itself
        // forbids `HEAD` as a branch name, so the only source of "HEAD"
        // from `--abbrev-ref` is the detached-HEAD signal. Drop it.
        const runner = makeRunner({
            "rev-parse HEAD": ok("def\n"),
            "rev-parse --abbrev-ref HEAD": ok("HEAD\n"),
            "config --get remote.origin.url": fail("no remote"),
        });
        const fp = await captureGitFingerprint(runner, "/tmp/repo");
        expect(fp.branch).toBeUndefined();
        expect(fp.sha).toBe("def");
    });
    test("HELL-9: all three queries are issued (even if first fails)", async () => {
        const runner = makeRunner({
            "rev-parse HEAD": fail("not a repo"),
            "rev-parse --abbrev-ref HEAD": fail("not a repo"),
            "config --get remote.origin.url": fail("not a repo"),
        });
        await captureGitFingerprint(runner, "/tmp/x");
        expect(runner.calls.length).toBe(3);
        expect(runner.calls[0]).toEqual(["rev-parse", "HEAD"]);
        expect(runner.calls[1]).toEqual([
            "rev-parse",
            "--abbrev-ref",
            "HEAD",
        ]);
        expect(runner.calls[2]).toEqual([
            "config",
            "--get",
            "remote.origin.url",
        ]);
    });
    test("HELL-10: signal forwarded to runner on each call", async () => {
        const captured = [];
        const runner = {
            async run(_args, _cwd, signal) {
                if (signal !== undefined)
                    captured.push(signal);
                return ok("abc\n");
            },
        };
        const ctrl = new AbortController();
        await captureGitFingerprint(runner, "/tmp/repo", ctrl.signal);
        expect(captured.length).toBe(3);
        expect(captured.every((s) => s === ctrl.signal)).toBe(true);
    });
});
