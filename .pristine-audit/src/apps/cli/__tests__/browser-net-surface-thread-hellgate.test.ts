/**
 * jul-04 CLI `/browser-net` LIVE-DATA hellgate (S1) — closes the LAST "landed-
 * but-empty" surfacing command.
 *
 * PRIOR STATE (the gap this pins):
 *   - `browser_network` reads a bounded METADATA-ONLY ring of network activity
 *     (method/url/status/mime/size — NO bodies/headers), but it is model-invoke-
 *     only. Nothing threaded that capture up to the operator surface, so the
 *     `/browser-net` slash `browserNet` ctx slot was never populated — it printed
 *     "no browser capture yet" even after the model read live rows.
 *
 * THE CONTRACT (surface-mints → down-thread, ONE holder):
 *   1. A surface-minted `BrowserNetHolder` is threaded INTO the browser toolset
 *      (`createBrowserToolset(port, { network:true, netHolder })`) — the producer —
 *      AND read by the slash (consumer) via `ctx.browserNet = () => holder.get()`:
 *      the SAME instance, no split-brain.
 *   2. A dispatch of `browser_network` mirrors the LIVE drained rows into the
 *      holder; `/browser-net` over the SAME holder then renders those rows.
 *   3. LEAK: even with a hostile url / header-ish garbage on the fixture, the
 *      rendered rows carry ONLY method/url/status/mime/size — never an auth token,
 *      cookie, request/response body, or header.
 *   4. Absent holder (gate off) ⇒ `/browser-net` prints "no browser capture yet"
 *      / "not wired" (default-OFF byte-identical).
 *   5. red-on-injection: a broken thread (holder wired to the surface but NOT to
 *      the tool) ⇒ the slash renders the empty capture, NOT stale rows.
 *
 * Boundary: drives the REAL `createBrowserToolset(port, opts)` producer wire (the
 * exact factory `buildBrowserBlock` calls) over the deterministic headless stub,
 * plus the REAL `/browser-net` command + `createBrowserNetHolder`, so a broken
 * thread turns the slash red.
 */

import { describe, expect, test } from "bun:test"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import { buildBrowserBlock } from "@/agent/tier1"
import type { NetworkEntry } from "@/browser"
import { createHeadlessBrowser } from "@/browser"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import { createBrowserToolset } from "@/tool/browser"
import { ToolRegistry } from "@/tool/registry"
import { browserNetCmd, createBrowserNetHolder } from "../slash/browser-net-cmd"
import type { SlashContext } from "../slash-contract"

const BYPASS: PermissionContext = { mode: "bypass" }

/** A cookie/auth sentinel — MUST never appear on any `/browser-net` render. A
 *  well-behaved metadata capture NEVER sees a header/cookie, so even a fixture
 *  that tries to smuggle one in through a field the projection ignores must not
 *  surface it. */
const COOKIE_SENTINEL = "ZZ_SET_COOKIE_authToken=SECRET_7f1a_NEVER_LEAK"

const call = (name: string, input: unknown): ToolUseBlock => ({
  type: "tool_use",
  id: "bnet-1",
  name,
  input,
})

const config = (registry: AgentConfig["registry"]): AgentConfig =>
  ({
    cwd: "/tmp",
    signal: new AbortController().signal,
    planMode: false,
    permission: BYPASS,
    registry,
  }) as AgentConfig

/** A `/browser-net` ctx over the SAME holder — mirrors the surface adapter
 *  (`browserNet: () => holder.get()`). */
const slashCtxOverHolder = (
  holder: ReturnType<typeof createBrowserNetHolder> | undefined,
): { ctx: SlashContext; out: () => string } => {
  let stdout = ""
  const ctx: SlashContext = {
    out: (s) => {
      stdout += s
    },
    err: () => {},
    cwd: "/tmp",
    ...(holder !== undefined ? { browserNet: () => holder.get() } : {}),
  }
  return { ctx, out: () => stdout }
}

/** Fixture network rows — METADATA only (the shape the CDP producer projects to).
 *  A `?tok=` on the url is PAGE-CONTROLLED noise the operator legitimately sees;
 *  the COOKIE_SENTINEL is smuggled into a field name that is NOT part of the
 *  closed NetworkEntry shape to prove the projection can't surface it. */
