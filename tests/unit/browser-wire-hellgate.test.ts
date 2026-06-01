/**
 * Hellgate — browser caller wire (ADR-0427 R2 audit [9]).
 *
 * Seals the surgical wire that surfaces a `BrowserPort` to the loop:
 *   1. `tier1/index.ts` re-exports `buildBrowserBlock`.
 *   2. `buildSessionFeatures` appends `buildBrowserBlock(config).tools` into
 *      `extraTools` AND threads `dispose` out as `features.browserDispose`,
 *      but ONLY when `config.browser.port` is wired (default-OFF byte-identical).
 *
 * STRUCTURAL assertions (read the materialized features) — the adapter behaviour
 * is hellgated elsewhere. Purpose: a later refactor cannot silently un-wire it.
 */

import { describe, expect, test } from "bun:test"
import { buildSessionFeatures } from "@/agent/features"
import { buildBrowserBlock } from "@/agent/tier1"
import type { AgentConfig } from "@/agent/types"
import { type BrowserPort, createHeadlessBrowser } from "@/browser"
import type { LLMPort } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { StreamPort } from "@/stream"
import { defaultTools, ToolRegistry } from "@/tool"

const baseCfg = (over: Record<string, unknown> = {}): AgentConfig =>
  ({
    registry: new ToolRegistry(defaultTools),
    stream: { emit() {} } as StreamPort,
    permission: { mode: "acceptEdits" } as PermissionContext,
    messages: [],
    system: "test",
    cwd: "/tmp",
    maxTurns: 1,
    signal: new AbortController().signal,
    llm: { model: "scripted", async *stream() {} } as unknown as LLMPort,
    ...over,
  }) as AgentConfig

const BROWSER_TOOL_NAMES = [
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
]

describe("browser wire — hellgate", () => {
  test("(1) tier1 barrel re-exports buildBrowserBlock", () => {
    expect(typeof buildBrowserBlock).toBe("function")
  })

  test("(2) default-OFF: no browser slot ⇒ no browser tools, no browserDispose", async () => {
    const f = await buildSessionFeatures(baseCfg())
    expect(f.extraTools.some((t) => t.name.startsWith("browser_"))).toBe(false)
    expect(f.browserDispose).toBeUndefined()
  })

  test("(3) wired slot ⇒ all browser tools in extraTools + working browserDispose", async () => {
    let closes = 0
    const inner = createHeadlessBrowser()
    const port: BrowserPort = {
      ...inner,
      close: (h) => {
        closes += 1
        return inner.close(h)
      },
    }
    const f = await buildSessionFeatures(baseCfg({ browser: { port } }))
    const names = f.extraTools.map((t) => t.name).filter((n) => n.startsWith("browser_"))
    expect(names.sort()).toEqual([...BROWSER_TOOL_NAMES].sort())
    expect(typeof f.browserDispose).toBe("function")
    // dispose reaches the port: spawn a handle first, then teardown closes it
    const ctx = { cwd: "/tmp", signal: new AbortController().signal }
    const nav = f.extraTools.find((t) => t.name === "browser_navigate")
    // navigate to an unknown url just to force the lazy spawn (denied page, but spawned)
    for await (const _ of nav?.execute({ url: "https://x.test/" }, ctx) ?? []) {
      // drain
    }
    await f.browserDispose?.()
    expect(closes).toBe(1)
  })
})
