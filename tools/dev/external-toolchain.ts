import { readdirSync, statSync } from "node:fs"

/**
 * Host capability fingerprint for verification receipts.
 *
 * WHY IT EXISTS. A green verification result is reusable only while the host
 * can still do what that green covered. `contract` and `real-toolchain-e2e`
 * shell out to docker / python / the language servers, and both are SKIPPED
 * wholesale when an exact receipt is reused — so a receipt that does not
 * record those capabilities lets a host that has since lost docker replay a
 * green it can no longer earn.
 *
 * ABSENCE IS A VALUE. A missing tool fingerprints as `<missing>`, so gaining a
 * capability invalidates a receipt exactly as losing one does; otherwise the
 * "skipped because absent" runs and the "passed because present" runs would
 * share a fingerprint.
 *
 * NO SUBPROCESS. The first version ran `<tool> --version` per entry. That was
 * unbounded — one wedged CLI stalls the campaign with no diagnostic — and,
 * measured, 931ms, spent on the PRE-LEASE receipt probe whose entire purpose
 * is to return immediately when there is no campaign to serialize. Identity
 * now comes from the resolved binary itself: PATH resolution, symlink target,
 * size, mtime. That is strictly better at the job the fingerprint exists for
 * (a rebuilt binary that still prints the same version string changes size and
 * mtime) and the whole "the probe hung" class is gone.
 */

/**
 * Executables whose PRESENCE decides whether a host-dependent test runs.
 *
 * Harvested from the corpus, not guessed: these are the names the
 * `*-real-e2e.test.ts` lane and the contract suites resolve before deciding
 * to skip. The first version listed five plausible tools and missed `cargo`,
 * `go`, `gopls`, `rust-analyzer`, `clangd`, `lldb-dap`, `node` and `npm` — the
 * whole 43-case real-toolchain lane — so installing a Rust or Go toolchain
 * left the fingerprint identical and replayed a green earned while those
 * cases skipped. It also probed `pyright`, while the tests gate on
 * `pyright-langserver`.
 *
 * `tests/unit/dev/external-toolchain-coverage.test.ts` fails when the corpus
 * gains a gating binary this list does not carry.
 */
export const EXTERNAL_TOOLS = [
  "bun",
  "bwrap",
  "cargo",
  "chromium",
  "chromium-browser",
  "clang",
  "clang++",
  "clangd",
  "dlv",
  "docker",
  "g++",
  "git",
  "go",
  "google-chrome",
  "google-chrome-stable",
  "gopls",
  "limactl",
  "lldb-dap",
  "node",
  "npm",
  "ollama",
  "pyright-langserver",
  "python3",
  "rust-analyzer",
  "typescript-language-server",
  "uv",
  // macOS resolves `lldb-dap` through the Xcode/CLT toolchain rather than PATH,
  // and `xcrun -f lldb-dap` is how the debugger lane finds it. Absent on Linux,
  // which is a true and useful value: the debugger arms resolve differently
  // there, and the two hosts must not share a fingerprint.
  "xcrun",
] as const

/**
 * Capability binaries that are NOT on PATH under their own name.
 *
 * macOS ships Chrome as an app bundle, so `Bun.which("google-chrome")` answers
 * `<missing>` on a box that has Chrome — and `src/browser/cdp-adapter/deps.ts`
 * knows that: it walks `DEFAULT_CHROME_CANDIDATES` on PATH and THEN
 * `DEFAULT_MAC_CHROME_PATHS` on disk. A fingerprint that only did the first
 * half reported "no browser capability" on every mac, which is the same value
 * a Linux box with no Chrome reports. Kept in lockstep with that adapter list
 * by `tests/unit/dev/external-toolchain-coverage.test.ts`.
 */
export const EXTERNAL_TOOL_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
] as const

/**
 * Capabilities that live inside an interpreter rather than on PATH.
 *
 * `debugpy` gates the whole python runtime-capture arm and is imported as a
 * module (`python3 -c "import debugpy"`), so neither `Bun.which` nor a stat can
 * see it. It is fingerprinted through the BOUNDED async probe below, never on
 * the sync fast path — the sync path's entire contract is that it cannot hang.
 */
export const PYTHON_CAPABILITY_MODULES = ["debugpy"] as const

/** Identity of an ABSOLUTE candidate. Same value shape as the PATH branch, so
 *  the two kinds of capability compare the same way. */
const fingerprintPath = (path: string): string => {
  try {
    const stat = statSync(path)
    return `${path} ${stat.dev}:${stat.ino} ${stat.size} ${Math.round(stat.mtimeMs)}`
  } catch {
    return "<missing>"
  }
}

