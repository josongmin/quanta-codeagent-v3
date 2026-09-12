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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
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
   * Another repository's lane. Not blocking (it is not about us) and NOT
   * deletable — `stale` is, and a foreign record was being reported as stale.
   *
   * MEASURED: a record written for `owner/repo` with a genuinely live survivor,
   * read as `other/repo`, answered `stale`; the contender's sweep then removed
   * the file, and the OWNER's next contender read `clear` and took a lane whose
   * poisoned processes were still running. One quarantine path per git
   * common-dir, and two identities can coexist there, so this was reachable.
   */
  | { readonly kind: "foreign"; readonly reason: string }

/**
 * May a contender take the lane?
 *
 * Liveness is decided by the SURVIVORS, never by the keeper: a keeper that was
 * itself killed must not strand the lane, and a keeper that is still running
 * must not hold it after the processes it was watching are gone. The keeper pid
 * is recorded for forensics and for the operator, not as the gate.
 */
export const quarantineVerdict = (
  input: {
    /**
     * EXACTLY ONE of these, enforced by the type.
     *
     * Making both optional was a new fail-open one level up: `quarantineVerdict({
     * repositoryId, nowMs, isAlive })` typechecked under `--strict` and answered
     * `clear`, and supplying both silently used `read` with no diagnostic. The
     * union makes "which question are you asking" a thing the caller must say.
     */
    readonly repositoryId: string
    readonly nowMs: number
    readonly isAlive: (pgid: number) => boolean
  } & (
    | { readonly read: LeaseQuarantineRead; readonly record?: never }
    /** Legacy shape. Cannot express "unreadable", so it still maps a corrupt
     *  record to `clear`; kept only for the arms that predate the outcome type. */
    | { readonly record: LeaseQuarantineRecord | undefined; readonly read?: never }
  ),
): QuarantineVerdict => {
  const { repositoryId, nowMs, isAlive } = input
  const read: LeaseQuarantineRead =
    input.read ??
    (input.record === undefined ? { kind: "absent" } : { kind: "record", record: input.record })
  if (read.kind === "absent") return { kind: "clear" }
  if (read.kind === "unreadable") {
    // FAIL CLOSED, bounded by the only metadata a corrupt body cannot corrupt.
    // A record we cannot parse may describe live survivors; treating it as an
    // empty lane is the fail-open this type exists to remove. Past the TTL it is
    // stale like any other, so a corrupt file cannot brick the lane forever.
    const ageMs = nowMs - read.writtenAtMs
    if (ageMs >= QUARANTINE_TTL_MS) {
      return {
        kind: "stale",
        reason: `unreadable quarantine written ${ageMs}ms ago, past the ${QUARANTINE_TTL_MS}ms ttl (${read.reason})`,
      }
    }
    return {
      kind: "blocked",
      reason:
        `lane quarantined by an UNREADABLE record written ${ageMs}ms ago (${read.reason}); ` +
        "refusing the lane because a record we cannot parse may describe live survivors",
      alive: [],
    }
  }
  const record = read.record
  if (record.repositoryId !== repositoryId) {
    return { kind: "foreign", reason: `quarantine belongs to "${record.repositoryId}"` }
  }
  const alive = record.survivors.map((group) => group.pgid).filter((pgid) => isAlive(pgid))
  if (nowMs >= record.expiresAtMs) {
    // THE TTL CEILING IS DELIBERATE — a crashed keeper must not brick
    // verification for everyone — but it was SILENT about the one fact that
    // makes releasing dangerous. Liveness was computed only on the path below,
    // so an expired record released the lane saying "quarantine expired 12ms
    // ago (keeper pid 4242)" whether every survivor had exited or all of them
    // were still running. The contender then took a lane over live poisoned
    // process groups with nothing in any receipt to say so.
    //
    // Still `stale`; the ceiling still wins. What changes is that the release
    // now names the groups it is releasing over, so the campaign receipt that
    // records this verdict records the risk with it.
    const expiredForMs = nowMs - record.expiresAtMs
    return {
      kind: "stale",
      reason:
        alive.length === 0
          ? `quarantine expired ${expiredForMs}ms ago (keeper pid ${record.keeperPid}); ` +
            "every quarantined group has exited"
          : `quarantine expired ${expiredForMs}ms ago (keeper pid ${record.keeperPid}) with ` +
            `${alive.length} of ${record.survivors.length} group(s) STILL ALIVE ` +
            `(${alive.join(", ")}) — the ttl ceiling is releasing a lane whose processes are ` +
            "still running",
    }
  }
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

/**
 * ABSENT and UNREADABLE are different answers, and collapsing them was fail-open.
 *
 * This returned `undefined` for both, and `quarantineVerdict` mapped `undefined`
 * to `clear`. MEASURED — every one of these read as "the lane is free", each
 * indistinguishable from "no quarantine was ever written":
 *
 *   truncated JSON            unreadable -> clear
 *   float createdAtMs         unreadable -> clear
 *   pgid as a string          unreadable -> clear
 *   unknown schema v2         unreadable -> clear
 *   zero-byte file            unreadable -> clear
 *
 * The record is written in a TEARDOWN path — `writeFileSync` then `rename`, from
 * the `finally` of a campaign that just failed to drain — which is precisely when
 * a partial write is likely. So the one input most likely to be malformed was the
 * one treated as permission to take the lane.
 *
 * An unreadable record is now reported as such, and the caller decides with the
 * only metadata that survives a corrupt body: the file's own mtime.
 */
export type LeaseQuarantineRead =
  | { readonly kind: "absent" }
  | { readonly kind: "unreadable"; readonly reason: string; readonly writtenAtMs: number }
  | { readonly kind: "record"; readonly record: LeaseQuarantineRecord }

export const readLeaseQuarantineOutcome = (path: string): LeaseQuarantineRead => {
  let text: string
  try {
    text = readFileSync(path, "utf8")
  } catch {
    return { kind: "absent" }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return {
      kind: "unreadable",
      reason: `unparseable json: ${String(error)}`,
      writtenAtMs: mtimeOf(path),
    }
  }
  const record = parseLeaseQuarantine(parsed)
  if (record === undefined) {
    return {
      kind: "unreadable",
      reason: "json does not satisfy quanta.lease-quarantine.v1",
      writtenAtMs: mtimeOf(path),
    }
  }
  return { kind: "record", record }
}

const mtimeOf = (path: string): number => {
  try {
    return statSync(path).mtimeMs
  } catch {
    return 0
  }
}

/** The record, or `undefined` for absent OR unreadable. Prefer the outcome form:
 *  this shape is what made a corrupt record read as an empty lane. */
export const readLeaseQuarantine = (path: string): LeaseQuarantineRecord | undefined => {
  const outcome = readLeaseQuarantineOutcome(path)
  return outcome.kind === "record" ? outcome.record : undefined
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
  /**
   * Injected so an arm can drive the REAL default spawner's refusal without
   * moving a tracked file. Every other arm replaces the spawner entirely, which
   * is what left the default untested.
   */
  readonly keeperScriptPath?: string
  readonly log?: (line: string) => void
}

/** The keeper script this module spawns. Exported so a test can prove it exists. */
export const KEEPER_SCRIPT_PATH = join(import.meta.dir, "lease-quarantine-keeper.ts")

/**
 * Why the default spawner must refuse, or `undefined` when it may spawn.
 *
 * # Why this is a function and not an `if`
 *
 * It was an `if` inside `spawnDetachedKeeper`, and every arm injects
 * `spawnKeeper` while the detach arm spawns the script directly — so the
 * production default was exercised by nothing. A mutation audit renamed the
 * script to a path that does not exist and the whole suite stayed green. A
 * missing keeper means no record is ever released early and every quarantine
 * waits out its full 30-minute TTL: the exact failure the detach work claimed to
 * fix.
 *
 * The arm added afterwards was `expect(source).toContain("refusing to write a
 * record")` — a SOURCE-STRING guard, which stays green when the check is deleted
 * and the sentence left behind in a comment. That is the defect class this
 * campaign exists to remove, reintroduced in the fix for it. Importable and
 * injectable, so the arms drive the decision instead of grepping for it.
 */
export const keeperSpawnRefusal = (
  scriptPath: string = KEEPER_SCRIPT_PATH,
  exists: (path: string) => boolean = existsSync,
): string | undefined =>
  exists(scriptPath)
    ? undefined
    : `[quarantine] keeper script missing at ${scriptPath}; refusing to write a record ` +
      "whose keeper can never run"

const spawnDetachedKeeper = (
  path: string,
  repositoryId: string,
  scriptPath: string = KEEPER_SCRIPT_PATH,
): number => {
  const refusal = keeperSpawnRefusal(scriptPath)
  if (refusal !== undefined) throw new Error(refusal)
  const child = Bun.spawn(["bun", scriptPath, path, repositoryId], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  })
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
  const keeperPid =
    input.spawnKeeper === undefined
      ? spawnDetachedKeeper(input.path, input.repositoryId, input.keeperScriptPath)
      : input.spawnKeeper(input.path, input.repositoryId)
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
