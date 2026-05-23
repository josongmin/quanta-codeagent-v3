/**
 * ADR-0068 Wave B — Phase 2 consolidator git integration (thin wrapper).
 *
 * Wraps `git` CLI for the user-home `~/.quanta/memory/` repo.  Phase 2 uses
 * git as the durable "consolidation history" trail (one commit per Phase 2
 * run, sha returned in {@link Phase2Outcome}).  We do NOT depend on a
 * library — `git` is part of every dev box, and the surface here is tiny
 * (init / isRepo / addCommit) so a shell-out is cheaper than a node-git
 * dependency.
 *
 * The {@link GitPort} interface is dependency-injected into
 * {@link MemoryWriter} so unit tests use a deterministic mock and never
 * fork a real `git` process.  Integration tests use the real
 * {@link ChildProcessGitPort} on a tmpdir repo.
 *
 * Negative invariants:
 *   1. No silent failure — every non-zero exit becomes a thrown
 *      {@link MemoryWriteError} carrying the captured stderr.
 *   2. No `--no-verify` / `--no-gpg-sign` (commit hooks/signing remain
 *      whatever the user configured).  Quanta does not bypass user setup.
 *   3. `git config user.{name,email}` is set ONLY in the local repo (no
 *      `--global`).  We never mutate the user's global git identity.
 *   4. argv-array spawn (no shell), so commit messages cannot be turned
 *      into shell-injection vectors.
 */
import { MemoryWriteError } from "./types";
/** Spawn a git subprocess via Bun.spawn with argv-array (no shell, so
 *  message strings cannot inject).  Captures stdout+stderr in full;
 *  exit code is returned, not thrown — caller decides which code means
 *  failure (e.g. `git commit` exit 1 with "nothing to commit" stderr is
 *  a legitimate non-error result that addCommit() maps to null). */
const runGit = async (argv, cwd) => {
    const proc = Bun.spawn(["git", ...argv], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { stdout, stderr, exitCode };
};
/** Production GitPort backed by `git` CLI via Bun.spawn (argv-array, no
 *  shell). */
export class ChildProcessGitPort {
    async init(dir) {
        // `git init` is idempotent in itself ("Reinitialized existing Git
        // repository") but emits no error — we still call it so a fresh
        // dir gets a repo, and a re-init on an existing one is harmless.
        const initRes = await runGit(["init"], dir);
        if (initRes.exitCode !== 0) {
            throw new MemoryWriteError(`git init failed (exit ${initRes.exitCode}): ${initRes.stderr.trim()}`, dir);
        }
        // Local-only identity — never `--global` (negative invariant 3).
        // These are required for `git commit` to succeed when the user has
        // no global git user.{name,email} configured (CI / fresh dev box).
        const nameRes = await runGit(["config", "--local", "user.name", "quanta"], dir);
        if (nameRes.exitCode !== 0) {
            throw new MemoryWriteError(`git config user.name failed (exit ${nameRes.exitCode}): ${nameRes.stderr.trim()}`, dir);
        }
        const emailRes = await runGit(["config", "--local", "user.email", "quanta@localhost"], dir);
        if (emailRes.exitCode !== 0) {
            throw new MemoryWriteError(`git config user.email failed (exit ${emailRes.exitCode}): ${emailRes.stderr.trim()}`, dir);
        }
    }
    async isRepo(dir) {
        const res = await runGit(["rev-parse", "--git-dir"], dir);
        return res.exitCode === 0;
    }
    async addCommit(dir, message) {
        const addRes = await runGit(["add", "."], dir);
        if (addRes.exitCode !== 0) {
            throw new MemoryWriteError(`git add failed (exit ${addRes.exitCode}): ${addRes.stderr.trim()}`, dir);
        }
        // `git commit` exit code semantics:
        //   0 = commit created.
        //   1 = "nothing to commit, working tree clean" OR a real failure.
        // We disambiguate via stderr/stdout text (both can carry the clean
        // message depending on git version).
        const commitRes = await runGit(["commit", "-m", message], dir);
        if (commitRes.exitCode === 0) {
            // Resolve the freshly-minted sha.
            const shaRes = await runGit(["rev-parse", "HEAD"], dir);
            if (shaRes.exitCode !== 0) {
                throw new MemoryWriteError(`git rev-parse HEAD failed (exit ${shaRes.exitCode}): ${shaRes.stderr.trim()}`, dir);
            }
            const sha = shaRes.stdout.trim();
            if (sha.length < 7) {
                throw new MemoryWriteError(`git rev-parse HEAD returned an unexpectedly short sha: '${sha}'`, dir);
            }
            return sha;
        }
        // exit != 0 — distinguish "clean tree" (legitimate null) from real
        // failure.  Match both the stdout and stderr text because git
        // emits the clean message on different streams across versions.
        const combined = `${commitRes.stdout}\n${commitRes.stderr}`.toLowerCase();
        if (combined.includes("nothing to commit") ||
            combined.includes("no changes added to commit") ||
            combined.includes("working tree clean")) {
            return null;
        }
        throw new MemoryWriteError(`git commit failed (exit ${commitRes.exitCode}): ${commitRes.stderr.trim() || commitRes.stdout.trim()}`, dir);
    }
}
/** No-op GitPort used when `gitEnabled: false` is passed to the writer
 *  (test mode, or future opt-out for users who do not want a
 *  `.git` dir under their memory tree).  Every method is a deterministic
 *  no-op: init does nothing, isRepo always reports false, addCommit
 *  always reports null (no SHA).  The writer translates a null SHA into
 *  `gitCommitSha: null` in {@link Phase2Outcome}. */
export class NullGitPort {
    async init(_dir) {
        // No-op.
    }
    async isRepo(_dir) {
        return false;
    }
    async addCommit(_dir, _message) {
        return null;
    }
}
