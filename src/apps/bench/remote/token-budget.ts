import { randomUUID } from "node:crypto"
import { mkdir, readdir, rm, stat, unlink } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { errMessage } from "@/shared"
import {
  asPositiveInt,
  atomicWriteJson,
  createHeartbeatLoop,
  errorCodeOf,
  parseIsoMs,
  processAlive,
  readJson,
  sleepReal,
} from "./lease-fs"

export interface PatchGenBudgetLease {
  readonly leaseId: string
  readonly label: string
  readonly requestedUnits: number
  readonly units: number
  readonly limit: number
  readonly dir: string
  release(): Promise<void>
}

export interface PatchGenBudgetLeaseState {
  readonly leaseId: string
  readonly label: string
  readonly units: number
  readonly requestedUnits: number
  readonly pid: number
  readonly acquiredAt: string
  readonly heartbeatAt: string
  readonly ageSec: number
  readonly heartbeatAgeSec: number
}

export interface PatchGenBudgetState {
  readonly dir: string
  readonly limit: number
  readonly inUse: number
  readonly available: number
  readonly leases: readonly PatchGenBudgetLeaseState[]
}

export interface AcquirePatchGenBudgetLeaseOptions {
  readonly label: string
  readonly requestedUnits: number
  readonly minUnits?: number
  readonly dir?: string
  readonly limit?: number
  readonly waitMs?: number
  readonly pollMs?: number
  readonly heartbeatMs?: number
  readonly staleLeaseMs?: number
  readonly staleLockMs?: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly onLog?: (msg: string) => void
}

export interface ReadPatchGenBudgetStateOptions {
  readonly dir?: string
  readonly limit?: number
  readonly staleLeaseMs?: number
  readonly staleLockMs?: number
  readonly now?: () => number
}

interface PatchGenBudgetLeaseRecord {
  readonly leaseId: string
  readonly label: string
  readonly requestedUnits: number
  readonly units: number
  readonly pid: number
  readonly acquiredAt: string
  readonly heartbeatAt: string
}

interface MutationLockOptions {
  readonly dir: string
  readonly waitMs: number
  readonly pollMs: number
  readonly staleLockMs: number
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
}

interface ResolvedAcquirePatchGenBudgetLeaseOptions {
  readonly label: string
  readonly requestedUnits: number
  readonly minUnits: number
  readonly dir: string
  readonly stateDir: string
  readonly limit: number
  readonly waitMs: number
  readonly pollMs: number
  readonly heartbeatMs: number
  readonly staleLeaseMs: number
  readonly staleLockMs: number
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly onLog?: (msg: string) => void
}

type PatchGenBudgetAcquireAttempt =
  | { readonly kind: "acquired"; readonly lease: PatchGenBudgetLease }
  | { readonly kind: "waiting"; readonly state: PatchGenBudgetState }

const DEFAULT_PATCH_GEN_BUDGET = 16
const DEFAULT_WAIT_MS = 45 * 60 * 1000
const DEFAULT_POLL_MS = 15_000
const DEFAULT_HEARTBEAT_MS = 15_000
const DEFAULT_STALE_LEASE_MS = 60_000
const DEFAULT_STALE_LOCK_MS = 60_000
const LEASE_SUFFIX = ".lease.json"
const LOCK_DIR = ".lock"
const LOCK_META = "owner.json"
const STATE_DIR_SUFFIX = ".lease-state"

/** Budget waits are owner liveness, not background telemetry.
 *  `unref()` here let a waiter/lease-holder vanish between polls/heartbeats,
 *  silently dropping the budget record while work was still outstanding. */
export const clampPatchGenConcurrency = (raw: number): number =>
  Math.max(1, Math.min(16, Math.trunc(raw) || 1))

export const resolveGlobalPatchGenBudget = (): number => {
  const raw = process.env.QUANTA_BENCH_PATCH_GEN_BUDGET ?? process.env.SWEEP_PATCH_GEN_BUDGET
  const parsed = raw !== undefined && raw !== "" ? Number(raw) : Number.NaN
  return asPositiveInt(parsed, DEFAULT_PATCH_GEN_BUDGET)
}

export const resolvePatchGenBudgetDir = (): string =>
  process.env.QUANTA_BENCH_TOKEN_BUDGET_DIR?.trim() ||
  join(homedir(), ".quanta", "bench-token-budget")

const leasePath = (dir: string, leaseId: string): string => join(dir, `${leaseId}${LEASE_SUFFIX}`)

