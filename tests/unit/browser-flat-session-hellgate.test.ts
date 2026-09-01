/**
 * Hellgate — CDP flat-session routing (ADR-0427 R3 audit [4][5][10]).
 *
 * Pins the page-session protocol the real-chrome bring-up depends on:
 *   - requests after setActiveSessionId carry the sessionId envelope field;
 *   - events are delivered ONLY when their sessionId matches the page session;
 *   - Target.detachedFromTarget / Target.targetCrashed mark the session dead:
 *     in-flight calls settle fast (cdp-error) and later calls fail fast (no
 *     grind to the full timeout).
 */

import { describe, expect, test } from "bun:test"
import { createCdpSession } from "@/browser/cdp/cdp-session"
import type { CdpConnection, Scheduler } from "@/browser/cdp/ports"

interface Sent {
  readonly id: number
  readonly method: string
  readonly sessionId?: string
}

const fakeConn = () => {
  let onMsg: (raw: string) => void = () => {}
  const sent: Sent[] = []
  const conn: CdpConnection = {
    send: (p) => sent.push(JSON.parse(p) as Sent),
    onMessage: (cb) => {
      onMsg = cb
    },
    close: () => {},
  }
  return {
    conn,
    sent,
    reply: (index: number, result: unknown) =>
      onMsg(JSON.stringify({ id: sent[index]?.id, result })),
    emit: (method: string, sessionId: unknown, params: unknown) =>
      onMsg(JSON.stringify({ method, sessionId, params })),
  }
}

const idleScheduler: Scheduler = { schedule: () => () => {} }

describe("HELLGATE flat-session — sessionId stamping [10]", () => {
  test("requests after setActiveSessionId carry the sessionId; before, they do not", async () => {
    const f = fakeConn()
    const s = createCdpSession({ conn: f.conn, scheduler: idleScheduler })
    // browser-level (no sessionId yet)
    const p0 = s.request("Target.createTarget", { url: "about:blank" })
    f.reply(0, { targetId: "t1" })
    await p0
    expect(f.sent[0]?.sessionId).toBeUndefined()
    // attach → page session
    s.setActiveSessionId("s1")
    const p1 = s.request("Page.enable")
    f.reply(1, {})
    await p1
    expect(f.sent[1]?.sessionId).toBe("s1") // ★ mutation: drop the stamp ⇒ this fails
  })
})

describe("HELLGATE flat-session — event sessionId filter [4]", () => {
  test("foreign-session event does NOT satisfy a page-scoped waiter; matching one does", async () => {
    const f = fakeConn()
    const s = createCdpSession({ conn: f.conn, scheduler: idleScheduler })
    s.setActiveSessionId("s1")
    const p = s.waitForEvent("Page.loadEventFired")
    f.emit("Page.loadEventFired", "OTHER", { t: 1 }) // wrong session — must be ignored
    f.emit("Page.loadEventFired", undefined, { t: 2 }) // browser-level — must be ignored
    f.emit("Page.loadEventFired", "s1", { t: 3 }) // our page — delivers
    const r = await p
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ t: 3 })
  })

  test("before setActiveSessionId, an event with no sessionId is delivered (bring-up phase)", async () => {
    const f = fakeConn()
    const s = createCdpSession({ conn: f.conn, scheduler: idleScheduler })
    const p = s.waitForEvent("Some.event")
    f.emit("Some.event", undefined, { ok: true })
    const r = await p
    expect(r.ok).toBe(true)
  })
})

describe("HELLGATE flat-session — detach/crash dead-session [5]", () => {
  test("Target.detachedFromTarget settles in-flight + fails later calls fast", async () => {
    const f = fakeConn()
    const s = createCdpSession({ conn: f.conn, scheduler: idleScheduler })
    s.setActiveSessionId("s1")
    const inFlight = s.request("Page.captureScreenshot")
    f.emit("Target.detachedFromTarget", undefined, { sessionId: "s1" })
    const r = await inFlight
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("cdp-error")
    // a later call fails fast (does NOT hang to the timeout — idle scheduler never fires)
    const later = await s.request("DOM.getDocument")
    expect(later.ok).toBe(false)
    if (!later.ok) expect(later.error.kind).toBe("cdp-error")
  })

  test("Target.targetCrashed marks dead; a waiting event settles closed", async () => {
    const f = fakeConn()
    const s = createCdpSession({ conn: f.conn, scheduler: idleScheduler })
    s.setActiveSessionId("s1")
    const waiting = s.waitForEvent("Page.loadEventFired")
    f.emit("Target.targetCrashed", undefined, {})
    const r = await waiting
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("closed")
  })

  test("a detach for a DIFFERENT session does NOT kill ours", async () => {
    const f = fakeConn()
    const s = createCdpSession({ conn: f.conn, scheduler: idleScheduler })
    s.setActiveSessionId("s1")
    f.emit("Target.detachedFromTarget", undefined, { sessionId: "other" }) // not ours
    const p = s.request("DOM.getDocument")
    f.reply(0, { ok: true })
    const r = await p
    expect(r.ok).toBe(true) // still alive
  })
})
