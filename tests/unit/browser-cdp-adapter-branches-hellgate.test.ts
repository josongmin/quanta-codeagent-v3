/**
 * Hellgate — CDP adapter error branches (ADR-0427 R1 audit [24][27][28]).
 *
 * Covers the failure paths HELL-ADP-01..10 left unproven: navigate Page.navigate
 * error / load-timeout / non-string title; click/type cdp-error + eval-false;
 * screenshot success-decode + no-data. A configurable scripted transport drives
 * the real `createCdpBrowser`.
 */

import { describe, expect, test } from "bun:test"
import type {
  BrowserFs,
  CdpConnection,
  CdpTransport,
  Clock,
  ProcessSpawner,
  Scheduler,
} from "@/browser/cdp/ports"
import { createCdpBrowser } from "@/browser/cdp-adapter"
import { ok } from "@/shared"

const DOM = {
  title: "P",
  root: {
    backendPath: "/",
    role: "document",
    name: "P",
    children: [{ backendPath: "/0", role: "button", name: "Go" }],
  },
}

interface TxScript {
  navigateError?: string
  noLoad?: boolean
  titleValue?: unknown
  evalFalse?: boolean
  evalException?: string
  screenshot?: string | null
  enableError?: string
  createTargetError?: string
  noTargetId?: boolean
  attachError?: string
  noSessionId?: boolean
}

const spawner: ProcessSpawner = {
  which: () => "/usr/bin/google-chrome",
  spawn: () => ({ pid: 1, kill: () => {}, exited: new Promise<number>(() => {}) }),
}
const fs: BrowserFs = {
  existsSync: () => false,
  readFile: (p) => (p.endsWith("DevToolsActivePort") ? "9222\n/devtools/browser/x" : null),
  mkdirp: () => {},
  rmrf: () => {},
}
const idleScheduler: Scheduler = { schedule: () => () => {} }
const clock: Clock = { now: () => 0 }

interface SentMsg {
  readonly id: number
  readonly method: string
  readonly params: { expression?: string }
}

const evalBody = (id: number, expr: string, s: TxScript): string => {
  if (
    s.evalException !== undefined &&
    (expr.includes(".click()") || expr.includes("dispatchEvent"))
  ) {
    return JSON.stringify({ id, result: { exceptionDetails: { text: s.evalException } } })
  }
  let value: unknown
  if (expr === "document.title") value = "titleValue" in s ? s.titleValue : "P"
  else if (expr.includes("walk(document.body")) value = JSON.stringify(DOM)
  else value = s.evalFalse !== true
  return JSON.stringify({ id, result: { result: { value } } })
}

// Bring-up reply (Target.* + Page.enable) — returns the wire JSON or null when
// `m` is not a bring-up method. Keeps respond() under the complexity budget.
const bringUpReply = (m: SentMsg, s: TxScript): string | null => {
  if (m.method === "Target.createTarget") {
    return s.createTargetError !== undefined
      ? JSON.stringify({ id: m.id, error: { message: s.createTargetError } })
      : JSON.stringify({ id: m.id, result: s.noTargetId === true ? {} : { targetId: "t1" } })
  }
  if (m.method === "Target.attachToTarget") {
    return s.attachError !== undefined
      ? JSON.stringify({ id: m.id, error: { message: s.attachError } })
      : JSON.stringify({ id: m.id, result: s.noSessionId === true ? {} : { sessionId: "s1" } })
  }
  if (m.method === "Page.enable" && s.enableError !== undefined) {
    return JSON.stringify({ id: m.id, error: { message: s.enableError } })
  }
  return null
}

const respond = (m: SentMsg, s: TxScript, emit: (raw: string) => void): void => {
  if (m.method === "Runtime.evaluate") {
    emit(evalBody(m.id, m.params.expression ?? "", s))
    return
  }
  if (m.method === "Page.captureScreenshot") {
    emit(
      JSON.stringify({
        id: m.id,
        result: s.screenshot === null ? {} : { data: s.screenshot ?? "QUFB" },
      }),
    )
    return
  }
  const bring = bringUpReply(m, s)
  if (bring !== null) {
    emit(bring)
    return
  }
  if (m.method === "Page.navigate" && s.navigateError !== undefined) {
    emit(JSON.stringify({ id: m.id, error: { message: s.navigateError } }))
    return
  }
  emit(JSON.stringify({ id: m.id, result: {} }))
  if (m.method === "Page.navigate" && s.noLoad !== true) {
    setTimeout(
      () => emit(JSON.stringify({ method: "Page.loadEventFired", params: {}, sessionId: "s1" })),
      0,
    )
  }
}

