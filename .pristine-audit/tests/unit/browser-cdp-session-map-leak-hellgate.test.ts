/**
 * Hellgate — CDP adapter session-Map leak reaping (U3-cdp-leak).
 *
 * RESOURCE_LEAK fix proof: the internal `sessions` Map was never pruned —
 * close() returned early when a death mode (onDead / proc.exited) had already
 * flipped s.closed, and the death handlers themselves only marked closed. So
 * repeated browse→close (and crash) cycles grew the Map unbounded, pinning a
 * CdpConnection + console buffer + proc handle per session forever.
 *
 * The Map is private by design, so we observe its non-growth structurally:
 *  - every spawned proc reaches a terminal teardown (kill + profile rmrf), so
 *    the per-cycle teardown count must equal the cycle count (no live retention);
 *  - a closed/dead handle reports `isLive === false` AND fails closed on use,
 *    i.e. live()/isLive() treat the reaped (missing) entry exactly like a closed
 *    one — happy-path behavior is byte-identical;
 *  - a re-open after close/death yields a fresh working session.
 *
 *  LEAK-01: N browse→close cycles ⇒ N teardowns, every old handle closed, re-open works
 *  LEAK-02: proc.exited (crash) ⇒ session reaped; handle closed; re-open works
 *  LEAK-03: onDead (socket death) ⇒ session reaped; handle closed; re-open works
 *  LEAK-04: double-close stays idempotent after the Map entry is reaped
 */

import { describe, expect, test } from "bun:test"
import type {
  BrowserFs,
  CdpConnection,
  CdpTransport,
  Clock,
  ProcessSpawner,
  Scheduler,
  SpawnedProcess,
} from "@/browser/cdp/ports"
import { createCdpBrowser } from "@/browser/cdp-adapter"
import { ok } from "@/shared"

const idleScheduler: Scheduler = { schedule: () => () => {} }
const clock: Clock = { now: () => 0 }

// fs that always reports the DevTools port ready + records every rmrf (= profile
// teardown). A leaked, never-closed session would NOT produce an rmrf.
const recordingFs = (rmrf: string[]): BrowserFs => ({
  existsSync: () => false,
  readFile: (p) => (p.endsWith("DevToolsActivePort") ? "9222\n/devtools/browser/x" : null),
  mkdirp: () => {},
  rmrf: (p) => rmrf.push(p),
})

interface SentMsg {
  readonly id: number
  readonly method: string
  readonly params: { expression?: string }
}

// Per-connect transport: every spawn gets a *fresh* conn, and we capture the
// onClose cb so a test can fire socket death (onDead path).
const makeTransport = (closeCbs: Array<() => void>): CdpTransport => ({
  connect: async () => {
    let onMsg: (raw: string) => void = () => {}
    const conn: CdpConnection = {
      onMessage: (cb) => {
        onMsg = cb
      },
      onClose: (cb) => {
        closeCbs.push(cb)
      },
      close: () => {},
      send: (raw) => {
        const m = JSON.parse(raw) as SentMsg
        queueMicrotask(() => {
          let result: unknown = {}
          if (m.method === "Target.createTarget") result = { targetId: "t1" }
          else if (m.method === "Target.attachToTarget") result = { sessionId: "s1" }
          onMsg(JSON.stringify({ id: m.id, result }))
        })
      },
    }
    return ok(conn)
  },
})

// Spawner whose `exited` promise is externally resolvable, so a test can fire
// process death (proc.exited path). Tracks kill() calls = process teardown.
const makeSpawner = (kills: number[], exiters: Array<(code: number) => void>): ProcessSpawner => ({
  which: () => "/usr/bin/google-chrome",
  spawn: (): SpawnedProcess => {
    const idx = kills.length
    kills.push(0)
    let resolve!: (code: number) => void
    const exited = new Promise<number>((r) => {
      resolve = r
    })
    exiters.push(resolve)
    return {
      pid: 1000 + idx,
      kill: () => {
        kills[idx] = (kills[idx] ?? 0) + 1
      },
      exited,
    }
  },
})

const makeBrowser = () => {
  const rmrf: string[] = []
  const kills: number[] = []
  const closeCbs: Array<() => void> = []
  const exiters: Array<(code: number) => void> = []
  const b = createCdpBrowser({
    spawner: makeSpawner(kills, exiters),
    transport: makeTransport(closeCbs),
    fs: recordingFs(rmrf),
    scheduler: idleScheduler,
    clock,
    profileRoot: "/jail/.quanta/browser",
    endpointTimeoutMs: 1000,
  })
  return { b, rmrf, kills, closeCbs, exiters }
}

