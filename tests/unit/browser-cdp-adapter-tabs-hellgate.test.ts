/**
 * Hellgate — CDP adapter MULTI-TAB (TICKET-24 Wave B).
 *
 * Drives the REAL `createCdpBrowser` over a fake CDP transport that mints
 * sequential targetIds/sessionIds and RECORDS the envelope `sessionId` of every
 * send. Proves the state machine + the load-bearing invariants:
 *
 *  TABS-01: newTab → listTabs reflects 2 tabs; the first stays active.
 *  TABS-02: Target.* (create/attach/close/activate) are BROWSER-LEVEL — their
 *           send envelope carries NO sessionId even after a page session is active.
 *  TABS-03: after switchTab, a page op (Runtime.evaluate) routes to the SWITCHED
 *           tab's sessionId.
 *  TABS-04: REF ISOLATION — a ref minted on tab A fails closed on tab B (each tab
 *           owns its refMap), with NO eval issued for the stale ref.
 *  TABS-05: closeTab(active) reassigns the active tab.
 *  TABS-06: closeTab(unknown id) → tab-not-found listing the open ids.
 *  TABS-07: closeTab the LAST remaining tab is refused.
 *  TABS-08: switchTab accepts a 0-based INDEX as well as an id.
 */

import { describe, expect, test } from "bun:test"
import type {
  BrowserFs,
  CdpConnection,
  CdpTransport,
  ProcessSpawner,
  Scheduler,
  SpawnedProcess,
} from "@/browser/cdp/ports"
import { createCdpBrowser } from "@/browser/cdp-adapter"
import { ok } from "@/shared"

const DOM_FIXTURE = {
  title: "Tab Page",
  root: {
    backendPath: "/",
    role: "document",
    name: "Tab Page",
    children: [
      { backendPath: "/0", role: "textbox", name: "Email" },
      { backendPath: "/1", role: "button", name: "Sign in" },
    ],
  },
}

const spawnerThatFinds = (): ProcessSpawner => ({
  which: (cmd) => (cmd === "google-chrome" ? "/usr/bin/google-chrome" : null),
  spawn: (): SpawnedProcess => ({ pid: 4242, kill: () => {}, exited: new Promise<number>(() => {}) }),
})
const fsReady = (): BrowserFs => ({
  existsSync: () => false,
  readFile: (p) => (p.endsWith("DevToolsActivePort") ? "9222\n/devtools/browser/x" : null),
  mkdirp: () => {},
  rmrf: () => {},
})
const idleScheduler: Scheduler = { schedule: () => () => {} }

interface Sent {
  readonly id: number
  readonly method: string
  readonly sessionId: string | undefined
  readonly params: { expression?: string }
}

/** Fake transport: sequential t#/s# per create/attach, records every send's
 *  envelope sessionId, and evaluates the adapter's Runtime.evaluate expression. */
const tabTransport = (sends: Sent[]): CdpTransport => ({
  connect: async () => {
    let onMsg: (raw: string) => void = () => {}
    let targets = 0
    let sessionsN = 0
    const replyFor = (m: Sent): unknown => {
      if (m.method === "Target.createTarget") {
        targets += 1
        return { targetId: `t${targets}` }
      }
      if (m.method === "Target.attachToTarget") {
        sessionsN += 1
        return { sessionId: `s${sessionsN}` }
      }
      if (m.method === "Runtime.evaluate") {
        const expr = m.params.expression ?? ""
        if (expr === "document.title") return { result: { value: "Tab Page" } }
        if (expr.includes("walk(document.body")) return { result: { value: JSON.stringify(DOM_FIXTURE) } }
        return { result: { value: null } }
      }
      return {}
    }
    const respond = (m: Sent): void => {
      onMsg(JSON.stringify({ id: m.id, result: replyFor(m) }))
      if (m.method === "Page.navigate") {
        setTimeout(
          () => onMsg(JSON.stringify({ method: "Page.loadEventFired", params: {}, sessionId: m.sessionId })),
          0,
        )
      }
    }
    const conn: CdpConnection = {
      onMessage: (cb) => {
        onMsg = cb
      },
      close: () => {},
      send: (raw) => {
        const parsed = JSON.parse(raw) as { id: number; method: string; sessionId?: string; params?: { expression?: string } }
        const m: Sent = { id: parsed.id, method: parsed.method, sessionId: parsed.sessionId, params: parsed.params ?? {} }
        sends.push(m)
        queueMicrotask(() => respond(m))
      },
    }
    return ok(conn)
  },
})

const deps = (sends: Sent[]) => ({
  spawner: spawnerThatFinds(),
  transport: tabTransport(sends),
  fs: fsReady(),
  scheduler: idleScheduler,
  clock: { now: () => 0 },
  profileRoot: "/jail/.quanta/browser",
  endpointTimeoutMs: 1000,
})

/** Spawn + navigate + snapshot so tab #1 (s1) has refs e1/e2/e3 minted. */
const ready = async (sends: Sent[]) => {
  const b = createCdpBrowser(deps(sends))
  const h = await b.spawn()
  if (!h.ok) throw new Error("spawn failed")
  await b.navigate(h.value, "https://app.test/login")
  await b.snapshot(h.value)
  return { b, handle: h.value }
}

