import type { Subprocess } from "bun"
import { DEFAULT_ENV_ALLOWLIST, QuantaError, scrubEnvFrom } from "@/shared"
import { escalatingKill, withSpawnedChild } from "./guarded-spawn"
import { type ProxyEnvInput, withProxyEnv } from "./network-proxy"
import { defaultPpidWalkKiller } from "./process-tree"
import { asScrubbedEnv, bunScrubbedSpawner } from "./scrubbed-spawn"
import { disclaimedShellArgv } from "./shell-disclaim"
import type { ShellResult } from "./types"

/** D1 (jun-7) — whole-tree killer for the sandboxed `bash -lc` / `docker run`
 *  spawns below. LocalSandbox runs a user-command shell that forks children;
 *  the legacy single-PID `proc.kill()` SIGTERMed only the shell and orphaned its
 *  subtree (the exact bug shell.ts/bash-bg fix). Module-level singleton (the
 *  ppid-walk adapter is pure per `signalTree`). */
const SANDBOX_TREE_KILLER = defaultPpidWalkKiller()

/**
 * Declarative confinement for a single command execution.
 *
 * All fields are optional; an absent field means "no constraint of this kind".
 * The *degree* to which each constraint is actually enforced depends on the
 * concrete {@link Sandbox} implementation — see the enforcement matrix in the
 * doc comments of {@link LocalSandbox} and {@link DockerSandbox}. Never assume
 * a policy is a security boundary unless the implementation says so.
 */
export interface SandboxPolicy {
  /** Absolute directory the command runs in. Implementations MUST reject a
   *  command whose requested working directory escapes this jail. */
  cwdJail?: string
  /** When false/absent, network access SHOULD be denied where the
   *  implementation can do so (only DockerSandbox can truly enforce this). */
  allowNetwork?: boolean
  /** Exact set of environment variable names allowed through to the child.
   *  Anything else (including the parent's full env and API keys) is dropped.
   *  Absent ⇒ a minimal safe default set. */
  envAllowlist?: string[]
  /** Hard cap on combined captured stdout/stderr bytes. Excess is truncated
   *  with a visible marker. Absent ⇒ no cap. */
  maxOutputBytes?: number
  /** Wall-clock budget; the process is killed past this and `timedOut` is set. */
  timeoutMs?: number
  /** When true, launch the user shell with dotfile-skipping flags
   *  (`bash --noprofile --norc` / `zsh -f`). Approximates macOS
   *  `POSIX_SPAWN_SETDISCLAIM` for in-process spawns — user `~/.bashrc` /
   *  `~/.zshrc` cannot run in the child, so a hijacked dotfile cannot read
   *  the child's env or piggy-back on its descriptors. Default false
   *  (legacy behavior: `bash -lc` sources `.bashrc`/`.profile`). Tier-0
   *  absorption #0-2. */
  disclaimShell?: boolean
  /** ADR-0428 jun-02 wire — socket-level egress proxy env. When set with a bound
   *  `address`, the spawned child gets `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` (via
   *  {@link withProxyEnv}) so its OWN sockets are funneled through the loopback
   *  egress proxy — the SAME bypass-closure `runShell` applies. Only
   *  {@link LocalSandbox} honors this (it spawns in-process). `DockerSandbox`
   *  forwards proxy vars through its `envAllowlist` (HTTP_PROXY etc. are already
   *  in {@link DEFAULT_ENV_ALLOWLIST}). Absent / no `address` ⇒ `withProxyEnv`
   *  returns the same scrubbed env reference (byte-identical legacy). */
  proxyEnv?: ProxyEnvInput
}

/** A command runner that applies a {@link SandboxPolicy} before/around the run. */
export interface Sandbox {
  run(command: string, policy?: SandboxPolicy): Promise<ShellResult>
}

/** Raised when a sandbox backend it depends on is not usable (e.g. Docker is
 *  not installed / not running). The caller — not the sandbox — decides
 *  whether to fall back to a weaker backend. */
