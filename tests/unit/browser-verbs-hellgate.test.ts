/**
 * Hellgate — Phase-2 interaction verbs (ADR-0427 Wave 4).
 *
 * fill / select_option / scroll / press_key / drag / mouse_click_xy over the
 * headless port (tool layer) + the real adapter (orchestration over a scripted
 * transport). Proves ref-resolution, the JS/Input dispatch path, and the
 * element-not-found / coordinate branches.
 */

import { describe, expect, test } from "bun:test"
import { assertOk } from "../_support/assert-ok"
import { createHeadlessBrowser, type DomModel } from "@/browser"
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
import type { Tool, ToolResult } from "@/tool"
import { createBrowserToolset } from "@/tool/browser"

const PAGE: DomModel = {
  title: "Form",
  root: {
    backendPath: "/",
    role: "document",
    name: "Form",
    children: [
      { backendPath: "/0", role: "textbox", name: "Name" },
      { backendPath: "/1", role: "combobox", name: "Country" },
      { backendPath: "/2", role: "button", name: "Submit" },
    ],
  },
}
const PAGES = new Map([["https://app.test/form", { title: "Form", dom: PAGE }]])

const tool = (tools: Tool[], n: string): Tool => {
  const t = tools.find((x) => x.name === n)
  if (!t) throw new Error(n)
  return t
}
const run = async (t: Tool, input: unknown): Promise<ToolResult> => {
  let r: ToolResult | undefined
  for await (const ev of t.execute(input, { cwd: "/tmp", signal: new AbortController().signal })) {
    if (ev.type === "result") r = ev.result
  }
  if (!r) throw new Error("no result")
  return r
}

describe("HELLGATE verbs — tool layer over headless", () => {
  const setup = async () => {
    const ts = createBrowserToolset(createHeadlessBrowser({ pages: PAGES }))
    await run(tool(ts.tools, "browser_navigate"), { url: "https://app.test/form" })
    await run(tool(ts.tools, "browser_snapshot"), {}) // refs e1..e4
    return ts
  }

  test("fill known ref ⇒ ok; unknown ⇒ not_found", async () => {
    const ts = await setup()
    expect((await run(tool(ts.tools, "browser_fill"), { ref: "e2", value: "Ada" })).ok).toBe(true)
    const bad = await run(tool(ts.tools, "browser_fill"), { ref: "e99", value: "x" })
    expect(bad.failure?.mode).toBe("not_found")
  })

  test("select_option known ref ⇒ ok", async () => {
    const ts = await setup()
    expect(
      (await run(tool(ts.tools, "browser_select_option"), { ref: "e3", values: ["US"] })).ok,
    ).toBe(true)
  })

  test("scroll page (no ref) ⇒ ok; scroll bad ref ⇒ not_found", async () => {
    const ts = await setup()
    expect(
      (await run(tool(ts.tools, "browser_scroll"), { direction: "down", amount: 200 })).ok,
    ).toBe(true)
    const bad = await run(tool(ts.tools, "browser_scroll"), { ref: "e99" })
    expect(bad.failure?.mode).toBe("not_found")
  })

  test("press_key ⇒ ok", async () => {
    const ts = await setup()
    expect((await run(tool(ts.tools, "browser_press_key"), { key: "Enter" })).ok).toBe(true)
  })

  test("drag ref→ref ⇒ ok; missing target ⇒ rejected", async () => {
    const ts = await setup()
    expect(
      (await run(tool(ts.tools, "browser_drag"), { sourceRef: "e2", targetRef: "e4" })).ok,
    ).toBe(true)
    const noTarget = await run(tool(ts.tools, "browser_drag"), { sourceRef: "e2" })
    expect(noTarget.failure?.mode).toBe("rejected")
  })

  test("mouse_click_xy ⇒ ok", async () => {
    const ts = await setup()
    expect((await run(tool(ts.tools, "browser_mouse_click_xy"), { x: 10, y: 20 })).ok).toBe(true)
  })
})

