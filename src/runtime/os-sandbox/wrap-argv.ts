import { compileSeatbeltProfile } from "./seatbelt"
import type { SandboxPolicy } from "./types"

/**
 * Result of {@link wrapShellArgv}: an argv array suitable to hand to
 * `Bun.spawn` / `child_process.spawn` PLUS metadata about whether the sandbox
 * was actually applied (vs degraded to pass-through).
 *
 * `argv` is ALWAYS a complete spawnable argv. Callers swap their original
 * `["bash", "-lc", cmd]` for `result.argv` without further branching.
 *
 * `degradeReason` is present when the requested sandbox could not be fully
 * enforced. That includes full passthrough degradation
 * (`sandboxApplied === false`) and partial-enforcement cases where a wrapper
 * still ran but a capability gap remained. Stable opaque tags ONLY — never
 * echo a Seatbelt profile body or libsandbox internals to the operator
 * (anti-leak invariant).
 */
export interface WrappedShellArgv {
  readonly argv: string[]
  readonly sandboxApplied: boolean
  readonly degradeReason?: string
}

/**
 * Configuration for {@link wrapShellArgv}. All fields optional — production
 * uses the defaults; tests inject `platform` + `sandboxExecPath` to drive the
 * branches without touching the filesystem.
 */
export interface WrapShellArgvConfig {
  /** Platform override. Default `process.platform`. */
  readonly platform?: NodeJS.Platform
  /** Absolute path to `sandbox-exec`. Default `/usr/bin/sandbox-exec`. macOS
   *  ships this at a fixed path; we do NOT probe `which` per-spawn because
   *  per-call I/O would defeat the byte-identical-fast-path guarantee. Tests
   *  pass `null` to simulate sandbox-exec missing. */
  readonly sandboxExecPath?: string | null
}

/** Default location of `sandbox-exec` on macOS — fixed path, no per-spawn
 *  `which` probe. The CLI surface verifies presence ONCE at startup and
 *  surfaces a warning + falls back to passthrough when missing (sandbox-wire
 *  responsibility). */
export const DEFAULT_SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec"

/**
 * Wrap a `["bash", "-lc", command]`-style argv with the OS-native sandbox
 * preamble dictated by `policy` + `platform`.
 *
 *  - `policy.profile === "off"` ⇒ passthrough verbatim (sandboxApplied=false,
 *    no degradeReason — caller explicitly asked for no sandbox).
 *  - `policy.profile === "danger-full-access"` ⇒ same: explicit opt-out.
 *  - macOS (`platform === "darwin"`) + non-opt-out profile ⇒ prepend
 *    `[sandboxExecPath, "-p", <SBPL>]`.
 *  - Linux ⇒ degraded passthrough with `degradeReason:"landlock-not-implemented"`.
 *  - Other platforms ⇒ degraded passthrough with `unsupported-platform:<plat>`.
 *
 * Pure: no I/O, no mutation of `argv`. Returns a fresh argv array.
 */
export const wrapShellArgv = (
  argv: ReadonlyArray<string>,
  cwd: string,
  policy: SandboxPolicy,
  config: WrapShellArgvConfig = {},
): WrappedShellArgv => {
  const platform: NodeJS.Platform = config.platform ?? process.platform
  const sandboxExecPath: string | null =
    config.sandboxExecPath === undefined ? DEFAULT_SANDBOX_EXEC_PATH : config.sandboxExecPath

  // Explicit opt-out arms — verbatim passthrough, NO degradeReason (caller
  // asked for no sandbox; degradation is only meaningful when sandbox was
  // requested but couldn't be applied).
  if (policy.profile === "off" || policy.profile === "danger-full-access") {
    return { argv: [...argv], sandboxApplied: false }
  }

  if (platform === "darwin") {
    if (sandboxExecPath === null) {
      return {
        argv: [...argv],
        sandboxApplied: false,
        degradeReason: "sandbox-exec-missing",
      }
    }
    const profile = compileSeatbeltProfile(policy, cwd)
    if (profile === null) {
      // Defensive — the off/danger short-circuit above should make this
      // unreachable, but the null branch is part of the typed contract.
      return {
        argv: [...argv],
        sandboxApplied: false,
        degradeReason: "profile-uncompilable",
      }
    }
    return {
      argv: [sandboxExecPath, "-p", profile, ...argv],
      sandboxApplied: true,
    }
  }

  if (platform === "linux") {
    return {
      argv: [...argv],
      sandboxApplied: false,
      degradeReason: "landlock-not-implemented",
    }
  }

  return {
    argv: [...argv],
    sandboxApplied: false,
    degradeReason: `unsupported-platform:${platform}`,
  }
}
