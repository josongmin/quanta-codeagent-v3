/**
 * Per-host agent mode (ADR-0046).
 *
 * Codex stores a `agent-mode-by-host-id` mapping so a remote SSH host can be
 * pinned to read-only while localhost stays full-access. quanta-v3 mirrors
 * the convention.
 *
 * Host-id resolution (deterministic, no DNS lookups):
 *   - explicit `hostId` argument wins (CLI/test ergonomics)
 *   - `SSH_CONNECTION` env var present ⇒ `${USER}@${hostname}` (remote SSH)
 *   - else `localhost`
 *
 * The resolver lives in this module rather than `permission-store.ts` so
 * the store stays free of env-var probes (testable in isolation).
 */

import { hostname, userInfo } from "node:os"
import { runtimeConfig } from "@/shared/runtime-config"
import type { HostAgentMode, PermissionStore } from "./permission-store"

export type { HostAgentMode } from "./permission-store"

/** Override hook for `resolveHostId`. Tests pass an explicit shape; production
 *  callers leave it undefined and the function reads `sshConnection` from
 *  `runtimeConfig()` (the single legitimate env owner). */
export interface ResolveHostIdEnv {
  sshConnection?: string | undefined
  user?: string | undefined
  hostname?: string | undefined
}

/** Compute the canonical host-id for the CURRENT process. Pure function of
 *  env + os state — no IO. Tests inject a custom shape to drive both
 *  branches without mutating the process env. */
export const resolveHostId = (env?: ResolveHostIdEnv): string => {
  const sshConn = env?.sshConnection ?? runtimeConfig().sshConnection
  if (typeof sshConn === "string" && sshConn.length > 0) {
    let user = env?.user
    if (user === undefined) {
      try {
        user = userInfo().username
      } catch {
        // userInfo can throw on locked-down systems; degrade gracefully.
        user = "unknown"
      }
    }
    let host = env?.hostname
    if (host === undefined) {
      try {
        host = hostname()
      } catch {
        host = "unknown"
      }
    }
    return `${user}@${host}`
  }
  return "localhost"
}

/** `store` is REQUIRED — the composition root injects (no service-locator
 *  fallback). */
export const getHostMode = (hostId: string, store: PermissionStore): HostAgentMode | undefined =>
  store.getHost(hostId)

/** `store` is REQUIRED. */
export const setHostMode = (hostId: string, mode: HostAgentMode, store: PermissionStore): void => {
  store.setHost(hostId, mode)
}

/** `store` is REQUIRED. */
export const clearHostMode = (hostId: string, store: PermissionStore): void => {
  store.clearHost(hostId)
}

/**
 * Typed host-mode mutation verdict (T08 — May-31 bugbash, audit L8 H5).
 *
 *   - `"allow"`   — the host is pinned `full-access`.
 *   - `"deny"`    — the host is pinned `read-only`.
 *   - `"defer"`   — the host is pinned `custom`: a bespoke policy that THIS
 *                   function cannot resolve. The caller MUST resolve it (load
 *                   the per-host custom policy) before acting — it is NOT an
 *                   implicit allow.
 *   - `"unpinned"`— the caller never pinned a mode for this host; the
 *                   precedence chain falls through to the global default.
 *
 * Replacing the prior `boolean | undefined` shape: the old code mapped
 * `custom` to `true` (allow), so a host an operator deliberately marked
 * "custom — restrict me later" silently became fully writable. `custom` is
 * now `defer` — fail-CLOSED until the bespoke policy is resolved.
 */
export type HostMutationVerdict = "allow" | "deny" | "defer" | "unpinned"

/** Decide whether the host-mode default permits a mutating action, as a typed
 *  verdict (see {@link HostMutationVerdict}). `custom` ⇒ `defer` (the caller
 *  must resolve the bespoke policy — never an implicit allow). `undefined`
 *  mode ⇒ `unpinned` (fall through to the global default). */
export const hostMutationVerdict = (mode: HostAgentMode | undefined): HostMutationVerdict => {
  if (mode === undefined) return "unpinned"
  switch (mode) {
    case "full-access":
      return "allow"
    case "read-only":
      return "deny"
    case "custom":
      return "defer"
    default: {
      const _exhaustive: never = mode
      throw new Error(`unhandled HostAgentMode: ${String(_exhaustive)}`)
    }
  }
}

/** Back-compat boolean adapter for existing callers that still expect the
 *  pre-T08 `boolean | undefined` shape. Maps the typed verdict to the legacy
 *  tri-state, but with the SECURITY-CORRECTED `custom` mapping: `custom` no
 *  longer returns `true` — it returns `undefined` (caller must resolve the
 *  bespoke policy / fall to the global default) so it is never an implicit
 *  allow. Prefer {@link hostMutationVerdict} in new code. */
export const hostAllowsMutation = (mode: HostAgentMode | undefined): boolean | undefined => {
  const verdict = hostMutationVerdict(mode)
  switch (verdict) {
    case "allow":
      return true
    case "deny":
      return false
    default:
      // `defer` (custom) and `unpinned` BOTH fall through to the caller's
      // global-default resolution — NOT an implicit allow.
      return undefined
  }
}
