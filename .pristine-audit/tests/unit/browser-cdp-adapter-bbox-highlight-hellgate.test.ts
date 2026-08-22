/**
 * Hellgate — CDP adapter bounding_box + highlight (TICKET-24 Wave A).
 *
 * Drives the REAL `createCdpBrowser` against fully faked boundaries (the same
 * pattern as browser-cdp-adapter-hellgate). Asserts the per-element JS the
 * adapter emits, NOT a real layout engine — the transport script evaluates the
 * recorded expression and returns a fixture box.
 *
 *  HELL-BBOX-01: getBoundingBox(known ref) ⇒ {x,y,w,h,visible}
 *  HELL-BBOX-02: getBoundingBox(unknown ref) ⇒ element-not-found WITH zero
 *                Runtime.evaluate issued for the box (fail-closed before eval)
 *  HELL-BBOX-03: getBoundingBox ⇒ malformed page value ⇒ cdp-error (no NaN box)
 *  HELL-HL-01:   highlight(known ref) ⇒ ok; emitted expr creates an overlay div
 *                + schedules a setTimeout auto-remove
 *  HELL-HL-02:   highlight(unknown ref) ⇒ element-not-found
 *  HELL-HL-03:   a color carrying `'</script>` is JSON.stringify-escaped in the
 *                emitted highlight expression (red-on-injection)
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

const spawnerThatFinds = (): ProcessSpawner => ({
  which: (cmd) => (cmd === "google-chrome" ? "/usr/bin/google-chrome" : null),
  spawn: (): SpawnedProcess => ({
    pid: 4242,
    kill: () => {},
    exited: new Promise<number>(() => {}),
  }),
})

const fsReady = (): BrowserFs => ({
  existsSync: () => false,
  readFile: (p) => (p.endsWith("DevToolsActivePort") ? "9222\n/devtools/browser/x" : null),
  mkdirp: () => {},
  rmrf: () => {},
})

const idleScheduler: Scheduler = { schedule: () => () => {} }

interface SentMsg {
  readonly id: number
  readonly method: string
  readonly params: { expression?: string }
}

/** A transport that records every Runtime.evaluate expression and evaluates it
 *  via `evalFn` (so the adapter's emitted JS string is the thing under test). */
