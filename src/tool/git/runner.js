/** Bounded wall-clock for any single git invocation. Reads are typically
 *  sub-second; this catches hangs (e.g. a stuck filesystem) without ever
 *  letting a stray child outlive the tool call. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Subset of the parent env that git needs to function but cannot carry
 *  credentials or arbitrary code-exec. Mirrors the spirit of
 *  `@/runtime`'s default allowlist; copied here to keep `@/tool/git` slice-
 *  isolated (it must not depend on `@/runtime`). */
const ALLOWED_ENV = [
    "PATH",
    "HOME",
    "LANG",
    "TZ",
    "TMPDIR",
    // Allow ssh/https auth state if present — read-only ops may consult a
    // packed object via http(s) only when the user explicitly passes a base
    // that references a remote, which we don't construct ourselves.
    "GIT_SSH",
    "GIT_SSH_COMMAND",
];
/**
 * Deterministic env overrides for every git invocation (Codex §18.7
 * absorption — ADR-0105). These are HARD-SET regardless of what the parent
 * environment has, because:
 *
 *  - `GIT_OPTIONAL_LOCKS=0` — git's "optional locks" are advisory locks
 *    around index reads (e.g. `git status` writes the index to refresh
 *    stat cache). Concurrent agent reads can lock-contend with a user's
 *    interactive shell; disabling optional locks makes our reads
 *    side-effect-free.
 *  - `GIT_PAGER=cat` / `PAGER=cat` — git defaults to `less` for any
 *    output > one screenful; in a non-TTY child process this hangs
 *    waiting for stdin. `cat` is a pass-through.
 *  - `LC_ALL=C` — locale-independent output. Without this, `git status`
 *    / `git log` may emit translated messages depending on user locale,
 *    breaking our parsers.
 *  - `TERM=dumb` — disable color/escape sequences in git's output, which
 *    pollute our parsers.
 *  - `GIT_TERMINAL_PROMPT=0` — never prompt for credentials interactively;
 *    a missing credential is a clean failure, not a hang.
 *
 * Exported (via {@link buildGitEnv}) so the test suite can pin the contract
 * without spawning a real git process.
 */
const DETERMINISTIC_ENV = {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_PAGER: "cat",
    PAGER: "cat",
    LC_ALL: "C",
    TERM: "dumb",
    GIT_TERMINAL_PROMPT: "0",
};
export const buildGitEnv = () => {
    const out = {};
    for (const k of ALLOWED_ENV) {
        const v = process.env[k];
        if (typeof v === "string")
            out[k] = v;
    }
    // Deterministic overrides come LAST so they win over any pass-through.
    for (const [k, v] of Object.entries(DETERMINISTIC_ENV)) {
        out[k] = v;
    }
    return out;
};
/** Default GitRunner — spawns `git <args>` via Bun.spawn under `cwd`, with a
 *  bounded wall-clock and a scrubbed env. Stdout/stderr are read fully before
 *  resolving so callers never see a partial stream.
 *
 *  When the caller-supplied `signal` aborts (loop cancellation, subagent
 *  cancel, side-conversation budget exhaustion), the spawned process is killed
 *  immediately rather than orphaned until the wall-clock timeout fires. The
 *  abort listener is unhooked in `finally` so an already-completed run never
 *  leaks a reference into the AbortSignal's listener set. */
export const defaultGitRunner = {
    async run(args, cwd, signal) {
        const proc = Bun.spawn(["git", ...args], {
            cwd,
            env: buildGitEnv(),
            stdout: "pipe",
            stderr: "pipe",
        });
        const killProc = () => {
            try {
                proc.kill();
            }
            catch {
                // ignore — already exited
            }
        };
        const timer = setTimeout(killProc, DEFAULT_TIMEOUT_MS);
        let onAbort;
        if (signal !== undefined) {
            if (signal.aborted) {
                killProc();
            }
            else {
                onAbort = killProc;
                signal.addEventListener("abort", onAbort, { once: true });
            }
        }
        try {
            const [stdout, stderr] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
            ]);
            const exitCode = await proc.exited;
            return { stdout, stderr, exitCode };
        }
        finally {
            clearTimeout(timer);
            if (signal !== undefined && onAbort !== undefined) {
                signal.removeEventListener("abort", onAbort);
            }
        }
    },
};
