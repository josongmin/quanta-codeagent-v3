/**
 * Hellgate — browser bounding_box + highlight TOOL layer (TICKET-24 Wave A).
 *
 * Drives the real `createBrowserToolset` over the deterministic headless port.
 * Proves the independent gates + the model-facing output shapes.
 *
 *  HELL-TBH-01: DEFAULT-OFF — no flags ⇒ tool names IDENTICAL to the 15 base
 *               tools (browser_element_bounds / browser_highlight ABSENT)
 *  HELL-TBH-02: bounds:true ⇒ browser_element_bounds present; highlight:true ⇒
 *               browser_highlight present; the two gates are independent
 *  HELL-TBH-03: bounds tool output is `<ref>: x,y w×h visible=…`
 *  HELL-TBH-04: bounds(unknown ref) ⇒ not_found failure
 *  HELL-TBH-05: highlight tool isReadOnly() === true (cosmetic, no-HITL)
 *  HELL-TBH-06: highlight(known) ⇒ ok + reminds to pair with browser_screenshot
 */

import { describe, expect, test } from "bun:test"
import { createHeadlessBrowser, type DomModel } from "@/browser"
import type { Tool, ToolResult } from "@/tool"
import { type BrowserToolsetOpts, createBrowserToolset } from "@/tool/browser"

const PAGE: DomModel = {
  title: "Login",
  root: {
    backendPath: "/",
    role: "document",
    name: "Login",
    children: [
      { backendPath: "/0", role: "textbox", name: "Email" },
      { backendPath: "/1", role: "button", name: "Sign in" },
    ],
  },
}
const PAGES = new Map([["https://app.test/login", { title: "Login", dom: PAGE }]])

const BASE_15 = [
  "browser_navigate",
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_fill",
  "browser_select_option",
  "browser_scroll",
  "browser_press_key",
  "browser_drag",
  "browser_mouse_click_xy",
  "browser_screenshot",
  "browser_cdp",
  "browser_console",
  "browser_wait",
  "browser_read",
]

const toolset = (opts: BrowserToolsetOpts = {}) =>
  createBrowserToolset(createHeadlessBrowser({ pages: PAGES }), opts)

const toolByName = (tools: Tool[], name: string): Tool => {
  const t = tools.find((x) => x.name === name)
  if (t === undefined) throw new Error(`tool not found: ${name}`)
  return t
}

const run = async (tool: Tool, input: unknown): Promise<ToolResult> => {
  const ctx = { cwd: "/tmp", signal: new AbortController().signal }
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input, ctx)) {
    if (ev.type === "result") result = ev.result
  }
  if (result === undefined) throw new Error("tool produced no result")
  return result
}

/** Navigate+snapshot a fresh toolset so refs (e1=/ e2=/0 e3=/1) are minted. */
const ready = async (opts: BrowserToolsetOpts) => {
  const ts = toolset(opts)
  await run(toolByName(ts.tools, "browser_navigate"), { url: "https://app.test/login" })
  await run(toolByName(ts.tools, "browser_snapshot"), {})
  return ts
}

describe("HELLGATE browser bbox + highlight tool — independent gates (Wave A)", () => {
  test("HELL-TBH-01: DEFAULT-OFF ⇒ tool names byte-identical to the 15 base", () => {
    const ts = toolset()
    const names = ts.tools.map((t) => t.name)
    expect(names.sort()).toEqual([...BASE_15].sort())
    expect(names).not.toContain("browser_element_bounds")
    expect(names).not.toContain("browser_highlight")
  })

  test("HELL-TBH-02: each flag independently mints ONLY its own tool", () => {
    const boundsOnly = toolset({ bounds: true }).tools.map((t) => t.name)
    expect(boundsOnly).toContain("browser_element_bounds")
    expect(boundsOnly).not.toContain("browser_highlight")

    const hlOnly = toolset({ highlight: true }).tools.map((t) => t.name)
    expect(hlOnly).toContain("browser_highlight")
    expect(hlOnly).not.toContain("browser_element_bounds")

    const both = toolset({ bounds: true, highlight: true }).tools.map((t) => t.name)
    expect(both).toContain("browser_element_bounds")
    expect(both).toContain("browser_highlight")
    // exactly the 15 base + the 2 extras, nothing more
    expect(both.length).toBe(BASE_15.length + 2)
  })

  test("HELL-TBH-03: bounds output is `<ref>: x,y w×h visible=…`", async () => {
    const ts = await ready({ bounds: true })
    const r = await run(toolByName(ts.tools, "browser_element_bounds"), { ref: "e2" })
    expect(r.ok).toBe(true)
    // headless stub returns {x:10,y:20,w:100,h:40,visible:true}
    expect(r.output).toBe("e2: 10,20 100×40 visible=true")
  })

  test("HELL-TBH-04: bounds(unknown ref) ⇒ not_found failure", async () => {
    const ts = await ready({ bounds: true })
    const r = await run(toolByName(ts.tools, "browser_element_bounds"), { ref: "e999" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.failure?.mode).toBe("not_found")
  })

  test("HELL-TBH-05: highlight tool is read-only / no-HITL (cosmetic)", () => {
    const hl = toolByName(toolset({ highlight: true }).tools, "browser_highlight")
    expect(hl.isReadOnly()).toBe(true)
    expect(hl.hitlTier({ ref: "e1" })).toBe("pre-approval-ok")
  })

  test("HELL-TBH-06: highlight(known) ⇒ ok + reminds to pair with screenshot", async () => {
    const ts = await ready({ highlight: true })
    const r = await run(toolByName(ts.tools, "browser_highlight"), { ref: "e3" })
    expect(r.ok).toBe(true)
    expect(r.output).toContain("e3")
    expect(r.output).toContain("browser_screenshot")
  })

  test("HELL-TBH-07: bounds tool is read-only", () => {
    const bt = toolByName(toolset({ bounds: true }).tools, "browser_element_bounds")
    expect(bt.isReadOnly()).toBe(true)
  })
})
