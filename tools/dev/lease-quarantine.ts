/**
 * `tools/dev/lease-quarantine` — the lane is not free just because we exited.
 *
 * # The defect
 *
 * Both campaign owners did the same thing on a failed drain: set
 * `process.exitCode = 1`, print "refusing to bless this run", and then call
 * `lease?.release()` unconditionally. The verdict was honest and the HANDOFF
 * was not — the next contender acquired a lane where the previous campaign's
 * workers still held ports, `$HOME`, worktrees and the shared cache. That is
 * an isolation break that surfaces as an unrelated flake in someone else's run.
 *
 * # Why not "just don't release"
 *
 * The lease is a TCP listener on a hashed port. The kernel closes it when the
 * process exits, so skipping `release()` buys nothing at all: the lane is free
 * the instant the runner returns. Holding the lane requires something that
 * OUTLIVES the campaign.
 *
 * # Why a record and not a socket handoff
 *
 * Passing a bound listener to a detached child means inheriting a file
 * descriptor across a spawn, and the window between "parent releases" and
 * "keeper binds" is a race a third contender can win — in which case the
 * quarantine silently did nothing.
 *
 * A record has no such window: it is written BEFORE the lease is released, and
 * `acquireTestShardLease` consults it. The keeper's only job is to delete the
 * record once the survivors are gone, and its own death is not a bypass —
 * liveness is re-derived from the SURVIVORS on every read, so a record whose
 * survivors have exited is stale no matter who is holding it.
 */

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const LEASE_QUARANTINE_SCHEMA = "quanta.lease-quarantine.v1" as const

/** A process group the campaign could not account for. */
export interface QuarantinedGroup {
  readonly pgid: number
  /** Leader pid as recorded at spawn; `-1` when the leader had already exited. */
  readonly leaderPid: number
  /**
   * What the identity check concluded — the same vocabulary
   * `classifyKillTarget` uses, so the record says WHY the group was left alone
   * rather than only that it was.
   */
  readonly verdict: string
  readonly detail: string
}

export interface LeaseQuarantineRecord {
  readonly schema: typeof LEASE_QUARANTINE_SCHEMA
  readonly repositoryId: string
  /** The process that promised to watch the survivors out. */
  readonly keeperPid: number
  readonly survivors: readonly QuarantinedGroup[]
  readonly createdAtMs: number
  /**
   * Hard stop. A quarantine that outlives this is a bug in the keeper, not a
   * reason to block the lane forever — the ceiling is what keeps a crashed
   * keeper from bricking verification for everyone.
   */
  readonly expiresAtMs: number
}

export const quarantinePath = (cacheRoot: string): string =>
  join(cacheRoot, "lease-quarantine.json")

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value)

const isGroup = (value: unknown): value is QuarantinedGroup => {
  if (typeof value !== "object" || value === null) return false
  const row = value as Partial<QuarantinedGroup>
  return (
    isCount(row.pgid) &&
    (row.pgid as number) > 0 &&
    isCount(row.leaderPid) &&
    typeof row.verdict === "string" &&
    row.verdict !== "" &&
    typeof row.detail === "string"
  )
}

export const parseLeaseQuarantine = (candidate: unknown): LeaseQuarantineRecord | undefined => {
  if (typeof candidate !== "object" || candidate === null) return undefined
  const row = candidate as Partial<LeaseQuarantineRecord>
  if (row.schema !== LEASE_QUARANTINE_SCHEMA) return undefined
  if (typeof row.repositoryId !== "string" || row.repositoryId === "") return undefined
  if (!isCount(row.keeperPid) || (row.keeperPid as number) <= 0) return undefined
  if (!isCount(row.createdAtMs) || !isCount(row.expiresAtMs)) return undefined
  if (!Array.isArray(row.survivors) || row.survivors.length === 0) return undefined
  if (!row.survivors.every(isGroup)) return undefined
  return row as LeaseQuarantineRecord
}

export type QuarantineVerdict =
  | { readonly kind: "clear" }
  | { readonly kind: "blocked"; readonly reason: string; readonly alive: readonly number[] }
  | { readonly kind: "stale"; readonly reason: string }