export class SandboxUnavailableError extends QuantaError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("sandbox_unavailable", message, options)
  }
}

/** Raised when a policy constraint cannot be satisfied (e.g. a cwd-jail
 *  escape was requested). This is a hard stop, never a degraded run. */
export class SandboxPolicyError extends QuantaError {
  constructor(message: string) {
    super("sandbox_policy", message)
  }
}

const DEFAULT_TIMEOUT_MS = 120_000
const TRUNCATION_MARKER = "\n…[output truncated by sandbox maxOutputBytes]"

export { DEFAULT_ENV_ALLOWLIST }

/** Scrub THIS process's environment down to `allowlist`.
 *
 *  The PURE half (`scrubEnvFrom`, `@/shared/env-scrub`) takes the bag, because
 *  `@/subagent` may not import `@/runtime` and `@/shared` may not read
 *  `process.env`. This one-argument form supplies the ambient read on the side
 *  of the fence allowed to have it, so every existing caller here stays
 *  byte-identical. */
export const scrubEnv = (
  allowlist: readonly string[] = DEFAULT_ENV_ALLOWLIST,
): Record<string, string> => scrubEnvFrom(process.env, allowlist)

/** Resolve a jail directory to an absolute, normalized path. A relative jail
 *  is resolved against the current process cwd (callers SHOULD pass absolute).
 *  Throws {@link SandboxPolicyError} if `..` segments would climb above the
 *  jail's anchor root (an attempted jail escape). */
const normalizeJail = (jail: string): string => {
  const isAbs = jail.startsWith("/")
  const anchor = isAbs ? "" : process.cwd()
  const anchorDepth = anchor === "" ? 0 : anchor.split("/").filter(Boolean).length
  const parts: string[] = anchor === "" ? [] : anchor.split("/").filter(Boolean)
  for (const seg of jail.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") {
      if (parts.length <= anchorDepth) {
        throw new SandboxPolicyError(`cwd jail escape rejected: ${jail} climbs above its root`)
      }
      parts.pop()
    } else parts.push(seg)
  }
  return `/${parts.join("/")}`
}

/** Truncate combined output to a byte budget, appending a visible marker
 *  exactly once when the cap bites. */
const capOutput = (text: string, maxBytes: number | undefined): string => {
  if (maxBytes === undefined) return text
  const bytes = Buffer.from(text, "utf8")
  if (bytes.length <= maxBytes) return text
  return bytes.subarray(0, maxBytes).toString("utf8") + TRUNCATION_MARKER
}

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
export class LocalSandbox implements Sandbox {
  async run(command: string, policy: SandboxPolicy = {}): Promise<ShellResult> {
    // ADR-0428 jun-02 wire — inject the egress proxy env over the scrubbed base
    // so a LocalSandbox child's OWN sockets are gated too (closing the same
    // bypass `runShell` closes). Absent ⇒ `withProxyEnv` returns the same env.
    // S1 — branded at the scrubber chokepoint (compose-through-`withProxyEnv` is
    // still rooted at `scrubEnv`), then routed through the typed `spawnScrubbed`
    // boundary: an env leak here is a tsc error, not just an R-D3 scan hit.
    const env = asScrubbedEnv(
      withProxyEnv(scrubEnv(policy.envAllowlist ?? DEFAULT_ENV_ALLOWLIST), policy.proxyEnv ?? {}),
    )
    const cwd = this.resolveCwd(policy.cwdJail)
    const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let timedOut = false

    const argv =
      policy.disclaimShell === true
        ? [...disclaimedShellArgv("bash", command)]
        : ["bash", "-lc", command]
    const proc = bunScrubbedSpawner(argv, {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    }) as Subprocess<"ignore", "pipe", "pipe">

    // SIGTERM→SIGKILL escalation (KILL_GRACE_MS): a TERM-trapping child is
    // force-killed; `disarm` clears the grace timer in the guard's cleanup.
    const { kill, disarm } = escalatingKill(proc, SANDBOX_TREE_KILLER)
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)

