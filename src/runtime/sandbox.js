import { QuantaError } from "@/shared";
import { escalatingKill, withSpawnedChild } from "./guarded-spawn";
import { disclaimedShellArgv } from "./shell-disclaim";
/** Raised when a sandbox backend it depends on is not usable (e.g. Docker is
 *  not installed / not running). The caller — not the sandbox — decides
 *  whether to fall back to a weaker backend. */
export class SandboxUnavailableError extends QuantaError {
    constructor(message, options) {
        super("sandbox_unavailable", message, options);
    }
}
/** Raised when a policy constraint cannot be satisfied (e.g. a cwd-jail
 *  escape was requested). This is a hard stop, never a degraded run. */
export class SandboxPolicyError extends QuantaError {
    constructor(message) {
        super("sandbox_policy", message);
    }
}
const DEFAULT_TIMEOUT_MS = 120_000;
const TRUNCATION_MARKER = "\n…[output truncated by sandbox maxOutputBytes]";
/** Minimal, non-sensitive variables a child generally needs to function.
 *  Deliberately excludes anything that could carry credentials. This is the
 *  SINGLE source of truth for the env allowlist — `runShell`'s scrubbed mode
 *  (src/runtime/shell.ts) imports {@link scrubEnv}, it does NOT keep its own
 *  copy of this list (ADR-0006: one Local-honored guarantee, one definition). */
// Locale/identity, plus the infra vars a real edit→build→test loop needs:
// corp proxy + custom-CA (npm/bun/git/pip fail behind a MITM proxy without
// them), TMPDIR (pytest/tsc/bun temp), and an active venv.
//
// S5 [HIGH] env-policy → `sandbox.v2`: `NODE_OPTIONS` and
// `NODE_EXTRA_CA_CERTS` were REMOVED. `NODE_OPTIONS=--require=/evil.js`
// (or `--import`) is arbitrary code-exec injected into EVERY scrubbed
// node/bun child, and `NODE_EXTRA_CA_CERTS` lets an attacker-controlled CA
// silently MITM https from those children — both defeat the scrub. So the
// allowlist no longer claims "NONE can carry code/credentials": it now
// carries ONLY non-credential, non-code-exec vars. `SSL_CERT_FILE`/
// `SSL_CERT_DIR` are RETAINED on purpose — they add CA trust via a file
// path (needed behind a corp MITM proxy) but, unlike `NODE_OPTIONS`, cannot
// inject code into the runtime. The default-deny posture (no
// `*_API_KEY`/`*_TOKEN`/`*_SECRET`) is unchanged. Case-sensitive: tools
// read both `HTTP_PROXY` and lowercase `http_proxy`, so both are listed.
// NOTE for the bench agent: the env-policy version literal lives in
// `src/apps/bench/runner.ts` (ENV_POLICY_VERSION) — bump it to `sandbox.v2`
// to record that this allowlist change governs the run.
export const DEFAULT_ENV_ALLOWLIST = [
    "PATH",
    "HOME",
    "LANG",
    "LC_ALL",
    "TZ",
    "TERM",
    "TMPDIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "VIRTUAL_ENV",
];
/** Build the scrubbed environment: ONLY allowlisted names, copied from the
 *  parent if present. The parent's full env (API keys, tokens, …) never
 *  leaks — absent names are simply omitted. Exported so every shell-spawning
 *  path (LocalSandbox AND runShell's scrubbed mode) shares one implementation. */
export const scrubEnv = (allowlist = DEFAULT_ENV_ALLOWLIST) => {
    const out = {};
    for (const name of allowlist) {
        const value = process.env[name];
        if (value !== undefined)
            out[name] = value;
    }
    return out;
};
/** Resolve a jail directory to an absolute, normalized path. A relative jail
 *  is resolved against the current process cwd (callers SHOULD pass absolute).
 *  Throws {@link SandboxPolicyError} if `..` segments would climb above the
 *  jail's anchor root (an attempted jail escape). */
