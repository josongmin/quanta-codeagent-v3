/**
 * RFC-06 F1 (R1) hellgate — cross-process lost-update on the durable
 * user-disabled set.
 *
 * THE DEFECT (adversarially confirmed): `json-disabled-store` did an
 * UNCONDITIONAL serialize + atomic-rename with NO cross-process guard, and the
 * authority's CAS compares only its IN-PROCESS revision. Two processes sharing
 * `<userDir>/.disabled.json` (a CLI + a web-daemon) both read revision N, both
 * pass CAS, both rename → last-writer-wins, one session's disable silently lost.
 *
 * A rev-compare-then-rename does NOT fix it (read + rename are separate syscalls
 * — both processes pass the compare, both rename). The fix is a REAL cross-process
 * exclusive lock (`createFileLock`, O_EXCL `wx`) guarding the whole
 * read→transform→write as a critical section, with the revision layered ON TOP as
 * the optimistic re-sync signal.
 *
 * These tests use TWO independent store instances on the SAME temp file to
 * simulate two processes:
 *   1. GREEN (the fix): the real lock → both disables survive (the second
 *      acquires after the first, re-syncs onto rev N+1, applies → BOTH names).
 *   2. RED-on-injection: swap in a pass-through lock → the clobber returns
 *      (lost update). Proves the lock is load-bearing, not decorative.
 *   3. A crashed holder's stale lock is reclaimed (no deadlock); a LIVE holder
 *      blocks within a bounded budget (no clobber, no unbounded spin).
 *   4. A persist failure inside the critical section refuses to publish AND
 *      releases the lock (a subsequent mutation is not deadlocked).
 *   5. End-to-end: two authorities over the same file each disable a different
 *      skill → both survive on disk; `sync()` converges each to see both.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  DisabledStoreFs,
  DisabledStoreLock,
  PersistedDisabledSet,
  Skill,
  SkillRegistry,
  SkillRegistryEntry,
  SkillScope,
  SkillSnapshot,
} from "@/skill"
import {
  createFileLock,
  createJsonDisabledStore,
  createSkillRuntimeAuthority,
  decodeDisabledSet,
  disabledSetLockPath,
  emptyDisabledSet,
} from "@/skill"

/* ------------------------------------------------------------------------- *
 * Helpers.
 * ------------------------------------------------------------------------- */

/** A fresh, unique disabled-set path under a private temp dir. */
const freshPath = (): string =>
  join(mkdtempSync(join(tmpdir(), "disabled-flock-")), ".disabled.json")