// --- adapter layer: dispatch reaches the wire ---------------------------------

const DOM = {
  title: "F",
  root: {
    backendPath: "/",
    role: "document",
    name: "F",
    children: [{ backendPath: "/0", role: "textbox", name: "N" }],
  },
}

const evalValueFor = (expr: string): unknown => {
  if (expr.includes("walk(document.body")) return JSON.stringify(DOM)
  if (expr === "document.title") return "F"
  if (expr.includes("getBoundingClientRect")) return { x: 5, y: 6 }
  return true
}

interface VerbMsg {
  id: number
  method: string
  params: { expression?: string } & Record<string, unknown>
}

const respondVerb = (m: VerbMsg, emit: (raw: string) => void): void => {
  if (m.method === "Runtime.evaluate") {
    emit(
      JSON.stringify({
        id: m.id,
        result: { result: { value: evalValueFor(m.params.expression ?? "") } },
      }),
    )
    return
  }
  if (m.method === "Target.createTarget") {
    emit(JSON.stringify({ id: m.id, result: { targetId: "t1" } }))
    return
  }
  if (m.method === "Target.attachToTarget") {
    emit(JSON.stringify({ id: m.id, result: { sessionId: "s1" } }))
    return
  }
  emit(JSON.stringify({ id: m.id, result: {} }))
  if (m.method === "Page.navigate") {
    setTimeout(
      () => emit(JSON.stringify({ method: "Page.loadEventFired", params: {}, sessionId: "s1" })),
      0,
    )
  }
}

const adapter = () => {
  const sent: Array<{ method: string; params: Record<string, unknown> }> = []
  const transport: CdpTransport = {
    connect: async () => {
      let emit: (raw: string) => void = () => {}
      const conn: CdpConnection = {
        onMessage: (cb) => {
          emit = cb
        },
        close: () => {},
        send: (raw) => {
          const m = JSON.parse(raw) as VerbMsg
          sent.push({ method: m.method, params: m.params })
          queueMicrotask(() => respondVerb(m, emit))
        },
      }
      return ok(conn)
    },
  }
  const fs: BrowserFs = {
    existsSync: () => false,
    readFile: (p) => (p.endsWith("DevToolsActivePort") ? "9222\n/x" : null),
    mkdirp: () => {},
    rmrf: () => {},
  }
  const spawner: ProcessSpawner = {
    which: () => "/usr/bin/google-chrome",
    spawn: () => ({ pid: 1, kill: () => {}, exited: new Promise<number>(() => {}) }),
  }
  const scheduler: Scheduler = { schedule: () => () => {} }
  const clock: Clock = { now: () => 0 }
  const b = createCdpBrowser({
    spawner,
    transport,
    fs,
    scheduler,
    clock,
    profileRoot: "/jail/b",
    endpointTimeoutMs: 1000,
  })
  return { b, sent }
}

