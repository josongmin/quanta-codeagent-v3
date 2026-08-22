/**
 * ★ CONTRACT — ADR-0163 §oauth-refresh-lock:
 *   - LockResult union mirrors Cursor telemetry verbatim (acquired / would-wait
 *     / would-acquire / redis-error).
 *   - InMemoryLock: per-process Map; same-holder re-acquire RENEWS; different
 *     holder → would-wait; TTL-elapsed → reaped at next tryAcquire (NEVER via
 *     setTimeout).
 *   - FileBasedLock: same semantics across processes; stale (mtime > TTL)
 *     overwritten; corrupt JSON treated as stale; wrong-holder release no-op.
 *   - RedisLockStub: ALWAYS returns redis-error in Phase 1; release no-op.
 *   - FallbackLock: chains ports, returns first non-error; broadcasts release.
 *   - Negative invariants: ttlMs<=0 throws; empty holderId throws; no
 *     setTimeout reapers in any impl.
 */
import { describe, expect, test } from "bun:test"
import { FileBasedLock, type LockFileStorePort } from "@/auth/lock-file-based"
import { InMemoryLock } from "@/auth/lock-in-memory"
import { FallbackLock, RedisLockStub } from "@/auth/lock-redis-stub"
import type { OAuthRefreshLockPort } from "@/auth/oauth-refresh-lock"
import type { ClockPort } from "@/llm/oidc-federation"

const mkClock = (start: number): { clock: ClockPort; advance: (ms: number) => void } => {
  let t = start
  return {
    clock: { now: () => t },
    advance: (ms: number) => {
      t += ms
    },
  }
}

const mkInMemoryStore = (): LockFileStorePort => {
  const map = new Map<string, string>()
  return {
    read: async (key) => map.get(key) ?? null,
    write: async (key, content, mode) => {
      if (mode === "exclusive" && map.has(key)) return "exists"
      map.set(key, content)
      return "ok"
    },
    delete: async (key) => {
      map.delete(key)
    },
  }
}

describe("InMemoryLock — hellgate", () => {
  test("HELL-L1: tryAcquire returns 'acquired' on first call", async () => {
    const { clock } = mkClock(1000)
    const lock = new InMemoryLock(clock)
    expect(await lock.tryAcquire("k1", "holder-A", 60_000)).toBe("acquired")
  })

  test("HELL-L2: second holder gets 'would-wait' while first holds", async () => {
    const { clock } = mkClock(1000)
    const lock = new InMemoryLock(clock)
    await lock.tryAcquire("k1", "holder-A", 60_000)
    expect(await lock.tryAcquire("k1", "holder-B", 60_000)).toBe("would-wait")
  })

  test("HELL-L3: same holder re-acquire RENEWS (re-entrant)", async () => {
    const { clock, advance } = mkClock(1000)
    const lock = new InMemoryLock(clock)
    await lock.tryAcquire("k1", "holder-A", 1000)
    advance(500)
    expect(await lock.tryAcquire("k1", "holder-A", 5000)).toBe("acquired")
    // After renew, second holder still waits.
    advance(2000) // would have been past original TTL
    expect(await lock.tryAcquire("k1", "holder-B", 1000)).toBe("would-wait")
  })

  test("HELL-L4: TTL expiry → next tryAcquire by different holder succeeds", async () => {
    const { clock, advance } = mkClock(1000)
    const lock = new InMemoryLock(clock)
    await lock.tryAcquire("k1", "holder-A", 1000)
    advance(1001) // past TTL
    expect(await lock.tryAcquire("k1", "holder-B", 1000)).toBe("acquired")
  })

  test("HELL-L5: release frees the lock", async () => {
    const { clock } = mkClock(1000)
    const lock = new InMemoryLock(clock)
    await lock.tryAcquire("k1", "holder-A", 60_000)
    await lock.release("k1", "holder-A")
    expect(await lock.tryAcquire("k1", "holder-B", 60_000)).toBe("acquired")
  })

  test("HELL-L6: release with wrong holder is a no-op (does NOT free)", async () => {
    const { clock } = mkClock(1000)
    const lock = new InMemoryLock(clock)
    await lock.tryAcquire("k1", "holder-A", 60_000)
    await lock.release("k1", "holder-B") // wrong holder
    expect(await lock.tryAcquire("k1", "holder-C", 60_000)).toBe("would-wait")
  })

  test("HELL-L7: release on unknown key is idempotent (no throw)", async () => {
    const { clock } = mkClock(1000)
    const lock = new InMemoryLock(clock)
    await expect(lock.release("never-acquired", "holder-A")).resolves.toBeUndefined()
  })

  test("HELL-L8: ttlMs <= 0 throws (no silent default)", async () => {
    const { clock } = mkClock(1000)
    const lock = new InMemoryLock(clock)
    await expect(lock.tryAcquire("k", "h", 0)).rejects.toThrow(/ttlMs/)
    await expect(lock.tryAcquire("k", "h", -1)).rejects.toThrow(/ttlMs/)
  })

  test("HELL-L9: empty holderId throws (programmer bug)", async () => {
    const { clock } = mkClock(1000)
    const lock = new InMemoryLock(clock)
    await expect(lock.tryAcquire("k", "", 1000)).rejects.toThrow(/holderId/)
  })

  test("HELL-L10: 5-holder concurrent storm — exactly ONE acquires", async () => {
    const { clock } = mkClock(1000)
    const lock = new InMemoryLock(clock)
    const holders = ["h1", "h2", "h3", "h4", "h5"]
    const results = await Promise.all(holders.map((h) => lock.tryAcquire("k", h, 60_000)))
    const acquired = results.filter((r) => r === "acquired").length
    const waited = results.filter((r) => r === "would-wait").length
    expect(acquired).toBe(1)
    expect(waited).toBe(4)
  })

  test("HELL-L11: clock skew (backwards) — TTL still respected (no time travel)", async () => {
    const { clock, advance } = mkClock(10_000)
    const lock = new InMemoryLock(clock)
    await lock.tryAcquire("k", "h1", 5000)
    advance(-3000) // clock goes backwards (NTP correction)
    // expiresAt = 15_000; now = 7000 → still live (expiresAt > now)
    expect(await lock.tryAcquire("k", "h2", 1000)).toBe("would-wait")
  })
})

