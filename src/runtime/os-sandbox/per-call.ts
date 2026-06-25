import { existsSync } from "node:fs"
import { compileBubblewrapArgs } from "./bubblewrap"
import { compileLandlockCliArgs, LANDLOCK_CLI_NETWORK_DEFERRED_MARKER } from "./landlock-cli"
import type { LinuxSandboxBackend } from "./linux"
import type { SandboxPolicy, SandboxProfile } from "./types"
import { DEFAULT_SANDBOX_EXEC_PATH, type WrappedShellArgv, wrapShellArgv } from "./wrap-argv"

/**
 * ADR-0295 — closed-port adapter for **per-call** OS sandbox wrapping.
 *
 * The existing `ShellSandboxSlot` (`shell-sandbox-holder.ts`) is a SESSION-wide
 * boot-time install: the CLI picks one profile (`QUANTA_SANDBOX`) and every
 * `runShell` call inherits it. That model cannot express "this ONE call is
 * read-only (audit + accident-proof) even though the session is in `off`
 * mode" — which is the Cursor pattern this ADR absorbs.
 *
 * This port is the per-call inversion: the bash tool builds it ONCE per
 * `mode="read"` call, asks it to wrap the argv, and never reaches into the
 * session-wide slot. The port returns a {@link WrappedShellArgv} carrying the
 * sandbox-exec-prefixed argv (when applied) or a typed degrade reason (when
 * the OS cannot enforce — fail-closed in the consumer).
 *
 * Closed surface (only two methods):
 *
 *   - `wrap(argv, cwd)`     — compose the wrapped argv for one spawn.
 *   - `availability()`      — sync probe answering "can this wrap actually
 *                             enforce on this host?" Returns
 *                             `{supported:false, reason}` on
 *                             `darwin` w/o `sandbox-exec`, on `win32`, on
 *                             linux without the bwrap/landlock chain probed
 *                             at construction time, etc. The bash tool
 *                             reads this BEFORE handing the argv to
 *                             `runShell` so an unavailable backend short-
 *                             circuits with a typed `sandbox_unavailable`
 *                             failure (never falls back to the legacy
 *                             unsandboxed spawn).
 *
 * Default-OFF wire: the bash tool's `mode` parameter defaults to `"write"`,
 * which never consults this port. Only `mode="read"` allocates a port via
 * the injected factory. Test cases inject a fake port for hermetic coverage.
 */
export interface PerCallSandboxPort {
  /** Wrap the spawnable argv with the OS-native sandbox preamble. Pure (no
   *  I/O beyond what `wrapShellArgv` does — which is pure on macOS today).
   *  Returns the original argv verbatim on `availability().supported===false`. */
  readonly wrap: (
    argv: ReadonlyArray<string>,
    cwd: string,
  ) => WrappedShellArgv | Promise<WrappedShellArgv>
  /** Sync probe: can this port actually enforce the policy on this host?
   *  When `supported===false`, the bash tool surfaces a typed
   *  `sandbox_unavailable` failure WITHOUT spawning the command. */
  readonly availability: () => PerCallSandboxAvailability
}

/** Closed result of `PerCallSandboxPort.availability()`. */
export type PerCallSandboxAvailability =
  | { readonly supported: true }
  | { readonly supported: false; readonly reason: string }

/** Construction-time deps for {@link defaultPerCallSandbox}. All optional;
 *  tests pass `platform`/`sandboxExecPath`/`exists` to drive branches
 *  deterministically. */
export interface PerCallSandboxConfig {
  readonly platform?: NodeJS.Platform
  /** Absolute path to `sandbox-exec` (macOS). Default
   *  {@link DEFAULT_SANDBOX_EXEC_PATH}. Pass `null` to simulate missing. */
  readonly sandboxExecPath?: string | null
  /** Path-existence probe used to verify `sandbox-exec` presence on macOS at
   *  construction time. Default {@link existsSync}. */
  readonly exists?: (path: string) => boolean
  /** Per-call write holes for tools that need an ephemeral scratch dir while
   *  preserving read-only semantics for the workspace and the rest of /tmp.
   *  Used by bash mode="read" to support shell here-doc/tempfile mechanics via
   *  a caller-owned TMPDIR. */
  readonly extraWritePaths?: ReadonlyArray<string>
  /** SYNC PATH probe for the Linux backend (`bwrap` / `landlock-cli`). Default
   *  {@link Bun.which}. Synchronous on purpose — the per-call port's
   *  `availability()` is sync (the bash dispatch hot-path reads it before
   *  spawning), so the backend must be resolved at CONSTRUCTION time without an
   *  async probe. Tests inject a fake to drive the linux branches deterministically
   *  from any host. */
  readonly whichSync?: (binary: string) => string | null
}

/**
 * Build the default per-call sandbox port for `profile` (today only
 * `"read-only"` is wired by the bash tool — other arms remain available for
 * future tools). The construction probes `sandbox-exec` presence ONCE on
 * macOS; thereafter `wrap()` and `availability()` are pure.
 *
 * Linux backends (`bwrap` / `landlock-cli`) are detected SYNCHRONOUSLY at
 * construction time via {@link Bun.which} (injectable as `cfg.whichSync` for
 * tests). When a backend is present the port reports `supported:true` and
 * `wrap()` produces the proper backend-prefixed argv — reusing the same
 * `compileBubblewrapArgs` / `compileLandlockCliArgs` compilers the
 * session-wide `ShellSandboxSlot` uses, so the per-call path is no longer
 * inert on Linux. When NEITHER backend is on PATH the port stays fail-closed
 * (`supported:false`, reason `linux-bwrap-missing`) so the bash tool never
 * silently passes a mode="read" call through unsandboxed (matches the user's
 * rule: "fallback으로 직렬 실행 안 함 (fail-closed)").
 *
 * NOTE: the sync `Bun.which` probe is deliberate — `availability()` is sync
 * (the bash dispatch hot-path reads it before spawning), so an async detect
 * cannot be used here. `Bun.which` is the codebase-canonical sync PATH probe.
 */
