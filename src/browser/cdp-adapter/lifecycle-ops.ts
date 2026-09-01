/**
 * CDP adapter — process lifecycle: availability probe, liveness, spawn, close.
 *
 * The only group that MUTATES the session map and the only one owning OS
 * resources (the Chrome child process and its temp profile dir). Its teardown
 * invariants are unchanged from the pre-split factory: close is idempotent,
 * BOTH death modes run the full teardown before the map entry is reaped, and
 * the profile dir is removed even when the spawn itself threw.
 */

import { err, errMessage, ok, type Result } from "@/shared"
import { readDevToolsEndpoint } from "../cdp/dev-tools-endpoint"
import type { SpawnedProcess } from "../cdp/ports"
import type { BrowserPort } from "../port"
import { createRefMap } from "../snapshot"
import type { BrowserError, BrowserHandle, BrowserStartOpts } from "../types"
import { connectAndEnable } from "./bring-up"
import { resolveChromeBinary } from "./deps"
import type { CdpBrowserCtx, SessionState, TabState } from "./session-state"

// Globally-unique profile-dir suffix (R4 audit [8]) — independent of the
// per-instance seq so concurrent adapters sharing a profileRoot never collide.
const uniqueNonce = (): string => `${process.pid}-${crypto.randomUUID().slice(0, 8)}`

const PROCESS_EXIT_GRACE_MS = 500
const PROCESS_EXIT_FORCE_MS = 2_000

// Best-effort kill — Bun's Subprocess.kill() can throw (ESRCH/EPERM-style proc
// states); a throw must NOT skip the bounded wait/profile cleanup that follows.
const killQuietly = (proc: SpawnedProcess, signal?: "SIGTERM" | "SIGKILL"): void => {
  try {
    proc.kill(signal)
  } catch {
    // proc already gone / unkillable — the profile cleanup still runs
  }
}

/** Acquire terminal ownership of a spawned Chrome root. Production processes
 *  expose waitForExit; legacy fakes have synchronous kill semantics and omit
 *  it. A stuck Chrome gets one bounded graceful window, then SIGKILL, then one
 *  final bounded reap window. */
const terminateProcess = async (proc: SpawnedProcess): Promise<void> => {
  killQuietly(proc, "SIGTERM")
  if (proc.waitForExit === undefined) return
  if (await proc.waitForExit(PROCESS_EXIT_GRACE_MS)) return
  killQuietly(proc, "SIGKILL")
  await proc.waitForExit(PROCESS_EXIT_FORCE_MS)
}

const cleanupProfile = (state: SessionState, rmrf: (path: string) => void): void => {
  if (state.profileCleaned) return
  state.profileCleaned = true
  rmrf(state.profileDir)
}

const terminateAndCleanupState = async (
  state: SessionState,
  rmrf: (path: string) => void,
): Promise<void> => {
  await terminateProcess(state.proc)
  cleanupProfile(state, rmrf)
}

