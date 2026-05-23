/**
 * Tiny `bash -c` + argv-form exec helpers shared by every eval module.
 *
 * Shell exec is a tiny local Bun.spawn helper, but it spawns children with the
 * single-source `@/runtime` `scrubEnv()` allowlist (NOT raw `process.env`) so a
 * bench child can never inherit `OPENAI_API_KEY`/tokens — that is what makes
 * the trajectory's `envPolicyVersion` stamp truthful (C9). Apps may import
 * slices (RFC §3.1); reusing scrubEnv keeps ONE env policy, not a fork.
 */
import { scrubEnv } from "@/runtime";
/**
 * Minimal `bash -c` exec via Bun.spawn with a hard timeout. C9: children are
 * spawned with the single-source `scrubEnv()` allowlist (PATH/HOME/proxy/
 * locale/TMPDIR preserved so git/bun/node still work) — the parent's secrets
 * (`OPENAI_API_KEY`/tokens) are NEVER inherited. This makes the `sandbox`
 * trajectory event's `envPolicyVersion` claim true.
 */
export const exec = async (cmd, cwd, timeoutMs) => {
    const proc = Bun.spawn(["bash", "-c", cmd], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: scrubEnv(),
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    try {
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        const code = await proc.exited;
        return { code, stdout, stderr };
    }
    finally {
        clearTimeout(timer);
    }
};
/**
 * Argv-form exec (no `bash -c`). Used for git pathspec-exclude invocations
 * where the `:(exclude,top)…` magic must not pass through shell word-splitting
 * or quote-stripping. Same env scrub + timeout semantics as {@link exec}.
 */
export const execArgv = async (argv, cwd, timeoutMs) => {
    const proc = Bun.spawn([...argv], {
        cwd,
        stdout: "pipe",
        stderr: "pipe",
        env: scrubEnv(),
    });
    const timer = setTimeout(() => proc.kill(), timeoutMs);
    try {
        const [stdout, stderr] = await Promise.all([
            new Response(proc.stdout).text(),
            new Response(proc.stderr).text(),
        ]);
        const code = await proc.exited;
        return { code, stdout, stderr };
    }
    finally {
        clearTimeout(timer);
    }
};
export const trimOut = (r) => (r.code === 0 ? r.stdout.trim() : "");
