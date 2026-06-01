/**
 * Browser slice — default Bun-backed boundary implementations (ADR-0427).
 *
 * These are the ONLY un-unit-tested files in the slice: each is a thin wrapper
 * over a runtime primitive (Bun.spawn / Bun.which / global WebSocket / node:fs /
 * setTimeout). All logic lives behind the ports in `./ports`, tested with fakes.
 * Validate these with a real-chrome smoke run, not unit tests.
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs"
import { err, ok, type Result } from "@/shared"
import type {
  BrowserFs,
  CdpConnection,
  CdpTransport,
  Clock,
  ProcessSpawner,
  Scheduler,
  SpawnedProcess,
} from "./ports"

export const realScheduler: Scheduler = {
  schedule: (ms, cb) => {
    const t = setTimeout(cb, ms)
    return () => clearTimeout(t)
  },
}

export const realClock: Clock = { now: () => Date.now() }

export const defaultBrowserFs: BrowserFs = {
  existsSync: (p) => existsSync(p),
  readFile: (p) => {
    try {
      return readFileSync(p, "utf8")
    } catch {
      return null
    }
  },
  mkdirp: (p) => {
    mkdirSync(p, { recursive: true })
  },
  rmrf: (p) => {
    try {
      rmSync(p, { recursive: true, force: true })
    } catch {
      // best-effort cleanup — a leaked temp profile is not worth throwing over
    }
  },
}

export const defaultProcessSpawner: ProcessSpawner = {
  which: (cmd) => Bun.which(cmd),
  spawn: (argv): SpawnedProcess => {
    const proc = Bun.spawn([...argv], { stdout: "ignore", stderr: "ignore" })
    return {
      pid: proc.pid,
      kill: () => proc.kill(),
      exited: proc.exited,
    }
  },
}

export const defaultCdpTransport: CdpTransport = {
  connect: async (
    wsUrl: string,
    signal?: AbortSignal,
  ): Promise<Result<CdpConnection, { readonly detail: string }>> => {
    const ws = new WebSocket(wsUrl)
    try {
      // R2 audit [10]: remove all listeners on settle and close the socket on
      // abort/error so a connect that loses the race cannot leak the ws or fire
      // listeners after we've moved on.
      await new Promise<void>((resolve, reject) => {
        const cleanup = (): void => {
          ws.removeEventListener("open", onOpen)
          ws.removeEventListener("error", onError)
          signal?.removeEventListener("abort", onAbort)
        }
        const onOpen = (): void => {
          cleanup()
          resolve()
        }
        const onError = (): void => {
          cleanup()
          ws.close()
          reject(new Error("websocket error"))
        }
        const onAbort = (): void => {
          cleanup()
          ws.close()
          reject(new Error("aborted"))
        }
        ws.addEventListener("open", onOpen)
        ws.addEventListener("error", onError)
        signal?.addEventListener("abort", onAbort)
      })
      const conn: CdpConnection = {
        send: (p) => ws.send(p),
        onMessage: (cb) => {
          ws.addEventListener("message", (e: MessageEvent) => cb(String(e.data)))
        },
        // R3 audit [1]: a dropped socket (chrome crash/OOM/kill) closes the ws
        // WITHOUT any CDP event — fire the session's death hook so in-flight +
        // future calls fail fast instead of hanging to the per-call timeout.
        onClose: (cb) => {
          let fired = false
          const once = (): void => {
            if (fired) return
            fired = true
            cb()
          }
          ws.addEventListener("close", once, { once: true })
          ws.addEventListener("error", once, { once: true })
        },
        close: () => ws.close(),
      }
      return ok(conn)
    } catch (e) {
      ws.close()
      return err({ detail: e instanceof Error ? e.message : String(e) })
    }
  },
}
