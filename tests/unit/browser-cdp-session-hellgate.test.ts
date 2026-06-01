/**
 * Hellgate — CdpSession request/response correlation (ADR-0427, Wave 2).
 *
 * The protocol engine is the riskiest pure logic in the slice. Pinned with a
 * scripted fake connection + manual scheduler — no real browser, no real timers.
 * Every case has a control (the happy correlation) and adversarial twin
 * (unmatched id, protocol error, timeout, abort, dispose, garbage).
 *
 *  HELL-SESS-01: reply to matching id ⇒ ok(result)
 *  HELL-SESS-02: two concurrent requests correlate independently by id
 *  HELL-SESS-03: CDP {error} reply ⇒ cdp-error{detail}
 *  HELL-SESS-04: timeout fires ⇒ timeout{ms}; late reply is ignored (no double-settle)
 *  HELL-SESS-05: pre-aborted signal ⇒ cancelled, nothing sent
 *  HELL-SESS-06: abort mid-flight ⇒ cancelled
 *  HELL-SESS-07: unmatched id + garbage JSON ⇒ ignored, no crash
 *  HELL-SESS-08: waitForEvent resolves on emitted event; non-matching event ignored
 *  HELL-SESS-09: dispose ⇒ pending settle closed; later request ⇒ closed
 */

import { describe, expect, test } from "bun:test"
import { createCdpSession } from "@/browser/cdp/cdp-session"
import type { CdpConnection, Scheduler } from "@/browser/cdp/ports"

interface Sent {
  readonly id: number
  readonly method: string
  readonly params: unknown
}

const fakeConn = () => {
  let onMsg: (raw: string) => void = () => {}
  const sent: Sent[] = []
  let closed = false
  const conn: CdpConnection = {
    send: (p) => sent.push(JSON.parse(p) as Sent),
    onMessage: (cb) => {
      onMsg = cb
    },
    close: () => {
      closed = true
    },
  }
  const idAt = (index: number): number => {
    const m = sent[index]
    if (m === undefined) throw new Error(`no sent[${index}]`)
    return m.id
  }
  return {
    conn,
    sent,
    isClosed: () => closed,
    reply: (id: number, result: unknown) => onMsg(JSON.stringify({ id, result })),
    replyTo: (index: number, result: unknown) => onMsg(JSON.stringify({ id: idAt(index), result })),
    replyErrorTo: (index: number, message: string) =>
      onMsg(JSON.stringify({ id: idAt(index), error: { message } })),
    emit: (method: string, params: unknown) => onMsg(JSON.stringify({ method, params })),
    raw: (s: string) => onMsg(s),
  }
}

const manualScheduler = () => {
  const tasks: Array<{ cb: () => void; cancelled: boolean }> = []
  const scheduler: Scheduler = {
    schedule: (_ms, cb) => {
      const t = { cb, cancelled: false }
      tasks.push(t)
      return () => {
        t.cancelled = true
      }
    },
  }
  return {
    scheduler,
    fireAll: () => {
      for (const t of tasks) if (!t.cancelled) t.cb()
    },
  }
}

