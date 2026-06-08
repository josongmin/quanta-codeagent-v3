/**
 * Hellgate — browser TAB tools (TICKET-24 Wave B) over the deterministic stub.
 *
 *  TT-01: DEFAULT-OFF — no `tabs` flag ⇒ NO browser_tab_* tools (byte-identical).
 *  TT-02: tabs:true ⇒ the 4 browser_tab_{list,new,switch,close} appear.
 *  TT-03: browser_tab_list is read-only; switch/close are mutating + always-confirm.
 *  TT-04: E2E ref isolation — snapshot tab1, open+switch tab2, a ref from tab1 is
 *         not_found on tab2 (each tab owns its refMap).
 *  TT-05: closing the LAST tab is refused at the tool layer.
 *  TT-06: switch to an unknown tab ⇒ not_found echoing the open ids.
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
const TAB_TOOLS = ["browser_tab_list", "browser_tab_new", "browser_tab_switch", "browser_tab_close"]

const toolset = (opts: BrowserToolsetOpts = {}) =>
  createBrowserToolset(createHeadlessBrowser({ pages: PAGES }), opts)
const byName = (tools: Tool[], name: string): Tool => {
  const t = tools.find((x) => x.name === name)
  if (t === undefined) throw new Error(`tool not found: ${name}`)
  return t
}
const run = async (tool: Tool, input: unknown): Promise<ToolResult> => {
  const ctx = { cwd: "/tmp", signal: new AbortController().signal }
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input, ctx)) if (ev.type === "result") result = ev.result
  if (result === undefined) throw new Error("no result")
  return result
}

describe("HELLGATE browser tab tools (Wave B)", () => {
  test("TT-01: DEFAULT-OFF ⇒ no browser_tab_* tools", () => {
    const names = toolset().tools.map((t) => t.name)
    for (const n of TAB_TOOLS) expect(names).not.toContain(n)
  })

  test("TT-02: tabs:true ⇒ the 4 tab tools appear", () => {
    const names = toolset({ tabs: true }).tools.map((t) => t.name)
    for (const n of TAB_TOOLS) expect(names).toContain(n)
  })

  test("TT-03: tab_list read-only; switch/close mutating + always-confirm", () => {
    const ts = toolset({ tabs: true }).tools
    expect(byName(ts, "browser_tab_list").isReadOnly()).toBe(true)
    expect(byName(ts, "browser_tab_switch").isReadOnly()).toBe(false)
    expect(byName(ts, "browser_tab_switch").hitlTier({ tab: "0" })).toBe("always-confirm")
    expect(byName(ts, "browser_tab_close").hitlTier({ tab: "0" })).toBe("always-confirm")
  })

  test("TT-04: E2E ref isolation — a tab-1 ref is not_found after switching to tab 2", async () => {
    const ts = toolset({ tabs: true }).tools
    await run(byName(ts, "browser_navigate"), { url: "https://app.test/login" })
    await run(byName(ts, "browser_snapshot"), {}) // mints e1/e2/e3 on tab #1
    // open + list ⇒ 2 tabs
    await run(byName(ts, "browser_tab_new"), {})
    const list = await run(byName(ts, "browser_tab_list"), {})
    expect(list.ok).toBe(true)
    expect(list.output?.split("\n").length).toBe(2)
    // switch to tab index 1 (the new, empty tab) and try a tab-1 ref
    const sw = await run(byName(ts, "browser_tab_switch"), { tab: "1" })
    expect(sw.ok).toBe(true)
    const click = await run(byName(ts, "browser_click"), { ref: "e2" })
    expect(click.ok).toBe(false)
    if (!click.ok) expect(click.failure?.mode).toBe("not_found")
  })

  test("TT-05: closing the LAST tab is refused", async () => {
    const ts = toolset({ tabs: true }).tools
    await run(byName(ts, "browser_navigate"), { url: "https://app.test/login" })
    const r = await run(byName(ts, "browser_tab_close"), { tab: "0" })
    expect(r.ok).toBe(false)
  })

  test("TT-06: switch to an unknown tab ⇒ not_found echoing open ids", async () => {
    const ts = toolset({ tabs: true }).tools
    await run(byName(ts, "browser_navigate"), { url: "https://app.test/login" })
    const r = await run(byName(ts, "browser_tab_switch"), { tab: "nope" })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.failure?.mode).toBe("not_found")
      expect(r.output).toContain("open tabs")
    }
  })
})