const transport = (s: TxScript): CdpTransport => ({
  connect: async () => {
    let emit: (raw: string) => void = () => {}
    const conn: CdpConnection = {
      onMessage: (cb) => {
        emit = cb
      },
      close: () => {},
      send: (raw) => {
        const m = JSON.parse(raw) as SentMsg
        queueMicrotask(() => respond(m, s, emit))
      },
    }
    return ok(conn)
  },
})

const browser = (s: TxScript) =>
  createCdpBrowser({
    spawner,
    transport: transport(s),
    fs,
    scheduler: idleScheduler,
    clock,
    profileRoot: "/jail/b",
    endpointTimeoutMs: 1000,
  })

const spawned = async (s: TxScript) => {
  const b = browser(s)
  const h = await b.spawn()
  if (!h.ok) throw new Error("spawn failed")
  return { b, h: h.value }
}

describe("HELLGATE adapter branches — navigate [24]", () => {
  test("Page.navigate error ⇒ cdp-error propagated", async () => {
    const { b, h } = await spawned({ navigateError: "net::ERR" })
    const r = await b.navigate(h, "https://x.test/")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("cdp-error")
  })

  test("load event never fires ⇒ timeout", async () => {
    // manual scheduler: request timers are cancelled when their reply wins, so
    // the only live timer after navigate's Page.navigate resolves is the
    // loadEventFired waiter — fire it to trigger the timeout (R1 audit [24]).
    const timers: Array<{ cb: () => void; cancelled: boolean }> = []
    const sched: Scheduler = {
      schedule: (_ms, cb) => {
        const t = { cb, cancelled: false }
        timers.push(t)
        return () => {
          t.cancelled = true
        }
      },
    }
    const b = createCdpBrowser({
      spawner,
      transport: transport({ noLoad: true }),
      fs,
      scheduler: sched,
      clock,
      profileRoot: "/jail/b",
      endpointTimeoutMs: 100_000,
    })
    const h = await b.spawn()
    expect(h.ok).toBe(true)
    if (!h.ok) return
    const navP = b.navigate(h.value, "https://x.test/")
    await new Promise((r) => setTimeout(r, 0)) // drain microtasks → waitForEvent registered
    for (const t of timers) if (!t.cancelled) t.cb() // fire the live loadEventFired timer
    const r = await navP
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("timeout")
  })

  test("non-string title ⇒ navigate ok with empty title", async () => {
    const { b, h } = await spawned({ titleValue: 12345 })
    const r = await b.navigate(h, "https://x.test/")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.value.title).toBe("")
  })
})

describe("HELLGATE adapter branches — click/type [27]", () => {
  test("eval returns false ⇒ element-not-found", async () => {
    const { b, h } = await spawned({ evalFalse: true })
    await b.navigate(h, "https://x.test/")
    await b.snapshot(h) // refs e1,e2
    const r = await b.click(h, "e2")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("element-not-found")
  })

  test("eval exceptionDetails ⇒ cdp-error", async () => {
    const { b, h } = await spawned({ evalException: "ReferenceError: x" })
    await b.navigate(h, "https://x.test/")
    await b.snapshot(h)
    const r = await b.type(h, "e2", "hi")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("cdp-error")
  })
})

describe("HELLGATE adapter branches — bring-up failure [18]", () => {
  test("Page.enable error ⇒ spawn-failed + profile removed", async () => {
    const rm: string[] = []
    const recordingFs: BrowserFs = {
      ...fs,
      rmrf: (p) => rm.push(p),
    }
    let killed = 0
    const b = createCdpBrowser({
      spawner: {
        which: () => "/usr/bin/google-chrome",
        spawn: () => ({
          pid: 1,
          kill: () => {
            killed += 1
          },
          exited: new Promise<number>(() => {}),
        }),
      },
      transport: transport({ enableError: "Target closed" }),
      fs: recordingFs,
      scheduler: idleScheduler,
      clock,
      profileRoot: "/jail/b",
      endpointTimeoutMs: 1000,
    })
    const r = await b.spawn()
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.error.kind).toBe("spawn-failed")
      if (r.error.kind === "spawn-failed") expect(r.error.detail).toContain("Page.enable")
    }
    expect(rm).toHaveLength(1) // temp profile cleaned up
    expect(killed).toBe(1) // chrome proc killed
  })
})

