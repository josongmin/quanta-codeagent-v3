import { describe, expect, test } from "bun:test"
import type { TokenRecord } from "@/auth/chatgpt-oauth"
import {
  createRefreshHolderId,
  hashRefreshLockKey,
  refreshTokenTransaction,
  sleepRefreshBackoff,
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
    writeExclusive: async (key, content) => {
      if (files.has(key)) return "exists"
      files.set(key, content)
      return "ok"
    },
    compareAndSwap: async (key, expected, next) => {
      if (files.get(key) !== expected) return "changed"
      if (next === null) files.delete(key)
      else files.set(key, next)
      return "ok"
    },
  }
}

describe("chatgpt refresh transaction", () => {
  test("backoff does not lose an abort during listener registration", async () => {
    let aborted = false
    const signal = {
      get aborted() {
        return aborted
      },
      addEventListener: (
        _type: string,
        listener: ((event: unknown) => void) | { handleEvent(event: unknown): void },
      ) => {
        aborted = true
        if (typeof listener === "function") listener(undefined)
        else listener.handleEvent(undefined)
      },
      removeEventListener: () => undefined,
    } as unknown as AbortSignal

    await expect(sleepRefreshBackoff(60_000, signal)).rejects.toThrow(/aborted/)
  })

  test("backoff removes the abort listener after elapsed completion", async () => {
    let registered = 0
    let removed = 0
    const signal = {
      aborted: false,
      addEventListener: () => {
        registered++
      },
      removeEventListener: () => {
        removed++
      },
    } as unknown as AbortSignal

    await sleepRefreshBackoff(0, signal)
    expect(registered).toBe(1)
    expect(removed).toBe(1)
  })

  test("holder ids stay unique for the same pid and millisecond", () => {
    const ids = Array.from({ length: 100 }, () => createRefreshHolderId("test", 7, 1234))
    expect(new Set(ids).size).toBe(ids.length)
  })

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
