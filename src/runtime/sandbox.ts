import { QuantaError } from "@/shared"
import type { ShellResult } from "./types"

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

/** Minimal, non-sensitive variables a child generally needs to function.
 *  Deliberately excludes anything that could carry credentials. */
const DEFAULT_ENV_ALLOWLIST = ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "TERM"]

/** Build the scrubbed environment: ONLY allowlisted names, copied from the
 *  parent if present. The parent's full env (API keys, tokens, …) never
 *  leaks — absent names are simply omitted. */
const scrubEnv = (allowlist: readonly string[]): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const name of allowlist) {
    const value = process.env[name]
    if (value !== undefined) out[name] = value
  }
  return out
}

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
 *    including API keys, is never inherited);
 *  - cwd: the process starts in `cwdJail`, and a requested jail escape throws;
 *  - output cap: captured bytes are truncated to `maxOutputBytes`;
 *  - timeout: the process is killed past `timeoutMs` (`timedOut` set).
 */
export class LocalSandbox implements Sandbox {
  async run(command: string, policy: SandboxPolicy = {}): Promise<ShellResult> {
    const env = scrubEnv(policy.envAllowlist ?? DEFAULT_ENV_ALLOWLIST)
    const cwd = this.resolveCwd(policy.cwdJail)
    const timeoutMs = policy.timeoutMs ?? DEFAULT_TIMEOUT_MS
    let timedOut = false

    const proc = Bun.spawn(["bash", "-lc", command], {
      cwd,
      env,
      stdout: "pipe",
      stderr: "pipe",
    })

    const kill = () => {
      try {
        proc.kill()
      } catch {
        // already exited
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)

    try {
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
    } finally {
      clearTimeout(timer)
    }
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
}

const DEFAULT_IMAGE = "node:22-slim"
const CONTAINER_WORKDIR = "/workspace"

/** Append a flag pair only when the value is present (keeps argv minimal and
 *  satisfies exactOptionalPropertyTypes without conditional spreads in argv). */
const pushFlag = (argv: string[], flag: string, value: string | undefined) => {
  if (value !== undefined) argv.push(flag, value)
}

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

  constructor(options: DockerSandboxOptions = {}) {
    this.image = options.image ?? DEFAULT_IMAGE
    this.memory = options.memory
    this.cpus = options.cpus
    this.dockerBin = options.dockerBin ?? "docker"
  }

  /** True iff the docker CLI is present AND a daemon answers `docker version`. */
  async isAvailable(): Promise<boolean> {
    try {
      const proc = Bun.spawn([this.dockerBin, "version"], {
        stdout: "ignore",
        stderr: "ignore",
      })
      const timer = setTimeout(() => {
        try {
          proc.kill()
        } catch {
          // already exited
        }
      }, 5_000)
      try {
        return (await proc.exited) === 0
      } finally {
        clearTimeout(timer)
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

    argv.push(this.image, "bash", "-lc", command)
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

    const proc = Bun.spawn(argv, { stdout: "pipe", stderr: "pipe" })
    const kill = () => {
      try {
        proc.kill()
      } catch {
        // already exited
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      kill()
    }, timeoutMs)

    try {
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
    } finally {
      clearTimeout(timer)
    }
  }
}
