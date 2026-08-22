/**
 * Hellgate — CdpSession protocol EXTREME edge cases (ADR-0427, Wave 2).
 *
 * Sibling to browser-cdp-session-hellgate.test.ts. Where that file pins the
 * core happy/adversarial twins, THIS file goes for the protocol's nastiest
 * corners: malformed `id` shapes (string/float/negative/zero), replies with
 * BOTH result and error, messages with neither id nor method, raw JSON
 * null/array/number, non-string nested error.message, duplicate replies, late
 * replies after timeout, event params of every shape, fan-out splice delivery,
 * dispose-then-request, 100-way correlation, settle-exactly-once under racing
 * abort/reply, synchronous send throw, and a pre-request message flood.
 *
 * The hard invariant under audit everywhere: each call settles EXACTLY ONCE,
 * and a stray/garbage/duplicate frame never crashes nor double-settles.
 *
 * Every deny/edge case carries a control (a valid correlation that still
 * resolves) so a constant-return mutation in routeReply/routeEvent is caught.
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
    reply: (id: unknown, result: unknown) => onMsg(JSON.stringify({ id, result })),
    replyTo: (index: number, result: unknown) => onMsg(JSON.stringify({ id: idAt(index), result })),
    /** Emit a fully-custom message envelope (any keys). */
    rawMsg: (obj: unknown) => onMsg(JSON.stringify(obj)),
    emit: (method: string, params: unknown) => onMsg(JSON.stringify({ method, params })),
    /** Emit an event envelope with NO params key at all. */
    emitNoParams: (method: string) => onMsg(JSON.stringify({ method })),
    raw: (s: string) => onMsg(s),
    idAt,
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
    liveCount: () => tasks.filter((t) => !t.cancelled).length,
  }
}

