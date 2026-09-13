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
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import ts from "typescript"
import {
  clearLeaseQuarantine,
  effectiveQuarantineExpiry,
  expiredQuarantinePath,
  KEEPER_SCRIPT_PATH,
  keeperSpawnRefusal,
  LEASE_QUARANTINE_DIR_ENV,
  LEASE_QUARANTINE_SCHEMA,
  type LeaseQuarantineRead,
  type LeaseQuarantineRecord,
  laneQuarantinePath,
  laneSlotVerdict,
  leaseQuarantineRoot,
  legacyQuarantinePath,
  parseLeaseQuarantine,
  QUARANTINE_TTL_MS,
  quarantineLane,
  quarantineVerdict,
  readLeaseQuarantine,
  readLeaseQuarantineOutcome,
  writeLeaseQuarantine,
} from "../../../tools/dev/lease-quarantine"
import { keeperTick } from "../../../tools/dev/lease-quarantine-keeper"
import {
  acquireTestShardLease,
  normalizeRepositoryIdentity,
  resolveLaneOwnership,
  testShardLeasePort,
} from "../../../tools/dev/test-shard-lease"

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

/**
 * Comment-stripped source, because a guard that can read its own explanation
 * passes for the wrong reason — this campaign tripped over that three times.
 */
const withoutComments = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ")

/**
 * Every `acquireTestShardLease(...)` call in `text`, argument list included.
 *
 * Brace-matched rather than regex-matched: a `finally\s*\{([\s\S]*?)\}` guard
 * elsewhere in this campaign truncated at the first `}}` the moment a nested
 * object appeared, and silently guarded a prefix of what it claimed to.
 */
