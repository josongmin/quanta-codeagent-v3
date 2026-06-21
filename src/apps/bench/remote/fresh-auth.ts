import { readFile } from "node:fs/promises"
import {
  type FetchLike,
  refreshToken,
  resolveOAuthConfig,
  type TokenRecord,
  writeToken,
} from "@/auth/chatgpt-oauth"

export interface RefreshRemoteAuthJsonOptions {
  readonly env?: Record<string, string | undefined>
  readonly fetchImpl?: FetchLike
  readonly nowMs?: () => number
}

/**
 * Full-remote boxes receive only a stripped short-lived access token and cannot
 * refresh it. Refresh locally before provisioning so a revoked/stale access
 * token fails before we pay the box bootstrap tax.
 */
export const refreshRemoteAuthJson = async (
  authFile: string,
  opts: RefreshRemoteAuthJsonOptions = {},
): Promise<string> => {
  const current = JSON.parse(await readFile(authFile, "utf8")) as TokenRecord
  const next = await refreshToken({
    cfg: resolveOAuthConfig(opts.env ?? process.env),
    current,
    ...(opts.fetchImpl !== undefined ? { fetchImpl: opts.fetchImpl } : {}),
    ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
  })
  await writeToken(authFile, next)
  return JSON.stringify(next)
}
