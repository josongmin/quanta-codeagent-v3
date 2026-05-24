import { existsSync } from "node:fs"
import {
  DEFAULT_SANDBOX_EXEC_PATH,
  installShellSandbox,
  type OsSandboxPolicy,
  type ShellSandboxSlot,
  wrapShellArgv,
} from "@/runtime"
import { logger } from "@/shared"

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

/**
 * Resolve `QUANTA_SANDBOX` env to a {@link ShellSandboxSlot} or `undefined`
 * (passthrough). Pure: no I/O except an `existsSync` probe for
 * `/usr/bin/sandbox-exec` on macOS. NEVER throws — an unrecognised value
 * logs a warning and falls back to passthrough (operator should not lose
 * their session over a typo).
 *
 *  - unset / `"default"` / `"off"` / `""` ⇒ `undefined`
 *  - valid profile name ⇒ slot bound to that policy
 *  - unknown profile ⇒ warn + `undefined`
 *
 *  When the wire-up reports a degradation (macOS `sandbox-exec` missing,
 *  Linux Landlock not implemented, unsupported platform), the slot is still
 *  installed but its wrapper falls back to passthrough — the warning surfaces
 *  via {@link installCliSandbox}'s startup banner.
 */
export const buildCliOsSandbox = (
  env: NodeJS.ProcessEnv = process.env,
): ShellSandboxSlot | undefined => {
  const raw = env.QUANTA_SANDBOX ?? "default"
  // Passthrough arms — byte-identical to pre-S1.
  if (raw === "" || raw === "default" || raw === "off") return undefined
  if (!ACTIVE_SET.has(raw)) {
    logger.warn(`QUANTA_SANDBOX="${raw}" unrecognised — falling back to passthrough`)
    return undefined
  }
  const profile = raw as ActiveProfile
  const policy: OsSandboxPolicy = { profile }

  // macOS startup probe: detect missing `/usr/bin/sandbox-exec` ONCE here so
  // `wrapShellArgv` doesn't probe per-spawn. When missing, the slot wraps to
  // passthrough + `degradeReason:"sandbox-exec-missing"` (every call) and the
  // startup warning makes the degradation visible to the operator.
  let sandboxExecPath: string | null = DEFAULT_SANDBOX_EXEC_PATH
  if (process.platform === "darwin" && !existsSync(DEFAULT_SANDBOX_EXEC_PATH)) {
    sandboxExecPath = null
  }
  const config = { sandboxExecPath }

  return {
    policy,
    config,
    wrap: (argv, cwd) => wrapShellArgv(argv, cwd, policy, config),
  }
}

/**
 * Install the CLI-resolved sandbox slot into `@/runtime` AND surface a
 * one-line startup warning when the slot is degraded (operator-visible
 * "your sandbox isn't actually firing" diagnostic).
 *
 *  - returns the installed slot (`undefined` ⇒ passthrough mode)
 *  - on degraded macOS or any linux/non-darwin platform, logs a single
 *    `warn` line so the operator notices BEFORE running the first command
 *
 * Pure boot helper — safe to call before the REPL boots / on the entrypoint
 * top-level. Tests can avoid the global side effect by calling
 * {@link buildCliOsSandbox} directly.
 */
export const installCliSandbox = (
  env: NodeJS.ProcessEnv = process.env,
): ShellSandboxSlot | undefined => {
  const slot = buildCliOsSandbox(env)
  installShellSandbox(slot)
  if (slot !== undefined) {
    // Probe the slot with a benign argv to detect degradation eagerly. The
    // probe is cheap (pure compile of the SBPL string) — we just look at the
    // metadata bits.
    const probe = slot.wrap(["bash", "-lc", ":"], process.cwd())
    if (!probe.sandboxApplied && probe.degradeReason !== undefined) {
      logger.warn(
        `QUANTA_SANDBOX=${slot.policy.profile} requested but degraded (${probe.degradeReason}) — running unsandboxed`,
      )
    }
  }
  return slot
}
