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
import {
  getDefaultPermissionStore,
  type HostAgentMode,
  type PermissionStore,
} from "./permission-store"

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

export const getHostMode = (
  hostId: string,
  store: PermissionStore = getDefaultPermissionStore(),
): HostAgentMode | undefined => store.getHost(hostId)

export const setHostMode = (
  hostId: string,
  mode: HostAgentMode,
  store: PermissionStore = getDefaultPermissionStore(),
): void => {
  store.setHost(hostId, mode)
}

export const clearHostMode = (
  hostId: string,
  store: PermissionStore = getDefaultPermissionStore(),
): void => {
  store.clearHost(hostId)
}

/** Decide whether the host-mode default permits a mutating action.
 *
 *   - `full-access` → true
 *   - `read-only`   → false
 *   - `custom`      → true (the "custom" sentinel means the host has a
 *                    bespoke policy defined elsewhere — defer to the
 *                    global default rather than block here).
 *
 *  Returns `undefined` when the caller did not pin a mode for this host;
 *  the precedence chain then falls through to the global default. */
export const hostAllowsMutation = (mode: HostAgentMode | undefined): boolean | undefined => {
  if (mode === undefined) return undefined
  switch (mode) {
    case "full-access":
      return true
    case "read-only":
      return false
    case "custom":
      return true
    default: {
      const _exhaustive: never = mode
      throw new Error(`unhandled HostAgentMode: ${String(_exhaustive)}`)
    }
  }
}