const evalsWithSession = (sends: Sent[], sid: string | undefined): Sent[] =>
  sends.filter((s) => s.method === "Runtime.evaluate" && s.sessionId === sid)

describe("HELLGATE CDP adapter — multi-tab (Wave B)", () => {
  test("TABS-01: newTab ⇒ listTabs shows 2; first stays active", async () => {
    const sends: Sent[] = []
    const { b, handle } = await ready(sends)
    const nt = await b.newTab(handle)
    expect(nt.ok).toBe(true)
    if (!nt.ok) return
    expect(nt.value.active).toBe(false) // newTab does NOT auto-foreground
    const list = await b.listTabs(handle)
    expect(list.ok).toBe(true)
    if (!list.ok) return
    expect(list.value.length).toBe(2)
    expect(list.value.filter((t) => t.active).length).toBe(1)
    expect(list.value[0]?.active).toBe(true) // tab #1 still active
    expect(list.value[1]?.id).toBe(nt.value.id)
  })

  test("TABS-02: Target.* are browser-level (no sessionId) even with an active page", async () => {
    const sends: Sent[] = []
    const { b, handle } = await ready(sends)
    sends.length = 0 // clear bring-up
    await b.newTab(handle)
    const create = sends.find((s) => s.method === "Target.createTarget")
    const attach = sends.find((s) => s.method === "Target.attachToTarget")
    expect(create?.sessionId).toBeUndefined() // browser-level (sessionId:null)
    expect(attach?.sessionId).toBeUndefined()
    // (The contrasting claim — page ops DO carry the active session — is proven
    // with teeth in TABS-03 via switchTab; the prior `…length >= 0` assertion
    // here was vacuous, since this scenario issues no s1 page op at all.)
  })

  test("TABS-03: after switchTab, page ops route to the switched tab's sessionId", async () => {
    const sends: Sent[] = []
    const { b, handle } = await ready(sends)
    const nt = await b.newTab(handle) // t2/s2
    if (!nt.ok) return
    const sw = await b.switchTab(handle, nt.value.id)
    expect(sw.ok).toBe(true)
    sends.length = 0
    await b.snapshot(handle) // a page op (collect-script eval) on the now-active tab
    const s2Evals = evalsWithSession(sends, "s2")
    const s1Evals = evalsWithSession(sends, "s1")
    expect(s2Evals.length).toBeGreaterThan(0) // routed to s2
    expect(s1Evals.length).toBe(0) // NOT the old tab
  })

  test("TABS-04: REF ISOLATION — a ref from tab A fails closed on tab B (no eval issued)", async () => {
    const sends: Sent[] = []
    const { b, handle } = await ready(sends) // e1/e2/e3 minted on tab #1
    const nt = await b.newTab(handle)
    if (!nt.ok) return
    await b.switchTab(handle, nt.value.id) // tab #2 has a FRESH empty refMap
    sends.length = 0
    const click = await b.click(handle, "e2") // e2 belongs to tab #1
    expect(click.ok).toBe(false)
    if (!click.ok) expect(click.error.kind).toBe("element-not-found")
    // Fail-closed BEFORE any eval — the stale ref never reaches the page.
    expect(sends.filter((s) => s.method === "Runtime.evaluate").length).toBe(0)
  })

  test("TABS-05: closeTab(active) reassigns the active tab", async () => {
    const sends: Sent[] = []
    const { b, handle } = await ready(sends)
    const nt = await b.newTab(handle) // t2
    if (!nt.ok) return
    const close = await b.closeTab(handle, "t1") // close the active tab #1
    expect(close.ok).toBe(true)
    const list = await b.listTabs(handle)
    if (!list.ok) return
    expect(list.value.length).toBe(1)
    expect(list.value[0]?.id).toBe("t2")
    expect(list.value[0]?.active).toBe(true) // reassigned to the survivor
  })

  test("TABS-06: closeTab(unknown) ⇒ tab-not-found with the open ids", async () => {
    const sends: Sent[] = []
    const { b, handle } = await ready(sends)
    await b.newTab(handle)
    const r = await b.closeTab(handle, "t999")
    expect(r.ok).toBe(false)
    if (!r.ok && r.error.kind === "tab-not-found") {
      expect(r.error.id).toBe("t999")
      expect(r.error.open).toContain("t1")
      expect(r.error.open).toContain("t2")
    } else {
      throw new Error("expected tab-not-found")
    }
  })

  test("TABS-07: closing the LAST tab is refused", async () => {
    const sends: Sent[] = []
    const { b, handle } = await ready(sends)
    const r = await b.closeTab(handle, "t1") // only one tab open
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("cdp-error") // "cannot close the last tab"
  })

  test("TABS-08: switchTab accepts a 0-based index", async () => {
    const sends: Sent[] = []
    const { b, handle } = await ready(sends)
    const nt = await b.newTab(handle)
    if (!nt.ok) return
    const sw = await b.switchTab(handle, "1") // index 1 == the second tab
    expect(sw.ok).toBe(true)
    if (sw.ok) expect(sw.value.id).toBe(nt.value.id)
  })
})
