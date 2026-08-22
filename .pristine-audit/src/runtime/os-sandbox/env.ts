import { gateOn } from "@/shared/env-flag"
import type { SandboxProfile } from "./types"

const ACTIVE_PROFILES = [
  "read-only",
  "workspace-write",
  "workspace-write-net",
  "danger-full-access",
] as const

const ACTIVE_SET: ReadonlySet<string> = new Set<string>(ACTIVE_PROFILES)

/** Profile the sandbox flips to when `QUANTA_SANDBOX_DEFAULT` is ON and the
 *  operator left `QUANTA_SANDBOX` unset / `"default"`. Mirrors Codex's
 *  default-ON `workspace-write` posture (a real Seatbelt/Landlock/bwrap parity
 *  profile already exists for this arm). SINGLE source — both the env→profile
 *  projection here and the CLI slot builder consume it so the flip is uniform. */
export const SANDBOX_DEFAULT_FLIP_PROFILE: SandboxProfile = "workspace-write"

/** GATED default-flip (REPORT-jun26 §4 fix-2). When `QUANTA_SANDBOX_DEFAULT`
 *  is truthy (lenient `gateOn`), an UNSET / `"default"` `QUANTA_SANDBOX`
 *  resolves to {@link SANDBOX_DEFAULT_FLIP_PROFILE} instead of passthrough.
 *  Knob-OFF ⇒ byte-identical to the legacy passthrough (returns `false`); the
 *  flip is reversible (`QUANTA_SANDBOX=off` always wins) and measurable
 *  (a preset can set the knob for an A/B). */
const sandboxDefaultFlipOn = (env: NodeJS.ProcessEnv): boolean =>
  gateOn(env, "QUANTA_SANDBOX_DEFAULT")

/** Project `QUANTA_SANDBOX` onto the closed runtime profile enum without
 *  installing any global shell wrapper. Unknown values resolve to
 *  `undefined` so callers degrade conservatively.
 *
 *  Default-flip: when the operator left the profile UNSET / `"default"` AND
 *  `QUANTA_SANDBOX_DEFAULT` is ON, the resolved profile is the flip default
 *  (`workspace-write`). Explicit `"off"` and explicit profiles are NEVER
 *  affected by the knob. */
export const resolveSandboxProfileFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): SandboxProfile | undefined => {
  const raw = env.QUANTA_SANDBOX ?? "default"
  if (raw === "default" || raw === "") {
    return sandboxDefaultFlipOn(env) ? SANDBOX_DEFAULT_FLIP_PROFILE : undefined
  }
  if (raw === "off") return "off"
  if (!ACTIVE_SET.has(raw)) return undefined
  return raw as SandboxProfile
}