describe("HELLGATE CdpSession — correlation + timeout + abort", () => {
  test("HELL-SESS-01: matching id reply ⇒ ok", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.request("Runtime.evaluate", { expression: "1" })
    expect(f.sent).toHaveLength(1)
    f.replyTo(0, { value: 42 })
    const r = await p
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ value: 42 })
  })

  test("HELL-SESS-02: concurrent requests correlate by id", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const pa = s.request("A")
    const pb = s.request("B")
    expect(f.sent.map((x) => x.method)).toEqual(["A", "B"])
    // reply out of order
    f.replyTo(1, "rb")
    f.replyTo(0, "ra")
    const [ra, rb] = await Promise.all([pa, pb])
    expect(ra.ok && ra.value).toBe("ra")
    expect(rb.ok && rb.value).toBe("rb")
  })

  test("HELL-SESS-03: error reply ⇒ cdp-error{detail}", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.request("DOM.getDocument")
    f.replyErrorTo(0, "Cannot find context")
    const r = await p
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("cdp-error")
      if (r.error.kind === "cdp-error") expect(r.error.detail).toBe("Cannot find context")
    }
  })

  test("HELL-SESS-04: timeout ⇒ timeout{ms}; late reply ignored", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler, defaultTimeoutMs: 5000 })
    const p = s.request("Slow")
    sch.fireAll() // fire the timeout
    const r = await p
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("timeout")
      if (r.error.kind === "timeout") expect(r.error.ms).toBe(5000)
    }
    // a late reply must not double-settle / crash
    expect(() => f.replyTo(0, "late")).not.toThrow()
  })

  test("HELL-SESS-05: pre-aborted ⇒ cancelled, nothing sent", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const ac = new AbortController()
    ac.abort()
    const r = await s.request("X", {}, { signal: ac.signal })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("cancelled")
    expect(f.sent).toHaveLength(0) // never hit the wire
  })

  test("HELL-SESS-06: abort mid-flight ⇒ cancelled", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const ac = new AbortController()
    const p = s.request("X", {}, { signal: ac.signal })
    expect(f.sent).toHaveLength(1)
    ac.abort()
    const r = await p
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("cancelled")
  })

  test("HELL-SESS-07: unmatched id + garbage ignored", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.request("X")
    expect(() => f.reply(999, "nobody waiting")).not.toThrow()
    expect(() => f.raw("not json{")).not.toThrow()
    expect(() => f.raw("[1,2,3]")).not.toThrow() // array, not an object message
    f.replyTo(0, "ok") // the real one still resolves
    const r = await p
    expect(r.ok && r.value).toBe("ok")
  })

  test("HELL-SESS-08: waitForEvent resolves on match; other events ignored", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.waitForEvent("Page.loadEventFired")
    f.emit("Page.frameNavigated", { unrelated: true }) // must NOT resolve
    f.emit("Page.loadEventFired", { timestamp: 1 })
    const r = await p
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ timestamp: 1 })
  })

  test("HELL-SESS-09: dispose ⇒ pending closed; later request closed", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.request("X")
    s.dispose()
    const r = await p
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("closed")
    expect(f.isClosed()).toBe(true)
    const r2 = await s.request("Y")
    expect(r2.ok).toBe(false)
    if (!r2.ok) expect(r2.error.kind).toBe("closed")
  })

  // HELL-SESS-10..13 — R1 audit [21][22][29]: waitForEvent timeout/abort/dispose
  // + request send-throws. Each has a mutation it kills (see comments).

  test("HELL-SESS-10: waitForEvent timeout ⇒ timeout{ms}", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler, defaultTimeoutMs: 7000 })
    const p = s.waitForEvent("Page.loadEventFired")
    sch.fireAll() // fire the waitForEvent timer
    const r = await p
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("timeout")
      if (r.error.kind === "timeout") expect(r.error.ms).toBe(7000)
    }
    // a late event must not double-settle / crash (waiter was spliced out)
    expect(() => f.emit("Page.loadEventFired", {})).not.toThrow()
  })

  test("HELL-SESS-11: waitForEvent pre-abort ⇒ cancelled; later emit inert", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const ac = new AbortController()
    ac.abort()
    const r = await s.waitForEvent("Page.loadEventFired", { signal: ac.signal })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("cancelled")
    expect(() => f.emit("Page.loadEventFired", {})).not.toThrow() // waiter never registered
  })

  test("HELL-SESS-12: dispose settles pending waitForEvent ⇒ closed (no hang)", async () => {
    // Mutation killed: dropping the eventWaiter onClosed loop in dispose ⇒ this
    // promise never resolves and the test times out.
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.waitForEvent("Page.loadEventFired")
    s.dispose()
    const r = await p
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("closed")
  })

  test("HELL-SESS-13: conn.send throws ⇒ cdp-error; pending cleared", async () => {
    let onMsg: (raw: string) => void = () => {}
    const conn = {
      send: () => {
        throw new Error("socket write failed")
      },
      onMessage: (cb: (raw: string) => void) => {
        onMsg = cb
      },
      close: () => {},
    }
    const sch = manualScheduler()
    const s = createCdpSession({ conn, scheduler: sch.scheduler })
    const r = await s.request("X")
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("cdp-error")
      if (r.error.kind === "cdp-error") expect(r.error.detail).toBe("socket write failed")
    }
    // id 1 was deleted from pending on the throw ⇒ a stray reply is ignored
    expect(() => onMsg(JSON.stringify({ id: 1, result: "late" }))).not.toThrow()
  })
})