const budgetStateDir = (dir: string): string =>
  join(dirname(dir), `${basename(dir)}${STATE_DIR_SUFFIX}`)

const invalidLeaseRecordError = (path: string): Error =>
  new Error(`[budget] invalid lease record at ${path}; refusing to ignore accounting`)

const isLeaseRecord = (value: unknown): value is PatchGenBudgetLeaseRecord => {
  if (value === null || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return (
    typeof record.leaseId === "string" &&
    record.leaseId !== "" &&
    typeof record.label === "string" &&
    record.label !== "" &&
    typeof record.requestedUnits === "number" &&
    Number.isFinite(record.requestedUnits) &&
    record.requestedUnits > 0 &&
    typeof record.units === "number" &&
    Number.isFinite(record.units) &&
    record.units > 0 &&
    typeof record.pid === "number" &&
    Number.isFinite(record.pid) &&
    typeof record.acquiredAt === "string" &&
    record.acquiredAt !== "" &&
    typeof record.heartbeatAt === "string" &&
    record.heartbeatAt !== ""
  )
}

const heartbeatAgeMs = (record: PatchGenBudgetLeaseRecord, nowMs: number): number => {
  const at = parseIsoMs(record.heartbeatAt)
  return at === undefined ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - at)
}

const acquiredAgeMs = (record: PatchGenBudgetLeaseRecord, nowMs: number): number => {
  const at = parseIsoMs(record.acquiredAt)
  return at === undefined ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - at)
}

const leaseIsStale = (
  record: PatchGenBudgetLeaseRecord,
  nowMs: number,
  staleLeaseMs: number,
): boolean => heartbeatAgeMs(record, nowMs) > staleLeaseMs && !processAlive(record.pid)

const listLeaseRecords = async (
  dir: string,
  nowMs: number,
  staleLeaseMs: number,
  prune: boolean,
): Promise<PatchGenBudgetLeaseRecord[]> => {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const records: PatchGenBudgetLeaseRecord[] = []
  for (const entry of entries) {
    if (!entry.name.endsWith(LEASE_SUFFIX)) continue
    const path = join(dir, entry.name)
    if (!entry.isFile()) {
      throw invalidLeaseRecordError(path)
    }
    const parsed = await readJson<unknown>(path)
    if (!isLeaseRecord(parsed)) {
      throw invalidLeaseRecordError(path)
    }
    if (leaseIsStale(parsed, nowMs, staleLeaseMs)) {
      if (prune) await unlink(path)
      continue
    }
    records.push(parsed)
  }
  return records.sort(
    (a, b) => a.acquiredAt.localeCompare(b.acquiredAt) || a.leaseId.localeCompare(b.leaseId),
  )
}

const listBudgetLeaseRecords = async (
  dir: string,
  stateDir: string,
  nowMs: number,
  staleLeaseMs: number,
  prune: boolean,
): Promise<PatchGenBudgetLeaseRecord[]> => {
  const authoritative = await listLeaseRecords(stateDir, nowMs, staleLeaseMs, prune)
  if (authoritative.length > 0) return authoritative
  return listLeaseRecords(dir, nowMs, staleLeaseMs, prune)
}

const buildState = (
  dir: string,
  limit: number,
  records: readonly PatchGenBudgetLeaseRecord[],
  nowMs: number,
): PatchGenBudgetState => {
  const leases = records.map((record) => ({
    leaseId: record.leaseId,
    label: record.label,
    units: record.units,
    requestedUnits: record.requestedUnits,
    pid: record.pid,
    acquiredAt: record.acquiredAt,
    heartbeatAt: record.heartbeatAt,
    ageSec: Math.round(acquiredAgeMs(record, nowMs) / 1000),
    heartbeatAgeSec: Math.round(heartbeatAgeMs(record, nowMs) / 1000),
  }))
  const inUse = leases.reduce((sum, lease) => sum + lease.units, 0)
  return {
    dir,
    limit,
    inUse,
    available: Math.max(0, limit - inUse),
    leases,
  }
}

const lockDirPath = (dir: string): string => join(dir, LOCK_DIR)

