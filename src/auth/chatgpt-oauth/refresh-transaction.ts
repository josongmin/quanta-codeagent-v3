/**
 * Cross-process ChatGPT token refresh transaction.
 *
 * acquire → re-read → refresh only if still expired → persist → release.
 * In-process single-flight stays in {@link RefreshCoordinator}.
 */

import { createHash } from "node:crypto"
import type { OAuthRefreshLockPort } from "../oauth-refresh-lock"
import { isExpired, type TokenRecord } from "./token-store"

export interface RefreshTransactionDeps {
  readonly lock: OAuthRefreshLockPort
  readonly readCurrent: () => Promise<TokenRecord | null>
  readonly persist: (next: TokenRecord) => Promise<void>
  readonly refresh: (current: TokenRecord) => Promise<TokenRecord>
  readonly nowMs: () => number
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>
  readonly holderId: string
  readonly signal?: AbortSignal
  readonly ttlMs?: number
  readonly skewMs?: number
  readonly maxAttempts?: number
}

const DEFAULT_TTL_MS = 30_000
const DEFAULT_SKEW_MS = 60_000
const DEFAULT_ATTEMPTS = 8

export const hashRefreshLockKey = (raw: string): string =>
  createHash("sha256").update(raw).digest("hex").slice(0, 32)

const sleepClosed = async (ms: number, signal?: AbortSignal): Promise<void> => {
  if (signal?.aborted) throw new Error("refresh transaction aborted")
  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(resolve, ms)
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new Error("refresh transaction aborted"))
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

export const refreshTokenTransaction = async (
  key: string,
  deps: RefreshTransactionDeps,
): Promise<TokenRecord> => {
  const ttlMs = deps.ttlMs ?? DEFAULT_TTL_MS
  const skewMs = deps.skewMs ?? DEFAULT_SKEW_MS
  const maxAttempts = deps.maxAttempts ?? DEFAULT_ATTEMPTS
  const sleep = deps.sleep ?? sleepClosed
  const lockKey = hashRefreshLockKey(key)
  let acquired = false
  try {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (deps.signal?.aborted) throw new Error("refresh transaction aborted")
      const result = await deps.lock.tryAcquire(lockKey, deps.holderId, ttlMs)
      if (result === "acquired") {
        acquired = true
        break
      }
      await sleep(25 * (attempt + 1), deps.signal)
    }
    if (!acquired) {
      throw new Error("refresh transaction: lock acquire timed out")
    }
    const current = await deps.readCurrent()
    if (current === null) {
      throw new Error("refresh transaction: token missing after lock")
    }
    if (!isExpired(current, deps.nowMs(), skewMs)) {
      return current
    }
    const next = await deps.refresh(current)
    await deps.persist(next)
    return next
  } finally {
    if (acquired) {
      await deps.lock.release(lockKey, deps.holderId)
    }
  }
}
