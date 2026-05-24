/**
 * Per-connector token rotation (ADR-0160 Phase E).
 *
 * Generalizes `src/auth/chatgpt-oauth/refresh.ts` invariant (in-flight mutex,
 * atomic write) across arbitrary connectors. Caller supplies a `refresh`
 * callback that returns a fresh `TokenRecord` (the callback owns the network
 * shape — RFC 6749 §6 refresh_token, PKCE, etc).
 *
 * Concurrency contract: concurrent `rotate(connectorId, refresh)` calls for
 * the SAME connectorId coalesce — only one callback fires. Different ids run
 * independently.
 */

import { type ClockPort, type TokenRecord, TokenRotationError, type TokenStorePort } from "./types"

export interface TokenRotatorConfig {
  readonly tokenStore: TokenStorePort
  readonly clockPort: ClockPort
}

export interface TokenRotator {
  /** Read current token (or `undefined` if not stored). */
  read(connectorId: string): Promise<TokenRecord | undefined>
  /** Rotate via caller-supplied refresh callback. Persists atomically. */
  rotate(
    connectorId: string,
    refresh: (current: TokenRecord | undefined) => Promise<TokenRecord>,
  ): Promise<TokenRecord>
  /** Delete the stored token (idempotent). */
  forget(connectorId: string): Promise<void>
  /** Cheap helper: is the token expired right now? `false` if no expiry set. */
  isExpired(record: TokenRecord): boolean
}

export const createTokenRotator = (config: TokenRotatorConfig): TokenRotator => {
  const inFlight = new Map<string, Promise<TokenRecord>>()

  const read = async (connectorId: string): Promise<TokenRecord | undefined> =>
    config.tokenStore.read(connectorId)

  const rotate = async (
    connectorId: string,
    refresh: (current: TokenRecord | undefined) => Promise<TokenRecord>,
  ): Promise<TokenRecord> => {
    const existing = inFlight.get(connectorId)
    if (existing !== undefined) return existing

    const p = (async (): Promise<TokenRecord> => {
      try {
        const current = await config.tokenStore.read(connectorId)
        let next: TokenRecord
        try {
          next = await refresh(current)
        } catch (e) {
          throw new TokenRotationError("refresh-callback-failed", "refresh callback threw", {
            cause: e,
          })
        }
        try {
          await config.tokenStore.write(connectorId, next)
        } catch (e) {
          throw new TokenRotationError(
            "store-write-failed",
            `token store write failed for ${connectorId}`,
            { cause: e },
          )
        }
        return next
      } finally {
        inFlight.delete(connectorId)
      }
    })()
    inFlight.set(connectorId, p)
    return p
  }

  const forget = async (connectorId: string): Promise<void> => config.tokenStore.delete(connectorId)

  const isExpired = (record: TokenRecord): boolean => {
    if (record.expiresAt === undefined) return false
    return config.clockPort.now() >= record.expiresAt
  }

  return { read, rotate, forget, isExpired }
}