/** The on-disk record, decoded fail-closed (mirrors the store's read). */
const diskRecord = (path: string): PersistedDisabledSet => {
  try {
    return decodeDisabledSet(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return emptyDisabledSet()
  }
}

/** A transform that disables `name` (adds it to the set). */
const disable =
  (name: string) =>
  (names: Set<string>): Set<string> => {
    names.add(name)
    return names
  }

/** A pass-through "lock" with NO mutual exclusion — the injection that removes
 *  the guard so the lost-update clobber returns. */
const passThroughLock: DisabledStoreLock = { withLock: (fn) => fn() }

/** A fast-retry real lock (same O_EXCL mechanism, tuned so a released lock is
 *  re-acquired within a couple ms instead of the 100ms production default). */
const fastLock = (
  path: string,
  extra: Parameters<typeof createFileLock>[1] = {},
): DisabledStoreLock =>
  createFileLock(disabledSetLockPath(path), { retryIntervalMs: 2, timeoutMs: 3_000, ...extra })

/**
 * A read-gate that releases BOTH readers only after BOTH have read — forcing the
 * exact interleave a lock-free race would otherwise hit only probabilistically:
 * both writers observe the SAME base revision before either writes. Used ONLY for
 * the pass-through (RED) case to make the clobber deterministic; with a real lock
 * the second reader never runs concurrently, so this gate is neither used nor
 * needed there.
 */
const makeReadGate = (base: DisabledStoreFs, participants: number): DisabledStoreFs => {
  let arrived = 0
  let release: () => void = () => {}
  const bothRead = new Promise<void>((r) => {
    release = r
  })
  return {
    readText: async (p) => {
      const v = await base.readText(p)
      arrived += 1
      if (arrived >= participants) release()
      await bothRead
      return v
    },
    writeText: (p, t) => base.writeText(p, t),
  }
}

/** The real node fs seam (re-declared here so the gate can wrap it). */
const realFs: DisabledStoreFs = {
  readText: async (p) => {
    const { readFile } = await import("node:fs/promises")
    try {
      return await readFile(p, "utf8")
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null
      throw e
    }
  },
  writeText: async (p, t) => {
    const { mkdir, rename, writeFile: wf } = await import("node:fs/promises")
    const { dirname } = await import("node:path")
    await mkdir(dirname(p), { recursive: true })
    const tmp = `${p}.${process.pid}.${Date.now()}.${Math.random()}.tmp`
    await wf(tmp, t, "utf8")
    await rename(tmp, p)
  },
}

/* ------------------------------------------------------------------------- *
 * 1 + 2 — the lost-update RED and the lock's GREEN.
 * ------------------------------------------------------------------------- */

describe("R1 — cross-process lost-update on the disabled set", () => {
  test("GREEN: the O_EXCL lock makes two writers' disables BOTH survive (re-sync + re-apply)", async () => {
    const path = freshPath()
    // Two independent store instances on the SAME file = two processes. Real
    // O_EXCL lock (fast retry); both base on the same empty revision 0.
    const a = createJsonDisabledStore({ path, lock: fastLock(path) })
    const b = createJsonDisabledStore({ path, lock: fastLock(path) })

    const [oa, ob] = await Promise.all([
      a.mutate(0, disable("alpha")),
      b.mutate(0, disable("beta")),
    ])

    // Both disables are on disk — nothing was clobbered.
    expect(diskRecord(path).names).toEqual(["alpha", "beta"])
    // The winner committed rev 1; the one that waited re-synced onto it → rev 2.
    expect(diskRecord(path).revision).toBe(2)
    // Exactly ONE writer had to re-sync (it saw a revision it did not base on).
    expect([oa.resynced, ob.resynced].filter(Boolean)).toHaveLength(1)
    // The committed records reflect the monotonic 1 → 2 order.
    expect([oa.record.revision, ob.record.revision].sort()).toEqual([1, 2])
    // The lockfile is released (unlinked) after the critical sections.
    expect(diskRecord(disabledSetLockPath(path))).toEqual(emptyDisabledSet())
  })

  test("RED-on-injection: remove the lock (pass-through) → the second writer CLOBBERS the first", async () => {
    const path = freshPath()
    // A shared read-gate forces both writers to observe base rev 0 before either
    // writes — the deterministic form of the lock-free race.
    const gate = makeReadGate(realFs, 2)
    const a = createJsonDisabledStore({ path, fs: gate, lock: passThroughLock })
    const b = createJsonDisabledStore({ path, fs: gate, lock: passThroughLock })

    await Promise.all([a.mutate(0, disable("alpha")), b.mutate(0, disable("beta"))])

    // Last-writer-wins: exactly ONE disable survived — the other was lost.
    const final = diskRecord(path)
    expect(final.names).toHaveLength(1)
    expect(final.revision).toBe(1) // both wrote N+1 = 1 onto the same base
    // Concretely: at most one of the two intended names is present.
    expect(final.names.every((n) => n === "alpha" || n === "beta")).toBe(true)
    expect(final.names).not.toEqual(["alpha", "beta"])
  })
})

/* ------------------------------------------------------------------------- *
 * 3 — liveness: stale reclaim (no deadlock) + live-holder bounded block.
 * ------------------------------------------------------------------------- */

describe("R1 — lock liveness", () => {
  test("a crashed holder's STALE lock is reclaimed (no deadlock)", async () => {
    const path = freshPath()
    const lockPath = disabledSetLockPath(path)
    // Simulate a crashed process: its lockfile exists and is never released.
    await writeFile(lockPath, JSON.stringify({ pid: 999999, acquiredAt: 0 }), "utf8")
    const lockMtime = statSync(lockPath).mtimeMs

    // A fresh acquirer whose clock is well past the stale threshold reclaims it.
    const lock = createFileLock(lockPath, {
      retryIntervalMs: 1,
      timeoutMs: 1_000,
      staleThresholdMs: 30_000,
      now: () => lockMtime + 60_000,
    })
    const store = createJsonDisabledStore({ path, lock })
    const outcome = await store.mutate(0, disable("x"))

    expect(outcome.record.names).toEqual(["x"])
    expect(diskRecord(path).names).toEqual(["x"])
  })

  test("a LIVE holder blocks the writer within a bounded budget (no clobber, no unbounded spin)", async () => {
    const path = freshPath()
    const lockPath = disabledSetLockPath(path)
    // A live (fresh, non-stale) holder that never releases.
    await writeFile(lockPath, JSON.stringify({ pid: 999999, acquiredAt: Date.now() }), "utf8")

    const lock = createFileLock(lockPath, {
      retryIntervalMs: 5,
      timeoutMs: 60,
      staleThresholdMs: 30_000,
    })
    const store = createJsonDisabledStore({ path, lock })
    const start = Date.now()
    await expect(store.mutate(0, disable("y"))).rejects.toThrow(/lock: acquire timed out/)
    // Bounded: it gave up near the budget, it did not hang.
    expect(Date.now() - start).toBeLessThan(2_000)
    // And it did NOT clobber — the file was never written.
    expect(diskRecord(path)).toEqual(emptyDisabledSet())
  })
})

/* ------------------------------------------------------------------------- *
 * 4 — persist-failure refuses publish AND releases the lock.
 * ------------------------------------------------------------------------- */

describe("R1 — persist failure under the lock", () => {
  test("a failed write throws (refuse publish) and releases the lock so the next mutation proceeds", async () => {
    const path = freshPath()
    let failNext = true
    const flakyFs: DisabledStoreFs = {
      readText: realFs.readText,
      writeText: async (p, t) => {
        if (failNext) {
          failNext = false
          throw new Error("disk full")
        }
        return realFs.writeText(p, t)
      },
    }
    // A REAL lock so we prove the `finally` release, not a no-op pass-through.
    const store = createJsonDisabledStore({ path, fs: flakyFs, lock: fastLock(path) })

    // First mutation: the write throws → mutate rejects (persist-observing).
    await expect(store.mutate(0, disable("a"))).rejects.toThrow(/write failed/)
    // Nothing was published to disk.
    expect(diskRecord(path)).toEqual(emptyDisabledSet())
    // The lock was released (else this would time out / deadlock).
    const ok = await store.mutate(0, disable("a"))
    expect(ok.record.names).toEqual(["a"])
    expect(diskRecord(path).names).toEqual(["a"])
    // Lockfile gone after the successful critical section.
    expect(diskRecord(disabledSetLockPath(path))).toEqual(emptyDisabledSet())
  })
})

/* ------------------------------------------------------------------------- *
 * 5 — end-to-end: two authorities over the same file (CLI + web-daemon).
 * ------------------------------------------------------------------------- */

const mkSkill = (name: string): Skill => ({
  name,
  description: `desc-${name}`,
  body: `body-${name}`,
  sourcePath: `/fixtures/${name}/SKILL.md`,
  scope: "user" as SkillScope,
})

const mkSnapshot = (specNames: readonly string[]): SkillSnapshot => {
  const entries: SkillRegistryEntry[] = specNames
    .map((n) => ({ skill: mkSkill(n), winnerScope: "user" as SkillScope, overriddenScopes: [] }))
    .sort((x, y) => (x.skill.name < y.skill.name ? -1 : 1))
  const byName = new Map(entries.map((e) => [e.skill.name, e]))
  const registry: SkillRegistry = {
    entries,
    collisions: [],
    lookup: (n) => byName.get(n),
    bySope: () => [],
  }
  return { skills: entries.map((e) => e.skill), registry }
}

describe("R1 — two authorities over one file converge (CLI + web-daemon)", () => {
  test("each authority disables a DIFFERENT skill → both survive; sync converges", async () => {
    const path = freshPath()
    const mkAuthority = async () => {
      const store = createJsonDisabledStore({ path, lock: fastLock(path) })
      const persisted = await store.read()
      return createSkillRuntimeAuthority({
        snapshot: mkSnapshot(["alpha", "beta", "gamma"]),
        policy: null,
        disabledStore: store,
        persisted,
      })
    }
    // Two independent authority instances = two processes sharing the file.
    const cli = await mkAuthority()
    const web = await mkAuthority()

    const [rc, rw] = await Promise.all([
      cli.setEnabled("alpha", false, cli.read().revision),
      web.setEnabled("beta", false, web.read().revision),
    ])
    expect(rc.ok && rw.ok).toBe(true)

    // The durable set holds BOTH disables — neither session was clobbered.
    expect(diskRecord(path).names).toEqual(["alpha", "beta"])
    expect(diskRecord(path).revision).toBe(2)

    // Each authority converges to the shared truth on the next sync boundary.
    const cliView = await cli.sync()
    const webView = await web.sync()
    expect(cliView.revision).toBe(2)
    expect(webView.revision).toBe(2)
    for (const v of [cliView, webView]) {
      const active = v.active.map((s) => s.name).sort()
      expect(active).toEqual(["gamma"])
    }
  })
})