const normalizeJail = (jail) => {
    const isAbs = jail.startsWith("/");
    const anchor = isAbs ? "" : process.cwd();
    const anchorDepth = anchor === "" ? 0 : anchor.split("/").filter(Boolean).length;
    const parts = anchor === "" ? [] : anchor.split("/").filter(Boolean);
    for (const seg of jail.split("/")) {
        if (seg === "" || seg === ".")
            continue;
        if (seg === "..") {
            if (parts.length <= anchorDepth) {
                throw new SandboxPolicyError(`cwd jail escape rejected: ${jail} climbs above its root`);
            }
            parts.pop();
        }
        else
            parts.push(seg);
    }
    return `/${parts.join("/")}`;
};
/** Truncate combined output to a byte budget, appending a visible marker
 *  exactly once when the cap bites. */
const capOutput = (text, maxBytes) => {
    if (maxBytes === undefined)
        return text;
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length <= maxBytes)
        return text;
    return bytes.subarray(0, maxBytes).toString("utf8") + TRUNCATION_MARKER;
};
/**
 * Process-level confinement using the SAME mechanism as `runShell`
 * (`Bun.spawn(["bash","-lc", command])`).
 *
 * IMPORTANT — this is NOT a security boundary. It is best-effort, in-process
 * confinement only. Without an OS/container isolation layer a determined
 * command can still:
 *  - read/write anywhere the process user can (the cwd jail only sets the
 *    working directory + rejects an *explicitly requested* escape; it does
 *    not chroot or block absolute paths);
 *  - open network sockets (`allowNetwork:false` is advisory here and is NOT
 *    enforced — only {@link DockerSandbox} can truly cut the network);
 *  - exhaust CPU/memory.
 *
 * What it DOES honestly guarantee:
 *  - env scrubbing: the child sees ONLY allowlisted variables (parent env,
 *    including API keys, is never inherited). Note this same {@link scrubEnv}
 *    guarantee now also applies to the shell-spawning TOOLS (bash/grep/
 *    localize/test-runner) which route through `runShell`'s scrubbed mode —
 *    not just commands that go through this class;
 *  - cwd: the process starts in `cwdJail`, and a requested jail escape throws;
 *  - output cap: captured bytes are truncated to `maxOutputBytes`;
 *  - timeout: the process is killed past `timeoutMs` (`timedOut` set).
 */
export class LocalSandbox {
    async run(command, policy = {}) {
        const env = scrubEnv(policy.envAllowlist ?? DEFAULT_ENV_ALLOWLIST);
        const cwd = this.resolveCwd(policy.cwdJail);
        const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        let timedOut = false;
        const argv = policy.disclaimShell === true
            ? [...disclaimedShellArgv("bash", command)]
            : ["bash", "-lc", command];
        const proc = Bun.spawn(argv, {
            cwd,
            env,
            stdout: "pipe",
            stderr: "pipe",
        });
        // SIGTERM→SIGKILL escalation (KILL_GRACE_MS): a TERM-trapping child is
        // force-killed; `disarm` clears the grace timer in the guard's cleanup.
        const { kill, disarm } = escalatingKill(proc);
        const timer = setTimeout(() => {
            timedOut = true;
            kill();
        }, timeoutMs);
        // GUARDED: kill-on-throw + timer teardown via `withSpawnedChild`
        // (src/runtime/guarded-spawn.ts) instead of an inline catch/finally.
        return withSpawnedChild({ kill, timer, cleanup: disarm }, async () => {
            const [stdout, stderr] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
            ]);
            const exitCode = await proc.exited;
            return {
                stdout: capOutput(stdout, policy.maxOutputBytes),
                stderr: capOutput(stderr, policy.maxOutputBytes),
                exitCode,
                timedOut,
            };
        });
    }
    /** Validate + resolve the working directory. `normalizeJail` throws a
     *  {@link SandboxPolicyError} if `..` segments climb above the jail root. */
    resolveCwd(jail) {
        if (jail === undefined)
            return process.cwd();
        return normalizeJail(jail);
    }
}
const DEFAULT_IMAGE = "node:22-slim";
const CONTAINER_WORKDIR = "/workspace";
/** Hard cap on the `docker version` availability probe — a daemon that doesn't
 *  respond within this budget is treated as unavailable. Short because the
 *  probe blocks scenario startup; longer than 5s and a hung daemon could
 *  stall the whole eval / agent boot. */
const DOCKER_PROBE_TIMEOUT_MS = 5_000;
/** Append a flag pair only when the value is present (keeps argv minimal and
 *  satisfies exactOptionalPropertyTypes without conditional spreads in argv). */
