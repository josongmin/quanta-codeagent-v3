/**
 * Hellgate — wait / read / dialog / console capture through the REAL adapter
 * (ADR-0427 jun-2 absorption #1-#4), over fully faked CDP boundaries. No chrome.
 *
 * Unlike the stub-backed tests, this drives `createCdpBrowser` so the bring-up
 * wiring (Runtime/Log enable + event subscriptions + dialog auto-dismiss) and
 * the real poll/eval JS paths are exercised end-to-end against a scripted wire.
 *
 *  HELL-WRD-01: dialog opening ⇒ adapter auto-sends handleJavaScriptDialog{accept:false}
 *  HELL-WRD-02: consoleAPICalled / exceptionThrown / Log.entryAdded → buffer entries
 *  HELL-WRD-03: wait — selector present ⇒ ok
 *  HELL-WRD-04: wait — absent ⇒ timeout (deterministic clock)
 *  HELL-WRD-05: wait — pre-aborted ⇒ cancelled
 *  HELL-WRD-06: read text/attribute/visible happy
 *  HELL-WRD-07: read unknown ref ⇒ element-not-found (no eval)
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

const DOM_FIXTURE = {
  title: "App",
  root: {
    backendPath: "/",
    role: "document",
    name: "App",
    children: [{ backendPath: "/0", role: "textbox", name: "Email" }],
  },
}

const spawner = (): ProcessSpawner => ({
  which: (cmd) => (cmd === "google-chrome" ? "/usr/bin/google-chrome" : null),
  spawn: (): SpawnedProcess => ({ pid: 7, kill: () => {}, exited: new Promise<number>(() => {}) }),
})

const fs = (): BrowserFs => ({
  existsSync: () => false,
  readFile: (p) => (p.endsWith("DevToolsActivePort") ? "9222\n/devtools/browser/x" : null),
  mkdirp: () => {},
  rmrf: () => {},
})

const idleScheduler: Scheduler = { schedule: () => () => {} }

interface SentMsg {
  readonly id: number
  readonly method: string
  readonly params: Record<string, unknown>
}

interface WireOpts {
  readonly evaluate?: (expr: string) => unknown
}

/** A scripted transport that records every sent frame and exposes an `emit` so
 *  a test can push a CDP event (e.g. a dialog opening) onto the connection. */
const makeWire = (script: WireOpts) => {
  const sent: SentMsg[] = []
  let emit: (method: string, params: Record<string, unknown>) => void = () => {}
  const transport: CdpTransport = {
    connect: async () => {
      let onMsg: (raw: string) => void = () => {}
      const reply = (m: SentMsg): void => {
        let result: unknown = {}
        if (m.method === "Target.createTarget") result = { targetId: "t1" }
        else if (m.method === "Target.attachToTarget") result = { sessionId: "s1" }
        else if (m.method === "Runtime.evaluate") {
          result = { result: { value: script.evaluate?.(String(m.params.expression ?? "")) } }
        }
        onMsg(JSON.stringify({ id: m.id, result }))
      }
      const conn: CdpConnection = {
        onMessage: (cb) => {
          onMsg = cb
        },
        close: () => {},
        send: (raw) => {
          const m = JSON.parse(raw) as SentMsg
          sent.push(m)
          queueMicrotask(() => reply(m))
        },
      }
      emit = (method, params) => onMsg(JSON.stringify({ method, sessionId: "s1", params }))
      return ok(conn)
    },
  }
  return { transport, sent, emitEvent: (m: string, p: Record<string, unknown>) => emit(m, p) }
}

const baseDeps = (
  wire: ReturnType<typeof makeWire>,
  over: { scheduler?: Scheduler; clock?: Clock } = {},
) => ({
  spawner: spawner(),
  transport: wire.transport,
  fs: fs(),
  scheduler: over.scheduler ?? idleScheduler,
  clock: over.clock ?? { now: () => 0 },
  profileRoot: "/jail/.quanta/browser",
  endpointTimeoutMs: 1000,
})

const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 5))

