import { mkdir, rm, stat } from "node:fs/promises"
import { basename, dirname, join } from "node:path"
import { quantaHomePath } from "@/shared"
import {
  asPositiveInt,
  atomicWriteJson,
  createHeartbeatLoop,
  errorCodeOf,
  type HeartbeatScheduler,
  parseIsoMs,
  processAlive,
  readJson,
  sleepReal,
} from "./lease-fs"

export interface SingleBoxGuard {
  readonly dir: string
  readonly label: string
  release(): Promise<void>
}

export interface AcquireSingleBoxGuardOptions {
  readonly label: string
  readonly dir?: string
  readonly wait?: boolean
  readonly waitMs?: number
  readonly pollMs?: number
  readonly heartbeatMs?: number
  readonly heartbeatScheduler?: HeartbeatScheduler
  readonly staleHeartbeatMs?: number
  readonly now?: () => number
  readonly sleep?: (ms: number) => Promise<void>
  readonly onLog?: (msg: string) => void
}

interface SingleBoxOwnerRecord {
  readonly label: string
  readonly pid: number
  readonly acquiredAt: string
  readonly heartbeatAt: string
}

interface ResolvedAcquireSingleBoxGuardOptions {
  readonly label: string
  readonly dir: string
  readonly wait: boolean
  readonly waitMs: number
  readonly pollMs: number
  readonly heartbeatMs: number
  readonly heartbeatScheduler: HeartbeatScheduler | undefined
  readonly staleHeartbeatMs: number
  readonly now: () => number
  readonly sleep: (ms: number) => Promise<void>
  readonly log: (msg: string) => void
  readonly deadline: number | undefined
}

type SingleBoxAcquireAttempt =
  | { readonly kind: "acquired"; readonly guard: SingleBoxGuard }
  | {
      readonly kind: "waiting"
      readonly owner: SingleBoxOwnerRecord | undefined
      readonly timedOut: boolean
    }

const DEFAULT_WAIT_MS = 45 * 60 * 1000
const DEFAULT_POLL_MS = 15_000
const DEFAULT_HEARTBEAT_MS = 15_000
const DEFAULT_STALE_HEARTBEAT_MS = 60_000
const OWNER_META = "owner.json"
const OWNER_SHADOW_SUFFIX = ".owner-shadow.json"

export const resolveSingleBoxGuardDir = (): string =>
  process.env.QUANTA_BENCH_SINGLE_BOX_GUARD_DIR?.trim() || quantaHomePath("bench-single-box")

const isOwnerRecord = (value: unknown): value is SingleBoxOwnerRecord => {
  if (value === null || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return (
    typeof record.label === "string" &&
    record.label !== "" &&
    typeof record.pid === "number" &&
    Number.isFinite(record.pid) &&
    typeof record.acquiredAt === "string" &&
    record.acquiredAt !== "" &&
    typeof record.heartbeatAt === "string" &&
    record.heartbeatAt !== ""
  )
}

const ownerMetaPath = (dir: string): string => join(dir, OWNER_META)

const ownerShadowMetaPath = (dir: string): string =>
  join(dirname(dir), `${basename(dir)}${OWNER_SHADOW_SUFFIX}`)

const heartbeatAgeMs = (record: SingleBoxOwnerRecord, nowMs: number): number => {
  const at = parseIsoMs(record.heartbeatAt)
  return at === undefined ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - at)
}

const readOwnerRecordAtPath = async (path: string): Promise<SingleBoxOwnerRecord | undefined> => {
  const parsed = await readJson<unknown>(path)
  return isOwnerRecord(parsed) ? parsed : undefined
}

const readOwnerRecord = async (dir: string): Promise<SingleBoxOwnerRecord | undefined> =>
  readOwnerRecordAtPath(ownerMetaPath(dir))

const readShadowOwnerRecord = async (dir: string): Promise<SingleBoxOwnerRecord | undefined> =>
  readOwnerRecordAtPath(ownerShadowMetaPath(dir))

const ownerRecordIsReclaimable = (
  owner: SingleBoxOwnerRecord,
  nowMs: number,
  staleHeartbeatMs: number,
): boolean => heartbeatAgeMs(owner, nowMs) > staleHeartbeatMs && !processAlive(owner.pid)

const effectiveOwnerRecord = async (dir: string): Promise<SingleBoxOwnerRecord | undefined> =>
  (await readOwnerRecord(dir)) ?? (await readShadowOwnerRecord(dir))

