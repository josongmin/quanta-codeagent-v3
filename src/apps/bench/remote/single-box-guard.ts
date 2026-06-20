import { mkdir, rm, stat } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { asPositiveInt, atomicWriteJson, parseIsoMs, processAlive, readJson, sleepReal } from "./lease-fs"

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

export const acquireSingleBoxGuard = async (
  opts: AcquireSingleBoxGuardOptions,
): Promise<SingleBoxGuard> => {
  const dir = opts.dir ?? resolveSingleBoxGuardDir()
  const wait = opts.wait === true
  const waitMs = asPositiveInt(opts.waitMs ?? DEFAULT_WAIT_MS, DEFAULT_WAIT_MS)
  const pollMs = asPositiveInt(opts.pollMs ?? DEFAULT_POLL_MS, DEFAULT_POLL_MS)
  const heartbeatMs = asPositiveInt(opts.heartbeatMs ?? DEFAULT_HEARTBEAT_MS, DEFAULT_HEARTBEAT_MS)
  const staleHeartbeatMs = asPositiveInt(
    opts.staleHeartbeatMs ?? DEFAULT_STALE_HEARTBEAT_MS,
    DEFAULT_STALE_HEARTBEAT_MS,
  )
  const now = opts.now ?? (() => Date.now())
  const sleep = opts.sleep ?? sleepReal
  const log = opts.onLog ?? (() => {})
  const deadline = wait
    ? opts.waitMs !== undefined && opts.waitMs <= 0
      ? undefined
      : now() + waitMs
    : now()
  let announcedWait = false

  await mkdir(dirname(dir), { recursive: true })

  for (;;) {
    const acquiredAt = new Date(now()).toISOString()
    try {
      await mkdir(dir)
      const writeOwner = async (): Promise<void> =>
        atomicWriteJson(ownerMetaPath(dir), {
          label: opts.label,
          pid: process.pid,
          acquiredAt,
          heartbeatAt: new Date(now()).toISOString(),
        })
      try {
        await writeOwner()
      } catch (err) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
        throw err
      }
      let released = false
      let heartbeatStopped = false
      const heartbeat = setInterval(() => {
        void writeOwner().catch(() => undefined)
      }, heartbeatMs)
      return {
        dir,
        label: opts.label,
        release: async (): Promise<void> => {
          if (released) return
          if (!heartbeatStopped) {
            clearInterval(heartbeat)
            heartbeatStopped = true
          }
          await rm(dir, { recursive: true, force: true })
          released = true
        },
      }
    } catch (err) {
      const code =
        err !== null && typeof err === "object" && "code" in err
          ? (err as { code?: unknown }).code
          : undefined
      if (code !== "EEXIST") throw err
      const nowMs = now()
      if (await lockLooksStale(dir, nowMs, staleHeartbeatMs)) {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined)
        continue
      }
      const owner = await readOwnerRecord(dir)
      if (deadline !== undefined && nowMs >= deadline) {
        throw buildGuardError(dir, owner, wait)
      }
      if (!wait) {
        throw buildGuardError(dir, owner, false)
      }
      if (!announcedWait) {
        log(`[single-box] waiting for local owner guard ${dir} (${formatOwner(owner)})…`)
        announcedWait = true
      }
      await sleep(pollMs)
    }
  }
}
