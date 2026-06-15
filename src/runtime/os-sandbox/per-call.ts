import { existsSync } from "node:fs"
import type { SandboxProfile } from "./types"
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
}

/**
 * Build the default per-call sandbox port for `profile` (today only
 * `"read-only"` is wired by the bash tool — other arms remain available for
 * future tools). The construction probes `sandbox-exec` presence ONCE on
 * macOS; thereafter `wrap()` and `availability()` are pure.
 *
 * Linux backends require an async probe (`bwrap` / `landlock-cli`) that the
 * existing `ShellSandboxSlot` already encapsulates. To keep this per-call
 * port pure + fast on the bash hot-path we do NOT replicate that probe here:
 * linux callers get `supported:false` with a `linux-not-implemented-per-call`
 * reason, which the bash tool surfaces as fail-closed `sandbox_unavailable`.
 * That is the conservative posture (matches the user's stated rule:
 * "fallback으로 직렬 실행 안 함 (fail-closed)").
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

  // Pre-compute availability at construction time so `availability()` stays
  // sync (the bash tool calls it on the dispatch hot-path).
  const avail = computeAvailability(platform, sandboxExecPath)

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
      const policy =
        cfg.extraWritePaths !== undefined && cfg.extraWritePaths.length > 0
          ? { profile, extraWritePaths: cfg.extraWritePaths }
          : { profile }
      return wrapShellArgv(argv, cwd, policy, { platform, sandboxExecPath })
    },
    availability: () => avail,
  }
}

const computeAvailability = (
  platform: NodeJS.Platform,
  sandboxExecPath: string | null,
): PerCallSandboxAvailability => {
  if (platform === "darwin") {
    if (sandboxExecPath === null) {
      return { supported: false, reason: "sandbox-exec-missing" }
    }
    return { supported: true }
  }
  if (platform === "linux") {
    // Per-call port does not duplicate the async bwrap/landlock probe — keep
    // it conservative (fail-closed) so we never silently passthrough a
    // mode="read" call. The session-wide slot remains the path for linux
    // sandboxing today.
    return { supported: false, reason: "linux-not-implemented-per-call" }
  }
  return { supported: false, reason: `unsupported-platform:${platform}` }
}
