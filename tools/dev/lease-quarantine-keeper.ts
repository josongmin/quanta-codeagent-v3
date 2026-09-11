/**
 * `tools/dev/lease-quarantine-keeper` — watch the survivors out, then release.
 *
 * Detached on purpose: the campaign that wrote the quarantine is about to exit,
 * and something has to observe the processes it could not account for. The
 * keeper holds no socket and grants nothing — it only removes the record once
 * the groups are gone, so a keeper that dies costs an expiry wait rather than a
 * stranded lane. `quarantineVerdict` re-derives liveness from the SURVIVORS on
 * every read, so correctness never depends on this process being alive.
 */

import {
  clearLeaseQuarantine,
  type LeaseQuarantineRecord,
  quarantineVerdict,
  readLeaseQuarantine,
} from "./lease-quarantine"

const POLL_MS = 1_000

const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === "EPERM"
  }
}

export const keeperTick = (
  record: LeaseQuarantineRecord | undefined,
  repositoryId: string,
  nowMs: number,
  isAlive: (pgid: number) => boolean,
): "hold" | "release" => {
  const verdict = quarantineVerdict({ record, repositoryId, nowMs, isAlive })
  return verdict.kind === "blocked" ? "hold" : "release"
}

if (import.meta.main) {
  const path = process.argv[2]
  const repositoryId = process.argv[3]
  if (path === undefined || repositoryId === undefined) {
    process.stderr.write("lease-quarantine-keeper: usage <quarantine-path> <repository-id>\n")
    process.exit(2)
  }
  for (;;) {
    const record = readLeaseQuarantine(path)
    if (keeperTick(record, repositoryId, Date.now(), groupAlive) === "release") {
      clearLeaseQuarantine(path)
      process.stderr.write(`[quarantine] released ${repositoryId}\n`)
      process.exit(0)
    }
    await Bun.sleep(POLL_MS)
  }
}
