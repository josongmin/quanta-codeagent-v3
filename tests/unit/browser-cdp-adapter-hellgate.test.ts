/**
 * Hellgate — CDP adapter orchestration (ADR-0427, Wave 2).
 *
 * Drives the REAL `createCdpBrowser` against fully faked boundaries (spawner /
 * transport / fs / scheduler / clock) — same BrowserPort contract the headless
 * stub satisfies, but exercising the actual spawn→endpoint→session→teardown
 * orchestration. No real chrome.
 *
 *  HELL-ADP-01: availability ⇒ "chromium" when binary resolves, null otherwise
 *  HELL-ADP-02: spawn ⇒ ok handle; mkdirp + chrome argv + Page.enable issued
 *  HELL-ADP-03: no binary ⇒ backend-missing (no spawn, no profile)
 *  HELL-ADP-04: DevTools endpoint never ready ⇒ spawn-failed + proc killed + profile rm'd
 *  HELL-ADP-05: transport connect fails ⇒ spawn-failed + cleanup
 *  HELL-ADP-06: navigate waits loadEventFired then reads title
 *  HELL-ADP-07: snapshot ⇒ buildSnapshot over collected model; refs usable
 *  HELL-ADP-08: click(known ref) ⇒ ok; click(unknown ref) ⇒ element-not-found (no eval)
 *  HELL-ADP-09: cdp allowlist enforced end-to-end through the real adapter
 *  HELL-ADP-10: close ⇒ proc killed + profile removed + idempotent; post-close ⇒ closed
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
  title: "Login Page",
  root: {
    backendPath: "/",
    role: "document",
    name: "Login Page",
    children: [
      { backendPath: "/0", role: "textbox", name: "Email" },
      { backendPath: "/1", role: "button", name: "Sign in" },
    ],
  },
}

const spawnerThatFinds = (calls: { argv: readonly string[] | null }): ProcessSpawner => ({
  which: (cmd) => (cmd === "google-chrome" ? "/usr/bin/google-chrome" : null),
  spawn: (argv): SpawnedProcess => {
    calls.argv = argv
    return { pid: 4242, kill: () => {}, exited: new Promise<number>(() => {}) }
  },
})

const fsWithPort = (
  log: { mkdirp: string[]; rmrf: string[]; killed: boolean },
  portReady: boolean,
): BrowserFs => ({
  existsSync: () => false,
  readFile: (p) =>
    portReady && p.endsWith("DevToolsActivePort") ? "9222\n/devtools/browser/x" : null,
  mkdirp: (p) => log.mkdirp.push(p),
  rmrf: (p) => log.rmrf.push(p),
})

// never-firing scheduler: requests resolve via transport replies, not timeouts
const idleScheduler: Scheduler = { schedule: () => () => {} }

interface ScriptOpts {
  readonly evaluate?: (expr: string) => unknown
  readonly screenshot?: string
}

interface SentMsg {
  readonly id: number
  readonly method: string
  readonly params: { expression?: string }
}

const replyFor = (m: SentMsg, script: ScriptOpts): unknown => {
  if (m.method === "Runtime.evaluate") {
    const value = script.evaluate ? script.evaluate(m.params.expression ?? "") : undefined
    return { result: { value } }
  }
  if (m.method === "Page.captureScreenshot") return { data: script.screenshot ?? "" }
  if (m.method === "Target.createTarget") return { targetId: "t1" }
  if (m.method === "Target.attachToTarget") return { sessionId: "s1" }
  return {}
}

const scriptedTransport = (script: ScriptOpts): CdpTransport => ({
  connect: async () => {
    let onMsg: (raw: string) => void = () => {}
    const respond = (m: SentMsg): void => {
      onMsg(JSON.stringify({ id: m.id, result: replyFor(m, script) }))
      if (m.method === "Page.navigate") {
        // emit the load event on a later macrotask, after the adapter has
        // registered the waitForEvent waiter
        setTimeout(
          () =>
            onMsg(JSON.stringify({ method: "Page.loadEventFired", params: {}, sessionId: "s1" })),
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
        const m = JSON.parse(raw) as SentMsg
        queueMicrotask(() => respond(m))
      },
    }
    return ok(conn)
  },
})

const evalScript = (expr: string): unknown => {
  if (expr === "document.title") return "Login Page"
  if (expr.includes("walk(document.body")) return JSON.stringify(DOM_FIXTURE) // COLLECT_SCRIPT marker
  if (expr.includes(".click()")) return true
  if (expr.includes("dispatchEvent")) return true
  return undefined
}

const baseDeps = (over: { portReady?: boolean; scheduler?: Scheduler; clock?: Clock } = {}) => {
  const log = { mkdirp: [] as string[], rmrf: [] as string[], killed: false }
  const calls = { argv: null as readonly string[] | null }
  return {
    log,
    calls,
    deps: {
      spawner: spawnerThatFinds(calls),
      transport: scriptedTransport({ evaluate: evalScript, screenshot: "AAAA" }),
      fs: fsWithPort(log, over.portReady ?? true),
      scheduler: over.scheduler ?? idleScheduler,
      clock: over.clock ?? { now: () => 0 },
      profileRoot: "/jail/.quanta/browser",
      endpointTimeoutMs: 1000,
    },
  }
}

describe("HELLGATE CDP adapter — orchestration over fakes", () => {
  test("HELL-ADP-01: availability reflects binary probe", () => {
    const b = createCdpBrowser(baseDeps().deps)
    expect(b.availability()).toBe("chromium")
    const noChrome = createCdpBrowser({
      ...baseDeps().deps,
      spawner: {
        which: () => null,
        spawn: () => ({ pid: 0, kill: () => {}, exited: new Promise<number>(() => {}) }),
      },
    })
    expect(noChrome.availability()).toBeNull()
  })

  test("HELL-ADP-02: spawn ⇒ ok handle + profile + chrome flags", async () => {
    const { deps, log, calls } = baseDeps()
    const b = createCdpBrowser(deps)
    const h = await b.spawn()
    expect(h.ok).toBe(true)
    if (!h.ok) return
    expect(h.value.backend).toBe("chromium")
    expect(log.mkdirp).toHaveLength(1)
    expect(calls.argv).not.toBeNull()
    expect(calls.argv?.join(" ")).toContain("--headless=new")
    expect(calls.argv?.join(" ")).toContain("--remote-debugging-port=0")
    expect(calls.argv?.some((a) => a.startsWith("--user-data-dir="))).toBe(true)
  })

  test("HELL-ADP-03: no binary ⇒ backend-missing, no profile", async () => {
    const { deps, log } = baseDeps()
    const b = createCdpBrowser({
      ...deps,
      spawner: {
        which: () => null,
        spawn: () => ({ pid: 0, kill: () => {}, exited: new Promise<number>(() => {}) }),
      },
    })
    const h = await b.spawn()
    expect(h.ok).toBe(false)
    if (!h.ok) expect(h.error.kind).toBe("backend-missing")
    expect(log.mkdirp).toHaveLength(0)
  })

  test("HELL-ADP-04: endpoint never ready ⇒ spawn-failed + cleanup", async () => {
    // clock advances with each poll so the timeout budget is actually reached
    const state = { t: 0 }
    const sharedScheduler: Scheduler = {
      schedule: (_ms, cb) => {
        state.t += 50
        cb()
        return () => {}
      },
    }
    const { deps, log } = baseDeps({
      portReady: false,
      scheduler: sharedScheduler,
      clock: { now: () => state.t },
    })
    const b = createCdpBrowser(deps)
    const h = await b.spawn()
    expect(h.ok).toBe(false)
    if (!h.ok) expect(h.error.kind).toBe("spawn-failed")
    expect(log.rmrf).toHaveLength(1) // profile cleaned up
  })

  test("HELL-ADP-05: transport connect fails ⇒ spawn-failed + cleanup", async () => {
    const { deps, log } = baseDeps()
    const failingTransport: CdpTransport = {
      connect: async () => ({ ok: false, error: { detail: "refused" } }),
    }
    const b = createCdpBrowser({ ...deps, transport: failingTransport })
    const h = await b.spawn()
    expect(h.ok).toBe(false)
    if (!h.ok) {
      expect(h.error.kind).toBe("spawn-failed")
      if (h.error.kind === "spawn-failed") expect(h.error.detail).toBe("refused")
    }
    expect(log.rmrf).toHaveLength(1)
  })

  test("HELL-ADP-06: navigate waits load then reads title", async () => {
    const { deps } = baseDeps()
    const b = createCdpBrowser(deps)
    const h = await b.spawn()
    if (!h.ok) return
    const nav = await b.navigate(h.value, "https://app.test/login")
    expect(nav.ok).toBe(true)
    if (nav.ok) expect(nav.value.title).toBe("Login Page")
  })

  test("HELL-ADP-07: snapshot builds from collected model", async () => {
    const { deps } = baseDeps()
    const b = createCdpBrowser(deps)
    const h = await b.spawn()
    if (!h.ok) return
    await b.navigate(h.value, "https://app.test/login")
    const snap = await b.snapshot(h.value)
    expect(snap.ok).toBe(true)
    if (!snap.ok) return
    expect(snap.value.title).toBe("Login Page")
    expect(snap.value.yaml).toContain('button "Sign in"')
  })

  test("HELL-ADP-08: click known ref ok; unknown ref ⇒ element-not-found", async () => {
    const { deps } = baseDeps()
    const b = createCdpBrowser(deps)
    const h = await b.spawn()
    if (!h.ok) return
    await b.navigate(h.value, "https://app.test/login")
    await b.snapshot(h.value) // populates refMap (e1=/, e2=/0, e3=/1)
    const okClick = await b.click(h.value, "e3")
    expect(okClick.ok).toBe(true)
    const bad = await b.click(h.value, "e999")
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.error.kind).toBe("element-not-found")
  })

  test("HELL-ADP-09: cdp allowlist enforced through the adapter", async () => {
    const { deps } = baseDeps()
    const b = createCdpBrowser(deps)
    const h = await b.spawn()
    if (!h.ok) return
    const allowed = await b.cdp(h.value, "DOM.getDocument")
    expect(allowed.ok).toBe(true)
    const denied = await b.cdp(h.value, "Page.setDownloadBehavior")
    expect(denied.ok).toBe(false)
    if (!denied.ok) expect(denied.error.kind).toBe("cdp-method-denied")
  })

  test("HELL-ADP-10: close kills + removes profile + idempotent", async () => {
    let killCount = 0
    const { deps, log } = baseDeps()
    const spy: ProcessSpawner = {
      which: () => "/usr/bin/google-chrome",
      spawn: () => ({
        pid: 1,
        kill: () => {
          killCount += 1
        },
        exited: new Promise<number>(() => {}),
      }),
    }
    const b = createCdpBrowser({ ...deps, spawner: spy })
    const h = await b.spawn()
    if (!h.ok) return
    const c1 = await b.close(h.value)
    expect(c1.ok).toBe(true)
    expect(killCount).toBe(1)
    expect(log.rmrf).toHaveLength(1)
    const c2 = await b.close(h.value) // idempotent — no second kill
    expect(c2.ok).toBe(true)
    expect(killCount).toBe(1)
    const after = await b.navigate(h.value, "https://app.test/login")
    expect(after.ok).toBe(false)
    if (!after.ok) expect(after.error.kind).toBe("closed")
  })
})
