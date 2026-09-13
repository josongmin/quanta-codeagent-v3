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

import { createHash } from "node:crypto"
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { normalizeRepositoryIdentity } from "./repository-identity"

/**
 * v2 allows a record with NO keeper. v1 is still read: a record written by an
 * older checkout must keep blocking the lane it was written for.
 */
export const LEASE_QUARANTINE_SCHEMA = "quanta.lease-quarantine.v2" as const
const LEASE_QUARANTINE_SCHEMA_V1 = "quanta.lease-quarantine.v1"

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
  readonly schema: typeof LEASE_QUARANTINE_SCHEMA | typeof LEASE_QUARANTINE_SCHEMA_V1
  readonly repositoryId: string
  /**
   * The process that promised to watch the survivors out, or `null` when none
   * could be started. A keeperless record still blocks exactly while its
   * survivors live: liveness never came from the keeper.
   */
  readonly keeperPid: number | null
  /** Why no keeper runs, when `keeperPid` is `null`. */
  readonly keeperRefusal?: string
  readonly survivors: readonly QuarantinedGroup[]
  readonly createdAtMs: number
  /**
   * Hard stop. A quarantine that outlives this is a bug in the keeper, not a
   * reason to block the lane forever — the ceiling is what keeps a crashed
   * keeper from bricking verification for everyone.
   */
  readonly expiresAtMs: number
}

/** Absolute directory override for the quarantine root. Tests use it; production does not. */
export const LEASE_QUARANTINE_DIR_ENV = "QUANTA_LEASE_QUARANTINE_DIR"

/**
 * One directory per HOST USER, because the lane it protects is one port per host.
 *
 * # Why not the git common-dir, where it was
 *
 * The lease is a listener on a port hashed from the committed repository
 * identity, so two CLONES of this repository share one lane — serialising
 * repository copies is exactly why that identity was committed. The quarantine
 * lived under each copy's git common-dir, so two clones shared the port and not
 * the record. MEASURED by an audit with the real identity, cache-root and lease
 * functions: the second copy acquired the lane (port 44934) while a quarantined
 * group of the first was still alive, and the paired control reading the first
 * copy's file was blocked.
 *
 * Not `$TMPDIR` or `$HOME`: shells and the test fence rewrite both, and a root
 * that moves with the environment splits the lane again. A reboot empties /tmp
 * and kills every survivor with it, so a record cannot outlive what it describes.
 */
export const leaseQuarantineRoot = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): string => {
  const override = env[LEASE_QUARANTINE_DIR_ENV]
  if (override !== undefined && override !== "") {
    if (!isAbsolute(override)) {
      throw new Error(`[quarantine] ${LEASE_QUARANTINE_DIR_ENV} must be absolute: "${override}"`)
    }
    return override
  }
  return join("/tmp", `quanta-lease-quarantine-${process.getuid?.() ?? "nouid"}`)
}

/**
 * The slot for ONE identity. A hash, because identities carry `/` and `:`, and
 * of the NORMALISED identity, so a writer holding the raw remote and a gate
 * holding the normalised key meet at the same file.
 *
 * One file per git common-dir was shared by every identity that common-dir ever
 * saw, and a second identity's write overwrote the first's record.
 */
export const laneQuarantinePath = (
  identity: string,
  root: string = leaseQuarantineRoot(),
): string => {
  const key = normalizeRepositoryIdentity(identity)
  if (key === "") throw new Error("[quarantine] refusing a slot for an empty identity")
  const digest = createHash("sha256").update(key).digest("hex").slice(0, 32)
  return join(root, `lease-quarantine-${digest}.json`)
}

/**
 * TRANSITION ONLY: the old shared leaf under the git common-dir. Read so a live
 * record written by an older checkout still blocks, and mirrored for older
 * readers. `quarantinePath` is gone rather than aliased, so an old call site
 * fails typecheck instead of quietly keeping the shared leaf.
 */
export const legacyQuarantinePath = (cacheRoot: string): string =>
  join(cacheRoot, "lease-quarantine.json")

