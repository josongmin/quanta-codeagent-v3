import { existsSync } from "node:fs"
import {
  DEFAULT_SANDBOX_EXEC_PATH,
  installShellSandbox,
  type OsSandboxPolicy,
  type OsSandboxProfile,
  resolveSandboxProfileFromEnv as resolveSandboxProfileFromRuntimeEnv,
  type ShellSandboxSlot,
  type WrappedShellArgv,
  wrapShellArgv,
} from "@/runtime"
import {
  compileBubblewrapArgs,
  compileLandlockCliArgs,
  detectLinuxSandboxBackend,
  LANDLOCK_CLI_NETWORK_DEFERRED_MARKER,
  type LinuxSandboxBackend,
  SANDBOX_DEFAULT_FLIP_PROFILE,
} from "@/runtime/os-sandbox"
import { gateOn, logger } from "@/shared"

/**
 * Valid `QUANTA_SANDBOX` values that activate the OS-level sandbox. `default`,
 * `off`, and empty string keep the legacy byte-identical passthrough.
 *
 * NOTE: this mirrors the closed enum in `@/runtime/os-sandbox/types.ts`
 * (`SandboxProfile`). A new arm must be added in BOTH places — the typed
 * import of `SandboxPolicy` makes the producer side of that pact compile.
 */
const ACTIVE_PROFILES = [
  "read-only",
  "workspace-write",
  "workspace-write-net",
  "danger-full-access",
] as const
type ActiveProfile = (typeof ACTIVE_PROFILES)[number]
const ACTIVE_SET: ReadonlySet<string> = new Set<string>(ACTIVE_PROFILES)

interface CliSandboxDeps {
  readonly platform?: NodeJS.Platform
  readonly sandboxExecPath?: string | null
  readonly exists?: (path: string) => boolean
  readonly which?: (binary: string) => Promise<string | null>
}

/**
 * Resolve `QUANTA_SANDBOX` env to a {@link ShellSandboxSlot} or `undefined`
 * (passthrough). Build-time work stays side-effect-light: only the macOS
 * `/usr/bin/sandbox-exec` presence probe runs synchronously here; Linux
 * backend detection is deferred into the installed slot's async `wrap()`
 * path and cached there. NEVER throws — an unrecognised value logs a warning
 * and falls back to passthrough (operator should not lose their session over
 * a typo).
 *
 *  - unset / `"default"` / `"off"` / `""` ⇒ `undefined`
 *  - valid profile name ⇒ slot bound to that policy
 *  - unknown profile ⇒ warn + `undefined`
 *
 * When the wire-up reports a degradation (macOS `sandbox-exec` missing,
 * Linux backend unavailable / partially enforceable, unsupported platform),
 * the slot is still installed but its wrapper surfaces a typed degrade
 * reason — the warning surfaces via {@link installCliSandbox}'s startup
 * banner.
 */
