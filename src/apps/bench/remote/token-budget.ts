import { randomUUID } from "node:crypto"
import { mkdir, readdir, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"

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

const DEFAULT_PATCH_GEN_BUDGET = 16
const DEFAULT_WAIT_MS = 45 * 60 * 1000
const DEFAULT_POLL_MS = 15_000
const DEFAULT_HEARTBEAT_MS = 15_000
const DEFAULT_STALE_LEASE_MS = 60_000
const DEFAULT_STALE_LOCK_MS = 60_000
const LEASE_SUFFIX = ".lease.json"
const LOCK_DIR = ".lock"
const LOCK_META = "owner.json"

/** Budget waits are owner liveness, not background telemetry.
 *  `unref()` here let a waiter/lease-holder vanish between polls/heartbeats,
 *  silently dropping the budget record while work was still outstanding. */
const sleepReal = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

const asPositiveInt = (raw: number, fallback: number): number => {
  const n = Math.trunc(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

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

const parseIsoMs = (value: string): number | undefined => {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

const processAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const leasePath = (dir: string, leaseId: string): string => join(dir, `${leaseId}${LEASE_SUFFIX}`)

const atomicWriteJson = async (path: string, value: unknown): Promise<void> => {
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value)}\n`)
  await rename(tmp, path)
}

const readJson = async <T>(path: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch {
    return undefined
  }
}

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
    if (!entry.isFile() || !entry.name.endsWith(LEASE_SUFFIX)) continue
    const path = join(dir, entry.name)
    const parsed = await readJson<unknown>(path)
    if (!isLeaseRecord(parsed)) {
      if (prune) await unlink(path).catch(() => undefined)
      continue
    }
    if (leaseIsStale(parsed, nowMs, staleLeaseMs)) {
      if (prune) await unlink(path).catch(() => undefined)
      continue
    }
    records.push(parsed)
  }
  return records.sort(
    (a, b) => a.acquiredAt.localeCompare(b.acquiredAt) || a.leaseId.localeCompare(b.leaseId),
  )
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
  return ownerPid === undefined || !processAlive(ownerPid)
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
        await rm(lockDir, { recursive: true, force: true }).catch(() => undefined)
      }
    } catch (err) {
      const code = (err as { code?: string }).code
      if (code !== "EEXIST") throw err
      if (await lockLooksStale(opts.dir, opts.now(), opts.staleLockMs)) {
        await rm(lockDirPath(opts.dir), { recursive: true, force: true }).catch(() => undefined)
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
  const limit = asPositiveInt(opts.limit ?? resolveGlobalPatchGenBudget(), DEFAULT_PATCH_GEN_BUDGET)
  const requestedUnits = Math.max(1, Math.min(limit, Math.trunc(opts.requestedUnits) || 1))
  const minUnits = Math.max(1, Math.min(requestedUnits, Math.trunc(opts.minUnits ?? 1) || 1))
  const dir = opts.dir ?? resolvePatchGenBudgetDir()
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? sleepReal
  const waitMs = Math.max(0, Math.trunc(opts.waitMs ?? DEFAULT_WAIT_MS) || 0)
  const pollMs = Math.max(250, Math.trunc(opts.pollMs ?? DEFAULT_POLL_MS) || DEFAULT_POLL_MS)
  const heartbeatMs = Math.max(
    1_000,
    Math.trunc(opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS) || DEFAULT_HEARTBEAT_MS,
  )
  const staleLeaseMs = Math.max(
    heartbeatMs * 2,
    Math.trunc(opts.staleLeaseMs ?? DEFAULT_STALE_LEASE_MS) || DEFAULT_STALE_LEASE_MS,
  )
  const staleLockMs = Math.max(
    5_000,
    Math.trunc(opts.staleLockMs ?? DEFAULT_STALE_LOCK_MS) || DEFAULT_STALE_LOCK_MS,
  )
  const leaseId = randomUUID()
  const waitStartedAt = now()
  let announcedWait = false

  for (;;) {
    const releaseLock = await acquireMutationLock({
      dir,
      waitMs,
      pollMs,
      staleLockMs,
      now,
      sleep,
    })
    try {
      const records = await listLeaseRecords(dir, now(), staleLeaseMs, true)
      const state = buildState(dir, limit, records, now())
      if (state.available >= minUnits) {
        const grantedUnits = Math.min(requestedUnits, state.available)
        const acquiredAt = new Date(now()).toISOString()
        const record: PatchGenBudgetLeaseRecord = {
          leaseId,
          label: opts.label,
          requestedUnits,
          units: grantedUnits,
          pid: process.pid,
          acquiredAt,
          heartbeatAt: acquiredAt,
        }
        await atomicWriteJson(leasePath(dir, leaseId), record)
        let released = false
        const touch = async (): Promise<void> => {
          if (released) return
          await atomicWriteJson(leasePath(dir, leaseId), {
            ...record,
            heartbeatAt: new Date(now()).toISOString(),
          })
        }
        const heartbeat = setInterval(() => {
          void touch().catch(() => undefined)
        }, heartbeatMs)
        heartbeat.unref?.()
        return {
          leaseId,
          label: opts.label,
          requestedUnits,
          units: grantedUnits,
          limit,
          dir,
          release: async (): Promise<void> => {
            if (released) return
            released = true
            clearInterval(heartbeat)
            const unlock = await acquireMutationLock({
              dir,
              waitMs,
              pollMs,
              staleLockMs,
              now,
              sleep,
            })
            try {
              await unlink(leasePath(dir, leaseId))
            } finally {
              await unlock()
            }
          },
        }
      }
      if (!announcedWait) {
        opts.onLog?.(
          `[budget] waiting for >=${minUnits} patch-gen token(s); requested=${requestedUnits}  inUse=${state.inUse}/${state.limit}  holders=${holdersSummary(state.leases)}`,
        )
        announcedWait = true
      }
    } finally {
      await releaseLock()
    }
    if (waitMs > 0 && now() - waitStartedAt >= waitMs) {
      throw new Error(
        `[budget] timed out waiting for >=${minUnits} patch-gen token(s) for ${opts.label} (requested=${requestedUnits})`,
      )
    }
    await sleep(pollMs)
  }
}

export const readPatchGenBudgetState = async (
  opts: ReadPatchGenBudgetStateOptions = {},
): Promise<PatchGenBudgetState> => {
  const dir = opts.dir ?? resolvePatchGenBudgetDir()
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
    const records = await listLeaseRecords(dir, now(), staleLeaseMs, true)
    return buildState(dir, limit, records, now())
  } finally {
    await releaseLock()
  }
}