describe("HELLGATE cdp-adapter — session Map leak reaping", () => {
  test("LEAK-01: N browse→close cycles ⇒ N teardowns, old handles closed, re-open works", async () => {
    const { b, rmrf, kills } = makeBrowser()
    const N = 50
    const handles: { id: string; backend: string }[] = []
    for (let i = 0; i < N; i += 1) {
      const h = await b.spawn()
      expect(h.ok).toBe(true)
      if (!h.ok) return
      handles.push(h.value)
      expect(b.isLive(h.value)).toBe(true)
      const c = await b.close(h.value)
      expect(c.ok).toBe(true)
      // reaped → reports closed exactly like the old retained-but-closed entry
      expect(b.isLive(h.value)).toBe(false)
    }
    // Every cycle was fully torn down — no live session retained in the Map.
    expect(rmrf).toHaveLength(N)
    expect(kills.filter((k) => k === 1)).toHaveLength(N)
    // Every prior handle still reads closed (missing entry ≡ closed).
    for (const h of handles) {
      expect(b.isLive(h)).toBe(false)
      const nav = await b.navigate(h, "https://app.test/")
      expect(nav.ok).toBe(false)
      if (!nav.ok) expect(nav.error.kind).toBe("closed")
    }
    // Re-open after the whole storm still works.
    const fresh = await b.spawn()
    expect(fresh.ok).toBe(true)
    if (fresh.ok) expect(b.isLive(fresh.value)).toBe(true)
  })

  test("LEAK-02: proc.exited (crash) reaps the session; profile rmrf'd; handle closed; re-open works", async () => {
    const { b, exiters, rmrf } = makeBrowser()
    const h = await b.spawn()
    expect(h.ok).toBe(true)
    if (!h.ok) return
    expect(b.isLive(h.value)).toBe(true)
    const profileDir = `/jail/.quanta/browser/${h.value.id}`
    // No teardown has happened yet on the still-live session.
    expect(rmrf).toHaveLength(0)
    // Process dies with NO CDP event (crash/OOM/external kill) — and NO close().
    exiters[0]?.(137)
    await Promise.resolve() // let the proc.exited.then() handler run
    await Promise.resolve()
    expect(b.isLive(h.value)).toBe(false)
    // OVER_CORRECTION proof: the death path itself must remove the temp profile
    // (proc already gone, so we do NOT also kill it — close() can no longer run
    // teardown once the Map entry is reaped).
    expect(rmrf).toContain(profileDir)
    expect(rmrf).toHaveLength(1)
    // The reaped handle fails closed on use (not a stale-but-present entry).
    const nav = await b.navigate(h.value, "https://app.test/")
    expect(nav.ok).toBe(false)
    if (!nav.ok) expect(nav.error.kind).toBe("closed")
    // close() on the already-reaped handle is a no-op ok — and does NOT rmrf again.
    const c = await b.close(h.value)
    expect(c.ok).toBe(true)
    expect(rmrf).toHaveLength(1)
    // Re-open works.
    const again = await b.spawn()
    expect(again.ok).toBe(true)
    if (again.ok) expect(b.isLive(again.value)).toBe(true)
  })

  test("LEAK-03: onDead (socket death) kills proc + rmrf's profile; handle closed; re-open works", async () => {
    const { b, closeCbs, kills, rmrf } = makeBrowser()
    const h = await b.spawn()
    expect(h.ok).toBe(true)
    if (!h.ok) return
    expect(b.isLive(h.value)).toBe(true)
    const profileDir = `/jail/.quanta/browser/${h.value.id}`
    // Nothing torn down while the session is live.
    expect(kills[0]).toBe(0)
    expect(rmrf).toHaveLength(0)
    // Socket dies → cdp-session markDead → adapter onDead fires. NO close() is
    // ever called — the death path alone must perform the full teardown.
    closeCbs[0]?.()
    await Promise.resolve()
    expect(b.isLive(h.value)).toBe(false)
    // OVER_CORRECTION proof: the proc is still alive on a socket death, so the
    // death path must KILL it AND rmrf the temp profile (the round-1 fix dropped
    // the Map entry first, which made close() a no-op and leaked both).
    expect(kills[0]).toBe(1)
    expect(rmrf).toContain(profileDir)
    expect(rmrf).toHaveLength(1)
    const nav = await b.navigate(h.value, "https://app.test/")
    expect(nav.ok).toBe(false)
    if (!nav.ok) expect(nav.error.kind).toBe("closed")
    // A later close() on the reaped handle is a safe no-op — no double teardown.
    const c = await b.close(h.value)
    expect(c.ok).toBe(true)
    expect(kills[0]).toBe(1)
    expect(rmrf).toHaveLength(1)
    const again = await b.spawn()
    expect(again.ok).toBe(true)
    if (again.ok) expect(b.isLive(again.value)).toBe(true)
  })

  test("LEAK-04: double-close stays idempotent after the entry is reaped", async () => {
    const { b, kills, rmrf } = makeBrowser()
    const h = await b.spawn()
    expect(h.ok).toBe(true)
    if (!h.ok) return
    const c1 = await b.close(h.value)
    expect(c1.ok).toBe(true)
    expect(kills[0]).toBe(1)
    expect(rmrf).toHaveLength(1)
    // Second close: entry already reaped ⇒ no second kill, no second rmrf.
    const c2 = await b.close(h.value)
    expect(c2.ok).toBe(true)
    expect(kills[0]).toBe(1)
    expect(rmrf).toHaveLength(1)
  })
})