const lockLooksStale = async (
  dir: string,
  nowMs: number,
  staleLockMs: number,
): Promise<boolean> => {
  const lockDir = lockDirPath(dir)
  const info = await readJson<{ pid?: unknown; acquiredAt?: unknown }>(join(lockDir, LOCK_META))
  const ownerPid =
    typeof info?.pid === "number" && Number.isFinite(info.pid) ? Math.trunc(info.pid) : undefined
  const ownerAcquiredAt =
    typeof info?.acquiredAt === "string" && info.acquiredAt !== ""
      ? parseIsoMs(info.acquiredAt)
      : undefined
  const lockStat = await stat(lockDir).catch(() => undefined)
  const ageMs =
    ownerAcquiredAt !== undefined
      ? Math.max(0, nowMs - ownerAcquiredAt)
      : lockStat !== undefined
        ? Math.max(0, nowMs - lockStat.mtimeMs)
        : Number.POSITIVE_INFINITY
  if (ageMs <= staleLockMs) return false
  if (ownerPid === undefined) return false
  return !processAlive(ownerPid)
}

const acquireMutationLock = async (opts: MutationLockOptions): Promise<() => Promise<void>> => {
  const startMs = opts.now()
  await mkdir(opts.dir, { recursive: true })
  for (;;) {
    try {
      const lockDir = lockDirPath(opts.dir)
      await mkdir(lockDir)
      await atomicWriteJson(join(lockDir, LOCK_META), {
        pid: process.pid,
        acquiredAt: new Date(opts.now()).toISOString(),
      })
      return async (): Promise<void> => {
        await rm(lockDir, { recursive: true, force: true })
      }
    } catch (err) {
      const code = errorCodeOf(err)
      if (code !== "EEXIST") throw err
      if (await lockLooksStale(opts.dir, opts.now(), opts.staleLockMs)) {
        await rm(lockDirPath(opts.dir), { recursive: true, force: true })
        continue
      }
      if (opts.waitMs > 0 && opts.now() - startMs >= opts.waitMs) {
        throw new Error(
          `[budget] timed out waiting for the global patch-gen budget lock in ${opts.dir}`,
        )
      }
      await opts.sleep(opts.pollMs)
    }
  }
}

const lockOptsForBudgetLease = (
  opts: ResolvedAcquirePatchGenBudgetLeaseOptions,
): MutationLockOptions => ({
  dir: opts.dir,
  waitMs: opts.waitMs,
  pollMs: opts.pollMs,
  staleLockMs: opts.staleLockMs,
  now: opts.now,
  sleep: opts.sleep,
})

const resolveBudgetWaitMs = (value: number | undefined): number =>
  Math.max(0, Math.trunc(value ?? DEFAULT_WAIT_MS) || 0)

const resolveBudgetPollMs = (value: number | undefined): number =>
  Math.max(250, Math.trunc(value ?? DEFAULT_POLL_MS) || DEFAULT_POLL_MS)

const resolveBudgetHeartbeatMs = (value: number | undefined): number =>
  Math.max(1_000, Math.trunc(value ?? DEFAULT_HEARTBEAT_MS) || DEFAULT_HEARTBEAT_MS)

const resolveBudgetStaleLeaseMs = (value: number | undefined, heartbeatMs: number): number =>
  Math.max(heartbeatMs * 2, Math.trunc(value ?? DEFAULT_STALE_LEASE_MS) || DEFAULT_STALE_LEASE_MS)

const resolveBudgetStaleLockMs = (value: number | undefined): number =>
  Math.max(5_000, Math.trunc(value ?? DEFAULT_STALE_LOCK_MS) || DEFAULT_STALE_LOCK_MS)

const resolveAcquirePatchGenBudgetLeaseOptions = (
  opts: AcquirePatchGenBudgetLeaseOptions,
): ResolvedAcquirePatchGenBudgetLeaseOptions => {
  const limit = asPositiveInt(opts.limit ?? resolveGlobalPatchGenBudget(), DEFAULT_PATCH_GEN_BUDGET)
  const requestedUnits = Math.max(1, Math.min(limit, Math.trunc(opts.requestedUnits) || 1))
  const minUnits = Math.max(1, Math.min(requestedUnits, Math.trunc(opts.minUnits ?? 1) || 1))
  const dir = opts.dir ?? resolvePatchGenBudgetDir()
  const stateDir = budgetStateDir(dir)
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? sleepReal
  const waitMs = resolveBudgetWaitMs(opts.waitMs)
  const pollMs = resolveBudgetPollMs(opts.pollMs)
  const heartbeatMs = resolveBudgetHeartbeatMs(opts.heartbeatMs)
  return {
    label: opts.label,
    requestedUnits,
    minUnits,
    dir,
    stateDir,
    limit,
    waitMs,
    pollMs,
    heartbeatMs,
    staleLeaseMs: resolveBudgetStaleLeaseMs(opts.staleLeaseMs, heartbeatMs),
    staleLockMs: resolveBudgetStaleLockMs(opts.staleLockMs),
    now,
    sleep,
    ...(opts.onLog !== undefined ? { onLog: opts.onLog } : {}),
  }
}