describe("FileBasedLock — hellgate", () => {
  test("HELL-F1: cross-process simulation — two instances same store", async () => {
    const store = mkInMemoryStore()
    const { clock } = mkClock(1000)
    const lockA = new FileBasedLock({ store, clock, pid: 100 })
    const lockB = new FileBasedLock({ store, clock, pid: 200 })
    expect(await lockA.tryAcquire("k", "holder-A", 60_000)).toBe("acquired")
    expect(await lockB.tryAcquire("k", "holder-B", 60_000)).toBe("would-wait")
  })

  test("HELL-F2: stale lock (TTL elapsed) overwritten", async () => {
    const store = mkInMemoryStore()
    const { clock, advance } = mkClock(1000)
    const lock = new FileBasedLock({ store, clock, pid: 100 })
    await lock.tryAcquire("k", "holder-A", 1000)
    advance(2000) // stale
    expect(await lock.tryAcquire("k", "holder-B", 60_000)).toBe("acquired")
  })

  test("HELL-F3: corrupt JSON treated as released", async () => {
    const store = mkInMemoryStore()
    await store.write("k", "this is not json {{{", "overwrite")
    const { clock } = mkClock(1000)
    const lock = new FileBasedLock({ store, clock, pid: 100 })
    expect(await lock.tryAcquire("k", "holder-A", 60_000)).toBe("acquired")
  })

  test("HELL-F4: release frees the file", async () => {
    const store = mkInMemoryStore()
    const { clock } = mkClock(1000)
    const lock = new FileBasedLock({ store, clock, pid: 100 })
    await lock.tryAcquire("k", "holder-A", 60_000)
    await lock.release("k", "holder-A")
    expect(await store.read("k")).toBeNull()
  })

  test("HELL-F5: release wrong holder no-op", async () => {
    const store = mkInMemoryStore()
    const { clock } = mkClock(1000)
    const lock = new FileBasedLock({ store, clock, pid: 100 })
    await lock.tryAcquire("k", "holder-A", 60_000)
    await lock.release("k", "holder-B")
    expect(await store.read("k")).not.toBeNull()
  })

  test("HELL-F6: empty key throws", async () => {
    const store = mkInMemoryStore()
    const { clock } = mkClock(1000)
    const lock = new FileBasedLock({ store, clock, pid: 100 })
    await expect(lock.tryAcquire("", "h", 1000)).rejects.toThrow(/key/)
  })

  test("HELL-F7: same holder re-acquires (renews)", async () => {
    const store = mkInMemoryStore()
    const { clock, advance } = mkClock(1000)
    const lock = new FileBasedLock({ store, clock, pid: 100 })
    await lock.tryAcquire("k", "holder-A", 1000)
    advance(500)
    expect(await lock.tryAcquire("k", "holder-A", 5000)).toBe("acquired")
    advance(2000) // past original TTL
    // Should still be live (renewed)
    const otherLock = new FileBasedLock({ store, clock, pid: 200 })
    expect(await otherLock.tryAcquire("k", "holder-B", 1000)).toBe("would-wait")
  })

  test("HELL-F8: ttlMs<=0 throws", async () => {
    const store = mkInMemoryStore()
    const { clock } = mkClock(1000)
    const lock = new FileBasedLock({ store, clock, pid: 100 })
    await expect(lock.tryAcquire("k", "h", 0)).rejects.toThrow(/ttlMs/)
  })
})

