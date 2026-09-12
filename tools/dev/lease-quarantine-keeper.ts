/**
 * `tools/dev/lease-quarantine-keeper` — watch the survivors out, then release.
 *
 * Detached on purpose: the campaign that wrote the quarantine is about to exit,
 * and something has to observe the processes it could not account for. The
 * keeper holds no socket and grants nothing — it only removes the record once
 * the groups are gone, so a keeper that dies costs an expiry wait rather than a
 * stranded lane. `quarantineVerdict` re-derives liveness from the SURVIVORS on
 * every read, so correctness never depends on this process being alive.
 *
 * "Detached" was a claim about a function named `spawnDetachedKeeper`, and it
 * was false. MEASURED: `Bun.spawn` has no `detached` option and `unref()` only
 * stops the PARENT from waiting — the child keeps the parent's process group
 * (parent pid 26134 pgid 26124, child pid 26152 pgid 26124). A terminal Ctrl-C
 * signals the whole foreground group, so the process spawned to outlive the
 * campaign died with it, and the record then waited out its four-hour TTL
 * instead of being released the moment the survivors exited. The child leaves
 * the group itself, below.
 */

import { dlopen, FFIType, suffix } from "bun:ffi"
import {
  clearLeaseQuarantine,
  type LeaseQuarantineRead,
  type LeaseQuarantineRecord,
  quarantineVerdict,
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

const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === "EPERM"
  }
}

export type KeeperAction = "hold" | "release" | "detach"

export const keeperTick = (
  read: LeaseQuarantineRead,
  repositoryId: string,
  nowMs: number,
  isAlive: (pgid: number) => boolean,
): KeeperAction => {
  const verdict = quarantineVerdict({ read, repositoryId, nowMs, isAlive })
  // `foreign` is somebody else's record: the keeper must neither hold on it nor
  // DELETE it, and `release` deletes. It stops watching instead.
  if (verdict.kind === "foreign") return "detach"
  // An ABSENT record right after spawn is the write it is waiting for:
  // `quarantineLane` spawns the keeper BEFORE it writes, so that the record can
  // never name a pid that was never started. MEASURED: the keeper's first tick
  // against an absent record answered `release`, which deletes — so a keeper that
  // won that race removed the record it existed to watch. Holding on absence is
  // bounded by `absentGraceMs` below.
  if (read.kind === "absent") return "hold"
  return verdict.kind === "blocked" ? "hold" : "release"
}

if (import.meta.main) {
  const path = process.argv[2]
  const repositoryId = process.argv[3]
  if (path === undefined || repositoryId === undefined) {
    process.stderr.write("lease-quarantine-keeper: usage <quarantine-path> <repository-id>\n")
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
    const action = keeperTick(read, repositoryId, Date.now(), groupAlive)
    if (action === "detach") {
      process.stderr.write(
        `[quarantine] keeper detaching: ${repositoryId} does not own this record\n`,
      )
      process.exit(0)
    }
    if (action === "release") {
      clearLeaseQuarantine(path)
      process.stderr.write(`[quarantine] released ${repositoryId}\n`)
      process.exit(0)
    }
    if (read.kind === "absent" && Date.now() - startedAtMs > absentGraceMs) {
      process.stderr.write(
        `[quarantine] keeper giving up: no record appeared at ${path} within ${absentGraceMs}ms\n`,
      )
      process.exit(0)
    }
    await Bun.sleep(POLL_MS)
  }
}
