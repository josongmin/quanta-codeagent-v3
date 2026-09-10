import { randomUUID } from "node:crypto"
import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"

export const sleepReal = (ms: number): Promise<void> =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, ms)
  })

export const asPositiveInt = (raw: number, fallback: number): number => {
  const n = Math.trunc(raw)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

export const parseIsoMs = (value: string): number | undefined => {
  const ms = Date.parse(value)
  return Number.isFinite(ms) ? ms : undefined
}

export const processAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const errorCodeOf = (err: unknown): string | undefined => {
  if (err === null || typeof err !== "object" || !("code" in err)) return undefined
  const code = (err as { code?: unknown }).code
  return typeof code === "string" && code !== "" ? code : undefined
}

export const atomicWriteJson = async (path: string, value: unknown): Promise<void> => {
  // Heartbeat-backed ownership must survive external dir deletion; otherwise a
  // live owner can silently disappear and reopen a second launch/accounting lane.
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.tmp`
  await writeFile(tmp, `${JSON.stringify(value)}\n`)
  await rename(tmp, path)
}

export interface HeartbeatLoop {
  pause(): void
  resume(): void
  stop(): void
}

export interface HeartbeatScheduler {
  readonly schedule: (task: () => Promise<void>, intervalMs: number) => unknown
  readonly cancel: (handle: unknown) => void
}

const realHeartbeatScheduler: HeartbeatScheduler = {
  schedule: (task, intervalMs) =>
    setInterval(() => {
      void task()
    }, intervalMs),
  cancel: (handle) => clearInterval(handle as ReturnType<typeof setInterval>),
}

export const createHeartbeatLoop = (
  intervalMs: number,
  beat: () => Promise<void>,
  scheduler: HeartbeatScheduler = realHeartbeatScheduler,
): HeartbeatLoop => {
  let timer: unknown
  let armed = false
  let stopped = false
  const tick = async (): Promise<void> => beat().catch(() => undefined)
  const arm = (): void => {
    timer = scheduler.schedule(tick, intervalMs)
    armed = true
  }
  arm()
  return {
    pause(): void {
      if (!armed) return
      scheduler.cancel(timer)
      armed = false
      timer = undefined
    },
    resume(): void {
      if (stopped || armed) return
      arm()
    },
    stop(): void {
      stopped = true
      if (!armed) return
      scheduler.cancel(timer)
      armed = false
      timer = undefined
    },
  }
}

export const readJson = async <T>(path: string): Promise<T | undefined> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T
  } catch {
    return undefined
  }
}