describe("RedisLockStub — hellgate", () => {
  test("HELL-R1: tryAcquire ALWAYS returns redis-error in Phase 1", async () => {
    const lock = new RedisLockStub()
    expect(await lock.tryAcquire("k", "h", 1000)).toBe("redis-error")
    expect(await lock.tryAcquire("k", "h", 5000)).toBe("redis-error")
  })

  test("HELL-R2: onAcquireAttempt callback fires every call", async () => {
    const calls: { key: string; holderId: string; ttlMs: number }[] = []
    const lock = new RedisLockStub({
      onAcquireAttempt: (key, holderId, ttlMs) => calls.push({ key, holderId, ttlMs }),
    })
    await lock.tryAcquire("k1", "h1", 1000)
    await lock.tryAcquire("k2", "h2", 5000)
    expect(calls).toHaveLength(2)
    expect(calls[0]?.key).toBe("k1")
    expect(calls[1]?.ttlMs).toBe(5000)
  })

  test("HELL-R3: release is no-op (no throw)", async () => {
    const lock = new RedisLockStub()
    await expect(lock.release("k", "h")).resolves.toBeUndefined()
  })

  test("HELL-R4: onReleaseAttempt callback fires every release", async () => {
    const calls: { key: string; holderId: string }[] = []
    const lock = new RedisLockStub({
      onReleaseAttempt: (key, holderId) => calls.push({ key, holderId }),
    })
    await lock.release("k1", "h1")
    expect(calls).toHaveLength(1)
  })

  test("HELL-R5: ttlMs<=0 throws", async () => {
    const lock = new RedisLockStub()
    await expect(lock.tryAcquire("k", "h", 0)).rejects.toThrow(/ttlMs/)
  })
})

describe("FallbackLock — hellgate", () => {
  test("HELL-FB1: empty ports list throws at construction", () => {
    expect(() => new FallbackLock([])).toThrow(/at least one port/)
  })

  test("HELL-FB2: redis stub fails → file lock acquires", async () => {
    const redis = new RedisLockStub()
    const { clock } = mkClock(1000)
    const file = new FileBasedLock({ store: mkInMemoryStore(), clock, pid: 100 })
    const chain = new FallbackLock([redis, file])
    expect(await chain.tryAcquire("k", "h", 1000)).toBe("acquired")
  })

  test("HELL-FB3: full chain (redis → file → memory) — memory acquires when both upstream fail", async () => {
    const redis = new RedisLockStub()
    const failingStore: LockFileStorePort = {
      read: async () => {
        throw new Error("disk full")
      },
      write: async () => "ok",
      delete: async () => {},
    }
    const { clock } = mkClock(1000)
    // FileLock with failing store — its read throws, which propagates. We
    // wrap in a port that converts throw → redis-error to keep the fallback
    // contract clean.
    const wrappedFile: OAuthRefreshLockPort = {
      tryAcquire: async (k, h, ttl) => {
        try {
          await failingStore.read(k)
          return new FileBasedLock({ store: failingStore, clock, pid: 100 }).tryAcquire(k, h, ttl)
        } catch {
          return "redis-error"
        }
      },
      release: async () => {},
    }
    const memory = new InMemoryLock(clock)
    const chain = new FallbackLock([redis, wrappedFile, memory])
    expect(await chain.tryAcquire("k", "h", 1000)).toBe("acquired")
  })

  test("HELL-FB4: would-wait propagates (NOT redis-error)", async () => {
    const { clock } = mkClock(1000)
    const memory = new InMemoryLock(clock)
    await memory.tryAcquire("k", "h-other", 60_000)
    const chain = new FallbackLock([memory])
    expect(await chain.tryAcquire("k", "h-new", 1000)).toBe("would-wait")
  })

  test("HELL-FB5: release broadcasts to ALL ports", async () => {
    const releases: string[] = []
    const mkPort = (id: string): OAuthRefreshLockPort => ({
      tryAcquire: async () => "redis-error",
      release: async () => {
        releases.push(id)
      },
    })
    const chain = new FallbackLock([mkPort("a"), mkPort("b"), mkPort("c")])
    await chain.release("k", "h")
    expect(releases).toEqual(["a", "b", "c"])
  })

  test("HELL-FB6: all-redis-error chain returns redis-error", async () => {
    const chain = new FallbackLock([new RedisLockStub(), new RedisLockStub()])
    expect(await chain.tryAcquire("k", "h", 1000)).toBe("redis-error")
  })
})
