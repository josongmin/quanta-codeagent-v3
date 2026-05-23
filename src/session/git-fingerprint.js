/**
 * Session git fingerprint capture (ADR-0106 — Codex §18.9 absorption).
 *
 * Codex Desktop persists `threads.git_sha + git_branch + git_origin_url` on
 * every thread so replay / trajectory / reproducibility surfaces know
 * exactly which commit the session ran against. We absorb the same triple
 * onto {@link SessionMeta}.
 *
 * Closed-port design: takes an injected {@link GitRunner} so the capture
 * works under fake runners in tests and real Bun.spawn in production. Each
 * field is captured independently — a partial fingerprint (SHA but no
 * origin) is valid output for a local-only repo, and a missing field NEVER
 * causes the others to fail.
 */
/**
 * Capture the three-field git fingerprint for `cwd`. Best-effort: each
 * field is fetched in its own try/catch so a spawn failure on one query
 * does not cancel the others. Returns an empty object when `cwd` is not
 * a git repo (or git is not installed) — callers should treat the empty
 * result as "no fingerprint available", not as an error.
 */
export const captureGitFingerprint = async (runner, cwd, signal) => {
    const out = {};
    // SHA: `git rev-parse HEAD` — works on any repo with ≥1 commit.
    await tryCapture(async () => {
        const r = await runner.run(["rev-parse", "HEAD"], cwd, signal);
        if (r.exitCode === 0) {
            const sha = r.stdout.trim();
            if (sha.length > 0)
                out.sha = sha;
        }
    });
    // Branch: `git rev-parse --abbrev-ref HEAD` returns `HEAD` literal when
    // detached. We intentionally DROP the `HEAD` literal so a detached state
    // is observable as "SHA present, branch absent" — consumers can branch
    // on the shape (no special-case enum).
    await tryCapture(async () => {
        const r = await runner.run(["rev-parse", "--abbrev-ref", "HEAD"], cwd, signal);
        if (r.exitCode === 0) {
            const branch = r.stdout.trim();
            if (branch.length > 0 && branch !== "HEAD")
                out.branch = branch;
        }
    });
    // Origin URL: a local-only repo (no remote) returns non-zero exit; we
    // simply leave originUrl undefined in that case.
    await tryCapture(async () => {
        const r = await runner.run(["config", "--get", "remote.origin.url"], cwd, signal);
        if (r.exitCode === 0) {
            const url = r.stdout.trim();
            if (url.length > 0)
                out.originUrl = url;
        }
    });
    return out;
};
/** Tiny helper to swallow spawn errors on a single capture without
 *  cancelling the rest. Inline-typed (no shared dependency on the git
 *  tool slice's `safeRun`). */
const tryCapture = async (fn) => {
    try {
        await fn();
    }
    catch {
        // ignore — best-effort
    }
};
