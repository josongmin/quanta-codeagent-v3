/**
 * ★ CONTRACT — single-box guard: same-host single-box mode must fail closed
 *   src pointer: src/apps/bench/remote/single-box-guard.ts:138
 *   Every assertion below is CONTRACT.
 */
import { afterAll, describe, expect, test } from "bun:test"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { HeartbeatScheduler } from "../../src/apps/bench/remote/lease-fs"
import { acquireSingleBoxGuard } from "../../src/apps/bench/remote/single-box-guard"

const TEMP_DIRS = new Set<string>()

const allocTempDir = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TEMP_DIRS.add(dir)
  return dir
}

const manualHeartbeatScheduler = (): HeartbeatScheduler & {
  readonly fire: () => Promise<void>
  readonly active: () => number
} => {
  let nextId = 0
  const tasks = new Map<number, () => Promise<void>>()
  return {
    schedule: (task) => {
      nextId += 1
      tasks.set(nextId, task)
      return nextId
    },
    cancel: (handle) => {
      if (typeof handle === "number") tasks.delete(handle)
    },
    fire: async () => {
      await Promise.all([...tasks.values()].map((task) => task()))
    },
    active: () => tasks.size,
  }
}

afterAll(() => {
  for (const dir of TEMP_DIRS) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("single-box guard hellgate", () => {
  test("a second claimant FAIL-CLOSES while the first guard is held", async () => {
    const root = allocTempDir("bench-single-box-guard-")
    const dir = join(root, "guard")
    const first = await acquireSingleBoxGuard({
      label: "first",
      dir,
    })
    try {
      await expect(
        acquireSingleBoxGuard({
          label: "second",
          dir,
        }),
      ).rejects.toThrow(/single-box|owner/i)
    } finally {
      await first.release()
    }
  })

  test("a guard release deletion failure ABORTS instead of silently succeeding", async () => {
    const root = allocTempDir("bench-single-box-release-")
    const dir = join(root, "guard")
    const guard = await acquireSingleBoxGuard({
      label: "release-failure",
      dir,
    })
    chmodSync(root, 0o555)
    try {
      await expect(guard.release()).rejects.toThrow(
        /EACCES|EPERM|permission|operation not permitted/i,
      )
    } finally {
      chmodSync(root, 0o755)
      await guard.release().catch(() => undefined)
    }
  })

  test("missing owner metadata FAIL-CLOSES instead of reclaiming a live guard by age alone", async () => {
    const root = allocTempDir("bench-single-box-metadata-")
    const dir = join(root, "guard")
    const ownerMeta = join(dir, "owner.json")
    const first = await acquireSingleBoxGuard({
      label: "first",
      dir,
      heartbeatMs: 60_000,
    })
    try {
      unlinkSync(ownerMeta)
      utimesSync(dir, new Date(0), new Date(0))
      await expect(
        acquireSingleBoxGuard({
          label: "second",
          dir,
          staleHeartbeatMs: 1_000,
          now: () => Date.now() + 60_000,
        }),
      ).rejects.toThrow(/single-box|owner/i)
    } finally {
      await first.release().catch(() => undefined)
    }
  })

  test("malformed owner metadata FAIL-CLOSES instead of reclaiming a live guard by dir age alone", async () => {
    const root = allocTempDir("bench-single-box-malformed-")
    const dir = join(root, "guard")
    const ownerMeta = join(dir, "owner.json")
    const first = await acquireSingleBoxGuard({
      label: "first",
      dir,
      heartbeatMs: 60_000,
    })
    try {
      writeFileSync(ownerMeta, '{"label":"broken"}\n')
      utimesSync(dir, new Date(0), new Date(0))
      await expect(
        acquireSingleBoxGuard({
          label: "second",
          dir,
          staleHeartbeatMs: 1_000,
          now: () => Date.now() + 60_000,
        }),
      ).rejects.toThrow(/single-box|owner/i)
    } finally {
      await first.release().catch(() => undefined)
    }
  })

  test("a live guard re-creates its owner dir so external deletion cannot open a second launch lane", async () => {
    const root = allocTempDir("bench-single-box-heartbeat-")
    const dir = join(root, "guard")
    const scheduler = manualHeartbeatScheduler()
    const first = await acquireSingleBoxGuard({
      label: "first",
      dir,
      heartbeatMs: 1_000,
      heartbeatScheduler: scheduler,
    })
    let firstReleaseErr: unknown
    try {
      rmSync(dir, { recursive: true, force: true })
      await scheduler.fire()
      await expect(
        acquireSingleBoxGuard({
          label: "second",
          dir,
        }),
      ).rejects.toThrow(/single-box|owner/i)
    } finally {
      try {
        await first.release()
      } catch (err) {
        firstReleaseErr = err
      }
    }
    expect(firstReleaseErr).toBeUndefined()
    expect(scheduler.active()).toBe(0)
  })

  test("the production scheduler delivers a real heartbeat canary", async () => {
    const root = allocTempDir("bench-single-box-real-heartbeat-")
    const dir = join(root, "guard")
    const ownerMeta = join(dir, "owner.json")
    const first = await acquireSingleBoxGuard({ label: "first", dir, heartbeatMs: 10 })
    try {
      rmSync(dir, { recursive: true, force: true })
      const deadline = Date.now() + 1_000
      while (!existsSync(ownerMeta) && Date.now() < deadline) await Bun.sleep(5)
      expect(existsSync(ownerMeta)).toBe(true)
    } finally {
      await first.release().catch(() => undefined)
    }
  })

  test("external deletion cannot open a second launch lane BEFORE the next heartbeat lands", async () => {
    const root = allocTempDir("bench-single-box-gap-")
    const dir = join(root, "guard")
    const first = await acquireSingleBoxGuard({
      label: "first",
      dir,
      heartbeatMs: 60_000,
    })
    let firstReleaseErr: unknown
    try {
      rmSync(dir, { recursive: true, force: true })
      await expect(
        acquireSingleBoxGuard({
          label: "second",
          dir,
        }),
      ).rejects.toThrow(/single-box|owner/i)
    } finally {
      try {
        await first.release()
      } catch (err) {
        firstReleaseErr = err
      }
    }
    expect(firstReleaseErr).toBeUndefined()
  })

  // FIX B: stale-reclaim must be a BOUNDED loop, not unbounded self-recursion.
  // A pathological race where the lock dir always EEXISTs AND always looks stale
  // (another process keeps winning the create race on the same stale lock) used
  // to recurse forever, growing the stack until overflow. We simulate "always
  // EEXIST + always stale + reclaim can't clear it" by pre-seeding a stale owner
  // record then making the lock dir read-only: every reclaim's recursive `rm`
  // fails (caught/ignored), so owner.json survives, `lockLooksStale` stays true,
  // and the next `mkdir` re-hits EEXIST. The acquire MUST terminate with a clear
  // bound error (no stack overflow / no infinite loop).
  test("repeated stale-reclaim TERMINATES with a bounded error (no infinite recursion)", async () => {
    const root = allocTempDir("bench-single-box-reclaim-bound-")
    const dir = join(root, "guard")
    const ownerMeta = join(dir, "owner.json")
    // Pre-seed a STALE, reclaimable owner: dead pid + ancient heartbeat.
    mkdirSync(dir)
    writeFileSync(
      ownerMeta,
      `${JSON.stringify({
        label: "ghost",
        pid: 2_147_483_646, // not a live pid on this box
        acquiredAt: new Date(0).toISOString(),
        heartbeatAt: new Date(0).toISOString(),
      })}\n`,
    )
    // Read-only lock dir: rm(dir, {recursive}) cannot unlink owner.json (needs
    // write on dir), so the stale record persists across every reclaim and the
    // next mkdir keeps throwing EEXIST — the pathological "always stale" race.
    chmodSync(dir, 0o555)
    let caught: unknown
    try {
      await acquireSingleBoxGuard({
        label: "racer",
        dir,
        staleHeartbeatMs: 1_000,
        now: () => Date.now() + 60_000, // make the seeded heartbeat look stale
      })
    } catch (err) {
      caught = err
    } finally {
      chmodSync(dir, 0o755)
    }
    // Terminated (didn't overflow / hang) AND surfaced the bound error.
    expect(caught).toBeInstanceOf(Error)
    expect(String((caught as Error).message)).toMatch(/stale reclaim/i)
  })

  test("a failed release keeps the heartbeat alive so external deletion still cannot open a second launch lane", async () => {
    const root = allocTempDir("bench-single-box-release-heartbeat-")
    const dir = join(root, "guard")
    const scheduler = manualHeartbeatScheduler()
    const first = await acquireSingleBoxGuard({
      label: "first",
      dir,
      heartbeatMs: 1_000,
      heartbeatScheduler: scheduler,
    })
    let firstReleaseErr: unknown
    chmodSync(root, 0o555)
    try {
      await expect(first.release()).rejects.toThrow(
        /EACCES|EPERM|permission|operation not permitted/i,
      )
    } finally {
      chmodSync(root, 0o755)
    }
    try {
      rmSync(dir, { recursive: true, force: true })
      await scheduler.fire()
      await expect(
        acquireSingleBoxGuard({
          label: "second",
          dir,
        }),
      ).rejects.toThrow(/single-box|owner/i)
    } finally {
      try {
        await first.release()
      } catch (err) {
        firstReleaseErr = err
      }
    }
    expect(firstReleaseErr).toBeUndefined()
    expect(scheduler.active()).toBe(0)
  })
})