const lockLooksStale = async (
  dir: string,
  nowMs: number,
  staleHeartbeatMs: number,
): Promise<boolean> => {
  const owner = await effectiveOwnerRecord(dir)
  const lockStat = await stat(dir).catch(() => undefined)
  const ageMs =
    owner !== undefined
      ? heartbeatAgeMs(owner, nowMs)
      : lockStat !== undefined
        ? Math.max(0, nowMs - lockStat.mtimeMs)
        : Number.POSITIVE_INFINITY
  if (ageMs <= staleHeartbeatMs) return false
  if (owner === undefined) return false
  return ownerRecordIsReclaimable(owner, nowMs, staleHeartbeatMs)
}

const formatOwner = (owner: SingleBoxOwnerRecord | undefined): string =>
  owner === undefined ? "owner=unknown" : `owner=${owner.label} pid=${owner.pid}`

const buildGuardError = (
  dir: string,
  owner: SingleBoxOwnerRecord | undefined,
  timedOut: boolean,
): Error =>
  new Error(
    `[single-box] ${timedOut ? "timed out waiting for" : "another local bench run already owns"} ` +
      `${dir} (${formatOwner(owner)}) — refusing to attach or launch another box without explicit extra-box opt-in`,
  )

const resolveAcquireSingleBoxGuardOptions = (
  opts: AcquireSingleBoxGuardOptions,
): ResolvedAcquireSingleBoxGuardOptions => {
  const wait = opts.wait === true
  const waitMs = asPositiveInt(opts.waitMs ?? DEFAULT_WAIT_MS, DEFAULT_WAIT_MS)
  const now = opts.now ?? (() => Date.now())
  return {
    label: opts.label,
    dir: opts.dir ?? resolveSingleBoxGuardDir(),
    wait,
    waitMs,
    pollMs: asPositiveInt(opts.pollMs ?? DEFAULT_POLL_MS, DEFAULT_POLL_MS),
    heartbeatMs: asPositiveInt(opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS),
    heartbeatScheduler: opts.heartbeatScheduler,
    staleHeartbeatMs: asPositiveInt(
      opts.staleHeartbeatMs ?? DEFAULT_STALE_HEARTBEAT_MS,
      DEFAULT_STALE_HEARTBEAT_MS,
    ),
    now,
    sleep: opts.sleep ?? sleepReal,
    log: opts.onLog ?? (() => {}),
    deadline: !wait
      ? now()
      : opts.waitMs !== undefined && opts.waitMs <= 0
        ? undefined
        : now() + waitMs,
  }
}

const writeSingleBoxOwnerRecord = async (
  opts: ResolvedAcquireSingleBoxGuardOptions,
  acquiredAt: string,
): Promise<void> => {
  const record = {
    label: opts.label,
    pid: process.pid,
    acquiredAt,
    heartbeatAt: new Date(opts.now()).toISOString(),
  }
  await atomicWriteJson(ownerShadowMetaPath(opts.dir), record)
  await atomicWriteJson(ownerMetaPath(opts.dir), record)
}

