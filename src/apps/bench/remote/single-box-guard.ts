import { mkdir, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
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

export const resolveSingleBoxGuardDir = (): string =>
  process.env.QUANTA_BENCH_SINGLE_BOX_GUARD_DIR?.trim() ||
  join(homedir(), ".quanta", "bench-single-box")

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

const heartbeatAgeMs = (record: SingleBoxOwnerRecord, nowMs: number): number => {
  const at = parseIsoMs(record.heartbeatAt)
  return at === undefined ? Number.POSITIVE_INFINITY : Math.max(0, nowMs - at)
}

const readOwnerRecord = async (dir: string): Promise<SingleBoxOwnerRecord | undefined> => {
  const parsed = await readJson<unknown>(ownerMetaPath(dir))
  return isOwnerRecord(parsed) ? parsed : undefined
}

const lockLooksStale = async (
  dir: string,
  nowMs: number,
  staleHeartbeatMs: number,
): Promise<boolean> => {
  const owner = await readOwnerRecord(dir)
  const lockStat = await stat(dir).catch(() => undefined)
  const ageMs =
    owner !== undefined
      ? heartbeatAgeMs(owner, nowMs)
      : lockStat !== undefined
        ? Math.max(0, nowMs - lockStat.mtimeMs)
        : Number.POSITIVE_INFINITY
  if (ageMs <= staleHeartbeatMs) return false
  if (owner === undefined) return false
  return !processAlive(owner.pid)
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
  await atomicWriteJson(ownerMetaPath(opts.dir), {
    label: opts.label,
    pid: process.pid,
    acquiredAt,
    heartbeatAt: new Date(opts.now()).toISOString(),
  })
}

const createSingleBoxGuardHandle = (
  opts: ResolvedAcquireSingleBoxGuardOptions,
  acquiredAt: string,
): SingleBoxGuard => {
  const heartbeat = createHeartbeatLoop(opts.heartbeatMs, () =>
    writeSingleBoxOwnerRecord(opts, acquiredAt),
  )
  let released = false
  let releaseInFlight: Promise<void> | undefined

  const runRelease = async (): Promise<void> => {
    heartbeat.pause()
    try {
      await rm(opts.dir, { recursive: true, force: true })
      heartbeat.stop()
      released = true
    } catch (err) {
      heartbeat.resume()
      throw err
    }
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

const tryAcquireSingleBoxGuard = async (
  opts: ResolvedAcquireSingleBoxGuardOptions,
): Promise<SingleBoxAcquireAttempt> => {
  const acquiredAt = new Date(opts.now()).toISOString()
  try {
    await mkdir(opts.dir)
    try {
      await writeSingleBoxOwnerRecord(opts, acquiredAt)
    } catch (err) {
      await rm(opts.dir, { recursive: true, force: true }).catch(() => undefined)
      throw err
    }
    return {
      kind: "acquired",
      guard: createSingleBoxGuardHandle(opts, acquiredAt),
    }
  } catch (err) {
    if (errorCodeOf(err) !== "EEXIST") throw err
    const nowMs = opts.now()
    if (await lockLooksStale(opts.dir, nowMs, opts.staleHeartbeatMs)) {
      await rm(opts.dir, { recursive: true, force: true }).catch(() => undefined)
      return tryAcquireSingleBoxGuard(opts)
    }
    return {
      kind: "waiting",
      owner: await readOwnerRecord(opts.dir),
      timedOut: opts.deadline !== undefined && nowMs >= opts.deadline,
    }
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