    // GUARDED: kill-on-throw + timer teardown via `withSpawnedChild`
    // (src/runtime/guarded-spawn.ts) instead of an inline catch/finally.
    return withSpawnedChild({ kill, timer, cleanup: disarm }, async () => {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const exitCode = await proc.exited
      return {
        stdout: capOutput(stdout, policy.maxOutputBytes),
        stderr: capOutput(stderr, policy.maxOutputBytes),
        exitCode,
        timedOut,
      }
    })
  }

  /** Validate + resolve the working directory. `normalizeJail` throws a
   *  {@link SandboxPolicyError} if `..` segments climb above the jail root. */
  private resolveCwd(jail: string | undefined): string {
    if (jail === undefined) return process.cwd()
    return normalizeJail(jail)
  }
}

/** Tunables for {@link DockerSandbox}, all optional. */
export interface DockerSandboxOptions {
  /** Container image. Default `node:22-slim`. */
  image?: string
  /** `--memory` value, e.g. `"512m"`. Omitted ⇒ no limit flag. */
  memory?: string
  /** `--cpus` value, e.g. `"1"`. Omitted ⇒ no limit flag. */
  cpus?: string
  /** Override the docker binary (mainly for testing). Default `"docker"`. */
  dockerBin?: string
  /** Availability-probe deadline. Production default remains exactly 5000ms. */
  probeTimeoutMs?: number
  /** Probe-only scheduler seam. Omitted uses real platform timers. */
  probeScheduler?: DockerProbeScheduler
}

export interface DockerProbeScheduler {
  readonly schedule: (callback: () => void, delayMs: number) => unknown
  readonly cancel: (handle: unknown) => void
}

const DEFAULT_IMAGE = "node:22-slim"
const CONTAINER_WORKDIR = "/workspace"
/** Host-side Docker client variables. This is deliberately distinct from the
 * container allowlist: Docker itself must never inherit provider credentials
 * simply because it is executed from the agent process. */
const DOCKER_CLIENT_ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "TMPDIR",
  "DOCKER_HOST",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_CERT_PATH",
  "DOCKER_TLS_VERIFY",
] as const
/** Hard cap on the `docker version` availability probe — a daemon that doesn't
 *  respond within this budget is treated as unavailable. Short because the
 *  probe blocks scenario startup; longer than 5s and a hung daemon could
 *  stall the whole eval / agent boot. */
