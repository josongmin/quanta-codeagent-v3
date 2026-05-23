import { errMessage } from "@/shared";
export const isNotARepo = (stderr) => /not a git repository/i.test(stderr);
/** Invoke the runner, normalizing thrown spawn errors into a tagged result.
 *  This is the only place the catch-and-coerce lives, so each tool's
 *  `execute()` is a flat happy-path → branch on outcome. The optional
 *  `signal` is forwarded to {@link GitRunner.run} so a cancelled tool call
 *  kills the spawned `git` immediately instead of waiting on the runner's
 *  wall-clock timeout. */
export const safeRun = async (runner, args, cwd, toolName, signal) => {
    try {
        const result = await runner.run(args, cwd, signal);
        return { kind: "ok", result };
    }
    catch (err) {
        const msg = errMessage(err);
        return { kind: "spawn-error", message: `${toolName} failed: ${msg}` };
    }
};
/** Map a non-zero git exit to a single "best-effort" error string. */
export const stderrReason = (stderr, exitCode, toolName) => {
    const trimmed = stderr.trim();
    if (isNotARepo(stderr))
        return trimmed || "not a git repository";
    return trimmed || `${toolName} exited ${exitCode}`;
};
export const mutate = async (runner, args, cwd, toolName, signal) => {
    const out = await safeRun(runner, args, cwd, toolName, signal);
    if (out.kind === "spawn-error")
        return { kind: "err", output: out.message };
    const r = out.result;
    if (r.exitCode !== 0) {
        return { kind: "err", output: stderrReason(r.stderr, r.exitCode, toolName) };
    }
    return { kind: "ok", stdout: r.stdout, stderr: r.stderr };
};
