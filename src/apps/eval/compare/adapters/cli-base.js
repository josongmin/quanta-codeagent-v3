/**
 * Shared base for CLI-based adapters (claude-code, cursor, aider). Each
 * concrete adapter only declares: binary name, version-probe args, and how
 * to build the argv from a scenario. The base handles:
 *
 *   1. Availability probe via `--version` (or adapter-overridden command).
 *   2. Sandbox creation + scenario file materialisation (same posture as
 *      `synthetic/runner.ts`).
 *   3. Single-shot spawn with wall-clock timeout + stdout/stderr capture.
 *   4. Result shaping into `CompareRunResult`.
 *
 * Adapters are intentionally one-shot: we hand the scenario prompt over the
 * argv (or stdin, when configured) and read the final transcript from stdout.
 * Multi-turn interactive CLI driving is out of scope here — that would need
 * each vendor's own protocol and the surface explodes. The judge sees only
 * the final assistant text the CLI prints.
 */
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { errMessage, logger } from "@/shared";
/** Default wall-clock budgets — extracted as constants so they can be tuned
 *  centrally and unit-asserted (a regression test pins them). The probe is
 *  short because a hung version-probe should never block scenario startup. */
export const DEFAULT_VERSION_PROBE_TIMEOUT_MS = 5_000;
export const DEFAULT_RUN_TIMEOUT_MS = 180_000;
/** Grace period between SIGTERM and SIGKILL when a CLI ignores SIGTERM. A
 *  CLI that traps SIGTERM and refuses to exit would otherwise leak the child
 *  process; SIGKILL after this grace forces termination. */
export const TERM_TO_KILL_GRACE_MS = 5_000;
/** How many bytes of stderr to surface back in `failureReason`. Truncated to
 *  keep `CompareRunResult` size bounded (the full stderr lives only inside
 *  the child process at runtime). */
export const STDERR_TAIL_BYTES = 800;
/** True when `dest` lies inside (or is) `sandbox`. Uses `path.relative` so
 *  the check is portable — `string.startsWith('/')` was POSIX-only. */
const isInsideSandbox = (sandbox, dest) => {
    if (dest === sandbox)
        return true;
    const rel = relative(sandbox, dest);
    return rel !== "" && !rel.startsWith("..") && !rel.startsWith(`..${sep}`);
};
const safeRm = async (path) => {
    try {
        await rm(path, { recursive: true, force: true });
    }
    catch (e) {
        logger.warn("compare.cli: sandbox cleanup failed", {
            path,
            error: errMessage(e),
        });
    }
};
const writeScenarioFiles = (sandbox, files) => {
    if (files === undefined)
        return;
    for (const f of files) {
        const dest = resolve(sandbox, f.path);
        if (!isInsideSandbox(sandbox, dest)) {
            throw new Error(`scenario file path escapes sandbox: ${f.path}`);
        }
        mkdirSync(dirname(dest), { recursive: true });
        writeFileSync(dest, f.content);
    }
};
/** Concrete CLI adapter base. Subclasses can extend; consumers usually just
 *  instantiate with a `CliAdapterSpec`. */