export const lifecycleOps = (
  ctx: CdpBrowserCtx,
): Pick<BrowserPort, "availability" | "isLive" | "spawn" | "close"> => {
  const { deps, sessions } = ctx
  return {
    availability: () => (resolveChromeBinary(deps) !== null ? "chromium" : null),

    isLive: (h: BrowserHandle): boolean => {
      const s = sessions.get(h.id)
      return s !== undefined && !s.closed
    },

    async spawn(opts?: BrowserStartOpts): Promise<Result<BrowserHandle, BrowserError>> {
      const bin = resolveChromeBinary(deps)
      if (bin === null) return err({ kind: "backend-missing" })
      const seq = ctx.nextSeq()
      // R4 audit [8]: a per-instance seq alone collides across adapter instances
      // sharing a profileRoot (two sessions, same cwd → both "cdp-1"). A
      // process+random nonce makes the --user-data-dir globally unique.
      const id = `cdp-${seq}-${uniqueNonce()}`
      const profileDir = `${deps.profileRoot}/${id}`
      // R4 audit [6]: proc may never be created if spawner.spawn() throws
      // (EMFILE/EACCES); keep it nullable so teardown still rmrf's the mkdir'd dir.
      let proc: SpawnedProcess | null = null
      const teardown = async (): Promise<void> => {
        if (proc !== null) await terminateProcess(proc)
        deps.fs.rmrf(profileDir)
      }
      try {
        deps.fs.mkdirp(profileDir)
        proc = deps.spawner.spawn([
          bin,
          "--headless=new",
          "--remote-debugging-port=0",
          `--user-data-dir=${profileDir}`,
          "--no-first-run",
          "--disable-gpu",
          "--no-default-browser-check",
        ])
        const endpoint = await readDevToolsEndpoint({
          read: () => deps.fs.readFile(`${profileDir}/DevToolsActivePort`),
          scheduler: deps.scheduler,
          clock: deps.clock,
          ...(opts?.signal ? { signal: opts.signal } : {}),
          ...(deps.endpointTimeoutMs !== undefined ? { timeoutMs: deps.endpointTimeoutMs } : {}),
        })
        if (!endpoint.ok) {
          await teardown()
          return endpoint
        }
        const brought = await connectAndEnable(deps, endpoint.value, opts?.signal)
        if (!brought.ok) {
          await teardown()
          return brought
        }
        const session = brought.value.session
        // TICKET-24 Wave B — the bring-up's page becomes tab #1 (active). Its
        // refMap is the per-tab SSOT; further tabs each get their own.
        const tab0: TabState = {
          targetId: brought.value.targetId,
          sessionId: brought.value.sessionId,
          url: "about:blank",
          title: "",
          refMap: createRefMap(),
        }
        const state: SessionState = {
          closed: false,
          profileCleaned: false,
          proc,
          session,
          profileDir,
          console: brought.value.console,
          network: brought.value.network,
          tabs: new Map([[tab0.targetId, tab0]]),
          activeTabId: tab0.targetId,
        }
        sessions.set(id, state)
        // R3 audit [1][7]: observe BOTH death modes → mark the SessionState closed
        // so live()/isLive() report it and the holder re-spawns instead of
        // wedging on a dead session. onDead = CDP-event/socket death; proc.exited
        // = process death (crash/OOM/external kill).
        session.onDead(() => {
          // OVER_CORRECTION fix: reaping the Map entry here removed what close()
          // relied on to kill the proc + rmrf the temp profile — so on the death
          // path the on-disk profile leaked unbounded. Run the FULL teardown
          // (the proc is still alive on a socket/CDP death) BEFORE dropping the
          // entry. killQuietly swallows ESRCH/EPERM; rmrf is best-effort.
          if (!state.closed) {
            state.closed = true
            state.session.dispose()
            void terminateAndCleanupState(state, deps.fs.rmrf)
          }
          // Reap the (bounded) Map entry only after teardown. live()/isLive()
          // already treat a missing entry as closed, so dropping it is
          // observationally equal to the previously-retained closed entry.
          sessions.delete(id)
        })
        void proc.exited.then(() => {
          // OVER_CORRECTION fix: the process is already gone, so DON'T kill it
          // again — but the temp profile it left on disk must still be removed,
          // and the session wiring disposed. close() can no longer do this once
          // the Map entry is reaped, so do it here.
          if (!state.closed) {
            state.closed = true
            session.dispose()
          }
          // close() used to rmrf immediately after SIGTERM. Chrome could keep
          // running, recreate the directory, then exit after the test process,
          // leaving both an orphan and a residual profile. The process-exit
          // observer is the final cleanup authority on every death path.
          cleanupProfile(state, deps.fs.rmrf)
          sessions.delete(id)
        })
        return ok({ id, backend: "chromium" })
      } catch (e) {
        await teardown()
        return err({ kind: "spawn-failed", detail: errMessage(e) })
      }
    },

    async close(h: BrowserHandle): Promise<Result<void, BrowserError>> {
      const s = sessions.get(h.id)
      if (s === undefined) return ok(undefined)
      // RESOURCE_LEAK fix: even if a death mode (onDead / proc.exited) already
      // flipped s.closed, the Map entry was never reaped — repeated browse→close
      // cycles grew it unbounded, pinning the CdpConnection wiring + console
      // buffer + proc handle per session. Drop the entry on EVERY terminal path.
      if (!s.closed) {
        s.closed = true
        s.session.dispose()
        await terminateAndCleanupState(s, deps.fs.rmrf)
      }
      sessions.delete(h.id)
      return ok(undefined)
    },
  }
}