/** `kill(-pgid, 0)`: existence only. EPERM means it exists and is not ours — still a hazard. */
export const groupAlive = (pgid: number): boolean => {
  try {
    process.kill(-pgid, 0)
    return true
  } catch (error) {
    return (error as { code?: string }).code === "EPERM"
  }
}

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
  if (row.schema !== LEASE_QUARANTINE_SCHEMA && row.schema !== LEASE_QUARANTINE_SCHEMA_V1)
    return undefined
  if (typeof row.repositoryId !== "string" || row.repositoryId === "") return undefined
  const keeperless = row.schema === LEASE_QUARANTINE_SCHEMA && row.keeperPid === null
  if (!keeperless && (!isCount(row.keeperPid) || (row.keeperPid as number) <= 0)) return undefined
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
    // names the groups it is releasing over — and, since an audit showed nothing
    // printed or kept that reason, the gate now hands it to `onQuarantineRelease`
    // and preserves an expired record over live groups instead of deleting it.
    const expiredForMs = nowMs - record.expiresAtMs
    return {
      kind: "stale",
      reason:
        alive.length === 0
          ? `quarantine expired ${expiredForMs}ms ago (keeper pid ${record.keeperPid ?? "none"}); ` +
            "every quarantined group has exited"
          : `quarantine expired ${expiredForMs}ms ago (keeper pid ${record.keeperPid ?? "none"}) with ` +
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
      `lane quarantined by ${record.keeperPid === null ? "a keeperless record" : `pid ${record.keeperPid}`}: ` +
      `${alive.length} of ${record.survivors.length} group(s) still alive ` +
      `(${alive.join(", ")})`,
    alive,
  }
}