describe("HELLGATE adapter branches — screenshot [28]", () => {
  test("success ⇒ decoded bytes", async () => {
    const { b, h } = await spawned({ screenshot: "QUFB" }) // "AAA"
    const r = await b.screenshot(h)
    expect(r.ok).toBe(true)
    if (r.ok) expect(Array.from(r.value)).toEqual([0x41, 0x41, 0x41])
  })

  test("no data field ⇒ cdp-error", async () => {
    const { b, h } = await spawned({ screenshot: null })
    const r = await b.screenshot(h)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("cdp-error")
  })
})

describe("HELLGATE adapter branches — flat-session bring-up arms [13]", () => {
  const recFs = (rm: string[]): BrowserFs => ({ ...fs, rmrf: (p) => rm.push(p) })
  const build = (s: TxScript) => {
    const rm: string[] = []
    const b = createCdpBrowser({
      spawner: {
        which: () => "/usr/bin/google-chrome",
        spawn: () => ({ pid: 1, kill: () => {}, exited: new Promise<number>(() => {}) }),
      },
      transport: transport(s),
      fs: recFs(rm),
      scheduler: idleScheduler,
      clock,
      profileRoot: "/jail/b",
      endpointTimeoutMs: 1000,
    })
    return { b, rm }
  }
  const ARMS: ReadonlyArray<[string, TxScript, string]> = [
    ["Target.createTarget error", { createTargetError: "boom" }, "Target.createTarget"],
    ["no targetId", { noTargetId: true }, "targetId"],
    ["Target.attachToTarget error", { attachError: "nope" }, "Target.attachToTarget"],
    ["no sessionId", { noSessionId: true }, "sessionId"],
  ]
  for (const [label, script, detailNeedle] of ARMS) {
    test(`${label} ⇒ spawn-failed + profile cleaned`, async () => {
      const { b, rm } = build(script)
      const r = await b.spawn()
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.error.kind).toBe("spawn-failed")
        if (r.error.kind === "spawn-failed") expect(r.error.detail).toContain(detailNeedle)
      }
      expect(rm).toHaveLength(1) // temp profile removed on the failed arm
    })
  }
})

describe("HELLGATE adapter — navigate invalidates stale refs [12]", () => {
  test("a ref from page A is dead after navigating to page B (no re-snapshot)", async () => {
    const b = browser({}) // COLLECT returns a DOM with one child ⇒ refs e1,e2
    const h = await b.spawn()
    expect(h.ok).toBe(true)
    if (!h.ok) return
    await b.navigate(h.value, "https://a.test/")
    const snap = await b.snapshot(h.value)
    expect(snap.ok).toBe(true)
    const okClick = await b.click(h.value, "e2") // valid on page A
    expect(okClick.ok).toBe(true)
    // navigate to B → refMap.invalidate() fires; the old ref must now fail closed
    await b.navigate(h.value, "https://b.test/")
    const stale = await b.click(h.value, "e2")
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.error.kind).toBe("element-not-found")
  })

  test("WIRING — the adapter tells the endpoint wait when Chrome has exited", async () => {
    // The endpoint wait can only see a death it is told about. A spawner whose
    // process exits at once, and a profile that never gets the port file: the
    // spawn must fail as an EXIT, well before its endpoint budget.
    const state = { t: 0 }
    const b = createCdpBrowser({
      spawner: {
        which: () => "/usr/bin/google-chrome",
        spawn: () => ({ pid: 1, kill: () => {}, exited: Promise.resolve(1) }),
      },
      transport: { connect: async () => ok({} as CdpConnection) } as unknown as CdpTransport,
      fs: { existsSync: () => false, readFile: () => null, mkdirp: () => {}, rmrf: () => {} },
      scheduler: {
        schedule: (ms, cb) => {
          state.t += ms
          queueMicrotask(cb)
          return () => {}
        },
      },
      clock: { now: () => state.t },
      profileRoot: "/tmp/cdp-exit-arm",
      endpointTimeoutMs: 60_000,
    })
    const spawned = await b.spawn()
    expect(spawned.ok).toBe(false)
    if (!spawned.ok) {
      expect(spawned.error).toEqual({
        kind: "spawn-failed",
        detail: "Chrome exited with code 1 before the DevTools endpoint was ready",
      })
    }
    expect(state.t).toBeLessThan(60_000)
  })
})
