/**
 * ★ The lane is not free just because the campaign exited.
 *
 * Both owners did the same thing on a failed drain: set `exitCode = 1`, print
 * "refusing to bless this run", and then call `lease?.release()`
 * unconditionally. The verdict was honest and the HANDOFF was not — the next
 * contender took a lane whose ports, `$HOME`, worktrees and shared cache were
 * still held by processes the previous campaign could not account for. That
 * surfaces as an unrelated flake in someone else's run, which is the worst
 * possible place for it to surface.
 *
 * Not-releasing is not the fix: the lease is a TCP listener on a hashed port
 * and the kernel closes it when the process exits, so skipping `release()`
 * buys nothing at all.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearLeaseQuarantine,
  LEASE_QUARANTINE_SCHEMA,
  type LeaseQuarantineRecord,
  parseLeaseQuarantine,
  QUARANTINE_TTL_MS,
  quarantineLane,
  quarantinePath,
  quarantineVerdict,
  readLeaseQuarantine,
  writeLeaseQuarantine,
} from "../../../tools/dev/lease-quarantine"
import { keeperTick } from "../../../tools/dev/lease-quarantine-keeper"
import { acquireTestShardLease } from "../../../tools/dev/test-shard-lease"

const GROUP = {
  pgid: 4242,
  leaderPid: 4242,
  verdict: "still-running",
  detail: "still alive after the drain deadline",
} as const

const record = (overrides: Partial<LeaseQuarantineRecord> = {}): LeaseQuarantineRecord => ({
  schema: LEASE_QUARANTINE_SCHEMA,
  repositoryId: "owner/repo",
  keeperPid: 999,
  survivors: [GROUP],
  createdAtMs: 1_000,
  expiresAtMs: 1_000 + QUARANTINE_TTL_MS,
  ...overrides,
})

const alive =
  (...pgids: readonly number[]) =>
  (pgid: number): boolean =>
    pgids.includes(pgid)

const verdictFor = (
  rec: LeaseQuarantineRecord | undefined,
  isAlive: (pgid: number) => boolean,
  nowMs = 2_000,
) => quarantineVerdict({ record: rec, repositoryId: "owner/repo", nowMs, isAlive })

describe("lease quarantine", () => {
  test("a live survivor BLOCKS the lane, and the reason names it", () => {
    const verdict = verdictFor(record(), alive(4242))
    expect(verdict.kind).toBe("blocked")
    if (verdict.kind !== "blocked") throw new Error("unreachable")
    expect(verdict.alive).toEqual([4242])
    expect(verdict.reason).toContain("4242")
    expect(verdict.reason).toContain("999")
  })

  test("no quarantine is a clear lane — the default is not 'blocked'", () => {
    // ANTI-VACUITY: a gate that blocks unconditionally would satisfy the arm
    // above and break every ordinary campaign.
    expect(verdictFor(undefined, alive(4242)).kind).toBe("clear")
  })

  test("liveness is decided by the SURVIVORS, not by the keeper", () => {
    // A keeper that was itself killed must not strand the lane...
    expect(verdictFor(record(), alive()).kind).toBe("stale")
    // ...and a keeper that is still running must not hold it after the groups
    // it was watching are gone. Both arms use the same record; only the
    // process liveness differs, so the keeper pid provably is not the gate.
    expect(verdictFor(record({ keeperPid: 1 }), alive(4242)).kind).toBe("blocked")
    expect(verdictFor(record({ keeperPid: 1 }), alive()).kind).toBe("stale")
  })

  test("a partially-exited set still blocks", () => {
    const two = record({
      survivors: [GROUP, { pgid: 7, leaderPid: -1, verdict: "unverified", detail: "no evidence" }],
    })
    const verdict = verdictFor(two, alive(7))
    expect(verdict.kind).toBe("blocked")
    if (verdict.kind !== "blocked") throw new Error("unreachable")
    expect(verdict.alive).toEqual([7])
    expect(verdict.reason).toContain("1 of 2")
  })

  test("the TTL is a ceiling on a BROKEN keeper, not a grace period", () => {
    const rec = record()
    expect(verdictFor(rec, alive(4242), rec.expiresAtMs - 1).kind).toBe("blocked")
    const expired = verdictFor(rec, alive(4242), rec.expiresAtMs)
    expect(expired.kind).toBe("stale")
    if (expired.kind !== "stale") throw new Error("unreachable")
    expect(expired.reason).toContain("expired")
  })

  test("another repository's quarantine never blocks this one", () => {
    expect(verdictFor(record({ repositoryId: "other/repo" }), alive(4242)).kind).toBe("stale")
  })

  test("a malformed record is not a lock", () => {
    // Fail-closed is right for a VERDICT and wrong for a lane: an unparseable
    // file would otherwise brick verification with no way to name the reason.
    for (const bad of [
      null,
      {},
      { ...record(), schema: "quanta.lease-quarantine.v0" },
      { ...record(), survivors: [] },
      { ...record(), survivors: [{ pgid: 0, leaderPid: 1, verdict: "x", detail: "" }] },
      { ...record(), keeperPid: 0 },
      { ...record(), repositoryId: "" },
    ]) {
      expect(parseLeaseQuarantine(bad)).toBeUndefined()
    }
    // ANTI-VACUITY: the VALID record still parses.
    expect(parseLeaseQuarantine(record())).toBeDefined()
  })
})

describe("quarantine handoff", () => {
  const withDir = <T>(fn: (dir: string) => T): T => {
    const dir = mkdtempSync(join(tmpdir(), "quarantine-"))
    try {
      return fn(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  test("the record is written and carries the forensics a receipt needs", () => {
    withDir((dir) => {
      const path = quarantinePath(dir)
      const spawned: string[][] = []
      const written = quarantineLane({
        path,
        repositoryId: "owner/repo",
        groups: [GROUP, { pgid: 7, leaderPid: -1, verdict: "recycled", detail: "pid reused" }],
        nowMs: 5_000,
        spawnKeeper: (p, id) => {
          spawned.push([p, id])
          return 31_337
        },
      })
      expect(spawned).toEqual([[path, "owner/repo"]])
      expect(written.keeperPid).toBe(31_337)
      expect(written.expiresAtMs).toBe(5_000 + QUARANTINE_TTL_MS)

      const onDisk = readLeaseQuarantine(path)
      expect(onDisk).toEqual(written)
      // The verdicts survive: `recycled` and `unverified` send an operator to
      // different places, and a bare pgid list said neither.
      expect(onDisk?.survivors.map((group) => group.verdict)).toEqual(["still-running", "recycled"])
      expect(onDisk?.survivors.map((group) => group.leaderPid)).toEqual([4242, -1])
    })
  })

  test("the keeper is spawned BEFORE the record exists, so the record never names a pid that was never started", () => {
    withDir((dir) => {
      const path = quarantinePath(dir)
      let recordAtSpawn: LeaseQuarantineRecord | undefined
      quarantineLane({
        path,
        repositoryId: "owner/repo",
        groups: [GROUP],
        spawnKeeper: () => {
          recordAtSpawn = readLeaseQuarantine(path)
          return 5
        },
      })
      expect(recordAtSpawn).toBeUndefined()
      expect(readLeaseQuarantine(path)?.keeperPid).toBe(5)
    })
  })

  test("an unreadable or absent file reads as no quarantine", () => {
    withDir((dir) => {
      const path = quarantinePath(dir)
      expect(readLeaseQuarantine(path)).toBeUndefined()
      writeFileSync(path, "not json")
      expect(readLeaseQuarantine(path)).toBeUndefined()
      clearLeaseQuarantine(path)
      expect(readLeaseQuarantine(path)).toBeUndefined()
      // ANTI-VACUITY: a real record round-trips through the same reader.
      writeLeaseQuarantine(path, record())
      expect(readLeaseQuarantine(path)?.keeperPid).toBe(999)
      expect(JSON.parse(readFileSync(path, "utf8")).schema).toBe(LEASE_QUARANTINE_SCHEMA)
    })
  })
})

describe("the keeper", () => {
  test("holds while a group lives, releases once they are gone", () => {
    expect(keeperTick(record(), "owner/repo", 2_000, alive(4242))).toBe("hold")
    expect(keeperTick(record(), "owner/repo", 2_000, alive())).toBe("release")
  })

  test("releases a record that is not its own, and an expired one", () => {
    // A keeper that outlived its record must not sit forever on someone
    // else's file.
    expect(
      keeperTick(record({ repositoryId: "other/repo" }), "owner/repo", 2_000, alive(4242)),
    ).toBe("release")
    expect(keeperTick(record(), "owner/repo", 1_000 + QUARANTINE_TTL_MS, alive(4242))).toBe(
      "release",
    )
    expect(keeperTick(undefined, "owner/repo", 2_000, alive(4242))).toBe("release")
  })
})

/**
 * WIRING PROOF — the unconditional release is gone from both owners.
 */
