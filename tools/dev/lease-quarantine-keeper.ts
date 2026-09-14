/**
 * `tools/dev/lease-quarantine-keeper` — watch the survivors out, and say when.
 *
 * Detached on purpose: the campaign that wrote the quarantine is about to exit,
 * and something should observe the processes it could not account for. The
 * keeper holds no socket, grants nothing, and — since an audit — DELETES
 * NOTHING. `quarantineVerdict` re-derives liveness from the survivors on every
 * read, so a record whose groups have exited already stops blocking; removing
 * it bought no early release. What deleting did buy, measured:
 *
 *  - an expired record over LIVE groups was removed by the keeper at the TTL, so
 *    the next contender saw nothing, no `.expired-*` record was kept, and
 *    `onQuarantineRelease` never fired — the "kept and reported" fix never ran
 *    whenever a keeper existed;
 *  - the keeper deleted by path, not by record, so a newer campaign's record
 *    written after the keeper's read was the one removed.
 *
 * Clearing is now done only by a contender that HOLDS the lane's port
 * (`test-shard-lease.ts`), which is the one place no second writer can race.
 *
 * "Detached" was a claim about a function named `spawnDetachedKeeper`, and it
 * was false. MEASURED: `Bun.spawn` has no `detached` option and `unref()` only
 * stops the PARENT from waiting — the child keeps the parent's process group
 * (parent pid 26134 pgid 26124, child pid 26152 pgid 26124). A terminal Ctrl-C
 * signals the whole foreground group, so the process spawned to outlive the
 * campaign died with it, and the record then waited out its 30-minute TTL
 * instead of being released the moment the survivors exited. The child leaves
 * the group itself, below.
 */

import { dlopen, FFIType, suffix } from "bun:ffi"
import {
  groupAlive,
  type LeaseQuarantineRead,
  laneSlotVerdict,
  readLeaseQuarantineOutcome,
} from "./lease-quarantine"

const POLL_MS = 1_000

const libcName = (): string =>
  process.platform === "darwin" ? "libSystem.B.dylib" : `libc.${suffix}`

/**
 * Leave the parent's process group, from inside the child.
 *
 * `setsid(2)` is the only portable way in: macOS ships no `setsid(1)` to spawn
 * through, and `nohup` changes signal DISPOSITION rather than group membership.
 * It succeeds precisely because the child is not already a group leader — which
 * is the same measurement that proves the child was in the parent's group.
 *
 * Failure is not fatal. Correctness never depended on this process at all; a
 * keeper in the wrong group costs a TTL wait, and refusing to watch at all
 * costs the same TTL wait plus the diagnosis.
 */
export const detachIntoOwnSession = (): number => {
  try {
    const { symbols } = dlopen(libcName(), { setsid: { args: [], returns: FFIType.i32 } })
    return symbols.setsid()
  } catch {
    return -1
  }
}

/** `watch` keeps polling; `done` exits WITHOUT touching the record. */
export type KeeperAction = "watch" | "done"

export const keeperTick = (
  read: LeaseQuarantineRead,
  repositoryId: string,
  nowMs: number,
  isAlive: (pgid: number) => boolean,
): KeeperAction => {
  // The keeper watches ITS slot, so a record naming another identity is
  // misfiled rather than foreign: it holds until that record's own ceiling.
  const verdict = laneSlotVerdict({ read, identity: repositoryId, nowMs, isAlive })
  // An ABSENT record right after spawn is the write it is waiting for:
  // `quarantineLane` spawns the keeper BEFORE it writes, so that the record can
  // never name a pid that was never started. Watching on absence is bounded by
  // `absentGraceMs` below.
  if (read.kind === "absent") return "watch"
  return verdict.kind === "blocked" ? "watch" : "done"
}

if (import.meta.main) {
  const path = process.argv[2]
  const repositoryId = process.argv[3]
  /** Optional: the legacy shared file this record was mirrored into for older readers. */
  const legacyPath = process.argv[4]
  if (path === undefined || repositoryId === undefined) {
    process.stderr.write(
      "lease-quarantine-keeper: usage <quarantine-path> <repository-id> [legacy-path]\n",
    )
    process.exit(2)
  }
  const session = detachIntoOwnSession()
  process.stderr.write(
    session > 0
      ? `[quarantine] keeper session=${session} pgid=${process.pid}\n`
      : "[quarantine] keeper could NOT leave the campaign's process group; " +
          "a group-wide signal will take it down with the campaign and the record " +
          "will wait out its TTL instead of being released early\n",
  )
  // How long the keeper waits for the record its spawner is about to write.
  // Bounded: a keeper that was started and then abandoned must not poll forever.
  const absentGraceMs = 30_000
  const startedAtMs = Date.now()
  for (;;) {
    const read = readLeaseQuarantineOutcome(path)
    const nowMs = Date.now()
    if (keeperTick(read, repositoryId, nowMs, groupAlive) === "done") {
      const verdict = laneSlotVerdict({ read, identity: repositoryId, nowMs, isAlive: groupAlive })
      process.stderr.write(
        `[quarantine] keeper done for ${repositoryId} at ${new Date(nowMs).toISOString()}: ` +
          `${"reason" in verdict ? verdict.reason : verdict.kind}. The record is left for the next ` +
          `lane holder to clear${legacyPath === undefined ? "" : ` (legacy mirror ${legacyPath} too)`}.\n`,
      )
      process.exit(0)
    }
    if (read.kind === "absent" && nowMs - startedAtMs > absentGraceMs) {
      process.stderr.write(
        `[quarantine] keeper giving up: no record appeared at ${path} within ${absentGraceMs}ms\n`,
      )
      process.exit(0)
    }
    await Bun.sleep(POLL_MS)
  }
}