export const writeLeaseQuarantine = (path: string, record: LeaseQuarantineRecord): void => {
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp-${process.pid}`
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
      reason: "json does not satisfy quanta.lease-quarantine.v1 or v2",
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
  readonly repositoryId: string
  readonly groups: readonly QuarantinedGroup[]
  /**
   * No `path`: a call site cannot pick a location. The slot comes from the
   * identity and the root; tests move the root through this env only.
   */
  readonly env?: Readonly<Record<string, string | undefined>>
  /** The git common-dir cache, for the transition mirror older checkouts read. */
  readonly legacyCacheRoot?: string
  readonly nowMs?: number
  readonly isAlive?: (pgid: number) => boolean
  /** Injected so the handoff is testable without detaching a real process. */
  readonly spawnKeeper?: (
    path: string,
    repositoryId: string,
    legacyPath: string | undefined,
  ) => number
  /**
   * Injected so an arm can drive the REAL default spawner without moving a
   * tracked file. Every other arm replaces the spawner entirely, which is what
   * left the default untested.
   */
  readonly keeperScriptPath?: string
  readonly log?: (line: string) => void
}

/** The keeper script this module spawns. Exported so a test can prove it exists. */
export const KEEPER_SCRIPT_PATH = join(import.meta.dir, "lease-quarantine-keeper.ts")

/**
 * Why the default spawner cannot start a keeper, or `undefined` when it can.
 *
 * A decision an arm drives, not an `if`: the arm that preceded it was
 * `expect(source).toContain("refusing to write a record")`, which survives the
 * check being deleted and the sentence left in a comment.
 */
export const keeperSpawnRefusal = (
  scriptPath: string = KEEPER_SCRIPT_PATH,
  exists: (path: string) => boolean = existsSync,
): string | undefined =>
  exists(scriptPath) ? undefined : `[quarantine] keeper script missing at ${scriptPath}`

/** Detached keeper; its stderr goes to a log beside the slot, not to nowhere. */
const spawnDetachedKeeper = (
  path: string,
  repositoryId: string,
  legacyPath: string | undefined,
  scriptPath: string = KEEPER_SCRIPT_PATH,
): number => {
  const refusal = keeperSpawnRefusal(scriptPath)
  if (refusal !== undefined) throw new Error(refusal)
  const log = openSync(`${path}.keeper.log`, "a")
  const child = Bun.spawn(
    ["bun", scriptPath, path, repositoryId, ...(legacyPath === undefined ? [] : [legacyPath])],
    {
      stdin: "ignore",
      stdout: "ignore",
      stderr: log,
    },
  )
  child.unref()
  return child.pid
}

/** A private directory we own, not a symlink a stranger planted in /tmp. */
const ensurePrivateDirectory = (directory: string): void => {
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const stat = lstatSync(directory)
  const uid = process.getuid?.()
  if (!stat.isDirectory() || stat.isSymbolicLink() || (uid !== undefined && stat.uid !== uid)) {
    throw new Error(
      `[quarantine] refusing ${directory}: not a private directory owned by uid ${uid}`,
    )
  }
}

/**
 * What a record in OUR slot naming another identity means.
 *
 * With one slot per identity it is not a stranger's lane — it is MISFILED:
 * something wrote to our slot. Fail closed until its own ceiling. `foreign` keeps
 * its old meaning only for the shared legacy file, where two identities
 * genuinely coexisted.
 */
export const laneSlotVerdict = (input: {
  readonly read: LeaseQuarantineRead
  readonly identity: string
  readonly nowMs: number
  readonly isAlive: (pgid: number) => boolean
}): QuarantineVerdict => {
  const key = normalizeRepositoryIdentity(input.identity)
  const verdict = quarantineVerdict({
    read: input.read,
    repositoryId: key,
    nowMs: input.nowMs,
    isAlive: input.isAlive,
  })
  if (verdict.kind !== "foreign" || input.read.kind !== "record") return verdict
  const record = input.read.record
  return input.nowMs >= record.expiresAtMs
    ? {
        kind: "stale",
        reason: `misfiled record for "${record.repositoryId}" in the slot for "${key}", expired`,
      }
    : {
        kind: "blocked",
        alive: [],
        reason: `misfiled record for "${record.repositoryId}" in the slot for "${key}" until ${record.expiresAtMs}`,
      }
}

/** Where an expired record over LIVE groups is kept instead of being deleted. */
export const expiredQuarantinePath = (path: string, record: LeaseQuarantineRecord): string =>
  `${path}.expired-${record.createdAtMs}.json`

/** Old checkouts read only the legacy file. Write it for them, never over a record we do not own. */
const mirrorLegacyNoClobber = (
  legacy: string,
  record: LeaseQuarantineRecord,
  log: ((line: string) => void) | undefined,
): void => {
  mkdirSync(dirname(legacy), { recursive: true })
  const temporary = `${legacy}.mirror-${process.pid}`
  writeFileSync(temporary, `${JSON.stringify(record, null, 2)}\n`)
  try {
    try {
      linkSync(temporary, legacy)
      return
    } catch (error) {
      if ((error as { code?: string }).code !== "EEXIST") throw error
    }
    const held = readLeaseQuarantineOutcome(legacy)
    if (held.kind === "record" && held.record.repositoryId === record.repositoryId) {
      renameSync(temporary, legacy)
      return
    }
    log?.(
      `[quarantine] legacy mirror left untouched: it holds ${held.kind === "record" ? `"${held.record.repositoryId}"` : held.kind}\n`,
    )
  } finally {
    rmSync(temporary, { force: true })
  }
}

/**
 * Hold the lane for a campaign that could not account for its workers.
 *
 * Written BEFORE the caller releases its lease, because the kernel frees the
 * port the instant this process exits and a record written afterwards has a
 * window a contender can win.
 *
 * # A missing keeper still writes the record
 *
 * It refused, on the claim that a keeperless record "holds the lane for the full
 * TTL, which is worse than not quarantining at all". That is false: liveness is
 * re-derived from the survivors on every read, so a keeperless record frees the
 * lane the moment its survivors exit. Refusing turned "keeper missing" into NO
 * quarantine, and the next contender took a lane with live survivors — measured.
 *
 * # Our own live survivors are merged, not overwritten
 *
 * The runner and the campaign wrapper can both fail to drain in one campaign.
 * Each wrote a fresh record, and the second erased the first one's groups.
 */
export const quarantineLane = (input: QuarantineHandoffInput): LeaseQuarantineRecord => {
  const nowMs = input.nowMs ?? Date.now()
  const key = normalizeRepositoryIdentity(input.repositoryId)
  const path = laneQuarantinePath(key, leaseQuarantineRoot(input.env))
  const legacyPath =
    input.legacyCacheRoot === undefined ? undefined : legacyQuarantinePath(input.legacyCacheRoot)
  ensurePrivateDirectory(dirname(path))
  let keeperPid: number | null = null
  let keeperRefusal: string | undefined
  try {
    keeperPid =
      input.spawnKeeper === undefined
        ? spawnDetachedKeeper(path, key, legacyPath, input.keeperScriptPath)
        : input.spawnKeeper(path, key, legacyPath)
  } catch (error) {
    keeperRefusal = error instanceof Error ? error.message : String(error)
  }
  const isAlive = input.isAlive ?? groupAlive
  const existing = readLeaseQuarantineOutcome(path)
  const carried =
    existing.kind === "record" && existing.record.repositoryId === key
      ? existing.record.survivors.filter(
          (group) =>
            isAlive(group.pgid) && !input.groups.some((fresh) => fresh.pgid === group.pgid),
        )
      : []
  const record: LeaseQuarantineRecord = {
    schema: LEASE_QUARANTINE_SCHEMA,
    repositoryId: key,
    keeperPid,
    ...(keeperRefusal === undefined ? {} : { keeperRefusal }),
    survivors: [...input.groups, ...carried],
    createdAtMs: nowMs,
    expiresAtMs: nowMs + QUARANTINE_TTL_MS,
  }
  writeLeaseQuarantine(path, record)
  if (legacyPath !== undefined) mirrorLegacyNoClobber(legacyPath, record, input.log)
  input.log?.(
    `[quarantine] lane held for ${key} at ${path}: ${record.survivors.length} group(s) ` +
      `[${record.survivors.map((g) => `${g.pgid}:${g.verdict}`).join(", ")}] ` +
      `${keeperPid === null ? `NO KEEPER (${keeperRefusal ?? "unknown"})` : `keeper=${keeperPid}`} ` +
      `ttl=${QUARANTINE_TTL_MS}ms\n`,
  )
  return record
}