export const defaultPerCallSandbox = (
  profile: SandboxProfile,
  cfg: PerCallSandboxConfig = {},
): PerCallSandboxPort => {
  const platform: NodeJS.Platform = cfg.platform ?? process.platform
  const exists = cfg.exists ?? existsSync
  const rawSandboxExec =
    cfg.sandboxExecPath === undefined ? DEFAULT_SANDBOX_EXEC_PATH : cfg.sandboxExecPath
  const sandboxExecPath: string | null =
    platform === "darwin" &&
    rawSandboxExec === DEFAULT_SANDBOX_EXEC_PATH &&
    !exists(DEFAULT_SANDBOX_EXEC_PATH)
      ? null
      : rawSandboxExec

  // Detect the Linux backend ONCE, synchronously, at construction time so
  // `availability()` stays sync. `null` on non-linux (unused there).
  const linuxBackend: LinuxSandboxBackend | null =
    platform === "linux" ? detectLinuxSandboxBackendSync(cfg.whichSync) : null

  // Pre-compute availability at construction time so `availability()` stays
  // sync (the bash tool calls it on the dispatch hot-path).
  const avail = computeAvailability(platform, sandboxExecPath, linuxBackend)

  const buildPolicy = (): SandboxPolicy =>
    cfg.extraWritePaths !== undefined && cfg.extraWritePaths.length > 0
      ? { profile, extraWritePaths: cfg.extraWritePaths }
      : { profile }

  return {
    wrap: (argv, cwd) => {
      if (!avail.supported) {
        // Return original argv verbatim + degradeReason — the consumer reads
        // `availability()` to decide whether to spawn. This matches the
        // existing `WrappedShellArgv` shape.
        return {
          argv: [...argv],
          sandboxApplied: false,
          degradeReason: avail.reason,
        }
      }
      const policy = buildPolicy()
      if (platform === "linux") {
        // `avail.supported === true` on linux ⇒ a backend was detected.
        return wrapLinuxPerCall(argv, cwd, policy, linuxBackend as LinuxSandboxBackend)
      }
      return wrapShellArgv(argv, cwd, policy, { platform, sandboxExecPath })
    },
    availability: () => avail,
  }
}

/** Synchronous mirror of {@link detectLinuxSandboxBackend} — bubblewrap wins
 *  over landlock-cli when both present (stronger fence). Returns `null` when
 *  neither is on PATH. Uses the injected `whichSync` (default {@link Bun.which})
 *  so the per-call `availability()` can stay sync. */
const detectLinuxSandboxBackendSync = (
  whichSync?: (binary: string) => string | null,
): LinuxSandboxBackend | null => {
  const which = whichSync ?? ((b: string): string | null => Bun.which(b))
  if (which("bwrap") !== null) return "bubblewrap"
  if (which("landlock-cli") !== null) return "landlock-cli"
  return null
}

/** Compose the Linux backend-prefixed argv for one per-call spawn. Mirrors
 *  `sandbox-wire.ts`'s `wrapLinuxShellArgv` (session-wide slot) so the two
 *  paths produce identical fences from the same compilers. */
const wrapLinuxPerCall = (
  argv: ReadonlyArray<string>,
  cwd: string,
  policy: SandboxPolicy,
  backend: LinuxSandboxBackend,
): WrappedShellArgv => {
  if (backend === "bubblewrap") {
    const policyArgs = compileBubblewrapArgs(policy, cwd)
    // null ⇒ off/danger-full-access ⇒ verbatim passthrough (no degrade).
    if (policyArgs === null) return { argv: [...argv], sandboxApplied: false }
    return { argv: ["bwrap", ...policyArgs, "--", ...argv], sandboxApplied: true }
  }
  // landlock-cli: compile → filter the network-deferred marker (no real flag),
  // surfacing an honest `degradeReason` when network deny could not be enforced.
  const rawArgs = compileLandlockCliArgs(policy, cwd)
  if (rawArgs === null) return { argv: [...argv], sandboxApplied: false }
  const filtered = rawArgs.filter((tok) => tok !== LANDLOCK_CLI_NETWORK_DEFERRED_MARKER)
  return {
    argv: ["landlock-cli", ...filtered, "--", ...argv],
    sandboxApplied: true,
    ...(rawArgs.length !== filtered.length
      ? { degradeReason: "landlock-network-policy-not-enforced" }
      : {}),
  }
}

const computeAvailability = (
  platform: NodeJS.Platform,
  sandboxExecPath: string | null,
  linuxBackend: LinuxSandboxBackend | null,
): PerCallSandboxAvailability => {
  if (platform === "darwin") {
    if (sandboxExecPath === null) {
      return { supported: false, reason: "sandbox-exec-missing" }
    }
    return { supported: true }
  }
  if (platform === "linux") {
    // A real bwrap/landlock-cli backend ⇒ supported. Neither ⇒ fail-closed so
    // the bash tool surfaces `sandbox_unavailable` rather than silently
    // passing a mode="read" call through unsandboxed.
    if (linuxBackend === null) {
      return {
        supported: false,
        reason: "linux-bwrap-missing — install bubblewrap (apt/dnf/pacman)",
      }
    }
    return { supported: true }
  }
  return { supported: false, reason: `unsupported-platform:${platform}` }
}