describe("HELLGATE wait/read/dialog/console — real adapter over fakes", () => {
  test("HELL-WRD-01: dialog opening ⇒ auto handleJavaScriptDialog{accept:false}", async () => {
    const wire = makeWire({})
    const b = createCdpBrowser(baseDeps(wire))
    const h = await b.spawn()
    expect(h.ok).toBe(true)
    wire.sent.length = 0 // ignore bring-up frames
    wire.emitEvent("Page.javascriptDialogOpening", { message: "are you sure?", type: "confirm" })
    await flush()
    const handle = wire.sent.find((m) => m.method === "Page.handleJavaScriptDialog")
    expect(handle).toBeDefined()
    expect(handle?.params.accept).toBe(false) // ★ mutation: accept:true ⇒ fails
  })

  test("HELL-WRD-02: console/error/log events land in the buffer", async () => {
    const wire = makeWire({})
    const b = createCdpBrowser(baseDeps(wire))
    const h = await b.spawn()
    if (!h.ok) throw new Error("spawn failed")
    wire.emitEvent("Runtime.consoleAPICalled", { type: "error", args: [{ value: "boom" }] })
    wire.emitEvent("Runtime.exceptionThrown", {
      exceptionDetails: { exception: { description: "TypeError: x is undefined" } },
    })
    wire.emitEvent("Log.entryAdded", { entry: { level: "warning", text: "mixed content" } })
    await flush()
    const r = await b.consoleMessages(h.value)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.entries).toHaveLength(3)
    expect(r.value.entries[0]).toMatchObject({ level: "error", text: "boom" })
    expect(r.value.entries[1]).toMatchObject({ level: "error", text: "TypeError: x is undefined" })
    expect(r.value.entries[2]).toMatchObject({ level: "warn", text: "mixed content" })
    // clear drains
    const r2 = await b.consoleMessages(h.value, { clear: true })
    expect(r2.ok && r2.value.entries).toHaveLength(3)
    const r3 = await b.consoleMessages(h.value)
    expect(r3.ok && r3.value.entries).toHaveLength(0)
  })

  test("HELL-WRD-03: wait — selector present ⇒ ok", async () => {
    const wire = makeWire({ evaluate: (e) => e.includes("querySelector") })
    const b = createCdpBrowser(baseDeps(wire))
    const h = await b.spawn()
    if (!h.ok) throw new Error("spawn")
    const r = await b.wait(h.value, { selector: "#ready" })
    expect(r.ok).toBe(true)
  })

  test("HELL-WRD-04: wait — absent ⇒ timeout (deterministic clock)", async () => {
    // The scheduler advances the injected clock and fires `cb` on a real
    // macrotask so a CDP request's microtask reply always settles first (the
    // poll eval resolves before its own request-timeout would) — only the wait
    // poll-sleep advances time, and the loop exits via clock.now() vs timeoutMs.
    const state = { t: 0 }
    const scheduler: Scheduler = {
      schedule: (ms, cb) => {
        const handle = setTimeout(() => {
          state.t += ms
          cb()
        }, 0)
        return () => clearTimeout(handle)
      },
    }
    const wire = makeWire({ evaluate: () => false }) // never present
    const b = createCdpBrowser(baseDeps(wire, { scheduler, clock: { now: () => state.t } }))
    const h = await b.spawn()
    if (!h.ok) throw new Error("spawn")
    const r = await b.wait(h.value, { selector: "#never", timeoutMs: 500 })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("timeout")
      if (r.error.kind === "timeout") expect(r.error.ms).toBe(500)
    }
  })

  test("HELL-WRD-05: wait — pre-aborted ⇒ cancelled", async () => {
    const wire = makeWire({ evaluate: () => false })
    const b = createCdpBrowser(baseDeps(wire))
    const h = await b.spawn()
    if (!h.ok) throw new Error("spawn")
    const ac = new AbortController()
    ac.abort()
    const r = await b.wait(h.value, { selector: "#x" }, ac.signal)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("cancelled")
  })

  test("HELL-WRD-06: read text/attribute/visible happy", async () => {
    const wire = makeWire({
      evaluate: (e) => {
        if (e.includes("walk(document.body")) return JSON.stringify(DOM_FIXTURE)
        // disambiguate by the `const what = "<what>"` the readJs embeds
        if (e.includes('const what = "attribute"')) return { value: "email" }
        if (e.includes('const what = "visible"')) return { value: true }
        if (e.includes('const what = "text"')) return { value: "Sign in" }
        return undefined
      },
    })
    const b = createCdpBrowser(baseDeps(wire))
    const h = await b.spawn()
    if (!h.ok) throw new Error("spawn")
    await b.snapshot(h.value) // mint refs
    const t = await b.read(h.value, "e2", { what: "text" })
    expect(t.ok && t.value.value).toBe("Sign in")
    const a = await b.read(h.value, "e2", { what: "attribute", attr: "name" })
    expect(a.ok && a.value.value).toBe("email")
    const v = await b.read(h.value, "e2", { what: "visible" })
    expect(v.ok && v.value.value).toBe(true)
  })

  test("HELL-WRD-07: read unknown ref ⇒ element-not-found", async () => {
    let evals = 0
    const wire = makeWire({
      evaluate: (e) => {
        if (e.includes("walk(document.body")) return JSON.stringify(DOM_FIXTURE)
        evals += 1
        return { value: "x" }
      },
    })
    const b = createCdpBrowser(baseDeps(wire))
    const h = await b.spawn()
    if (!h.ok) throw new Error("spawn")
    await b.snapshot(h.value)
    const r = await b.read(h.value, "e999", { what: "text" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("element-not-found")
    expect(evals).toBe(0) // never ran the read JS for an unknown ref
  })
})