export const probeToolVersion = (tool: string): string => {
  // An absolute candidate (the mac Chrome bundles) is not a PATH lookup: stat
  // it where it claims to be. `Bun.which` on an absolute path is not a
  // documented resolution and would silently answer `<missing>` for a binary
  // that is right there.
  if (tool.startsWith("/")) return fingerprintPath(tool)
  // Resolve against the CURRENT PATH, explicitly. `Bun.which(tool)` reads the
  // PATH the process started with and ignores later `process.env.PATH` changes
  // (measured on Bun 1.3.14), which would fingerprint a capability the
  // children will not actually see.
  const path = Bun.which(tool, { PATH: process.env.PATH ?? "" })
  if (path === null) return "<missing>"
  try {
    // `statSync` FOLLOWS the link, which is the point: `~/.bun/bin/<tool>` and
    // `/usr/local/bin/<tool>` are usually links, and an upgrade repoints them
    // or replaces the target — either way dev:ino, size or mtime moves.
    //
    // NOT `realpathSync`. MEASURED on this box: sampling the 18 tools twice a
    // second while a 4-wide test run went on, `/usr/bin/python3` resolved to
    // `/usr/bin/git` and back. They are HARDLINKS to one inode — the Command
    // Line Tools shim, 78 names on a single file — and Bun's realpath answers
    // per inode, so under concurrency it returns whichever name it resolved
    // first. That made the fingerprint a non-function of the host state: it
    // flipped between two campaigns 475ms apart and turned a reusable exact
    // receipt into `toolchainSha256 mismatch`, i.e. 21 gates re-run for
    // nothing. dev:ino carries the identity realpath was reached for, and it
    // is a value the kernel reports rather than a path a cache guesses.
    const stat = statSync(path)
    return `${path} ${stat.dev}:${stat.ino} ${stat.size} ${Math.round(stat.mtimeMs)}`
  } catch {
    // Present on PATH but unreadable is its own state — never silently equal
    // to a healthy tool.
    return `${path} <unreadable>`
  }
}

let cachedFingerprint: Record<string, string> | undefined

/** Probed once per process; an injected probe is never cached. */
export const externalToolchainFingerprint = (
  probe: (tool: string) => string = probeToolVersion,
): Record<string, string> => {
  if (probe === probeToolVersion && cachedFingerprint !== undefined) return cachedFingerprint
  const fingerprint = Object.fromEntries(EXTERNAL_TOOLS.map((tool) => [tool, probe(tool)]))
  if (probe === probeToolVersion) cachedFingerprint = fingerprint
  return fingerprint
}

/**
 * Which of those tools this box does NOT have.
 *
 * The fingerprint already makes absence part of the cache identity, so a green
 * earned without docker cannot be replayed on a box that has it. What it does
 * not do is TELL anyone. A run where `real-toolchain-e2e` silently skipped 43
 * cases prints the same `PASS` as one where they all ran, and the number of
 * gates passed is identical — so the strength of a green was unreadable from
 * its own report.
 */
export const missingExternalTools = (
  probe: (tool: string) => string = probeToolVersion,
): readonly string[] =>
  Object.entries(externalToolchainFingerprint(probe))
    .filter(([, value]) => value === "<missing>" || value.endsWith("<unreadable>"))
    .map(([tool]) => tool)
    .sort()

/* ────────────────────────────────────────────────────────────────────────── *
 *  DAEMON STATE — because an inode is not a running service
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * `docker` on PATH is a CLIENT. `limactl` on PATH is a CLI. Neither says
 * anything about whether a daemon is up or a VM is booted, and that is exactly
 * what decides whether `tests/contract/sandbox-docker.test.ts` executes or
 * skips. Fingerprinting the binary alone made "daemon stopped" and "daemon
 * running" share a receipt, so a green earned while the docker contracts
 * skipped could be replayed as if they had run — and the reverse.
 *
 * The evidence is FILESYSTEM state, deliberately: a socket/pidfile stat is
 * bounded by construction, where `docker info` is a subprocess that hangs for
 * 30s+ against a half-dead daemon. This is not a liveness check and does not
 * claim to be — `probeDaemonLive` below is, and it carries an explicit
 * deadline. What this is, is a value that MOVES when the daemon starts or
 * stops, which is all a cache identity needs.
 */
export interface DaemonStateProbe {
  readonly id: string
  /** Env var that relocates the endpoint; part of the state when set. */
  readonly env?: string
  /** Filesystem evidence of a live service, in preference order. */
  readonly sockets: readonly string[]
  /** Directory whose entries enumerate instances (Lima VMs). */
  readonly instanceRoot?: string
  /** Bounded liveness endpoint, when one exists. */
  readonly httpProbe?: string
}

const home = (): string => process.env.HOME ?? ""

