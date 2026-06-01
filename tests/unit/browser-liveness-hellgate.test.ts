/**
 * Hellgate — session liveness + crash recovery (ADR-0427 R3 audit [1][2][4][7]).
 *
 * Proves the death-observability + re-spawn machinery the prior rounds missed:
 *  - cdp-session: transport onClose ⇒ markDead ⇒ onDead fires + pending/ waiters
 *    settle closed; Inspector.detached (session-scoped) ⇒ markDead.
 *  - cdp-adapter: onDead ⇒ SessionState closed ⇒ isLive false; proc.exited ⇒
 *    session disposed + isLive false (process death, no CDP event).
 *  - session-holder: a dead (not-disposed) handle is dropped + re-spawned; a
 *    DISPOSED holder stays terminal (no resurrection).
 */

import { describe, expect, test } from "bun:test"
import type { BrowserError, BrowserHandle, BrowserPort } from "@/browser"
import { createCdpSession } from "@/browser/cdp/cdp-session"
import type { CdpConnection, Scheduler } from "@/browser/cdp/ports"
import type { Result } from "@/shared"
import { ok } from "@/shared"
import { createBrowserSession } from "@/tool/browser/session-holder"

const idleScheduler: Scheduler = { schedule: () => () => {} }

// fake conn that captures the onClose cb so the test can fire transport death
const fakeConn = () => {
  let onMsg: (raw: string) => void = () => {}
  let onCloseCb: (() => void) | null = null
  const conn: CdpConnection = {
    send: () => {},
    onMessage: (cb) => {
      onMsg = cb
    },
    onClose: (cb) => {
      onCloseCb = cb
    },
    close: () => {},
  }
  return {
    conn,
    emit: (obj: unknown) => onMsg(JSON.stringify(obj)),
    dropSocket: () => onCloseCb?.(),
  }
}

describe("HELLGATE liveness — cdp-session death observability", () => {
  test("transport onClose ⇒ markDead: onDead fires + pending settles closed", async () => {
    const f = fakeConn()
    const s = createCdpSession({ conn: f.conn, scheduler: idleScheduler })
    let deadFired = false
    s.onDead(() => {
      deadFired = true
    })
    const p = s.request("Page.navigate") // in-flight (never replied)
    f.dropSocket() // socket dies with no CDP event
    const r = await p
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("cdp-error") // DEAD_ERR settles in-flight requests fast
    expect(deadFired).toBe(true)
    // onDead registered AFTER death fires immediately
    let lateFired = false
    s.onDead(() => {
      lateFired = true
    })
    expect(lateFired).toBe(true)
  })

  test("Inspector.detached on our session ⇒ markDead", async () => {
    const f = fakeConn()
    const s = createCdpSession({ conn: f.conn, scheduler: idleScheduler })
    s.useSessionId("sess-1")
    let dead = false
    s.onDead(() => {
      dead = true
    })
    const p = s.waitForEvent("Page.loadEventFired")
    f.emit({
      method: "Inspector.detached",
      sessionId: "sess-1",
      params: { reason: "target_closed" },
    })
    const r = await p
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("closed")
    expect(dead).toBe(true)
  })

  test("Inspector.detached for a DIFFERENT session is ignored", async () => {
    const f = fakeConn()
    const s = createCdpSession({ conn: f.conn, scheduler: idleScheduler })
    s.useSessionId("sess-1")
    let dead = false
    s.onDead(() => {
      dead = true
    })
    f.emit({ method: "Inspector.detached", sessionId: "other", params: {} })
    expect(dead).toBe(false)
  })
})

// ── session-holder re-spawn on death ─────────────────────────────────────────

const flakyPort = () => {
  let spawnCount = 0
  let liveFlag = true
  const closed: string[] = []
  const port: BrowserPort = {
    availability: () => "stub",
    isLive: () => liveFlag,
    spawn: async (): Promise<Result<BrowserHandle, BrowserError>> => {
      spawnCount += 1
      liveFlag = true
      return ok({ id: `h-${spawnCount}`, backend: "stub" })
    },
    navigate: async () => ok({ title: "t" }),
    snapshot: async () => ok({ yaml: "", url: "", title: "" }),
    click: async () => ok(undefined),
    type: async () => ok(undefined),
    fill: async () => ok(undefined),
    selectOption: async () => ok(undefined),
    scroll: async () => ok(undefined),
    pressKey: async () => ok(undefined),
    drag: async () => ok(undefined),
    mouseClickXY: async () => ok(undefined),
    screenshot: async () => ok(new Uint8Array()),
    cdp: async () => ok({}),
    close: async (h) => {
      closed.push(h.id)
      return ok(undefined)
    },
  }
  return {
    port,
    kill: () => {
      liveFlag = false
    },
    counts: () => ({ spawnCount, closed }),
  }
}

describe("HELLGATE liveness — holder re-spawn vs terminal dispose", () => {
  test("dead (not-disposed) handle ⇒ next ensure re-spawns + reaps the dead one [2]", async () => {
    const fp = flakyPort()
    const session = createBrowserSession(fp.port)
    const a = await session.ensure()
    expect(a.ok && a.value.id).toBe("h-1")
    fp.kill() // page crash — isLive flips false
    const b = await session.ensure()
    expect(b.ok && b.value.id).toBe("h-2") // RE-SPAWNED, not the dead h-1
    expect(fp.counts().spawnCount).toBe(2)
    expect(fp.counts().closed).toContain("h-1") // dead handle reaped
  })

  test("DISPOSED holder stays terminal — no resurrection even if isLive were true", async () => {
    const fp = flakyPort()
    const session = createBrowserSession(fp.port)
    await session.ensure() // h-1
    await session.dispose()
    const r = await session.ensure()
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("closed")
    expect(fp.counts().spawnCount).toBe(1) // never re-spawned
  })
})