const touchBudgetLease = async (
  authoritativePath: string,
  mirrorPath: string,
  record: PatchGenBudgetLeaseRecord,
  now: () => number,
): Promise<void> => {
  const heartbeatAt = new Date(now()).toISOString()
  const nextRecord = {
    ...record,
    heartbeatAt,
  }
  await atomicWriteJson(authoritativePath, nextRecord)
  await atomicWriteJson(mirrorPath, nextRecord)
}

const ensureBudgetReleaseLock = async (
  pendingUnlock: (() => Promise<void>) | undefined,
  opts: ResolvedAcquirePatchGenBudgetLeaseOptions,
): Promise<() => Promise<void>> =>
  pendingUnlock ?? acquireMutationLock(lockOptsForBudgetLease(opts))

const unlinkBudgetLeaseFile = async (
  path: string,
  leaseDeleted: boolean,
  tolerateMissing: boolean,
): Promise<{ readonly leaseDeleted: boolean; readonly error: unknown }> => {
  if (leaseDeleted) {
    return {
      leaseDeleted,
      error: undefined,
    }
  }
  try {
    await unlink(path)
    return {
      leaseDeleted: true,
      error: undefined,
    }
  } catch (err) {
    if (tolerateMissing && errorCodeOf(err) === "ENOENT") {
      return {
        leaseDeleted: true,
        error: undefined,
      }
    }
    return {
      leaseDeleted: false,
      error: err,
    }
  }
}

const releaseBudgetMutationLock = async (
  pendingUnlock: (() => Promise<void>) | undefined,
): Promise<unknown> => {
  if (pendingUnlock === undefined) return undefined
  try {
    await pendingUnlock()
    return undefined
  } catch (err) {
    return err
  }
}

const buildBudgetReleaseError = (leaseId: string, unlinkErr: unknown, unlockErr: unknown): Error =>
  new Error(
    `[budget] release failed for ${leaseId}: primary=${errMessage(unlinkErr)}; cleanup=${errMessage(unlockErr)}`,
  )

const createPatchGenBudgetLeaseHandle = (
  opts: ResolvedAcquirePatchGenBudgetLeaseOptions,
  record: PatchGenBudgetLeaseRecord,
): PatchGenBudgetLease => {
  const authoritativePath = leasePath(opts.stateDir, record.leaseId)
  const mirrorPath = leasePath(opts.dir, record.leaseId)
  const heartbeat = createHeartbeatLoop(opts.heartbeatMs, () =>
    touchBudgetLease(authoritativePath, mirrorPath, record, opts.now),
  )
  let released = false
  let authoritativeDeleted = false
  let mirrorDeleted = false
  let pendingUnlock: (() => Promise<void>) | undefined
  let releaseInFlight: Promise<void> | undefined

  const runRelease = async (): Promise<void> => {
    pendingUnlock = await ensureBudgetReleaseLock(pendingUnlock, opts)
    heartbeat.pause()
    const authoritativeUnlink = await unlinkBudgetLeaseFile(
      authoritativePath,
      authoritativeDeleted,
      false,
    )
    authoritativeDeleted = authoritativeUnlink.leaseDeleted
    const mirrorUnlink = await unlinkBudgetLeaseFile(mirrorPath, mirrorDeleted, true)
    mirrorDeleted = mirrorUnlink.leaseDeleted
    const unlockErr = await releaseBudgetMutationLock(pendingUnlock)
    if (unlockErr === undefined) {
      pendingUnlock = undefined
    }
    if (unlockErr !== undefined) {
      if (!authoritativeDeleted) heartbeat.resume()
      if (authoritativeUnlink.error !== undefined) {
        throw buildBudgetReleaseError(record.leaseId, authoritativeUnlink.error, unlockErr)
      }
      throw unlockErr
    }
    if (authoritativeUnlink.error !== undefined) {
      heartbeat.resume()
      throw authoritativeUnlink.error
    }
    if (mirrorUnlink.error !== undefined) {
      throw mirrorUnlink.error
    }
    heartbeat.stop()
    released = true
  }

  return {
    leaseId: record.leaseId,
    label: opts.label,
    requestedUnits: opts.requestedUnits,
    units: record.units,
    limit: opts.limit,
    dir: opts.dir,
    release: async (): Promise<void> => {
      if (released) return
      if (releaseInFlight !== undefined) return releaseInFlight
      releaseInFlight = runRelease()
      try {
        await releaseInFlight
      } finally {
        releaseInFlight = undefined
      }
    },
  }
}