export const DAEMON_STATE_PROBES: readonly DaemonStateProbe[] = [
  {
    id: "docker-daemon",
    env: "DOCKER_HOST",
    sockets: [
      "/var/run/docker.sock",
      `${home()}/.docker/run/docker.sock`,
      `${home()}/.colima/default/docker.sock`,
      `${home()}/.rd/docker.sock`,
    ],
  },
  {
    id: "lima-vm",
    env: "LIMA_HOME",
    sockets: [],
    instanceRoot: `${home()}/.lima`,
  },
  {
    id: "ollama-daemon",
    env: "OLLAMA_HOST",
    sockets: [],
    httpProbe: "http://127.0.0.1:11434/api/tags",
  },
]

/** Bounded, subprocess-free state of one daemon. Never throws. */
export const probeDaemonState = (probe: DaemonStateProbe): string => {
  const parts: string[] = []
  const endpoint = probe.env === undefined ? undefined : process.env[probe.env]
  if (endpoint !== undefined && endpoint !== "") parts.push(`${probe.env}=${endpoint}`)
  for (const socket of probe.sockets) {
    try {
      const stat = statSync(socket)
      // A socket's mtime moves when the daemon is (re)started; the inode moves
      // when it is recreated. Size is meaningless for a socket and is omitted
      // so a restart is not mistaken for a no-op.
      parts.push(`${socket} ${stat.dev}:${stat.ino} ${Math.round(stat.mtimeMs)}`)
    } catch {
      // Absent socket is not evidence of anything; keep scanning.
    }
  }
  if (probe.instanceRoot !== undefined) {
    try {
      // A Lima instance is BOOTED when its host-agent socket exists; the
      // directory alone survives `limactl stop`.
      const entries = readdirSync(probe.instanceRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
      for (const name of entries) {
        const sock = `${probe.instanceRoot}/${name}/ha.sock`
        try {
          const stat = statSync(sock)
          parts.push(`${name} booted ${stat.dev}:${stat.ino} ${Math.round(stat.mtimeMs)}`)
        } catch {
          parts.push(`${name} stopped`)
        }
      }
    } catch {
      // No Lima at all.
    }
  }
  return parts.length === 0 ? "<down>" : parts.join(" | ")
}

let cachedDaemonState: Record<string, string> | undefined

/** Probed once per process; an injected probe is never cached. */
export const daemonStateFingerprint = (
  probe: (spec: DaemonStateProbe) => string = probeDaemonState,
): Record<string, string> => {
  if (probe === probeDaemonState && cachedDaemonState !== undefined) return cachedDaemonState
  const fingerprint = Object.fromEntries(
    DAEMON_STATE_PROBES.map((spec) => [spec.id, probe(spec)] as const),
  )
  if (probe === probeDaemonState) cachedDaemonState = fingerprint
  return fingerprint
}

/**
 * The complete host capability identity: PATH binaries, absolute candidates
 * that are not on PATH, and daemon state.
 *
 * `externalToolchainFingerprint` deliberately stays the PATH-binary-only value
 * (its callers pin its key set and a <100ms budget); this is the superset a
 * capability receipt should carry.
 */
export const hostCapabilityFingerprint = (): Record<string, string> => ({
  ...externalToolchainFingerprint(),
  ...Object.fromEntries(EXTERNAL_TOOL_PATHS.map((path) => [path, probeToolVersion(path)] as const)),
  ...daemonStateFingerprint(),
})

export type LiveCapabilityVerdict = "live" | "down" | "unknown"

/**
 * ACTUAL liveness, for the capability runner rather than the receipt fast path.
 *
 * Explicitly deadlined: `AbortSignal.timeout` on the fetch, and
 * `Bun.spawn` + `signal` (never `Bun.spawnSync`, which has no deadline at all —
 * the shape this whole module's header argues against) for the interpreter
 * probes. A probe that cannot answer inside the deadline is `unknown`, which is
 * NOT `live` and NOT a pass.
 */
export const probeDaemonLive = async (
  probe: DaemonStateProbe,
  timeoutMs = 3_000,
): Promise<LiveCapabilityVerdict> => {
  if (probe.httpProbe === undefined) {
    return probeDaemonState(probe) === "<down>" ? "down" : "unknown"
  }
  try {
    const res = await fetch(probe.httpProbe, { signal: AbortSignal.timeout(timeoutMs) })
    return res.ok ? "live" : "down"
  } catch {
    return "down"
  }
}

/** Bounded `python3 -c "import <module>"`. Never `spawnSync`. */
export const probePythonModule = async (
  moduleName: string,
  timeoutMs = 5_000,
): Promise<LiveCapabilityVerdict> => {
  const python = Bun.which("python3", { PATH: process.env.PATH ?? "" })
  if (python === null) return "down"
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const child = Bun.spawn([python, "-c", `import ${moduleName}`], {
      stdout: "ignore",
      stderr: "ignore",
      signal: controller.signal,
    })
    return (await child.exited) === 0 ? "live" : "down"
  } catch {
    return "unknown"
  } finally {
    clearTimeout(timer)
  }
}