const createSingleBoxGuardHandle = (
  opts: ResolvedAcquireSingleBoxGuardOptions,
  acquiredAt: string,
): SingleBoxGuard => {
  const heartbeat = createHeartbeatLoop(
    opts.heartbeatMs,
    () => writeSingleBoxOwnerRecord(opts, acquiredAt),
    opts.heartbeatScheduler,
  )
  let released = false
  let releaseInFlight: Promise<void> | undefined

  const runRelease = async (): Promise<void> => {
    heartbeat.pause()
    let dirErr: unknown
    let shadowErr: unknown
    try {
      await rm(opts.dir, { recursive: true, force: true })
    } catch (err) {
      dirErr = err
    }
    try {
      await rm(ownerShadowMetaPath(opts.dir), { force: true })
    } catch (err) {
      shadowErr = err
    }
    if (dirErr !== undefined || shadowErr !== undefined) {
      heartbeat.resume()
      if (dirErr !== undefined && shadowErr !== undefined) {
        throw new Error(
          `[single-box] release failed for ${opts.label}: dir=${String(dirErr)}; shadow=${String(shadowErr)}`,
        )
      }
      throw dirErr ?? shadowErr
    }
    heartbeat.stop()
    released = true
  }

  return {
    dir: opts.dir,
    label: opts.label,
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

/**
 * Max stale-reclaim retries within a single acquire attempt. A pathological
 * race (two processes both seeing the lock stale) can ping-pong
 * reclaim→re-create→reclaim; bounding the retries to a small constant turns the
 * former unbounded self-recursion into a terminating loop that fails loudly
 * instead of overflowing the stack.
 */
const MAX_STALE_RECLAIMS = 3

/** A single acquire attempt's outcome — `reclaim` signals "stale lock cleared, retry". */
type SingleBoxAcquireStep = SingleBoxAcquireAttempt | { readonly kind: "reclaim" }

/** Clear a stale lock dir + its shadow so the next mkdir can win the create. */
const clearStaleLock = async (opts: ResolvedAcquireSingleBoxGuardOptions): Promise<void> => {
  await rm(opts.dir, { recursive: true, force: true }).catch(() => undefined)
  await rm(ownerShadowMetaPath(opts.dir), { force: true }).catch(() => undefined)
}

/** One acquire attempt: create+claim the lock, or report waiting / stale-reclaim. */
const tryAcquireSingleBoxGuardOnce = async (
  opts: ResolvedAcquireSingleBoxGuardOptions,
  nowMs: number,
): Promise<SingleBoxAcquireStep> => {
  const shadowOwner = await readShadowOwnerRecord(opts.dir)
  if (shadowOwner !== undefined) {
    if (!ownerRecordIsReclaimable(shadowOwner, nowMs, opts.staleHeartbeatMs)) {
      return {
        kind: "waiting",
        owner: shadowOwner,
        timedOut: opts.deadline !== undefined && nowMs >= opts.deadline,
      }
    }
    await rm(ownerShadowMetaPath(opts.dir), { force: true }).catch(() => undefined)
  }
  const acquiredAt = new Date(opts.now()).toISOString()
  try {
    await mkdir(opts.dir)
    try {
      await writeSingleBoxOwnerRecord(opts, acquiredAt)
    } catch (err) {
      await clearStaleLock(opts)
      throw err
    }
    return { kind: "acquired", guard: createSingleBoxGuardHandle(opts, acquiredAt) }
  } catch (err) {
    if (errorCodeOf(err) !== "EEXIST") throw err
    if (await lockLooksStale(opts.dir, nowMs, opts.staleHeartbeatMs)) return { kind: "reclaim" }
    return {
      kind: "waiting",
      owner: await effectiveOwnerRecord(opts.dir),
      timedOut: opts.deadline !== undefined && nowMs >= opts.deadline,
    }
  }
}

const tryAcquireSingleBoxGuard = async (
  opts: ResolvedAcquireSingleBoxGuardOptions,
): Promise<SingleBoxAcquireAttempt> => {
  // Bounded iterative stale-reclaim: each EEXIST-on-stale clears the lock and
  // retries in-loop (no self-recursion). After MAX_STALE_RECLAIMS reclaims that
  // all lose the create race to another reclaimer, give up with a clear error.
  for (let staleReclaims = 0; ; staleReclaims += 1) {
    const step = await tryAcquireSingleBoxGuardOnce(opts, opts.now())
    if (step.kind !== "reclaim") return step
    if (staleReclaims >= MAX_STALE_RECLAIMS) {
      throw new Error(
        `[single-box] could not acquire single-box guard after ${MAX_STALE_RECLAIMS} stale reclaims ` +
          `for ${opts.dir} — another process is racing reclaim of the same stale lock`,
      )
    }
    await clearStaleLock(opts)
  }
}

export const acquireSingleBoxGuard = async (
  opts: AcquireSingleBoxGuardOptions,
): Promise<SingleBoxGuard> => {
  const resolved = resolveAcquireSingleBoxGuardOptions(opts)
  let announcedWait = false

  await mkdir(dirname(resolved.dir), { recursive: true })

  for (;;) {
    const attempt = await tryAcquireSingleBoxGuard(resolved)
    if (attempt.kind === "acquired") return attempt.guard
    if (attempt.timedOut || !resolved.wait) {
      throw buildGuardError(resolved.dir, attempt.owner, resolved.wait)
    }
    if (!announcedWait) {
      resolved.log(
        `[single-box] waiting for local owner guard ${resolved.dir} (${formatOwner(attempt.owner)})…`,
      )
      announcedWait = true
    }
    await resolved.sleep(resolved.pollMs)
  }
}