export class CliAgentAdapter {
    spec;
    name;
    constructor(spec) {
        this.spec = spec;
        this.name = spec.name;
    }
    async available() {
        try {
            const r = spawnSync(this.spec.bin, [...this.spec.versionArgs], {
                encoding: "utf8",
                timeout: this.spec.versionTimeoutMs ?? DEFAULT_VERSION_PROBE_TIMEOUT_MS,
            });
            if (r.status === 0)
                return { ok: true };
            return {
                ok: false,
                reason: `exit=${r.status} stderr=${(r.stderr ?? "").slice(0, STDERR_TAIL_BYTES)}`,
            };
        }
        catch (e) {
            return { ok: false, reason: errMessage(e) };
        }
    }
    async runOne(scenario) {
        const start = Date.now();
        const sandbox = await mkdtemp(join(tmpdir(), `quanta-compare-${this.name}-`));
        try {
            writeScenarioFiles(sandbox, scenario.files);
            const { argv, usingStdin } = this.spec.buildArgv(scenario, sandbox);
            const timeoutMs = this.spec.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS;
            const result = await spawnCaptured(this.spec.bin, argv, sandbox, timeoutMs, usingStdin === true ? scenario.prompt : undefined);
            // Include stderr in the transcript: many CLI agents print human-visible
            // status (deltas, warnings, final summary) to stderr. Dropping it would
            // hand the judge an incomplete picture and might silently penalise an
            // agent that prefers stderr for its final report.
            const transcript = result.stderr.length > 0 ? `${result.stdout}\n[stderr]\n${result.stderr}` : result.stdout;
            // Surface a tail of stderr in the failure reason too — invaluable for
            // diagnosing a failing run without re-spawning the child.
            const stderrTail = result.stderr.length > 0 ? ` stderr=${result.stderr.slice(-STDERR_TAIL_BYTES)}` : "";
            return {
                agent: this.name,
                transcript,
                toolsUsed: [],
                durationMs: Date.now() - start,
                exitOk: result.exit === 0,
                ...(result.exit === 0
                    ? {}
                    : {
                        failureReason: `exit=${result.exit} ${result.failure ?? ""}${stderrTail}`.trim(),
                    }),
            };
        }
        catch (e) {
            const reason = errMessage(e);
            return {
                agent: this.name,
                transcript: "",
                toolsUsed: [],
                durationMs: Date.now() - start,
                exitOk: false,
                failureReason: reason,
            };
        }
        finally {
            await safeRm(sandbox);
        }
    }
}
const spawnCaptured = (bin, argv, cwd, timeoutMs, stdin) => new Promise((resolve) => {
    const child = spawn(bin, [...argv], { cwd, stdio: ["pipe", "pipe", "pipe"] });
    const outChunks = [];
    const errChunks = [];
    child.stdout.on("data", (c) => outChunks.push(c));
    child.stderr.on("data", (c) => errChunks.push(c));
    let finished = false;
    let killTimer;
    const finish = (exit, failure) => {
        if (finished)
            return;
        finished = true;
        if (killTimer !== undefined)
            clearTimeout(killTimer);
        const result = {
            stdout: Buffer.concat(outChunks).toString("utf8"),
            stderr: Buffer.concat(errChunks).toString("utf8"),
            exit,
            ...(failure !== undefined ? { failure } : {}),
        };
        resolve(result);
    };
    const timer = setTimeout(() => {
        // SIGTERM first; if the CLI traps it we promote to SIGKILL after a
        // grace period so the parent never leaks an orphaned child.
        child.kill("SIGTERM");
        killTimer = setTimeout(() => {
            if (!finished)
                child.kill("SIGKILL");
        }, TERM_TO_KILL_GRACE_MS);
        finish(124, `timeout after ${timeoutMs}ms`);
    }, timeoutMs);
    // `close` emits `code:null` when killed by signal. Propagate the signal
    // name so the judge / failure reason can mention SIGSEGV/SIGKILL/etc.
    child.on("close", (code, signal) => {
        clearTimeout(timer);
        if (typeof code === "number")
            finish(code);
        else if (typeof signal === "string")
            finish(128, `killed by ${signal}`);
        else
            finish(1, "exited with unknown status");
    });
    child.on("error", (e) => {
        clearTimeout(timer);
        finish(1, e.message);
    });
    // Unhandled `child.stdin` errors crash the parent process (default Node
    // behaviour is to emit `error` on the writable). The most common case is
    // EPIPE when the child exits before we finish writing — that's recorded
    // in the spawn's exit code already, so swallow the stdin error here
    // (with a log) rather than crashing the entire eval run.
    child.stdin.on("error", (e) => {
        logger.warn("compare.cli: stdin write error (likely child exited early)", {
            bin,
            error: e.message,
        });
    });
    if (stdin !== undefined) {
        try {
            child.stdin.write(stdin);
        }
        catch (e) {
            logger.warn("compare.cli: stdin write threw", {
                bin,
                error: errMessage(e),
            });
        }
    }
    try {
        child.stdin.end();
    }
    catch {
        // ignored — `end()` on a closed stdin is benign
    }
});