const pushFlag = (argv, flag, value) => {
    if (value !== undefined)
        argv.push(flag, value);
};
/**
 * Real isolation via `docker run --rm`. Policy → docker flags:
 *  - `cwdJail`  → bind-mounted at {@link CONTAINER_WORKDIR} (`-v host:ctr`),
 *                 container `-w` set there;
 *  - `allowNetwork:false/absent` → `--network none` (TRUE network cut);
 *  - `envAllowlist` → only those names passed via repeated `--env`
 *                     (Docker reads the value from this process's env);
 *  - `memory`/`cpus` → `--memory` / `--cpus` when configured.
 *
 * The user command is passed as the argv tail `bash -lc <command>` — it is
 * NEVER interpolated into a shell string on the host, so there is no
 * host-side shell injection surface.
 *
 * If Docker is unavailable, {@link run} throws {@link SandboxUnavailableError}
 * — it does NOT silently degrade to LocalSandbox. The caller chooses.
 */
export class DockerSandbox {
    image;
    memory;
    cpus;
    dockerBin;
    constructor(options = {}) {
        this.image = options.image ?? DEFAULT_IMAGE;
        this.memory = options.memory;
        this.cpus = options.cpus;
        this.dockerBin = options.dockerBin ?? "docker";
    }
    /** True iff the docker CLI is present AND a daemon answers `docker version`. */
    async isAvailable() {
        try {
            const proc = Bun.spawn([this.dockerBin, "version"], {
                stdout: "ignore",
                stderr: "ignore",
            });
            const timer = setTimeout(() => {
                try {
                    proc.kill();
                }
                catch {
                    // already exited
                }
            }, DOCKER_PROBE_TIMEOUT_MS);
            try {
                return (await proc.exited) === 0;
            }
            finally {
                clearTimeout(timer);
            }
        }
        catch {
            return false;
        }
    }
    /** Compose the full docker argv for a policy + command. Pure + unit-friendly. */
    buildArgv(command, policy) {
        const argv = [this.dockerBin, "run", "--rm"];
        if (policy.allowNetwork !== true)
            argv.push("--network", "none");
        if (policy.cwdJail !== undefined) {
            const host = normalizeJail(policy.cwdJail);
            argv.push("-v", `${host}:${CONTAINER_WORKDIR}`);
            argv.push("-w", CONTAINER_WORKDIR);
        }
        for (const name of policy.envAllowlist ?? DEFAULT_ENV_ALLOWLIST) {
            // `--env NAME` (no `=`) ⇒ docker forwards the value from THIS process's
            // env, so non-allowlisted parent vars never reach the container.
            if (process.env[name] !== undefined)
                argv.push("--env", name);
        }
        pushFlag(argv, "--memory", this.memory);
        pushFlag(argv, "--cpus", this.cpus);
        argv.push(this.image);
        if (policy.disclaimShell === true) {
            argv.push(...disclaimedShellArgv("bash", command));
        }
        else {
            argv.push("bash", "-lc", command);
        }
        return argv;
    }
    async run(command, policy = {}) {
        if (!(await this.isAvailable())) {
            throw new SandboxUnavailableError(`Docker is not available (\`${this.dockerBin} version\` failed). ` +
                "Refusing to run; the caller should choose a fallback explicitly.");
        }
        const argv = this.buildArgv(command, policy);
        const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS;
        let timedOut = false;
        const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" });
        // SIGTERM→SIGKILL escalation (KILL_GRACE_MS): a `docker run` that ignores
        // TERM is force-killed; `disarm` clears the grace timer in cleanup.
        const { kill, disarm } = escalatingKill(proc);
        const timer = setTimeout(() => {
            timedOut = true;
            kill();
        }, timeoutMs);
        // GUARDED: kill-on-throw + timer teardown via `withSpawnedChild`. The
        // host-side `docker run` process must still be reaped on a mid-drain throw
        // (the `--rm` flag only cleans the CONTAINER on its own exit), so the same
        // guard the local path uses applies here unchanged.
        return withSpawnedChild({ kill, timer, cleanup: disarm }, async () => {
            const [stdout, stderr] = await Promise.all([
                new Response(proc.stdout).text(),
                new Response(proc.stderr).text(),
            ]);
            const exitCode = await proc.exited;
            return {
                stdout: capOutput(stdout, policy.maxOutputBytes),
                stderr: capOutput(stderr, policy.maxOutputBytes),
                exitCode,
                timedOut,
            };
        });
    }
}
