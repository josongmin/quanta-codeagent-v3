import type { SandboxProfile } from "./types"

const ACTIVE_PROFILES = [
  "read-only",
  "workspace-write",
  "workspace-write-net",
  "danger-full-access",
] as const

const ACTIVE_SET: ReadonlySet<string> = new Set<string>(ACTIVE_PROFILES)

/** Project `QUANTA_SANDBOX` onto the closed runtime profile enum without
 *  installing any global shell wrapper. Unknown values resolve to
 *  `undefined` so callers degrade conservatively. */
export const resolveSandboxProfileFromEnv = (
  env: NodeJS.ProcessEnv = process.env,
): SandboxProfile | undefined => {
  const raw = env.QUANTA_SANDBOX ?? "default"
  if (raw === "default" || raw === "") return undefined
  if (raw === "off") return "off"
  if (!ACTIVE_SET.has(raw)) return undefined
  return raw as SandboxProfile
}