describe("HELLGATE verbs — adapter dispatch", () => {
  test("press_key dispatches Input.dispatchKeyEvent down+up", async () => {
    const { b, sent } = adapter()
    const h = await b.spawn()
    assertOk(h)
    const r = await b.pressKey(h.value, "Enter")
    expect(r.ok).toBe(true)
    const keys = sent.filter((s) => s.method === "Input.dispatchKeyEvent")
    expect(keys.map((k) => k.params.type)).toEqual(["keyDown", "keyUp"])
  })

  // chrome-FREE guard for real-chrome closeout bug #2: a bare `{key}` event does
  // not trigger Blink's implicit form-submit; the named-key descriptor table
  // MUST stamp windowsVirtualKeyCode/code (and `text` for text-generating keys).
  // Mutation killed: keyEventBase named branch → `return { key }`.
  test("press_key(Enter) carries the full virtual-key descriptor on BOTH down+up", async () => {
    const { b, sent } = adapter()
    const h = await b.spawn()
    assertOk(h)
    expect((await b.pressKey(h.value, "Enter")).ok).toBe(true)
    const keys = sent.filter((s) => s.method === "Input.dispatchKeyEvent")
    expect(keys.length).toBe(2)
    for (const k of keys) {
      expect(k.params.key).toBe("Enter")
      expect(k.params.code).toBe("Enter")
      expect(k.params.windowsVirtualKeyCode).toBe(13)
      expect(k.params.nativeVirtualKeyCode).toBe(13)
      expect(k.params.text).toBe("\r") // Enter is text-generating
    }
  })

  test("press_key(Tab) stamps the vk/code but NO text (non-text-generating key)", async () => {
    const { b, sent } = adapter()
    const h = await b.spawn()
    assertOk(h)
    expect((await b.pressKey(h.value, "Tab")).ok).toBe(true)
    const k = sent.find((s) => s.method === "Input.dispatchKeyEvent")
    expect(k?.params.windowsVirtualKeyCode).toBe(9)
    expect(k?.params.code).toBe("Tab")
    expect("text" in (k?.params ?? {})).toBe(false)
  })

  test("press_key(single char) sends printable text + KeyX code", async () => {
    const { b, sent } = adapter()
    const h = await b.spawn()
    assertOk(h)
    expect((await b.pressKey(h.value, "a")).ok).toBe(true)
    const k = sent.find((s) => s.method === "Input.dispatchKeyEvent")
    expect(k?.params.key).toBe("a")
    expect(k?.params.text).toBe("a")
    expect(k?.params.code).toBe("KeyA")
  })

  // chrome-FREE guard for real-chrome closeout bug #3: click/fill/type MUST focus
  // the element first (else a follow-up Enter goes to <body>). The in-page JS runs
  // only in a real browser, but the EXPRESSION is observable on the wire here.
  // Mutation killed: dropping `if (el.focus) el.focus()` from clickJs/fillJs/typeJs.
  test("click / fill / type emit in-page JS that focuses the element first", async () => {
    const { b, sent } = adapter()
    const h = await b.spawn()
    assertOk(h)
    await b.navigate(h.value, "https://x.test/")
    await b.snapshot(h.value) // refs e1 (doc), e2 (textbox /0)
    sent.length = 0
    expect((await b.click(h.value, "e2")).ok).toBe(true)
    expect((await b.fill(h.value, "e2", "v")).ok).toBe(true)
    expect((await b.type(h.value, "e2", "v")).ok).toBe(true)
    const exprs = sent
      .filter((s) => s.method === "Runtime.evaluate")
      .map((s) => String(s.params.expression ?? ""))
    expect(exprs.length).toBe(3)
    for (const e of exprs) expect(e).toContain("el.focus()")
  })

  test("mouse_click_xy dispatches pressed+released at coords", async () => {
    const { b, sent } = adapter()
    const h = await b.spawn()
    assertOk(h)
    const r = await b.mouseClickXY(h.value, 11, 22)
    expect(r.ok).toBe(true)
    const mice = sent.filter((s) => s.method === "Input.dispatchMouseEvent")
    expect(mice.map((m) => m.params.type)).toEqual(["mousePressed", "mouseReleased"])
    expect(mice[0]?.params.x).toBe(11)
  })

  test("drag ref→coords: pressed at element center, released at target", async () => {
    const { b, sent } = adapter()
    const h = await b.spawn()
    assertOk(h)
    await b.navigate(h.value, "https://x.test/")
    await b.snapshot(h.value) // refs e1,e2
    const r = await b.drag(h.value, "e2", { x: 99, y: 88 })
    expect(r.ok).toBe(true)
    const mice = sent.filter((s) => s.method === "Input.dispatchMouseEvent")
    expect(mice.map((m) => m.params.type)).toEqual(["mousePressed", "mouseMoved", "mouseReleased"])
    expect(mice[0]?.params.x).toBe(5) // element center from getBoundingClientRect stub
    expect(mice[2]?.params.x).toBe(99) // dropped at target coord
  })
})
