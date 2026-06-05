/** jun-06 — `TokenRecord` ↔ string codec for the keyring secret payload.
 *
 *  The keyring stores ONE opaque string per `(service, account)`; we serialize
 *  the connectors `TokenRecord` to JSON and parse it back. `parseRecord` is
 *  TOTAL — a corrupt / non-conforming blob (a keyring entry mangled by another
 *  tool) resolves `undefined` rather than throwing, so a read degrades to
 *  "secret absent" → re-login, never a crash.
 */

import type { TokenRecord } from "@/connectors"

export const serializeRecord = (record: TokenRecord): string => JSON.stringify(record)

/** Parse a keyring blob into a `TokenRecord`, or `undefined` when the blob is
 *  absent / malformed / missing the required string fields. NO-THROW. */
export const parseRecord = (blob: string | undefined): TokenRecord | undefined => {
  if (blob === undefined || blob.length === 0) return undefined
  let parsed: unknown
  try {
    parsed = JSON.parse(blob)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object") return undefined
  const o = parsed as Record<string, unknown>
  if (typeof o.accessToken !== "string" || o.accessToken.length === 0) return undefined
  if (typeof o.tokenType !== "string" || o.tokenType.length === 0) return undefined
  return {
    accessToken: o.accessToken,
    tokenType: o.tokenType,
    ...(typeof o.refreshToken === "string" ? { refreshToken: o.refreshToken } : {}),
    ...(typeof o.expiresAt === "number" ? { expiresAt: o.expiresAt } : {}),
  }
}