const ROWS: NetworkEntry[] = [
  {
    method: "GET",
    url: "https://api.example.com/users?tok=abc",
    status: 200,
    mime: "application/json",
    size: 512,
  },
  {
    method: "POST",
    url: "https://api.example.com/login",
    status: 401,
    mime: "application/json",
    size: 33,
  },
]

describe("S1 /browser-net LIVE — net holder threaded into the browser toolset", () => {
  test("browser_network dispatch → /browser-net renders the LIVE rows over the SAME holder (single-instance)", async () => {
    const holder = createBrowserNetHolder()
    const port = createHeadlessBrowser({ networkEntries: ROWS })
    // The REAL producer factory the CLI uses, with the surface holder threaded in.
    const toolset = createBrowserToolset(port, { network: true, netHolder: holder })
    const registry = new ToolRegistry(toolset.tools)

    // Before any read: nothing captured ⇒ the slash shows "no browser capture yet".
    expect(holder.get()).toBeUndefined()

    const res = await dispatchTool(call("browser_network", {}), config(registry), BYPASS)
    expect(res.ok).toBe(true)

    // The mirror landed on the SAME holder the surface reads — one instance.
    const snap = holder.get()
    expect(snap).toBeDefined()
    expect(snap?.rows.length).toBe(2)

    const { ctx, out } = slashCtxOverHolder(holder)
    const code = await browserNetCmd.run([], ctx)
    expect(code).toBe(0)
    expect(out()).toContain("Browser network")
    expect(out()).toContain("GET")
    expect(out()).toContain("https://api.example.com/users")
    expect(out()).toContain("200")
    expect(out()).toContain("401")

    await toolset.dispose()
  })

  // ── Adversarial round 1 — LEAK: no cookie/auth/body ever reaches the render ──
  test("LEAK: a hostile fixture carrying a cookie sentinel surfaces metadata only", async () => {
    const holder = createBrowserNetHolder()
    // The sentinel is placed on a field OUTSIDE the closed NetworkEntry shape.
    const hostile = [
      {
        method: "GET",
        url: "https://evil.test/x",
        status: 200,
        mime: "text/html",
        size: 10,
        setCookie: COOKIE_SENTINEL,
        headers: { authorization: COOKIE_SENTINEL },
        body: COOKIE_SENTINEL,
      } as unknown as NetworkEntry,
    ]
    const port = createHeadlessBrowser({ networkEntries: hostile })
    const toolset = createBrowserToolset(port, { network: true, netHolder: holder })
    const registry = new ToolRegistry(toolset.tools)
    await dispatchTool(call("browser_network", {}), config(registry), BYPASS)

    const snap = holder.get()
    expect(snap).toBeDefined()
    // The holder snapshot carries NO cookie/header/body — structurally metadata.
    expect(JSON.stringify(snap)).not.toContain(COOKIE_SENTINEL)

    const { ctx, out } = slashCtxOverHolder(holder)
    await browserNetCmd.run([], ctx)
    expect(out()).not.toContain(COOKIE_SENTINEL)
    // … but the legitimate metadata IS surfaced.
    expect(out()).toContain("https://evil.test/x")
    await toolset.dispose()
  })

  // ── Adversarial round 2 — clear:true still mirrors what it drained ───────────
  test("browser_network clear:true mirrors the drained rows into the holder before draining", async () => {
    const holder = createBrowserNetHolder()
    const port = createHeadlessBrowser({ networkEntries: ROWS })
    const toolset = createBrowserToolset(port, { network: true, netHolder: holder })
    const registry = new ToolRegistry(toolset.tools)
    const res = await dispatchTool(
      call("browser_network", { clear: true }),
      config(registry),
      BYPASS,
    )
    expect(res.ok).toBe(true)
    expect(holder.get()?.rows.length).toBe(2)
    await toolset.dispose()
  })

  // ── Adversarial round 3 — red-on-injection: broken thread ⇒ empty, not stale ─
  test("holder wired to the surface but NOT to the tool ⇒ /browser-net renders empty (live, not stale)", async () => {
    // The surface has a holder, but the toolset was built WITHOUT it (thread cut).
    const holder = createBrowserNetHolder()
    const port = createHeadlessBrowser({ networkEntries: ROWS })
    const toolset = createBrowserToolset(port, { network: true }) // no netHolder
    const registry = new ToolRegistry(toolset.tools)
    await dispatchTool(call("browser_network", {}), config(registry), BYPASS)

    // The tool ran but nothing was mirrored ⇒ the surface holder is still empty.
    expect(holder.get()).toBeUndefined()
    const { ctx, out } = slashCtxOverHolder(holder)
    expect(await browserNetCmd.run([], ctx)).toBe(0)
    expect(out().toLowerCase()).toContain("no browser capture yet")
    await toolset.dispose()
  })

  // ── Adversarial round 4 — holder ABSENT (surface gate off) ⇒ "not wired" ─────
  test("holder ABSENT on the ctx ⇒ /browser-net prints 'not wired' + exit 2 (D-6)", async () => {
    const { ctx, out } = slashCtxOverHolder(undefined)
    const code = await browserNetCmd.run([], ctx)
    expect(code).toBe(2) // D-6 (UUX-2-22): not-wired is exit 2 + gate hint
    expect(out().toLowerCase()).toContain("not wired")
    expect(out()).toContain("hint: set QUANTA_BROWSER_NETWORK=1")
  })

  // ── Adversarial round 5 — the network gate is OFF ⇒ tool absent (byte-ident) ─
  test("network gate OFF ⇒ browser_network is NOT registered (default-OFF byte-identical)", () => {
    const holder = createBrowserNetHolder()
    const port = createHeadlessBrowser({ networkEntries: ROWS })
    // netHolder present but network gate off: the tool must not appear, so the
    // holder can never be populated — the mirror rides ONLY the gated tool.
    const toolset = createBrowserToolset(port, { netHolder: holder })
    expect(toolset.tools.some((t) => t.name === "browser_network")).toBe(false)
  })

  // ── PRODUCTION seam — the REAL `buildBrowserBlock` (features.ts producer) reads
  //    the `netHolder` off `config.browser` (the exact slot `maybeWireBrowser`
  //    populates from the compose down-thread) and forwards it to the toolset. ──
  test("buildBrowserBlock forwards config.browser.netHolder → a browser_network drain mirrors into the SAME holder", async () => {
    const holder = createBrowserNetHolder()
    const port = createHeadlessBrowser({ networkEntries: ROWS })
    // The SHAPE `maybeWireBrowser` builds on `config.browser` (duck-typed slot),
    // with the surface holder threaded in — the assembler's OUTPUT contract.
    const slot = { port, network: true, netHolder: holder }
    const block = buildBrowserBlock({ browser: slot } as unknown as AgentConfig)
    expect(block.tools.some((t) => t.name === "browser_network")).toBe(true)
    // Dispatch over a config whose registry IS the produced block (the loop wires
    // block.tools into the live registry).
    const config = {
      cwd: "/tmp",
      signal: new AbortController().signal,
      planMode: false,
      permission: BYPASS,
      registry: new ToolRegistry(block.tools),
    } as unknown as AgentConfig
    await dispatchTool(call("browser_network", {}), config, BYPASS)
    // The holder the surface reads is the SAME one the assembler-shaped slot fed.
    // red-on-injection: if `buildBrowserBlock` dropped `netHolder`, this is empty.
    expect(holder.get()?.rows.length).toBe(2)
    await block.dispose()
  })

  // ── red-on-injection (assembler-shape cut) — netHolder ABSENT on config.browser
  //    ⇒ the drain mirrors nowhere ⇒ the surface holder stays empty (not stale). ─
  test("config.browser WITHOUT netHolder ⇒ drain mirrors nowhere (surface holder empty)", async () => {
    const holder = createBrowserNetHolder()
    const port = createHeadlessBrowser({ networkEntries: ROWS })
    // netHolder omitted on the slot (the compose down-thread was cut).
    const block = buildBrowserBlock({
      browser: { port, network: true },
    } as unknown as AgentConfig)
    const config = {
      cwd: "/tmp",
      signal: new AbortController().signal,
      planMode: false,
      permission: BYPASS,
      registry: new ToolRegistry(block.tools),
    } as unknown as AgentConfig
    await dispatchTool(call("browser_network", {}), config, BYPASS)
    expect(holder.get()).toBeUndefined()
    await block.dispose()
  })
})