describe("quarantine wiring", () => {
  const source = (rel: string): string =>
    readFileSync(join(import.meta.dir, "..", "..", "..", rel), "utf8")

  test("the shard runner holds the lane instead of handing it on", () => {
    const runner = source("tools/dev/run-test-shards.ts")
    expect(runner).toContain("quarantineLane({")
    expect(runner).toContain("quarantinePath: QUARANTINE_PATH")
    // The write must happen BEFORE the release, or the kernel frees the port
    // into a window a contender can win.
    const nondrain = runner.indexOf("quarantineLane({")
    const release = runner.indexOf("lease?.release()", nondrain)
    expect(nondrain).toBeGreaterThan(0)
    expect(release).toBeGreaterThan(nondrain)
  })

  test("the campaign wrapper does the same, and records it", () => {
    const campaign = source("tools/dev/verification-campaign.ts")
    expect(campaign).toContain("quarantineLane({")
    expect(campaign).toContain("quarantine: {")
    expect(campaign).toContain("keeperPid: quarantineRecord.keeperPid")
    const held = campaign.indexOf("quarantineLane({")
    expect(campaign.indexOf("lease?.release()", held)).toBeGreaterThan(held)
  })

  test("acquisition consults the quarantine before accepting a bind", () => {
    const lease = source("tools/dev/test-shard-lease.ts")
    expect(lease).toContain("quarantineBlock(identity, options)")
    // Checked BEFORE `tryListen`, because a free PORT is not a free LANE.
    const check = lease.indexOf("quarantineBlock(identity, options)")
    const bind = lease.indexOf("tryListen(port, digest)", check)
    expect(check).toBeGreaterThan(0)
    expect(bind).toBeGreaterThan(check)
  })

  /**
   * BEHAVIOURAL, because the source assertions above are not enough: a mutant
   * that neutered the block's inner branch left them all green. These actually
   * try to take the lane.
   */
  test("a quarantined lane cannot be acquired, and a cleared one can", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quarantine-acquire-"))
    try {
      const path = quarantinePath(dir)
      // A unique identity, so the hashed port belongs to this test alone.
      const identity = `quarantine-test/${process.pid}-${Date.now()}`
      // REAL timestamps: the fixture's synthetic 1_000 is decades in the past,
      // so the record read as expired and the lane was granted — the first
      // version of this test failed for that reason rather than for the one it
      // was written to catch.
      const now = Date.now()
      writeLeaseQuarantine(
        path,
        record({ repositoryId: identity, createdAtMs: now, expiresAtMs: now + QUARANTINE_TTL_MS }),
      )

      const waits: string[] = []
      await expect(
        acquireTestShardLease({
          identity,
          quarantinePath: path,
          waitMs: 150,
          pollMs: 10,
          heartbeatMs: 0,
          isGroupAlive: () => true,
          onQuarantineWait: (reason) => waits.push(reason),
        }),
      ).rejects.toThrow(/timed out/)
      expect(waits.join(" ")).toContain("quarantined")

      // PAIRED CONTROL: the same lane, the same record, survivors gone. The
      // stale record is cleared as a side effect and the lease is granted.
      const granted = await acquireTestShardLease({
        identity,
        quarantinePath: path,
        waitMs: 2_000,
        pollMs: 10,
        isGroupAlive: () => false,
      })
      try {
        expect(granted.port).toBeGreaterThan(0)
        expect(readLeaseQuarantine(path)).toBeUndefined()
      } finally {
        granted.release()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})