const tryAcquirePatchGenBudgetLease = async (
  opts: ResolvedAcquirePatchGenBudgetLeaseOptions,
  leaseId: string,
): Promise<PatchGenBudgetAcquireAttempt> => {
  const releaseLock = await acquireMutationLock(lockOptsForBudgetLease(opts))
  try {
    const records = await listBudgetLeaseRecords(
      opts.dir,
      opts.stateDir,
      opts.now(),
      opts.staleLeaseMs,
      true,
    )
    const state = buildState(opts.dir, opts.limit, records, opts.now())
    if (state.available < opts.minUnits) {
      return {
        kind: "waiting",
        state,
      }
    }
    const acquiredAt = new Date(opts.now()).toISOString()
    const record: PatchGenBudgetLeaseRecord = {
      leaseId,
      label: opts.label,
      requestedUnits: opts.requestedUnits,
      units: Math.min(opts.requestedUnits, state.available),
      pid: process.pid,
      acquiredAt,
      heartbeatAt: acquiredAt,
    }
    const authoritativePath = leasePath(opts.stateDir, leaseId)
    const mirrorPath = leasePath(opts.dir, leaseId)
    await atomicWriteJson(authoritativePath, record)
    try {
      await atomicWriteJson(mirrorPath, record)
    } catch (err) {
      await unlink(authoritativePath).catch(() => undefined)
      throw err
    }
    return {
      kind: "acquired",
      lease: createPatchGenBudgetLeaseHandle(opts, record),
    }
  } finally {
    await releaseLock()
  }
}

const holdersSummary = (leases: readonly PatchGenBudgetLeaseState[]): string =>
  leases.length === 0
    ? "none"
    : leases
        .slice(0, 3)
        .map((lease) => `${lease.label}:${lease.units}`)
        .join(", ") + (leases.length > 3 ? ` +${leases.length - 3} more` : "")

export const acquirePatchGenBudgetLease = async (
  opts: AcquirePatchGenBudgetLeaseOptions,
): Promise<PatchGenBudgetLease> => {
  const resolved = resolveAcquirePatchGenBudgetLeaseOptions(opts)
  const leaseId = randomUUID()
  const waitStartedAt = resolved.now()
  let announcedWait = false

  for (;;) {
    const attempt = await tryAcquirePatchGenBudgetLease(resolved, leaseId)
    if (attempt.kind === "acquired") return attempt.lease
    if (!announcedWait) {
      resolved.onLog?.(
        `[budget] waiting for >=${resolved.minUnits} patch-gen token(s); requested=${resolved.requestedUnits}  inUse=${attempt.state.inUse}/${attempt.state.limit}  holders=${holdersSummary(attempt.state.leases)}`,
      )
      announcedWait = true
    }
    if (resolved.waitMs > 0 && resolved.now() - waitStartedAt >= resolved.waitMs) {
      throw new Error(
        `[budget] timed out waiting for >=${resolved.minUnits} patch-gen token(s) for ${resolved.label} (requested=${resolved.requestedUnits})`,
      )
    }
    await resolved.sleep(resolved.pollMs)
  }
}

export const readPatchGenBudgetState = async (
  opts: ReadPatchGenBudgetStateOptions = {},
): Promise<PatchGenBudgetState> => {
  const dir = opts.dir ?? resolvePatchGenBudgetDir()
  const stateDir = budgetStateDir(dir)
  const limit = asPositiveInt(opts.limit ?? resolveGlobalPatchGenBudget(), DEFAULT_PATCH_GEN_BUDGET)
  const now = opts.now ?? (() => Date.now())
  const staleLeaseMs = Math.max(
    1_000,
    Math.trunc(opts.staleLeaseMs ?? DEFAULT_STALE_LEASE_MS) || DEFAULT_STALE_LEASE_MS,
  )
  const staleLockMs = Math.max(
    5_000,
    Math.trunc(opts.staleLockMs ?? DEFAULT_STALE_LOCK_MS) || DEFAULT_STALE_LOCK_MS,
  )
  const releaseLock = await acquireMutationLock({
    dir,
    waitMs: 2_000,
    pollMs: 100,
    staleLockMs,
    now,
    sleep: sleepReal,
  })
  try {
    await mkdir(dir, { recursive: true })
    const records = await listBudgetLeaseRecords(dir, stateDir, now(), staleLeaseMs, true)
    return buildState(dir, limit, records, now())
  } finally {
    await releaseLock()
  }
}