const leaseAcquisitionCalls = (text: string): readonly string[] => {
  const needle = "acquireTestShardLease("
  const calls: string[] = []
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + 1)) {
    let depth = 0
    let cursor = at + needle.length - 1
    for (; cursor < text.length; cursor += 1) {
      const char = text[cursor]
      if (char === "(" || char === "{") depth += 1
      else if (char === ")" || char === "}") {
        depth -= 1
        if (depth === 0) break
      }
    }
    calls.push(text.slice(at, cursor + 1))
  }
  return calls
}

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

  /**
   * ★ The ceiling released the lane without saying what it was releasing over.
   *
   * Liveness was computed only AFTER the expiry branch returned, so an expired
   * record produced the same sentence — "quarantine expired 12ms ago (keeper pid
   * 4242)" — whether every survivor had exited or all of them were still
   * running. The contender then took a lane over live poisoned process groups,
   * and nothing in the campaign receipt that records this verdict said so.
   *
   * The ceiling still wins: a crashed keeper must not brick verification for
   * everyone. What the arms pin is that the release NAMES the groups it is
   * releasing over.
   */
  test("an expired quarantine says whether it is releasing over LIVE groups", () => {
    const rec = record()
    const overLive = verdictFor(rec, alive(4242), rec.expiresAtMs + 5)
    expect(overLive.kind).toBe("stale")
    if (overLive.kind !== "stale") throw new Error("unreachable")
    expect(overLive.reason).toContain("STILL ALIVE")
    expect(overLive.reason).toContain("4242")
    expect(overLive.reason).toContain("ttl ceiling is releasing")

    // PAIRED CONTROL 1 — expired with everything already gone is the benign
    // case, and it must NOT carry the warning, or the warning means nothing.
    const overDead = verdictFor(rec, alive(), rec.expiresAtMs + 5)
    expect(overDead.kind).toBe("stale")
    if (overDead.kind !== "stale") throw new Error("unreachable")
    expect(overDead.reason).toContain("every quarantined group has exited")
    expect(overDead.reason).not.toContain("STILL ALIVE")

    // PAIRED CONTROL 2 — before the ceiling, a live group still BLOCKS. The
    // arms above must not have turned the ceiling into the only verdict.
    expect(verdictFor(rec, alive(4242), rec.expiresAtMs - 1).kind).toBe("blocked")
  })

  test("another repository's quarantine never blocks this one — and is never deleted", () => {
    // `stale` is the DELETABLE verdict, and a foreign record was reported as
    // stale. Measured end to end: the owner read `blocked`, a contender with a
    // different identity read `stale` and swept the file, and the owner's next
    // contender then read `clear` and took a lane whose poisoned groups were
    // still alive. One quarantine path per git common-dir, and two identities can
    // coexist there.
    const verdict = verdictFor(record({ repositoryId: "other/repo" }), alive(4242))
    expect(verdict.kind).toBe("foreign")
    expect(verdict.kind === "foreign" ? verdict.reason : "").toContain("other/repo")
  })

  test("a malformed record is REFUSED as a record, and blocks the lane until its TTL", () => {
    // The original rule here was "a malformed record is not a lock", because an
    // unparseable file would otherwise brick verification with no way to name the
    // reason. That objection is answered rather than ignored: an unreadable record
    // now blocks, the reason names the parse failure and the file's age, and past
    // the 30-minute TTL it goes stale like any other — so the brick is bounded and
    // diagnosable instead of the lane being handed over.
    //
    // MEASURED before this: truncated JSON, a float `createdAtMs`, a string
    // `pgid`, an unknown schema and a zero-byte file each read as `clear`, which
    // is indistinguishable from "no quarantine was ever written" — and the record
    // is written from a teardown `finally`, the one place a partial write is
    // likely.
    const now = 10 * 60_000
    const unreadable = { kind: "unreadable", reason: "unparseable json", writtenAtMs: now } as const
    expect(
      quarantineVerdict({
        read: unreadable,
        repositoryId: "owner/repo",
        nowMs: now + 1_000,
        isAlive: alive(4242),
      }).kind,
    ).toBe("blocked")
    expect(
      quarantineVerdict({
        read: unreadable,
        repositoryId: "owner/repo",
        nowMs: now + QUARANTINE_TTL_MS + 1,
        isAlive: alive(4242),
      }).kind,
    ).toBe("stale")

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
      const path = laneQuarantinePath("owner/repo", dir)
      const spawned: string[][] = []
      const written = quarantineLane({
        env: { [LEASE_QUARANTINE_DIR_ENV]: dir },
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
      const path = laneQuarantinePath("owner/repo", dir)
      let recordAtSpawn: LeaseQuarantineRecord | undefined
      quarantineLane({
        env: { [LEASE_QUARANTINE_DIR_ENV]: dir },
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
      const path = join(dir, "lease-quarantine.json")
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

/**
 * `spawnDetachedKeeper` did not detach anything.
 *
 * MEASURED: `Bun.spawn` has no `detached` option, and `unref()` only stops the
 * PARENT from waiting — parent pid 26134 pgid 26124, child pid 26152 pgid 26124.
 * A terminal Ctrl-C signals the whole foreground process group, so the process
 * spawned to outlive the campaign died with it, and the record then sat until
 * its four-hour TTL instead of being cleared when the survivors exited.
 *
 * Ground truth from `ps`, not from the option name: this is the second time in
 * this campaign that a promise in a symbol's NAME was the only evidence the
 * behaviour existed.
 */
describe("the keeper outlives the group that spawned it", () => {
  const pgidOf = (pid: number): string =>
    new TextDecoder()
      .decode(Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)], { stdout: "pipe" }).stdout)
      .trim()

  test("it leaves the spawner's process group and leads its own", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-detach-"))
    const ownPgid = pgidOf(process.pid)
    // The survivor is THIS process's group, so the verdict is `blocked` and the
    // keeper stays up long enough to be observed.
    const now = Date.now()
    const path = laneQuarantinePath("detach-probe/repo", dir)
    writeLeaseQuarantine(
      path,
      record({
        repositoryId: "detach-probe/repo",
        createdAtMs: now,
        expiresAtMs: now + QUARANTINE_TTL_MS,
        survivors: [
          {
            pgid: Number(ownPgid),
            leaderPid: process.pid,
            verdict: "probe",
            detail: "this test's own group, so the keeper holds",
          },
        ],
      }),
    )
    const keeper = Bun.spawn(
      [
        "bun",
        join(import.meta.dir, "..", "..", "..", "tools", "dev", "lease-quarantine-keeper.ts"),
        path,
        "detach-probe/repo",
      ],
      { stdin: "ignore", stdout: "ignore", stderr: "pipe" },
    )
    keeper.unref()
    try {
      // READINESS, not a timer: the keeper announces its session on stderr as
      // its first act, so the observation happens after `setsid` has returned
      // rather than after an interval somebody guessed. `bun test`'s own
      // per-test timeout is the backstop if it never speaks.
      let announced = ""
      for await (const chunk of keeper.stderr as ReadableStream<Uint8Array>) {
        announced += new TextDecoder().decode(chunk)
        if (announced.includes("\n")) break
      }
      expect(announced).toContain("[quarantine] keeper session=")
      const keeperPgid = pgidOf(keeper.pid)
      expect({ left: keeperPgid !== ownPgid, own: keeperPgid === String(keeper.pid) }).toEqual({
        left: true,
        own: true,
      })

      // PAIRED CONTROL, and the reason the fix is needed: an ordinary
      // `Bun.spawn` + `unref()` child stays in this process's group, so the
      // measurement above is not just reading a value that is always different.
      const plain = Bun.spawn(["bash", "-c", "sleep 30"], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
      })
      plain.unref()
      try {
        expect(pgidOf(plain.pid)).toBe(ownPgid)
      } finally {
        plain.kill()
      }
    } finally {
      keeper.kill()
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})

/**
 * The PRODUCER, not a hand-written verdict input.
 *
 * The arms that assert "an unreadable record blocks the lane" drove
 * `quarantineVerdict` with a literal `{kind:"unreadable", …}`. So the mapping the
 * fix actually consists of — a parse failure becoming `unreadable` WITH the
 * file's mtime — was tested by nothing, and an audit restored the whole fail-open
 * by making both `unreadable` returns say `absent` instead: 25 arms stayed green.
 */
describe("readLeaseQuarantineOutcome maps corruption to unreadable, not absent", () => {
  const corrupt: readonly (readonly [string, string])[] = [
    ["truncated json", '{"schema":"quanta.lease-quarantine.v1","repositoryI'],
    ["zero bytes", ""],
    ["valid json, wrong shape", '{"hello":"world"}'],
    ["unknown schema", JSON.stringify({ ...record(), schema: "quanta.lease-quarantine.v3" })],
    [
      "pgid as a string",
      JSON.stringify({
        ...record(),
        survivors: [{ pgid: "4242", leaderPid: 1, verdict: "x", detail: "" }],
      }),
    ],
    ["float createdAtMs", JSON.stringify({ ...record(), createdAtMs: 1.5 })],
  ]

  test("every corrupt file reads as UNREADABLE and blocks, with the file's own age", () => {
    const dir = mkdtempSync(join(tmpdir(), "quarantine-corrupt-"))
    try {
      const path = join(dir, "lease-quarantine.json")
      for (const [why, body] of corrupt) {
        writeFileSync(path, body)
        const read = readLeaseQuarantineOutcome(path)
        expect({ why, kind: read.kind }).toEqual({ why, kind: "unreadable" })
        if (read.kind !== "unreadable") throw new Error("unreachable")
        // The mtime is what bounds the block; a zero would make every corrupt
        // record instantly stale and re-open the fail-open by another route.
        expect({ why, hasAge: read.writtenAtMs > 0 }).toEqual({ why, hasAge: true })
        const verdict = quarantineVerdict({
          read,
          repositoryId: "owner/repo",
          nowMs: read.writtenAtMs + 1_000,
          isAlive: () => true,
        })
        expect({ why, verdict: verdict.kind }).toEqual({ why, verdict: "blocked" })
      }
      // PAIRED CONTROL: a well-formed record on the same path reads as a record.
      writeFileSync(path, JSON.stringify(record()))
      expect(readLeaseQuarantineOutcome(path).kind).toBe("record")
      // ...and an ABSENT file is absent, not unreadable — the two answers this
      // type exists to keep apart.
      rmSync(path, { force: true })
      expect(readLeaseQuarantineOutcome(path).kind).toBe("absent")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test("the same corruption past the TTL goes stale, so a bad file cannot brick the lane", () => {
    const dir = mkdtempSync(join(tmpdir(), "quarantine-corrupt-ttl-"))
    try {
      const path = join(dir, "lease-quarantine.json")
      writeFileSync(path, "{ not json")
      const read = readLeaseQuarantineOutcome(path)
      if (read.kind !== "unreadable") throw new Error("unreachable")
      expect(
        quarantineVerdict({
          read,
          repositoryId: "owner/repo",
          nowMs: read.writtenAtMs + QUARANTINE_TTL_MS + 1,
          isAlive: () => true,
        }).kind,
      ).toBe("stale")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("the keeper script the default spawner points at", () => {
  test("it exists, and the module refuses to write a record without it", () => {
    // Every other arm injects `spawnKeeper`, and the detach arm spawns the script
    // directly, so the production default was exercised by nothing: a mutation
    // audit renamed it to `…-keeper-MISSING.ts` and the suite stayed green. A
    // keeper that never runs means every quarantine waits out its full 30-minute
    // TTL instead of clearing when the survivors exit.
    expect(existsSync(KEEPER_SCRIPT_PATH)).toBe(true)
    expect(KEEPER_SCRIPT_PATH.endsWith("tools/dev/lease-quarantine-keeper.ts")).toBe(true)
  })

  /**
   * The previous version of this arm asserted
   * `expect(source).toContain("refusing to write a record")` against
   * `lease-quarantine.ts`. That is a SOURCE-STRING guard: delete the
   * `existsSync` check, leave the sentence in a comment, and it stays green. It
   * was written as the fix for an untested default and reintroduced the exact
   * defect class it was fixing.
   */
  test("the refusal is a DECISION, driven here rather than grepped for", () => {
    const missing = keeperSpawnRefusal("/nonexistent/lease-quarantine-keeper.ts", () => false)
    expect(missing).toContain("keeper script missing")
    expect(missing).toContain("/nonexistent/lease-quarantine-keeper.ts")

    // PAIRED CONTROL — the SHIPPED path must not refuse. This is the wiring
    // proof the string match only pretended to be: if the script is renamed or
    // moved, this fails, and it fails with the real path in the message.
    expect(keeperSpawnRefusal()).toBeUndefined()
  })

  /**
   * ★ A missing keeper used to mean NO quarantine.
   *
   * The refusal threw and wrote nothing, on the claim that a keeperless record
   * "holds the lane for the full TTL, which is worse than not quarantining at
   * all". False: liveness is re-derived from the survivors on every read, so a
   * keeperless record frees the lane the moment they exit. Refusing handed the
   * next contender a lane with live survivors — measured by an audit.
   */
  test("the DEFAULT spawner with no keeper still writes a record that BLOCKS while survivors live", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-default-"))
    try {
      const identity = `keeperless/${process.pid}-${Date.now()}`
      const env = { [LEASE_QUARANTINE_DIR_ENV]: dir }
      const written = quarantineLane({
        env,
        repositoryId: identity,
        groups: [{ pgid: 4_242, leaderPid: 4_242, verdict: "still-running", detail: "survivor" }],
        keeperScriptPath: join(dir, "keeper-that-is-not-there.ts"),
      })
      expect(written.keeperPid).toBeNull()
      expect(written.keeperRefusal).toContain("keeper script missing")
      expect(readLeaseQuarantine(laneQuarantinePath(identity, dir))?.keeperPid).toBeNull()

      await expect(
        acquireTestShardLease({
          identity,
          env,
          waitMs: 150,
          pollMs: 10,
          heartbeatMs: 0,
          isGroupAlive: () => true,
        }),
      ).rejects.toThrow(/timed out/)
      // PAIRED CONTROL — survivors gone, the same keeperless record frees the lane.
      const granted = await acquireTestShardLease({
        identity,
        env,
        waitMs: 2_000,
        pollMs: 10,
        isGroupAlive: () => false,
      })
      granted.release()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)
})

describe("the keeper", () => {
  const held = (row: LeaseQuarantineRecord): LeaseQuarantineRead => ({
    kind: "record",
    record: row,
  })

  test("watches while a group lives, and is done once they are gone", () => {
    expect(keeperTick(held(record()), "owner/repo", 2_000, alive(4242))).toBe("watch")
    expect(keeperTick(held(record()), "owner/repo", 2_000, alive())).toBe("done")
  })

  test("keeps watching a record naming another identity until that record's own ceiling", () => {
    const misfiled = record({ repositoryId: "other/repo" })
    expect(keeperTick(held(misfiled), "owner/repo", 2_000, alive(4242))).toBe("watch")
    expect(keeperTick(held(misfiled), "owner/repo", misfiled.expiresAtMs, alive(4242))).toBe("done")
  })

  test("an expired record ends the watch; an ABSENT one does not", () => {
    expect(keeperTick(held(record()), "owner/repo", 1_000 + QUARANTINE_TTL_MS, alive(4242))).toBe(
      "done",
    )
    // `quarantineLane` spawns the keeper BEFORE it writes the record, so that no
    // record ever names a pid that was never started. The keeper's first tick
    // therefore races the write, and answering `release` there DELETED the record
    // it exists to watch. Measured: `recordOnDisk=false -> release`.
    expect(keeperTick({ kind: "absent" }, "owner/repo", 2_000, alive(4242))).toBe("watch")
  })

  test("an UNREADABLE record is watched, and stops being watched past the TTL", () => {
    const unreadable = (writtenAtMs: number): LeaseQuarantineRead => ({
      kind: "unreadable",
      reason: "unparseable json",
      writtenAtMs,
    })
    expect(keeperTick(unreadable(2_000), "owner/repo", 3_000, alive(4242))).toBe("watch")
    expect(
      keeperTick(unreadable(2_000), "owner/repo", 3_000 + QUARANTINE_TTL_MS, alive(4242)),
    ).toBe("done")
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
    expect(runner).toContain("legacyQuarantineCacheRoot: SHARED_CACHE_ROOT")
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

  /**
   * WRITING a record and never READING one is half a quarantine, and this file
   * shipped exactly that: the campaign wrote the record on a failed drain and
   * acquired without `quarantinePath`, so the next campaign took the lane over
   * its own predecessor's survivors. Measured before the fix, same identity,
   * same record, injected keeper:
   *
   *   without quarantinePath -> ACQUIRED port=47451 (record ignored)
   *   with    quarantinePath -> refused: lane quarantined by pid …, 1 of 1 alive
   *
   * The arm above could not see it: it asserted the WRITE. So this one is over
   * every acquisition in the tree, found by brace matching rather than by a
   * regex that stops at the first `}` — an earlier guard in this campaign broke
   * exactly that way once a nested object appeared in the argument list.
   */
  test("EVERY acquisition of the repository lane consults the quarantine", () => {
    const owners = [
      "tools/dev/run-test-shards.ts",
      "tools/dev/verification-campaign.ts",
      "tools/dev/test-shard-lease.ts",
    ]

    // ANTI-VACUITY: the stripper must not empty the file, and the search must
    // find the calls that exist. A guard over zero call sites is green forever.
    const found = owners.flatMap((file) => {
      const text = withoutComments(source(file))
      expect({ file, hasCode: text.includes("acquireTestShardLease") }).toEqual({
        file,
        hasCode: true,
      })
      return leaseAcquisitionCalls(text).map((call) => ({ file, call }))
    })
    // The two lane owners. `test-shard-lease.ts` is in the list because it is
    // where a third acquirer would most plausibly be added, and its own
    // definition is not a call — so if that ever changes, this list must be
    // updated rather than silently covering fewer sites.
    expect(found.map(({ file }) => file).sort()).toEqual([
      "tools/dev/run-test-shards.ts",
      "tools/dev/verification-campaign.ts",
    ])

    // The gate now consults the slot UNCONDITIONALLY for the repository lane, so
    // "passed a quarantine path" is no longer the question. What each owner must
    // still pass is the LEGACY root: without it a live record written by an older
    // checkout, into the old shared file, would be invisible during transition.
    for (const { file, call } of found) {
      expect({ file, legacyRead: call.includes("legacyQuarantineCacheRoot") }).toEqual({
        file,
        legacyRead: true,
      })
    }
  })

  test("acquisition reads the quarantine only while HOLDING the port it just bound", () => {
    // It read BEFORE binding, and an audit reproduced both holes that opens: a
    // holder writing its record and releasing between the read and the bind, and
    // a waiting contender deleting a record a live holder had just written.
    const tree = ts.createSourceFile(
      "test-shard-lease.ts",
      source("tools/dev/test-shard-lease.ts"),
      ts.ScriptTarget.ESNext,
      true,
      ts.ScriptKind.TS,
    )
    const checks: ts.CallExpression[] = []
    const walk = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === "quarantineBlock"
      ) {
        checks.push(node)
      }
      node.forEachChild(walk)
    }
    walk(tree)
    expect(checks).toHaveLength(1)
    const [check] = checks
    // Inside `if (listener !== undefined)`, where `listener = tryListen(…)`.
    let guard: ts.Node | undefined = check
    while (guard !== undefined && !ts.isIfStatement(guard)) guard = guard.parent
    if (guard === undefined || !ts.isIfStatement(guard)) throw new Error("the check is unguarded")
    expect(guard.expression.getText(tree)).toBe("listener !== undefined")
    const block = guard.parent
    if (!ts.isBlock(block)) throw new Error("the guard is not in a block")
    const bindAt = block.statements.findIndex((statement) =>
      statement.getText(tree).includes("const listener = tryListen("),
    )
    expect(bindAt).toBeGreaterThanOrEqual(0)
    expect(block.statements.indexOf(guard)).toBeGreaterThan(bindAt)
  })

  /**
   * BEHAVIOURAL, because the source assertions above are not enough: a mutant
   * that neutered the block's inner branch left them all green. These actually
   * try to take the lane.
   */
  test("a quarantined lane cannot be acquired, and a cleared one can", async () => {
    const dir = mkdtempSync(join(tmpdir(), "quarantine-acquire-"))
    try {
      // A unique identity, so the hashed port belongs to this test alone.
      const identity = `quarantine-test/${process.pid}-${Date.now()}`
      const env = { [LEASE_QUARANTINE_DIR_ENV]: dir }
      const path = laneQuarantinePath(identity, dir)
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
          env,
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
        env,
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

/**
 * The runner set its quarantine key only in the branch that ACQUIRES a lease.
 * Under a campaign — the normal path, where the wrapper owns the lane — the key
 * stayed `undefined` and `if (leaseIdentity !== undefined)` silently skipped
 * the write. The quarantine was therefore inert exactly where it mattered: the
 * campaign's own drain accounts only for groups the CAMPAIGN spawned, so a
 * shard worker group the runner could not account for was quarantined by nobody.
 */
describe("lane ownership names the key in both shapes", () => {
  const OWNER_ENV = "QUANTA_VERIFICATION_LEASE_IDENTITY"

  test("an inherited lane still knows the key its survivors belong to", async () => {
    let ownCalls = 0
    const ownership = await resolveLaneOwnership({
      inherited: true,
      env: { [OWNER_ENV]: "git@github.com:acme/widgets.git" },
      ownIdentity: async () => {
        ownCalls += 1
        return "/not/asked"
      },
    })
    // Not acquiring is the point — reacquiring would deadlock against the
    // wrapper's own lease — but the KEY is present anyway.
    expect(ownership.acquireIdentity).toBeUndefined()
    expect(ownership.quarantineKey).toBe("acme/widgets")
    // ...and an inherited run does not pay for two `git` invocations.
    expect(ownCalls).toBe(0)
  })

  test("an owning run acquires under the raw identity and quarantines under the key", async () => {
    const ownership = await resolveLaneOwnership({
      inherited: false,
      env: {},
      ownIdentity: async () => "/Users/someone/quanta-codeagent-v3",
    })
    // RAW for the acquisition, because that is what the lease hashes, and
    // NORMALISED for the record, because that is what a contender compares.
    expect(ownership.acquireIdentity).toBe("/Users/someone/quanta-codeagent-v3")
    expect(ownership.quarantineKey).toBe("someone/quanta-codeagent-v3")
  })

  test("an inherited lane with no owner identity fails CLOSED", async () => {
    // The silent-undefined state is what the defect produced. A run that
    // cannot name its key must not run at all.
    for (const env of [{}, { [OWNER_ENV]: "" }]) {
      await expect(
        resolveLaneOwnership({ inherited: true, env, ownIdentity: async () => "unused" }),
      ).rejects.toThrow(/no owner identity/)
    }
  })

  test("the key a contender reads is the one the lease hashed its port from", async () => {
    // The normalisation is not cosmetic: `acquireTestShardLease` runs its
    // identity through `normalizeRepositoryIdentity` before hashing, so a
    // record under the raw string is compared against a different key and
    // never blocks.
    const raw = "/Users/someone/quanta-codeagent-v3"
    const ownership = await resolveLaneOwnership({
      inherited: false,
      env: {},
      ownIdentity: async () => raw,
    })
    expect(ownership.quarantineKey).toBe(normalizeRepositoryIdentity(raw))
    // BEHAVIOURAL: take the lane under the RAW identity, exactly as the runner
    // does, and the port it lands on is the one derived from the key the record
    // is written under. Hashing the raw string instead lands elsewhere
    // (measured 45790 vs 43098), which is how a record can end up describing a
    // lane no contender is looking at.
    const unique = `${raw}-${process.pid}-${Date.now()}`
    const key = (
      await resolveLaneOwnership({ inherited: false, env: {}, ownIdentity: async () => unique })
    ).quarantineKey
    const lease = await acquireTestShardLease({ identity: unique, waitMs: 2_000, pollMs: 10 })
    try {
      expect(lease.port).toBe(testShardLeasePort(key))
    } finally {
      lease.release()
    }
  })
})

/**
 * ★ One slot per identity, on a root every copy of the repository shares.
 *
 * The record lived at `<git-common-dir>/quanta-verification-cache/lease-quarantine.json`:
 * one file per git common-dir, while the LEASE is a port hashed from the committed
 * identity and therefore shared by every clone on the host. An audit reproduced
 * it with the real identity, cache-root and lease functions — two copies, one
 * port (44934), two quarantine files, and the second copy acquired the lane over
 * a live quarantined group of the first. The same shared leaf also let a second
 * identity's write overwrite the first identity's record.
 */
describe("quarantine slots", () => {
  const G = (pgid: number) => ({ pgid, leaderPid: pgid, verdict: "still-running", detail: "live" })
  const withRoot = async (
    fn: (root: string, env: Record<string, string>) => Promise<void> | void,
  ) => {
    const root = mkdtempSync(join(tmpdir(), "lane-slot-"))
    try {
      await fn(root, { [LEASE_QUARANTINE_DIR_ENV]: root })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  }

  test("two identities keep two slots, and the gate reads the one its writer used", async () => {
    await withRoot(async (root, env) => {
      const raw = `git@github.com:acme/slot-${process.pid}-${Date.now()}.git`
      const other = `acme/other-${process.pid}-${Date.now()}`
      quarantineLane({ repositoryId: raw, groups: [G(4242)], env, spawnKeeper: () => 7 })
      quarantineLane({ repositoryId: other, groups: [G(5151)], env, spawnKeeper: () => 8 })
      expect(readdirSync(root).filter((name) => name.endsWith(".json"))).toHaveLength(2)
      expect(
        readLeaseQuarantine(laneQuarantinePath(other, root))?.survivors.map((g) => g.pgid),
      ).toEqual([5151])

      // The RAW remote was written; the gate normalises — and still finds it.
      const waits: string[] = []
      await expect(
        acquireTestShardLease({
          identity: raw,
          env,
          waitMs: 150,
          pollMs: 10,
          heartbeatMs: 0,
          isGroupAlive: (pgid) => pgid === 4242,
          onQuarantineWait: (reason) => waits.push(reason),
        }),
      ).rejects.toThrow(/timed out/)
      expect(waits.join(" ")).toContain("4242")
    })
  }, 20_000)

  test("the leaf is a hash of the NORMALISED identity: no traversal, no collision", () => {
    const ids = [
      "owner/repo",
      "owner:repo",
      "owner_repo",
      "repository-id:quanta-codeagent-v3",
      "../../etc/passwd",
      "a/b/../c",
    ]
    const paths = ids.map((id) => laneQuarantinePath(id, "/r"))
    for (const path of paths) {
      expect(dirname(path)).toBe("/r")
      expect(basename(path)).toMatch(/^lease-quarantine-[0-9a-f]{32}\.json$/)
    }
    expect(new Set(paths).size).toBe(ids.length)
    expect(laneQuarantinePath("git@github.com:acme/w.git", "/r")).toBe(
      laneQuarantinePath("acme/w", "/r"),
    )
  })

  test("the default root does not follow the checkout, HOME or TMPDIR", () => {
    const a = leaseQuarantineRoot({ HOME: "/h1", TMPDIR: "/t1" })
    const b = leaseQuarantineRoot({ HOME: "/h2", TMPDIR: "/t2" })
    expect(a).toBe(b)
    expect(a).not.toContain("quanta-verification-cache")
    expect(() => leaseQuarantineRoot({ [LEASE_QUARANTINE_DIR_ENV]: "relative/dir" })).toThrow(
      /absolute/,
    )
  })

  test("TRANSITION — a live legacy record still blocks; a stranger's is never deleted", async () => {
    await withRoot(async (root, env) => {
      const cache = join(root, "cache")
      const identity = `legacy/${process.pid}-${Date.now()}`
      const now = Date.now()
      writeLeaseQuarantine(
        legacyQuarantinePath(cache),
        record({ repositoryId: identity, createdAtMs: now, expiresAtMs: now + QUARANTINE_TTL_MS }),
      )
      await expect(
        acquireTestShardLease({
          identity,
          env,
          legacyQuarantineCacheRoot: cache,
          waitMs: 150,
          pollMs: 10,
          heartbeatMs: 0,
          isGroupAlive: () => true,
        }),
      ).rejects.toThrow(/timed out/)

      writeLeaseQuarantine(
        legacyQuarantinePath(cache),
        record({
          repositoryId: "someone/else",
          createdAtMs: now,
          expiresAtMs: now + QUARANTINE_TTL_MS,
        }),
      )
      const before = readFileSync(legacyQuarantinePath(cache), "utf8")
      const granted = await acquireTestShardLease({
        identity,
        env,
        legacyQuarantineCacheRoot: cache,
        waitMs: 2_000,
        pollMs: 10,
        isGroupAlive: () => true,
      })
      granted.release()
      expect(readFileSync(legacyQuarantinePath(cache), "utf8")).toBe(before)
    })
  }, 20_000)

  test("the legacy mirror serves old readers and never clobbers a record it does not own", async () => {
    await withRoot((root, env) => {
      const cache = join(root, "cache")
      const identity = `mirror/${process.pid}`
      writeLeaseQuarantine(legacyQuarantinePath(cache), record({ repositoryId: "someone/else" }))
      const before = readFileSync(legacyQuarantinePath(cache), "utf8")
      quarantineLane({
        repositoryId: identity,
        groups: [G(1)],
        env,
        legacyCacheRoot: cache,
        spawnKeeper: () => 9,
      })
      expect(readFileSync(legacyQuarantinePath(cache), "utf8")).toBe(before)

      rmSync(legacyQuarantinePath(cache))
      quarantineLane({
        repositoryId: identity,
        groups: [G(1)],
        env,
        legacyCacheRoot: cache,
        spawnKeeper: () => 9,
      })
      expect(readLeaseQuarantine(legacyQuarantinePath(cache))?.repositoryId).toBe(identity)
      expect(readdirSync(cache).filter((name) => name.includes(".mirror-"))).toEqual([])
    })
  })

  test("a record for another identity in OUR slot blocks until its own ceiling", () => {
    const misfiled = record({
      repositoryId: "other/repo",
      createdAtMs: 1_000,
      expiresAtMs: 1_000 + QUARANTINE_TTL_MS,
    })
    const read: LeaseQuarantineRead = { kind: "record", record: misfiled }
    expect(
      laneSlotVerdict({ read, identity: "owner/repo", nowMs: 2_000, isAlive: () => false }).kind,
    ).toBe("blocked")
    expect(
      laneSlotVerdict({
        read,
        identity: "owner/repo",
        nowMs: misfiled.expiresAtMs,
        isAlive: () => false,
      }).kind,
    ).toBe("stale")
  })

  test("a second quarantine CARRIES the first one's live survivors and drops its dead ones", async () => {
    await withRoot((root, env) => {
      const identity = `merge/${process.pid}`
      const path = laneQuarantinePath(identity, root)
      quarantineLane({
        repositoryId: identity,
        groups: [G(111)],
        env,
        isAlive: () => true,
        spawnKeeper: () => 1,
      })
      quarantineLane({
        repositoryId: identity,
        groups: [G(222)],
        env,
        isAlive: (p) => p === 111,
        spawnKeeper: () => 2,
      })
      expect(readLeaseQuarantine(path)?.survivors.map((g) => g.pgid)).toEqual([222, 111])
      quarantineLane({
        repositoryId: identity,
        groups: [G(333)],
        env,
        isAlive: () => false,
        spawnKeeper: () => 3,
      })
      expect(readLeaseQuarantine(path)?.survivors.map((g) => g.pgid)).toEqual([333])
    })
  })

  /**
   * ★ The warning about releasing over live groups reached NOBODY.
   *
   * `quarantineVerdict` computed "STILL ALIVE … the ttl ceiling is releasing a
   * lane whose processes are still running", and the gate discarded the reason
   * and deleted the record in the same call. Measured by an audit: zero callback
   * invocations, zero bytes on stdout/stderr, record gone.
   */
  test("an expired release over live groups is REPORTED, and its record is kept", async () => {
    await withRoot(async (root, env) => {
      const identity = `expired/${process.pid}-${Date.now()}`
      const path = laneQuarantinePath(identity, root)
      const past = Date.now() - QUARANTINE_TTL_MS - 5_000
      writeLeaseQuarantine(
        path,
        record({
          repositoryId: identity,
          createdAtMs: past,
          expiresAtMs: past + QUARANTINE_TTL_MS,
        }),
      )
      const released: string[] = []
      const lease = await acquireTestShardLease({
        identity,
        env,
        waitMs: 2_000,
        pollMs: 10,
        isGroupAlive: () => true,
        onQuarantineRelease: (reason) => released.push(reason),
      })
      lease.release()
      expect(released.join(" ")).toContain("STILL ALIVE")
      expect(existsSync(path)).toBe(false)
      expect(existsSync(expiredQuarantinePath(path, record({ createdAtMs: past })))).toBe(true)
    })
  }, 20_000)

  /**
   * The DEFAULT spawner's success path: argv, `unref`, and the injected script.
   * An audit's mutants swapping argv, deleting `unref()` (a real hang: the owner
   * lives until the keeper exits) and spawning `KEEPER_SCRIPT_PATH` instead of
   * the injected path all left every arm green.
   */
  test("the default spawner hands the keeper its slot and does not hold the owner open", async () => {
    const dir = mkdtempSync(join(tmpdir(), "keeper-argv-"))
    const argvOut = join(dir, "argv.json")
    const release = join(dir, "release")
    const stub = join(dir, "stub-keeper.ts")
    // The stub reports its pid and waits for `release`. It also gives up when its
    // directory is gone: the first version waited for `release` only, and the
    // `finally` wrote that file and removed the directory in the same tick — so
    // every run left a stub polling forever. An audit found 18 of them.
    writeFileSync(
      stub,
      [
        'import { existsSync, writeFileSync } from "node:fs"',
        `writeFileSync(${JSON.stringify(argvOut)}, JSON.stringify({ argv: process.argv.slice(2), pid: process.pid }))`,
        `while (!existsSync(${JSON.stringify(release)}) && existsSync(${JSON.stringify(dir)})) await Bun.sleep(20)`,
      ].join("\n"),
    )
    let stubPid: number | undefined
    const root = join(dir, "root")
    const moduleUrl = join(import.meta.dir, "..", "..", "..", "tools", "dev", "lease-quarantine.ts")
    try {
      const owner = Bun.spawn(
        [
          process.execPath,
          "-e",
          [
            `import { quarantineLane } from ${JSON.stringify(moduleUrl)}`,
            "quarantineLane({",
            '  repositoryId: "acme/argv",',
            '  groups: [{ pgid: 4242, leaderPid: 4242, verdict: "still-running", detail: "x" }],',
            `  env: { ${LEASE_QUARANTINE_DIR_ENV}: ${JSON.stringify(root)} },`,
            `  keeperScriptPath: ${JSON.stringify(stub)},`,
            "})",
          ].join("\n"),
        ],
        { stdout: "ignore", stderr: "pipe" },
      )
      // The owner EXITS while the stub keeper is still waiting — without `unref`
      // this await would last as long as the keeper does.
      expect(await owner.exited).toBe(0)
      for (let tries = 0; tries < 250 && !existsSync(argvOut); tries += 1) await Bun.sleep(20)
      const reported = JSON.parse(readFileSync(argvOut, "utf8")) as { argv: string[]; pid: number }
      stubPid = reported.pid
      expect(reported.argv).toEqual([laneQuarantinePath("acme/argv", root), "acme/argv"])
      // The keeper this arm started is GONE when the arm ends.
      writeFileSync(release, "")
      const alive = (pid: number): boolean => {
        try {
          process.kill(pid, 0)
          return true
        } catch {
          return false
        }
      }
      for (let tries = 0; tries < 250 && alive(stubPid); tries += 1) await Bun.sleep(20)
      expect(alive(stubPid)).toBe(false)
    } finally {
      rmSync(dir, { recursive: true, force: true })
      if (stubPid !== undefined) {
        try {
          process.kill(stubPid, "SIGKILL")
        } catch {
          // already exited, which is the expected path
        }
      }
    }
  }, 20_000)
})

/**
 * ★ Second adversarial audit of the quarantine (f14f3dae9).
 *
 * Every arm here reproduces something an auditor ran against the committed code:
 * the keeper deleting an expired record over live groups, read errors reading
 * as an empty lane, an unbounded expiry, a non-idempotent key, a replaced record
 * losing its survivors, and three mutants that left the whole file green.
 */
describe("the lane is cleared only by its holder, and an error is not an empty lane", () => {
  const G = (pgid: number) => ({ pgid, leaderPid: pgid, verdict: "still-running", detail: "live" })
  const withRoot = async (
    fn: (root: string, env: Record<string, string>) => Promise<void> | void,
  ) => {
    const base = mkdtempSync(join(tmpdir(), "lane-audit-"))
    const root = join(base, "root")
    mkdirSync(root, { mode: 0o700 })
    try {
      await fn(root, { [LEASE_QUARANTINE_DIR_ENV]: root })
    } finally {
      chmodSync(root, 0o700)
      rmSync(base, { recursive: true, force: true })
    }
  }
  const refusedWith = async (identity: string, env: Record<string, string>): Promise<string> => {
    const waits: string[] = []
    await expect(
      acquireTestShardLease({
        identity,
        env,
        waitMs: 150,
        pollMs: 10,
        heartbeatMs: 0,
        isGroupAlive: () => true,
        onQuarantineWait: (reason) => waits.push(reason),
      }),
    ).rejects.toThrow(/timed out/)
    return waits.join(" ")
  }

  test("REAL KEEPER — an expired record over a live group is left for the holder, who keeps and reports it", async () => {
    await withRoot(async (root, env) => {
      const identity = `keeper-expiry/${process.pid}-${Date.now()}`
      const path = laneQuarantinePath(identity, root)
      // A group that is really alive: this test process's own.
      const pgid = Number(
        Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(process.pid)])
          .stdout.toString()
          .trim(),
      )
      expect(pgid).toBeGreaterThan(0)
      const past = Date.now() - QUARANTINE_TTL_MS - 5_000
      const expired = record({
        repositoryId: identity,
        survivors: [G(pgid)],
        createdAtMs: past,
        expiresAtMs: past + QUARANTINE_TTL_MS,
      })
      writeLeaseQuarantine(path, expired)
      const keeper = Bun.spawn([process.execPath, KEEPER_SCRIPT_PATH, path, identity], {
        stdout: "ignore",
        stderr: "pipe",
      })
      expect(await keeper.exited).toBe(0)
      expect(await new Response(keeper.stderr).text()).toContain("left for the next lane holder")
      // The keeper deleted this record, which is why the fix below never ran.
      expect(existsSync(path)).toBe(true)
      const released: string[] = []
      const lease = await acquireTestShardLease({
        identity,
        env,
        waitMs: 2_000,
        pollMs: 10,
        onQuarantineRelease: (reason) => released.push(reason),
      })
      lease.release()
      expect(released.join(" ")).toContain("STILL ALIVE")
      expect(existsSync(expiredQuarantinePath(path, expired))).toBe(true)
    })
  }, 30_000)

  test("a record that cannot be READ blocks: chmod 000, a directory at the slot, an unreadable root", async () => {
    await withRoot(async (root, env) => {
      const locked = `unreadable-file/${process.pid}-${Date.now()}`
      const lockedPath = laneQuarantinePath(locked, root)
      writeLeaseQuarantine(
        lockedPath,
        record({
          repositoryId: locked,
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + QUARANTINE_TTL_MS,
        }),
      )
      chmodSync(lockedPath, 0o000)
      expect(readLeaseQuarantineOutcome(lockedPath).kind).toBe("unreadable")
      expect(await refusedWith(locked, env)).toContain("EACCES")
      chmodSync(lockedPath, 0o600)

      const directory = `directory-at-slot/${process.pid}-${Date.now()}`
      mkdirSync(laneQuarantinePath(directory, root))
      expect(await refusedWith(directory, env)).toContain("EISDIR")

      // A root that cannot be searched: not even the record's mtime can be read,
      // which used to date it to 1970 — past every TTL — and grant the lane.
      const searchless = `searchless-root/${process.pid}-${Date.now()}`
      writeLeaseQuarantine(
        laneQuarantinePath(searchless, root),
        record({
          repositoryId: searchless,
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + QUARANTINE_TTL_MS,
        }),
      )
      chmodSync(root, 0o000)
      try {
        expect(await refusedWith(searchless, env)).toContain("EACCES")
      } finally {
        chmodSync(root, 0o700)
      }
    })
  }, 30_000)

  test("a root that is not ours blocks the reader; a loose mode on our own root is tightened", async () => {
    const base = mkdtempSync(join(tmpdir(), "lane-root-"))
    try {
      const real = join(base, "real")
      mkdirSync(real, { mode: 0o700 })
      const link = join(base, "link")
      symlinkSync(real, link)
      const identity = `symlink-root/${process.pid}-${Date.now()}`
      const reason = await refusedWith(identity, { [LEASE_QUARANTINE_DIR_ENV]: link })
      expect(reason).toContain("the quarantine root is unusable")
      // The writer refuses the same root and falls back to the per-clone file.
      const cache = join(base, "cache")
      const lines: string[] = []
      const written = quarantineLane({
        repositoryId: identity,
        groups: [G(4242)],
        env: { [LEASE_QUARANTINE_DIR_ENV]: link },
        legacyCacheRoot: cache,
        spawnKeeper: () => 1,
        log: (line) => lines.push(line),
      })
      expect(readLeaseQuarantine(legacyQuarantinePath(cache))?.createdAtMs).toBe(
        written.createdAtMs,
      )
      expect(written.keeperPid).toBeNull()
      expect(lines.join("")).toContain("per-clone legacy file")
      // ...and with nowhere to fall back to, it throws rather than returning a record nobody wrote.
      expect(() =>
        quarantineLane({
          repositoryId: identity,
          groups: [G(4242)],
          env: { [LEASE_QUARANTINE_DIR_ENV]: link },
          spawnKeeper: () => 1,
        }),
      ).toThrow(/no legacy location/)

      // PAIRED CONTROL: our own root at 0777 is a umask, not an attack.
      const loose = join(base, "loose")
      mkdirSync(loose)
      chmodSync(loose, 0o777)
      quarantineLane({
        repositoryId: `loose/${process.pid}`,
        groups: [G(1)],
        env: { [LEASE_QUARANTINE_DIR_ENV]: loose },
        spawnKeeper: () => 1,
      })
      expect(statSync(loose).mode & 0o777).toBe(0o700)
    } finally {
      rmSync(base, { recursive: true, force: true })
    }
  }, 30_000)

  test("a record's expiry is capped by its creation and its file, not by what it says", () => {
    const now = 10_000_000
    const forever = record({ createdAtMs: now, expiresAtMs: Number.MAX_SAFE_INTEGER })
    expect(effectiveQuarantineExpiry(forever)).toBe(now + QUARANTINE_TTL_MS)
    const future = record({
      createdAtMs: now * 1_000,
      expiresAtMs: now * 1_000 + QUARANTINE_TTL_MS,
    })
    expect(effectiveQuarantineExpiry(future, now)).toBe(now + QUARANTINE_TTL_MS)
    // Behaviour, not just the helper: all survivors dead is not the point — it
    // blocks while alive, and stops at the capped ceiling even while alive.
    const read: LeaseQuarantineRead = { kind: "record", record: forever }
    expect(
      laneSlotVerdict({ read, identity: "owner/repo", nowMs: now + 1, isAlive: () => true }).kind,
    ).toBe("blocked")
    expect(
      laneSlotVerdict({
        read,
        identity: "owner/repo",
        nowMs: now + QUARANTINE_TTL_MS,
        isAlive: () => true,
      }).kind,
    ).toBe("stale")
    const misfiled: LeaseQuarantineRead = {
      kind: "record",
      record: record({
        repositoryId: "other/repo",
        createdAtMs: now,
        expiresAtMs: Number.MAX_SAFE_INTEGER,
      }),
    }
    expect(
      laneSlotVerdict({
        read: misfiled,
        identity: "owner/repo",
        nowMs: now + QUARANTINE_TTL_MS,
        isAlive: () => false,
      }).kind,
    ).toBe("stale")
  })

  test("the identity key is idempotent, so a writer's record lands in the slot it reads", () => {
    const inputs = [
      "git@github.com:acme/repo.git",
      "https://github.com/acme/repo.git.git",
      "acme/repo.git/",
      "host: acme/repo",
      "  acme/repo  ",
      "acme/r2d-e.git.git",
    ]
    for (const input of inputs) {
      const once = normalizeRepositoryIdentity(input)
      expect({ input, twice: normalizeRepositoryIdentity(once) }).toEqual({ input, twice: once })
    }
    expect(normalizeRepositoryIdentity("acme/r2d-e.git.git")).toBe("acme/r2d-e")
  })

  test("a replaced record keeps what it cannot read, carries a misfiled live group, and survives a failed mirror", async () => {
    await withRoot((root, env) => {
      const identity = `replace/${process.pid}-${Date.now()}`
      const path = laneQuarantinePath(identity, root)
      writeFileSync(path, '{"schema":"quanta.lease-quarantine.v3","survivors":[{"pgid":6161}]}')
      const lines: string[] = []
      quarantineLane({
        repositoryId: identity,
        groups: [G(7171)],
        env,
        spawnKeeper: () => 1,
        log: (l) => lines.push(l),
      })
      const displaced = readdirSync(root).filter((name) => name.includes(".displaced-"))
      expect(displaced).toHaveLength(1)
      expect(readFileSync(join(root, displaced[0] ?? ""), "utf8")).toContain("6161")
      expect(lines.join("")).toContain("was moved to")

      writeLeaseQuarantine(
        path,
        record({
          repositoryId: "other/misfiled",
          survivors: [G(8181)],
          createdAtMs: Date.now(),
          expiresAtMs: Date.now() + QUARANTINE_TTL_MS,
        }),
      )
      quarantineLane({
        repositoryId: identity,
        groups: [G(9191)],
        env,
        isAlive: () => true,
        spawnKeeper: () => 1,
      })
      expect(readLeaseQuarantine(path)?.survivors.map((g) => g.pgid)).toEqual([9191, 8181])

      // A legacy root that is a FILE: the mirror throws after the slot is written.
      const notADirectory = join(root, "not-a-dir")
      writeFileSync(notADirectory, "")
      const mirrored = quarantineLane({
        repositoryId: identity,
        groups: [G(1)],
        env,
        legacyCacheRoot: notADirectory,
        spawnKeeper: () => 1,
        isAlive: () => false,
      })
      expect(readLeaseQuarantine(path)?.createdAtMs).toBe(mirrored.createdAtMs)
    })
  })

  test("the legacy mirror is REFRESHED for the same identity, not left holding the old record", async () => {
    await withRoot((root, env) => {
      const cache = join(root, "cache")
      const identity = `refresh/${process.pid}-${Date.now()}`
      writeLeaseQuarantine(
        legacyQuarantinePath(cache),
        record({ repositoryId: identity, createdAtMs: 5 }),
      )
      const fresh = quarantineLane({
        repositoryId: identity,
        groups: [G(1)],
        env,
        legacyCacheRoot: cache,
        spawnKeeper: () => 1,
      })
      expect(readLeaseQuarantine(legacyQuarantinePath(cache))?.createdAtMs).toBe(fresh.createdAtMs)
    })
  })
})