const DOCKER_PROBE_TIMEOUT_MS = 5_000
const REAL_DOCKER_PROBE_SCHEDULER: DockerProbeScheduler = {
  schedule: (callback, delayMs) => setTimeout(callback, delayMs),
  cancel: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/** Append a flag pair only when the value is present (keeps argv minimal and
 *  satisfies exactOptionalPropertyTypes without conditional spreads in argv). */
const pushFlag = (argv: string[], flag: string, value: string | undefined) => {
  if (value !== undefined) argv.push(flag, value)
}

/** Docker resolves `--env NAME` from its own process environment. Build the
 * host client environment from the daemon keys plus exactly those names the
 * caller deliberately forwards to the container; ambient parent variables
 * cannot cross either boundary. */
const dockerClientEnv = (containerAllowlist: readonly string[]): ReturnType<typeof asScrubbedEnv> =>
  asScrubbedEnv(scrubEnv([...new Set([...DOCKER_CLIENT_ENV_ALLOWLIST, ...containerAllowlist])]))

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
export class DockerSandbox implements Sandbox {
  private readonly image: string
  private readonly memory: string | undefined
  private readonly cpus: string | undefined
  private readonly dockerBin: string
  private readonly probeTimeoutMs: number
  private readonly probeScheduler: DockerProbeScheduler

  constructor(options: DockerSandboxOptions = {}) {
    this.image = options.image ?? DEFAULT_IMAGE
    this.memory = options.memory
    this.cpus = options.cpus
    this.dockerBin = options.dockerBin ?? "docker"
    this.probeTimeoutMs = options.probeTimeoutMs ?? DOCKER_PROBE_TIMEOUT_MS
    this.probeScheduler = options.probeScheduler ?? REAL_DOCKER_PROBE_SCHEDULER
  }

  /** True iff the docker CLI is present AND a daemon answers `docker version`. */
  async isAvailable(): Promise<boolean> {
    try {
      const proc = bunScrubbedSpawner([this.dockerBin, "version"], {
        cwd: process.cwd(),
        env: dockerClientEnv([]),
        stdout: "ignore",
        stderr: "ignore",
      }) as Subprocess<"ignore", "ignore", "ignore">
      const timer = this.probeScheduler.schedule(() => {
        try {
          proc.kill()
        } catch {
          // already exited
        }
      }, this.probeTimeoutMs)
      try {
        return (await proc.exited) === 0
      } finally {
        this.probeScheduler.cancel(timer)
      }
    } catch {
      return false
    }
  }

  /** Compose the full docker argv for a policy + command. Pure + unit-friendly. */
  buildArgv(command: string, policy: SandboxPolicy): string[] {
    const argv = [this.dockerBin, "run", "--rm"]

    if (policy.allowNetwork !== true) argv.push("--network", "none")

    if (policy.cwdJail !== undefined) {
      const host = normalizeJail(policy.cwdJail)
      argv.push("-v", `${host}:${CONTAINER_WORKDIR}`)
      argv.push("-w", CONTAINER_WORKDIR)
    }

    for (const name of policy.envAllowlist ?? DEFAULT_ENV_ALLOWLIST) {
      // `--env NAME` (no `=`) ⇒ docker forwards the value from THIS process's
      // env, so non-allowlisted parent vars never reach the container.
      if (process.env[name] !== undefined) argv.push("--env", name)
    }

    pushFlag(argv, "--memory", this.memory)
    pushFlag(argv, "--cpus", this.cpus)

    argv.push(this.image)
    if (policy.disclaimShell === true) {
      argv.push(...disclaimedShellArgv("bash", command))
    } else {
      argv.push("bash", "-lc", command)
    }
    return argv
  }

  async run(command: string, policy: SandboxPolicy = {}): Promise<ShellResult> {
    if (!(await this.isAvailable())) {
      throw new SandboxUnavailableError(
        `Docker is not available (\`${this.dockerBin} version\` failed). ` +
          "Refusing to run; the caller should choose a fallback explicitly.",
      )
    }

    const argv = this.buildArgv(command, policy)
    const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let timedOut = false

    const proc = bunScrubbedSpawner(argv, {
      cwd: process.cwd(),
      env: dockerClientEnv(policy.envAllowlist ?? DEFAULT_ENV_ALLOWLIST),
      stdout: "pipe",
      stderr: "pipe",
    }) as Subprocess<"ignore", "pipe", "pipe">
    // SIGTERM→SIGKILL escalation (KILL_GRACE_MS): a `docker run` that ignores
    // TERM is force-killed; `disarm` clears the grace timer in cleanup.
    const { kill, disarm } = escalatingKill(proc, SANDBOX_TREE_KILLER)
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)

    // GUARDED: kill-on-throw + timer teardown via `withSpawnedChild`. The
    // host-side `docker run` process must still be reaped on a mid-drain throw
    // (the `--rm` flag only cleans the CONTAINER on its own exit), so the same
    // guard the local path uses applies here unchanged.
    return withSpawnedChild({ kill, timer, cleanup: disarm }, async () => {
      const [stdout, stderr] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      const exitCode = await proc.exited
      return {
        stdout: capOutput(stdout, policy.maxOutputBytes),
        stderr: capOutput(stderr, policy.maxOutputBytes),
        exitCode,
        timedOut,
      }
    })
  }
}