export const buildCliOsSandbox = (
  env: NodeJS.ProcessEnv = process.env,
  deps: CliSandboxDeps = {},
): ShellSandboxSlot | undefined => {
  const raw = env.QUANTA_SANDBOX ?? "default"
  // GATED default-flip (REPORT-jun26 §4 fix-2): an UNSET / "default" profile
  // installs NOTHING by default (byte-identical passthrough). When
  // `QUANTA_SANDBOX_DEFAULT` is ON it instead resolves to the flip default
  // (`workspace-write`, Codex's posture) — every compiler/parity-fixture for
  // that arm already exists. Explicit "off" ALWAYS wins (reversible opt-out).
  let resolved = raw
  if (raw === "" || raw === "default") {
    if (!gateOn(env, "QUANTA_SANDBOX_DEFAULT")) return undefined
    resolved = SANDBOX_DEFAULT_FLIP_PROFILE
  }
  if (resolved === "off") return undefined
  if (!ACTIVE_SET.has(resolved)) {
    logger.warn(`QUANTA_SANDBOX="${resolved}" unrecognised — falling back to passthrough`)
    return undefined
  }

  const profile = resolved as ActiveProfile
  // §12.6 (jun-08 long-tail) — Codex `exclude_slash_tmp` parity. Default-OFF:
  // absent ⇒ `excludeTmpdir` omitted ⇒ the compiled Seatbelt profile keeps its
  // baseline `/tmp` read-allow (byte-identical). `QUANTA_SANDBOX_EXCLUDE_TMPDIR`
  // truthy ⇒ `/tmp` is dropped from the profile. Uses the lenient `gateOn` (a
  // hardening preference, not a security kill-switch) per the bool-vocab SSOT.
  const excludeTmpdir = gateOn(env, "QUANTA_SANDBOX_EXCLUDE_TMPDIR")
  const policy: OsSandboxPolicy = { profile, ...(excludeTmpdir ? { excludeTmpdir: true } : {}) }
  const platform: NodeJS.Platform = deps.platform ?? process.platform
  const pathExists = deps.exists ?? existsSync

  let sandboxExecPath: string | null =
    deps.sandboxExecPath === undefined ? DEFAULT_SANDBOX_EXEC_PATH : deps.sandboxExecPath
  if (
    platform === "darwin" &&
    sandboxExecPath === DEFAULT_SANDBOX_EXEC_PATH &&
    !pathExists(DEFAULT_SANDBOX_EXEC_PATH)
  ) {
    sandboxExecPath = null
  }
  const config = { platform, sandboxExecPath }

  let linuxBackendPromise: Promise<LinuxSandboxBackend | null> | undefined
  const detectLinuxBackend = (): Promise<LinuxSandboxBackend | null> => {
    if (linuxBackendPromise === undefined) {
      linuxBackendPromise =
        deps.which !== undefined
          ? detectLinuxSandboxBackend({ which: deps.which })
          : detectLinuxSandboxBackend()
    }
    return linuxBackendPromise
  }

  return {
    policy,
    config,
    wrap: async (argv, cwd) => {
      if (platform !== "linux") return wrapShellArgv(argv, cwd, policy, config)
      return wrapLinuxShellArgv(argv, cwd, policy, await detectLinuxBackend())
    },
  }
}

/**
 * Install the CLI-resolved sandbox slot into `@/runtime` AND surface a
 * one-line startup warning when the slot is degraded.
 *
 *  - returns the installed slot (`undefined` ⇒ passthrough mode)
 *  - on any degraded backend, logs a single `warn` line before the first
 *    command runs
 */
export const installCliSandbox = async (
  env: NodeJS.ProcessEnv = process.env,
  deps: CliSandboxDeps = {},
): Promise<ShellSandboxSlot | undefined> => {
  const slot = buildCliOsSandbox(env, deps)
  installShellSandbox(slot)
  if (slot !== undefined) {
    const probe = await slot.wrap(["bash", "-lc", ":"], process.cwd())
    if (probe.degradeReason !== undefined) {
      logger.warn(
        `QUANTA_SANDBOX=${slot.policy.profile} requested but degraded (${probe.degradeReason})`,
      )
    }
  }
  return slot
}

/**
 * ADR-0297 — env→profile projection for the `bash` HITL tier wire. Returns
 * the same closed-enum `OsSandboxProfile` that the CLI sandbox slot would
 * resolve from `QUANTA_SANDBOX`, WITHOUT installing anything globally. Used
 * by composition roots that build `buildDefaultTools({ sandboxProfile })`
 * — the bash tool factory closes over this value (instead of regex-matching
 * the command). Pure: same env → same result. Unknown values yield
 * `undefined` (conservative — degrades the bash tier to `always-confirm`).
 */
export const resolveSandboxProfileFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): OsSandboxProfile | undefined => resolveSandboxProfileFromRuntimeEnv(env)

const wrapLinuxShellArgv = (
  argv: ReadonlyArray<string>,
  cwd: string,
  policy: OsSandboxPolicy,
  backend: LinuxSandboxBackend | null,
): WrappedShellArgv => {
  if (backend === null) {
    return {
      argv: [...argv],
      sandboxApplied: false,
      degradeReason: "linux-bwrap-missing — install bubblewrap (apt/dnf/pacman)",
    }
  }

  if (backend === "bubblewrap") {
    const policyArgs = compileBubblewrapArgs(policy, cwd)
    if (policyArgs === null) return { argv: [...argv], sandboxApplied: false }
    return {
      argv: ["bwrap", ...policyArgs, "--", ...argv],
      sandboxApplied: true,
    }
  }

  const rawArgs = compileLandlockCliArgs(policy, cwd) ?? []
  const filteredArgs = rawArgs.filter((tok) => tok !== LANDLOCK_CLI_NETWORK_DEFERRED_MARKER)
  return {
    argv: ["landlock-cli", ...filteredArgs, "--", ...argv],
    sandboxApplied: true,
    ...(rawArgs.length !== filteredArgs.length
      ? { degradeReason: "landlock-network-policy-not-enforced" }
      : {}),
  }
}
