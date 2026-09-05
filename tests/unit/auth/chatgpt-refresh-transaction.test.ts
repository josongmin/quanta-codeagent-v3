import { describe, expect, test } from "bun:test"
import type { TokenRecord } from "@/auth/chatgpt-oauth"
import {
  hashRefreshLockKey,
  refreshTokenTransaction,
} from "@/auth/chatgpt-oauth/refresh-transaction"
import { FileBasedLock, type LockFileStorePort } from "@/auth/lock-file-based"
import type { OAuthRefreshLockPort } from "@/auth/oauth-refresh-lock"

const expired: TokenRecord = {
  access_token: "old-access",
  refresh_token: "old-refresh-secret-bytes",
  expires_at: new Date(0).toISOString(),
}

const winner: TokenRecord = {
  access_token: "new-access",
  refresh_token: "new-refresh",
  expires_at: new Date(Date.now() + 3_600_000).toISOString(),
}

const memoryStore = (): LockFileStorePort => {
  const files = new Map<string, string>()
  return {
    read: async (key) => files.get(key) ?? null,
    write: async (key, content, mode) => {
      if (mode === "exclusive" && files.has(key)) return "exists"
      files.set(key, content)
      return "ok"
    },
    delete: async (key) => {
      files.delete(key)
    },
  }
}

describe("chatgpt refresh transaction", () => {
  test("two independent holders share one lock store → issuer count 1", async () => {
    const store = memoryStore()
    const clock = { now: () => Date.now() }
    const lockA = new FileBasedLock({ store, clock, pid: 1 })
    const lockB = new FileBasedLock({ store, clock, pid: 2 })
    let disk: TokenRecord = expired
    let issuer = 0
    const run = (lock: OAuthRefreshLockPort, holderId: string) =>
      refreshTokenTransaction("token-path", {
        lock,
        holderId,
        nowMs: () => Date.now(),
        sleep: (ms) => Bun.sleep(ms),
        maxAttempts: 20,
        readCurrent: async () => disk,
        persist: async (next) => {
          disk = next
        },
        refresh: async () => {
          issuer++
          await Bun.sleep(20)
          return winner
        },
      })
    const [a, b] = await Promise.all([run(lockA, "h1"), run(lockB, "h2")])
    expect(issuer).toBe(1)
    expect(a).toEqual(winner)
    expect(b).toEqual(winner)
    expect(hashRefreshLockKey("old-refresh-secret-bytes")).not.toContain("old-refresh")
  })

  test("mutation A: skip re-read → issuer count 2", async () => {
    const store = memoryStore()
    const clock = { now: () => Date.now() }
    const lockA = new FileBasedLock({ store, clock, pid: 1 })
    const lockB = new FileBasedLock({ store, clock, pid: 2 })
    let issuer = 0
    const broken = (lock: OAuthRefreshLockPort, holderId: string) =>
      refreshTokenTransaction("k", {
        lock,
        holderId,
        nowMs: () => Date.now(),
        sleep: (ms) => Bun.sleep(ms),
        maxAttempts: 8,
        readCurrent: async () => expired,
        persist: async () => undefined,
        refresh: async () => {
          issuer++
          return winner
        },
      })
    await Promise.all([broken(lockA, "h1"), broken(lockB, "h2")])
    expect(issuer).toBe(2)
  })

  test("would-wait is not success: acquire timeout fails closed", async () => {
    const lock: OAuthRefreshLockPort = {
      tryAcquire: async () => "would-wait",
      release: async () => undefined,
    }
    await expect(
      refreshTokenTransaction("k", {
        lock,
        holderId: "h",
        nowMs: () => Date.now(),
        sleep: async () => undefined,
        maxAttempts: 2,
        readCurrent: async () => expired,
        persist: async () => undefined,
        refresh: async () => winner,
      }),
    ).rejects.toThrow(/timed out/)
  })
})