/**
 * May a contender take the lane?
 *
 * Liveness is decided by the SURVIVORS, never by the keeper: a keeper that was
 * itself killed must not strand the lane, and a keeper that is still running
 * must not hold it after the processes it was watching are gone. The keeper pid
 * is recorded for forensics and for the operator, not as the gate.
 */
export const quarantineVerdict = (input: {
  readonly record: LeaseQuarantineRecord | undefined
  readonly repositoryId: string
  readonly nowMs: number
  readonly isAlive: (pgid: number) => boolean
}): QuarantineVerdict => {
  const { record, repositoryId, nowMs, isAlive } = input
  if (record === undefined) return { kind: "clear" }
  if (record.repositoryId !== repositoryId) {
    return { kind: "stale", reason: `quarantine belongs to "${record.repositoryId}"` }
  }
  if (nowMs >= record.expiresAtMs) {
    return {
      kind: "stale",
      reason: `quarantine expired ${nowMs - record.expiresAtMs}ms ago (keeper pid ${record.keeperPid})`,
    }
  }
  const alive = record.survivors.map((group) => group.pgid).filter((pgid) => isAlive(pgid))
  if (alive.length === 0) {
    return { kind: "stale", reason: "every quarantined group has exited" }
  }
  return {
    kind: "blocked",
    reason:
      `lane quarantined by pid ${record.keeperPid}: ` +
      `${alive.length} of ${record.survivors.length} group(s) still alive ` +
      `(${alive.join(", ")})`,
    alive,
  }
}

export const writeLeaseQuarantine = (path: string, record: LeaseQuarantineRecord): void => {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${record.keeperPid}`
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`)
  renameSync(temporary, path)
}

export const readLeaseQuarantine = (path: string): LeaseQuarantineRecord | undefined => {
  try {
    return parseLeaseQuarantine(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return undefined
  }
}

/** Remove a record. Safe when absent; never throws into a teardown path. */
export const clearLeaseQuarantine = (path: string): void => {
  try {
    rmSync(path, { force: true })
  } catch {
    /* a quarantine we cannot delete is re-evaluated against live survivors on
     * the next read, so failing to remove it is not a correctness problem. */
  }
}

/** How long a quarantine may block the lane before it is treated as a bug. */
export const QUARANTINE_TTL_MS = 30 * 60_000

export interface QuarantineHandoffInput {
  readonly path: string
  readonly repositoryId: string
  readonly groups: readonly QuarantinedGroup[]
  readonly nowMs?: number
  /** Injected so the handoff is testable without detaching a real process. */
  readonly spawnKeeper?: (path: string, repositoryId: string) => number
  readonly log?: (line: string) => void
}

const spawnDetachedKeeper = (path: string, repositoryId: string): number => {
  const child = Bun.spawn(
    ["bun", join(import.meta.dir, "lease-quarantine-keeper.ts"), path, repositoryId],
    { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
  )
  child.unref()
  return child.pid
}

/**
 * Hold the lane for a campaign that could not account for its workers.
 *
 * Written BEFORE the caller releases its lease, because the kernel frees the
 * port the instant this process exits and a record written afterwards has a
 * window a contender can win. Returns the record so the caller can put the
 * survivors, their identity verdicts and the keeper's pid in its receipt —
 * "refusing to bless this run" with no forensics is how these end up
 * unattributable.
 */
export const quarantineLane = (input: QuarantineHandoffInput): LeaseQuarantineRecord => {
  const nowMs = input.nowMs ?? Date.now()
  const keeperPid = (input.spawnKeeper ?? spawnDetachedKeeper)(input.path, input.repositoryId)
  const record: LeaseQuarantineRecord = {
    schema: LEASE_QUARANTINE_SCHEMA,
    repositoryId: input.repositoryId,
    keeperPid,
    survivors: input.groups,
    createdAtMs: nowMs,
    expiresAtMs: nowMs + QUARANTINE_TTL_MS,
  }
  writeLeaseQuarantine(input.path, record)
  input.log?.(
    `[quarantine] lane held for ${input.repositoryId}: ` +
      `${input.groups.length} group(s) [${input.groups.map((g) => `${g.pgid}:${g.verdict}`).join(", ")}] ` +
      `keeper=${keeperPid} ttl=${QUARANTINE_TTL_MS}ms\n`,
  )
  return record
}