describe("HELLGATE CdpSession — EXTREME protocol edges", () => {
  // ── malformed `id` shapes ──────────────────────────────────────────────────

  test("EDGE-01: id as string ⇒ ignored (not a number); real reply still wins", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.request("X")
    const real = f.idAt(0)
    // string "1" must NOT correlate even if the digit matches the real id
    expect(() => f.reply(String(real), "string-id")).not.toThrow()
    f.replyTo(0, "ok")
    const r = await p
    expect(r.ok && r.value).toBe("ok")
  })

  test("EDGE-02: id as float (1.5) ⇒ routed but unmatched ⇒ ignored", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.request("X")
    expect(() => f.reply(1.5, "float")).not.toThrow()
    f.replyTo(0, "ok")
    const r = await p
    expect(r.ok && r.value).toBe("ok")
  })

  test("EDGE-03: id negative ⇒ unmatched ⇒ ignored; control resolves", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.request("X")
    expect(() => f.reply(-1, "neg")).not.toThrow()
    f.replyTo(0, "ok")
    const r = await p
    expect(r.ok && r.value).toBe("ok")
  })

  test("EDGE-04: id zero ⇒ unmatched (seq starts at 1) ⇒ ignored", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.request("X")
    expect(f.idAt(0)).toBe(1) // proves 0 can never be a live id
    expect(() => f.reply(0, "zero")).not.toThrow()
    f.replyTo(0, "ok")
    const r = await p
    expect(r.ok && r.value).toBe("ok")
  })

  test("EDGE-05: id NaN / boolean / null ⇒ ignored; control resolves", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.request("X")
    expect(() => f.rawMsg({ id: null, result: "n" })).not.toThrow()
    expect(() => f.rawMsg({ id: true, result: "b" })).not.toThrow()
    expect(() => f.rawMsg({ id: { nested: 1 }, result: "o" })).not.toThrow()
    f.replyTo(0, "ok")
    const r = await p
    expect(r.ok && r.value).toBe("ok")
  })

  // ── result/error envelope shapes ────────────────────────────────────────────

  test("EDGE-06: reply with BOTH result AND error ⇒ error wins (cdp-error)", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.request("X")
    f.rawMsg({ id: f.idAt(0), result: { value: 1 }, error: { message: "boom" } })
    const r = await p
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("cdp-error")
      if (r.error.kind === "cdp-error") expect(r.error.detail).toBe("boom")
    }
  })

  test("EDGE-07: control — reply with ONLY result ⇒ ok", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.request("X")
    f.rawMsg({ id: f.idAt(0), result: { value: 1 } })
    const r = await p
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ value: 1 })
  })

  test("EDGE-08: error.message non-string (number) ⇒ generic cdp protocol error", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.request("X")
    f.rawMsg({ id: f.idAt(0), error: { message: 42, code: -32000 } })
    const r = await p
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === "cdp-error") {
      expect(r.error.detail).toBe("cdp protocol error")
    }
  })

  test("EDGE-09: deeply nested error.message object ⇒ generic; control string detail", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p1 = s.request("X")
    f.rawMsg({ id: f.idAt(0), error: { message: { deep: { reason: "nope" } } } })
    const r1 = await p1
    expect(r1.ok).toBe(false)
    if (!r1.ok && r1.error.kind === "cdp-error") {
      expect(r1.error.detail).toBe("cdp protocol error") // never stringifies the object
    }
    // control: a real string message DOES come through verbatim
    const p2 = s.request("Y")
    f.rawMsg({ id: f.idAt(1), error: { message: "real detail" } })
    const r2 = await p2
    if (!r2.ok && r2.error.kind === "cdp-error") expect(r2.error.detail).toBe("real detail")
  })

  test("EDGE-10: error present but undefined message ⇒ generic cdp protocol error", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.request("X")
    f.rawMsg({ id: f.idAt(0), error: {} })
    const r = await p
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === "cdp-error") expect(r.error.detail).toBe("cdp protocol error")
  })

  // ── degenerate envelopes ────────────────────────────────────────────────────

  test("EDGE-11: message with NEITHER id nor method ⇒ ignored; control resolves", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.request("X")
    expect(() => f.rawMsg({ result: "orphan" })).not.toThrow()
    expect(() => f.rawMsg({ params: { a: 1 } })).not.toThrow()
    f.replyTo(0, "ok")
    const r = await p
    expect(r.ok && r.value).toBe("ok")
  })

  test("EDGE-12: empty {} envelope ⇒ ignored; control resolves", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.request("X")
    expect(() => f.rawMsg({})).not.toThrow()
    f.replyTo(0, "ok")
    const r = await p
    expect(r.ok && r.value).toBe("ok")
  })

  test("EDGE-13: raw JSON null ⇒ ignored (not an object); control resolves", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.request("X")
    expect(() => f.raw("null")).not.toThrow()
    f.replyTo(0, "ok")
    const r = await p
    expect(r.ok && r.value).toBe("ok")
  })

  test("EDGE-14: raw JSON array / number / string / bool ⇒ all ignored", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.request("X")
    expect(() => f.raw("[1,2,3]")).not.toThrow()
    expect(() => f.raw("3.14")).not.toThrow()
    expect(() => f.raw('"just a string"')).not.toThrow()
    expect(() => f.raw("true")).not.toThrow()
    f.replyTo(0, "ok")
    const r = await p
    expect(r.ok && r.value).toBe("ok")
  })

  // ── duplicate / late / timed-out replies ────────────────────────────────────

  test("EDGE-15: duplicate reply for same id ⇒ second ignored (settle once)", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.request("X")
    f.replyTo(0, "first")
    expect(() => f.replyTo(0, "second")).not.toThrow() // id already deleted from pending
    const r = await p
    expect(r.ok && r.value).toBe("first")
  })

  test("EDGE-16: reply for id that already timed out ⇒ ignored; timeout stands", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler, defaultTimeoutMs: 1234 })
    const p = s.request("X")
    sch.fireAll()
    const r = await p
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === "timeout") expect(r.error.ms).toBe(1234)
    expect(() => f.replyTo(0, "late")).not.toThrow() // no double settle
  })

  test("EDGE-17: timeout AND late reply ordering — first-settler wins both directions", async () => {
    // (a) reply BEFORE timer fires ⇒ ok; firing the (now-cancelled) timer is inert.
    const fa = fakeConn()
    const sa = manualScheduler()
    const sessA = createCdpSession({
      conn: fa.conn,
      scheduler: sa.scheduler,
      defaultTimeoutMs: 500,
    })
    const pa = sessA.request("A")
    fa.replyTo(0, "won")
    sa.fireAll() // timer was cancelled on settle; must be inert
    const ra = await pa
    expect(ra.ok && ra.value).toBe("won")

    // (b) timer BEFORE reply ⇒ timeout; late reply inert.
    const fb = fakeConn()
    const sb = manualScheduler()
    const sessB = createCdpSession({
      conn: fb.conn,
      scheduler: sb.scheduler,
      defaultTimeoutMs: 500,
    })
    const pb = sessB.request("B")
    sb.fireAll()
    fb.replyTo(0, "won")
    const rb = await pb
    expect(rb.ok).toBe(false)
    if (!rb.ok) expect(rb.error.kind).toBe("timeout")
  })

  test("EDGE-18: settle-once cancels the timer (no leaked live task after reply)", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.request("X")
    expect(sch.liveCount()).toBe(1)
    f.replyTo(0, "ok")
    await p
    expect(sch.liveCount()).toBe(0) // cancelTimer ran on settle
  })

  // ── event params shapes ─────────────────────────────────────────────────────

  test("EDGE-19: event with null params ⇒ normalized to {}", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.waitForEvent("E")
    f.emit("E", null)
    const r = await p
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({})
  })

  // BUG: routeEvent normalizes via `typeof p === "object" && p !== null`, but an
  // ARRAY satisfies both (typeof [] === "object", [] !== null), so an array
  // payload is delivered VERBATIM as the event params instead of being coerced
  // to {} — violating the declared waitForEvent return type
  // Readonly<Record<string,unknown>>. The guard must also reject Array.isArray.
  // src/browser/cdp/cdp-session.ts:90 — `typeof rawParams === "object" && rawParams !== null`
  test("EDGE-20: event with array params ⇒ normalized to {} (BUG: array leaks through)", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.waitForEvent("E")
    f.emit("E", [1, 2, 3])
    const r = await p
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({}) // FAILS: receives [1,2,3]
  })

  test("EDGE-20b: array event params normalized to {} (bug #2 fixed)", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.waitForEvent("E")
    f.emit("E", [1, 2, 3])
    const r = await p
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({}) // array no longer leaks — coerced to {}
  })

  test("EDGE-21: event with MISSING params key ⇒ normalized to {}", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.waitForEvent("E")
    f.emitNoParams("E")
    const r = await p
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({})
  })

  test("EDGE-22: control — event with object params ⇒ delivered verbatim", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.waitForEvent("E")
    f.emit("E", { a: 1, nested: { b: 2 } })
    const r = await p
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value).toEqual({ a: 1, nested: { b: 2 } })
  })

  test("EDGE-23: event with non-string method (number) ⇒ not routed; control resolves", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.waitForEvent("E")
    expect(() => f.rawMsg({ method: 123, params: {} })).not.toThrow()
    f.emit("E", { ok: true })
    const r = await p
    expect(r.ok && r.value).toEqual({ ok: true })
  })

  // ── multi-waiter fan-out + splice ───────────────────────────────────────────

  test("EDGE-24: multiple waiters on same event ⇒ ALL delivered once, then spliced", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p1 = s.waitForEvent("E")
    const p2 = s.waitForEvent("E")
    const p3 = s.waitForEvent("E")
    f.emit("E", { n: 7 })
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    for (const r of [r1, r2, r3]) {
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.value).toEqual({ n: 7 })
    }
    // waiters were spliced out — a SECOND emit must not re-settle (already settled)
    // and a fresh waiter sees only the new emit.
    const p4 = s.waitForEvent("E")
    f.emit("E", { n: 99 })
    const r4 = await p4
    expect(r4.ok && r4.value).toEqual({ n: 99 })
  })

  test("EDGE-25: emit with no registered waiters ⇒ inert; later waiter unaffected", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    expect(() => f.emit("E", { early: true })).not.toThrow() // nobody listening yet
    const p = s.waitForEvent("E")
    f.emit("E", { late: true })
    const r = await p
    expect(r.ok && r.value).toEqual({ late: true }) // got the SECOND emit, not the lost first
  })

  // ── dispose interplay ───────────────────────────────────────────────────────

  test("EDGE-26: waitForEvent then dispose ⇒ closed (no hang); later emit inert", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.waitForEvent("E")
    s.dispose()
    const r = await p
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("closed")
    expect(f.isClosed()).toBe(true)
    expect(() => f.emit("E", {})).not.toThrow() // waiter spliced/cleared
  })

  test("EDGE-27: request AFTER dispose ⇒ closed, nothing hits the wire", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    s.dispose()
    const r = await s.request("X")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("closed")
    expect(f.sent).toHaveLength(0)
  })

  test("EDGE-28: waitForEvent AFTER dispose ⇒ closed", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    s.dispose()
    const r = await s.waitForEvent("E")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("closed")
  })

  test("EDGE-29: double dispose ⇒ idempotent (close called once, no throw)", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    let closeCount = 0
    const conn: CdpConnection = {
      send: f.conn.send,
      onMessage: f.conn.onMessage,
      close: () => {
        closeCount += 1
      },
    }
    const s = createCdpSession({ conn, scheduler: sch.scheduler })
    s.dispose()
    expect(() => s.dispose()).not.toThrow()
    expect(closeCount).toBe(1) // second dispose short-circuits on `disposed`
  })

  // ── scale + races ───────────────────────────────────────────────────────────

  test("EDGE-30: 100 concurrent requests all correlate by id (reverse-order replies)", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const N = 100
    const ps: Array<Promise<{ ok: boolean; value?: unknown }>> = []
    for (let i = 0; i < N; i++) ps.push(s.request(`M${i}`) as never)
    expect(f.sent).toHaveLength(N)
    // reply in reverse, each result tagged to its own index
    for (let i = N - 1; i >= 0; i--) f.replyTo(i, `r${i}`)
    const results = await Promise.all(ps)
    for (let i = 0; i < N; i++) {
      const r = results[i]
      expect(r?.ok).toBe(true)
      if (r?.ok) expect(r.value).toBe(`r${i}`)
    }
  })

  test("EDGE-31: abort fires SAME tick as reply ⇒ settle exactly once (reply wins, abort inert)", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const ac = new AbortController()
    const p = s.request("X", {}, { signal: ac.signal })
    // reply first (synchronously settles done=true), then abort in the same tick
    f.replyTo(0, "won")
    expect(() => ac.abort()).not.toThrow() // onAbort sees done=true ⇒ inert
    const r = await p
    expect(r.ok && r.value).toBe("won")
  })

  test("EDGE-32: abort then reply SAME tick ⇒ cancelled wins, reply inert", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const ac = new AbortController()
    const p = s.request("X", {}, { signal: ac.signal })
    ac.abort() // settles cancelled, deletes pending id
    expect(() => f.replyTo(0, "too-late")).not.toThrow()
    const r = await p
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("cancelled")
  })

  test("EDGE-33: conn.send throws synchronously ⇒ cdp-error{detail}; pending cleared", async () => {
    let onMsg: (raw: string) => void = () => {}
    const conn: CdpConnection = {
      send: () => {
        throw new Error("EPIPE write")
      },
      onMessage: (cb) => {
        onMsg = cb
      },
      close: () => {},
    }
    const sch = manualScheduler()
    const s = createCdpSession({ conn, scheduler: sch.scheduler })
    const r = await s.request("X")
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === "cdp-error") expect(r.error.detail).toBe("EPIPE write")
    // pending entry deleted on throw ⇒ a stray matching reply is inert
    expect(() => onMsg(JSON.stringify({ id: 1, result: "stray" }))).not.toThrow()
  })

  test("EDGE-34: conn.send throws a non-Error ⇒ cdp-error with String(value)", async () => {
    const conn: CdpConnection = {
      send: () => {
        // intentionally throwing a non-Error to exercise the String(value) path
        throw "string failure"
      },
      onMessage: () => {},
      close: () => {},
    }
    const sch = manualScheduler()
    const s = createCdpSession({ conn, scheduler: sch.scheduler })
    const r = await s.request("X")
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === "cdp-error") expect(r.error.detail).toBe("string failure")
  })

  test("EDGE-35: onMessage delivered BEFORE any request ⇒ no crash, no listener wired", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    // a flood of frames arrives before anyone calls request/waitForEvent
    expect(() => f.reply(1, "ghost")).not.toThrow()
    expect(() => f.emit("E", { x: 1 })).not.toThrow()
    expect(() => f.raw("garbage{")).not.toThrow()
    expect(() => f.rawMsg({})).not.toThrow()
  })

  test("EDGE-36: pre-request flood then a real request still correlates", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    f.reply(1, "ghost") // id 1 before request ⇒ pending empty ⇒ inert
    const p = s.request("X") // this becomes id 1
    f.replyTo(0, "real")
    const r = await p
    expect(r.ok && r.value).toBe("real")
  })

  test("EDGE-37: mixed id+method frame ⇒ id branch wins (routed as reply)", async () => {
    const f = fakeConn()
    const sch = manualScheduler()
    const s = createCdpSession({ conn: f.conn, scheduler: sch.scheduler })
    const p = s.request("X")
    // frame carries BOTH a numeric id and a method string; impl checks id first
    f.rawMsg({ id: f.idAt(0), method: "SomeEvent", result: "as-reply" })
    const r = await p
    expect(r.ok && r.value).toBe("as-reply")
  })
})