const recordingTransport = (
  evalExprs: string[],
  evalFn: (expr: string) => unknown,
): CdpTransport => ({
  connect: async () => {
    let onMsg: (raw: string) => void = () => {}
    const replyFor = (m: SentMsg): unknown => {
      if (m.method === "Runtime.evaluate") {
        const expr = m.params.expression ?? ""
        evalExprs.push(expr)
        return { result: { value: evalFn(expr) } }
      }
      if (m.method === "Target.createTarget") return { targetId: "t1" }
      if (m.method === "Target.attachToTarget") return { sessionId: "s1" }
      return {}
    }
    const respond = (m: SentMsg): void => {
      onMsg(JSON.stringify({ id: m.id, result: replyFor(m) }))
      if (m.method === "Page.navigate") {
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

const collectMarker = "walk(document.body"

// Box/highlight scripts both start with the resolveJs IIFE; the box returns a
// rect object, the highlight returns true (overlay created). The collect script
// must return the DOM fixture so snapshot mints refs.
const makeEvalFn =
  (box: unknown) =>
  (expr: string): unknown => {
    if (expr === "document.title") return "Login Page"
    if (expr.includes(collectMarker)) return JSON.stringify(DOM_FIXTURE)
    // highlight: overlay-create JS contains createElement('div') + setTimeout
    if (expr.includes("createElement('div')")) return true
    // box: emitted by boxJs, returns the rect fixture
    if (expr.includes("getBoundingClientRect")) return box
    return undefined
  }

const deps = (box: unknown, evalExprs: string[]) => ({
  spawner: spawnerThatFinds(),
  transport: recordingTransport(evalExprs, makeEvalFn(box)),
  fs: fsReady(),
  scheduler: idleScheduler,
  clock: { now: () => 0 },
  profileRoot: "/jail/.quanta/browser",
  endpointTimeoutMs: 1000,
})

const VALID_BOX = { x: 142, y: 88, w: 220, h: 40, visible: true }

const spawnNavSnap = async (box: unknown, evalExprs: string[]) => {
  const b = createCdpBrowser(deps(box, evalExprs))
  const h = await b.spawn()
  if (!h.ok) throw new Error("spawn failed")
  await b.navigate(h.value, "https://app.test/login")
  await b.snapshot(h.value) // mints e1=/ e2=/0 e3=/1
  return { b, handle: h.value }
}

describe("HELLGATE CDP adapter — bounding_box + highlight (Wave A)", () => {
  test("HELL-BBOX-01: getBoundingBox(known ref) ⇒ full rect + visible", async () => {
    const exprs: string[] = []
    const { b, handle } = await spawnNavSnap(VALID_BOX, exprs)
    const r = await b.getBoundingBox(handle, "e3")
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value).toEqual({ x: 142, y: 88, w: 220, h: 40, visible: true })
  })

  test("HELL-BBOX-02: unknown ref ⇒ element-not-found, ZERO box eval issued", async () => {
    const exprs: string[] = []
    const { b, handle } = await spawnNavSnap(VALID_BOX, exprs)
    const before = exprs.length
    const r = await b.getBoundingBox(handle, "e999")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("element-not-found")
    // No Runtime.evaluate issued after the unknown-ref resolve — fail-closed.
    expect(exprs.length).toBe(before)
  })

  test("HELL-BBOX-03: malformed page value ⇒ cdp-error (no NaN box)", async () => {
    const exprs: string[] = []
    // page returns a poisoned shape (x is a string) — must NOT surface as a box
    const { b, handle } = await spawnNavSnap({ x: "nope", y: 0, w: 0, h: 0, visible: true }, exprs)
    const r = await b.getBoundingBox(handle, "e2")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("cdp-error")
  })

  test("HELL-HL-01: highlight(known) ⇒ ok; expr creates overlay + setTimeout", async () => {
    const exprs: string[] = []
    const { b, handle } = await spawnNavSnap(VALID_BOX, exprs)
    const r = await b.highlight(handle, "e2")
    expect(r.ok).toBe(true)
    const hlExpr = exprs.find((e) => e.includes("createElement('div')"))
    expect(hlExpr).toBeDefined()
    expect(hlExpr).toContain("createElement('div')")
    expect(hlExpr).toContain("setTimeout")
    // outline only, never a fill — the overlay must not paint over content
    expect(hlExpr).toContain("outline")
    expect(hlExpr).toContain("pointerEvents")
    expect(hlExpr).toContain("'transparent'")
  })

  test("HELL-HL-02: highlight(unknown) ⇒ element-not-found", async () => {
    const exprs: string[] = []
    const { b, handle } = await spawnNavSnap(VALID_BOX, exprs)
    const r = await b.highlight(handle, "e999")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error.kind).toBe("element-not-found")
  })

  test("HELL-HL-03: custom color is JSON.stringify-escaped (breakout neutralized)", async () => {
    const exprs: string[] = []
    const { b, handle } = await spawnNavSnap(VALID_BOX, exprs)
    // a color carrying a `"`-quote + backslash breakout payload — JSON.stringify
    // is what makes it an INERT double-quoted JS string literal (escapes the
    // `"` and `\`), so it can never close the literal and inject code.
    const payload = `red" ; alert(1) // \\ "x`
    const r = await b.highlight(handle, "e2", { color: payload })
    expect(r.ok).toBe(true)
    const hlExpr = exprs.find((e) => e.includes("createElement('div')"))
    expect(hlExpr).toBeDefined()
    // The color appears ONLY as its JSON.stringify form (a safe escaped literal),
    // and the raw breakout substring (unescaped `"` + `\`) is NEVER emitted —
    // red-on-injection: removing the JSON.stringify wrap would surface the raw
    // payload here and fail this assertion.
    expect(hlExpr).toContain(JSON.stringify(payload))
    expect(hlExpr).not.toContain(payload)
  })
})
