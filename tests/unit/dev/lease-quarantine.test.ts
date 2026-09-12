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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  clearLeaseQuarantine,
  KEEPER_SCRIPT_PATH,
  LEASE_QUARANTINE_SCHEMA,
  type LeaseQuarantineRead,
  type LeaseQuarantineRecord,
  parseLeaseQuarantine,
  QUARANTINE_TTL_MS,
  quarantineLane,
  quarantinePath,
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
    const path = quarantinePath(dir)
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
    ["unknown schema", JSON.stringify({ ...record(), schema: "quanta.lease-quarantine.v2" })],
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
      const path = quarantinePath(dir)
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
      const path = quarantinePath(dir)
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
    // ...and the guard is in the production path, not just in this assertion.
    expect(readFileSync(KEEPER_SCRIPT_PATH, "utf8")).toContain("export const keeperTick")
    expect(
      readFileSync(
        join(import.meta.dir, "..", "..", "..", "tools/dev/lease-quarantine.ts"),
        "utf8",
      ),
    ).toContain("refusing to write a record")
  })
})

describe("the keeper", () => {
  const held = (row: LeaseQuarantineRecord): LeaseQuarantineRead => ({
    kind: "record",
    record: row,
  })

  test("holds while a group lives, releases once they are gone", () => {
    expect(keeperTick(held(record()), "owner/repo", 2_000, alive(4242))).toBe("hold")
    expect(keeperTick(held(record()), "owner/repo", 2_000, alive())).toBe("release")
  })

  test("DETACHES from a record that is not its own, instead of deleting it", () => {
    // `release` deletes. A keeper that answered `release` on a foreign record
    // removed a live quarantine protecting somebody else's poisoned lane —
    // measured end to end: owner blocked, foreign contender swept, owner then
    // read `clear`.
    expect(
      keeperTick(held(record({ repositoryId: "other/repo" })), "owner/repo", 2_000, alive(4242)),
    ).toBe("detach")
  })

  test("an expired record is released; an ABSENT one is held, not released", () => {
    expect(keeperTick(held(record()), "owner/repo", 1_000 + QUARANTINE_TTL_MS, alive(4242))).toBe(
      "release",
    )
    // `quarantineLane` spawns the keeper BEFORE it writes the record, so that no
    // record ever names a pid that was never started. The keeper's first tick
    // therefore races the write, and answering `release` there DELETED the record
    // it exists to watch. Measured: `recordOnDisk=false -> release`.
    expect(keeperTick({ kind: "absent" }, "owner/repo", 2_000, alive(4242))).toBe("hold")
  })

  test("an UNREADABLE record holds the lane, and stops holding past the TTL", () => {
    const unreadable = (writtenAtMs: number): LeaseQuarantineRead => ({
      kind: "unreadable",
      reason: "unparseable json",
      writtenAtMs,
    })
    expect(keeperTick(unreadable(2_000), "owner/repo", 3_000, alive(4242))).toBe("hold")
    expect(
      keeperTick(unreadable(2_000), "owner/repo", 3_000 + QUARANTINE_TTL_MS, alive(4242)),
    ).toBe("release")
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

    for (const { file, call } of found) {
      expect({ file, quarantineChecked: call.includes("quarantinePath") }).toEqual({
        file,
        quarantineChecked: true,
      })
    }
  })

  test("acquisition consults the quarantine before accepting a bind", () => {
    const lease = source("tools/dev/test-shard-lease.ts")
    expect(lease).toContain("quarantineBlock(identity, options)")
    // Checked BEFORE the bind, because a free PORT is not a free LANE.
    // Matched on the call NAME, not its argument list: pinning
    // `tryListen(port, digest)` broke the moment the listener gained a token
    // parameter, which is the brittleness this file criticises elsewhere.
    const check = lease.indexOf("quarantineBlock(identity, options)")
    const bind = lease.indexOf("tryListen(", check)
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
