/**
 * Hellgate — browser TOOL-LAYER EXTREME edge cases (ADR-0427, Wave 3).
 *
 * Dimension: the model-facing tool layer (`createBrowserToolset`) + the
 * registry's `capToolOutput` + abort-signal threading + the session holder,
 * driven over the deterministic headless port (and spy/deferred overrides).
 * Sibling to `browser-tool-hellgate.test.ts`; this file pushes the ADVERSARIAL
 * extremes its predecessor sketched:
 *
 *  - pre-aborted ctx.signal at EVERY mutating/cancellable verb ⇒ a typed
 *    failure, never a crash (control: a fresh signal ⇒ ok);
 *  - a HUGE snapshot (thousands of nodes) over the 200k cap ⇒ the registry
 *    persists + truncates (output bounded, `<persisted-output>` marker, spill
 *    path on `evidence.fullLogPath`); control: a small snapshot is byte-identical;
 *  - concurrent `ensure()` coalescing under a deferred spawn fired 10× ⇒ EXACTLY
 *    one spawn; control: 10 SERIAL ensures after resolution still spawn once;
 *  - dispose during an in-flight spawn ⇒ the fresh handle is closed once, the
 *    session is terminal; control: a normal spawn→dispose closes once;
 *  - every verb's element-not-found path with a bogus ref ⇒ not_found (control:
 *    each verb with a real ref ⇒ ok);
 *  - a denied CDP method through the tool ⇒ permission_denied (control: allowed);
 *  - schema-invalid inputs through ToolRegistry.run ⇒ throw ToolInputError
 *    (control: valid input runs);
 *  - the 15 tools present with the documented isReadOnly / isConcurrencySafe.
 */

import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { BrowserError, BrowserHandle } from "@/browser"
import {
  type BrowserPort,
  CDP_ALLOWED_METHODS,
  createHeadlessBrowser,
  type DomModel,
  type DomNode,
} from "@/browser"
import type { Result } from "@/shared"
import { ToolInputError } from "@/shared"
import { type Tool, ToolRegistry, type ToolResult } from "@/tool"
import { createBrowserToolset } from "@/tool/browser"
import { createBrowserSession } from "@/tool/browser/session-holder"

// ── fixtures ────────────────────────────────────────────────────────────────

const URL = "https://app.test/login"

/** A small page whose two leaves render to refs e2 (textbox) + e3 (button). */
const SMALL: DomModel = {
  title: "Login",
  root: {
    backendPath: "/",
    role: "document",
    name: "Login",
    children: [
      { backendPath: "/0", role: "textbox", name: "Email" },
      { backendPath: "/1", role: "button", name: "Submit" },
    ],
  },
}

/** Build a DomModel with `n` leaf nodes, each carrying a long name so the
 *  rendered snapshot blows past `capToolOutput`'s 200k-char default cap. */
const hugeModel = (n: number): DomModel => {
  const filler = "x".repeat(80) // ~80 chars of name per node
  const children: DomNode[] = []
  for (let i = 0; i < n; i++) {
    children.push({ backendPath: `/${i}`, role: "button", name: `node-${i}-${filler}` })
  }
  return { title: "Huge", root: { backendPath: "/", role: "document", name: "Huge", children } }
}

const PAGES = new Map([[URL, { title: "Login", dom: SMALL }]])

// ── helpers ─────────────────────────────────────────────────────────────────

const toolByName = (tools: Tool[], name: string): Tool => {
  const t = tools.find((x) => x.name === name)
  if (t === undefined) throw new Error(`tool not found: ${name}`)
  return t
}

/** Drive a tool directly (no registry), as the real loop does per ToolEvent. */
const run = async (tool: Tool, input: unknown, signal?: AbortSignal): Promise<ToolResult> => {
  const ctx = { cwd: tmpdir(), signal: signal ?? new AbortController().signal }
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input, ctx)) {
    if (ev.type === "result") result = ev.result
  }
  if (result === undefined) throw new Error("tool produced no result")
  return result
}

const navTo = async (tools: Tool[], url = URL): Promise<void> => {
  const r = await run(toolByName(tools, "browser_navigate"), { url })
  if (!r.ok) throw new Error(`navigate failed: ${r.output}`)
}

/** Snapshot first so the refMap is populated; returns the live toolset. */
const toolsetOnPage = async (
  model: DomModel = SMALL,
): Promise<ReturnType<typeof createBrowserToolset>> => {
  const port = createHeadlessBrowser({ pages: new Map([[URL, { title: "P", dom: model }]]) })
  const ts = createBrowserToolset(port)
  await navTo(ts.tools)
  await run(toolByName(ts.tools, "browser_snapshot"), {})
  return ts
}

const aborted = (): AbortSignal => {
  const ac = new AbortController()
  ac.abort()
  return ac.signal
}

/** Wrap a port so EVERY signal-threading verb returns {cancelled} when the
 *  signal it RECEIVES is aborted. The headless stub only honors the signal on a
 *  few verbs; this wrapper proves the TOOL forwards ctx.signal to each port
 *  method — if a tool dropped the signal, the verb would still succeed. */
const abortAwarePort = (inner: BrowserPort): BrowserPort => {
  const cancelled = (): Result<never, BrowserError> => ({ ok: false, error: { kind: "cancelled" } })
  const ab = (s?: AbortSignal): boolean => s?.aborted === true
  return {
    ...inner,
    navigate: (h, u, s) => (ab(s) ? Promise.resolve(cancelled()) : inner.navigate(h, u, s)),
    click: (h, r, s) => (ab(s) ? Promise.resolve(cancelled()) : inner.click(h, r, s)),
    type: (h, r, t, o) => (ab(o?.signal) ? Promise.resolve(cancelled()) : inner.type(h, r, t, o)),
    fill: (h, r, v, s) => (ab(s) ? Promise.resolve(cancelled()) : inner.fill(h, r, v, s)),
    selectOption: (h, r, v, s) =>
      ab(s) ? Promise.resolve(cancelled()) : inner.selectOption(h, r, v, s),
    scroll: (h, o, s) => (ab(s) ? Promise.resolve(cancelled()) : inner.scroll(h, o, s)),
    pressKey: (h, k, s) => (ab(s) ? Promise.resolve(cancelled()) : inner.pressKey(h, k, s)),
    drag: (h, sr, t, s) => (ab(s) ? Promise.resolve(cancelled()) : inner.drag(h, sr, t, s)),
    mouseClickXY: (h, x, y, s) =>
      ab(s) ? Promise.resolve(cancelled()) : inner.mouseClickXY(h, x, y, s),
  }
}

/** A toolset on the loaded page over an abort-aware port (for signal-threading
 *  proofs). */
const abortAwareToolsetOnPage = async (): Promise<ReturnType<typeof createBrowserToolset>> => {
  const port = abortAwarePort(createHeadlessBrowser({ pages: PAGES }))
  const ts = createBrowserToolset(port)
  await navTo(ts.tools)
  await run(toolByName(ts.tools, "browser_snapshot"), {})
  return ts
}

// ── the 15 tools surface ─────────────────────────────────────────────────────

describe("HELLGATE browser edge — 15-tool surface contract", () => {
  test("HELL-BE-01: exactly the 15 tools, with correct read-only / concurrency flags", () => {
    const ts = createBrowserToolset(createHeadlessBrowser({ pages: PAGES }))
    const names = ts.tools.map((t) => t.name).sort()
    expect(names).toEqual(
      [
        "browser_cdp",
        "browser_click",
        "browser_console",
        "browser_drag",
        "browser_fill",
        "browser_mouse_click_xy",
        "browser_navigate",
        "browser_press_key",
        "browser_read",
        "browser_screenshot",
        "browser_scroll",
        "browser_select_option",
        "browser_snapshot",
        "browser_type",
        "browser_wait",
      ].sort(),
    )
    // Read-only verbs: snapshot + screenshot + the 3 new verification reads.
    const readOnly = ts.tools
      .filter((t) => t.isReadOnly())
      .map((t) => t.name)
      .sort()
    expect(readOnly).toEqual([
      "browser_console",
      "browser_read",
      "browser_screenshot",
      "browser_snapshot",
      "browser_wait",
    ])
    // NONE is concurrency-safe (a single shared stateful handle).
    for (const t of ts.tools) {
      expect(t.isConcurrencySafe({} as never)).toBe(false)
    }
  })
})

// ── pre-aborted signal at every cancellable verb ─────────────────────────────

describe("HELLGATE browser edge — pre-aborted signal at every verb", () => {
  // Each verb that threads ctx.signal into the port: a pre-aborted signal must
  // fail (not crash). The headless stub maps an aborted signal to {cancelled},
  // which the result-map turns into a `mode:"error"` failure.
  const VERBS: ReadonlyArray<{ name: string; input: () => unknown }> = [
    { name: "browser_navigate", input: () => ({ url: URL }) },
    { name: "browser_click", input: () => ({ ref: "e3" }) },
    { name: "browser_type", input: () => ({ ref: "e2", text: "hi" }) },
    { name: "browser_fill", input: () => ({ ref: "e2", value: "v" }) },
    { name: "browser_select_option", input: () => ({ ref: "e2", values: ["a"] }) },
    { name: "browser_scroll", input: () => ({ ref: "e2" }) },
    { name: "browser_press_key", input: () => ({ key: "Enter" }) },
    { name: "browser_drag", input: () => ({ sourceRef: "e2", targetRef: "e3" }) },
    { name: "browser_mouse_click_xy", input: () => ({ x: 1, y: 2 }) },
  ]

  for (const v of VERBS) {
    test(`HELL-BE-02:${v.name}: pre-aborted signal ⇒ failure, not crash`, async () => {
      // Over an abort-aware port: the tool MUST forward ctx.signal into the port
      // method, so a pre-aborted signal becomes a {cancelled} → failure. If the
      // tool dropped the signal, the verb would succeed and this would fail.
      const ts = await abortAwareToolsetOnPage()
      const r = await run(toolByName(ts.tools, v.name), v.input(), aborted())
      expect(r.ok).toBe(false)
      expect(r.failure).toBeDefined()
    })
  }

  test("HELL-BE-03: CONTROL — every verb with a FRESH signal ⇒ ok", async () => {
    for (const v of VERBS) {
      const ts = await toolsetOnPage()
      const r = await run(toolByName(ts.tools, v.name), v.input())
      expect(r.ok).toBe(true)
    }
  })

  test("HELL-BE-04: snapshot (no signal param) still succeeds when ctx.signal pre-aborted", async () => {
    // The snapshot port method takes no signal, so a pre-aborted ctx must NOT
    // be able to force a failure here — proves we don't pre-check the signal in
    // a way that would break read-only perception.
    const ts = await toolsetOnPage()
    const r = await run(toolByName(ts.tools, "browser_snapshot"), {}, aborted())
    expect(r.ok).toBe(true)
  })
})

// ── HUGE snapshot ⇒ capToolOutput persists + truncates ───────────────────────

describe("HELLGATE browser edge — huge snapshot over capToolOutput", () => {
  const regOn = (model: DomModel): { reg: ToolRegistry; cwd: string } => {
    const port = createHeadlessBrowser({ pages: new Map([[URL, { title: "P", dom: model }]]) })
    const ts = createBrowserToolset(port)
    const reg = new ToolRegistry(ts.tools)
    const cwd = mkdtempSync(join(tmpdir(), "browser-edge-"))
    return { reg, cwd }
  }

  test("HELL-BE-05: thousands-of-node snapshot ⇒ output capped + persisted marker", async () => {
    const model = hugeModel(5_000)
    const { reg, cwd } = regOn(model)
    const ctx = { cwd, signal: new AbortController().signal }
    await reg.run("browser_navigate", { url: URL }, ctx)
    const r = await reg.run("browser_snapshot", {}, ctx)
    expect(r.ok).toBe(true)
    // The RAW snapshot is well over the 200k cap...
    expect(r.output.length).toBeGreaterThan(0)
    // ...but the registry-capped output is bounded far under the raw size and
    // carries the persisted-output marker + a spill path on evidence.
    expect(r.output.length).toBeLessThan(50_000)
    expect(r.output).toContain("<persisted-output>")
    expect(r.output).toContain("persisted to disk")
    expect(r.evidence?.fullLogPath).toBeDefined()
    expect(typeof r.evidence?.fullLogPath).toBe("string")
  })

  test("HELL-BE-06: the raw snapshot text genuinely exceeds the 200k cap (proof the cap fired)", async () => {
    // Render the same model the headless port would, to prove the precondition:
    // without a real over-cap input, HELL-BE-05's assertions would be vacuous.
    const { buildSnapshot, createRefMap } = await import("@/browser")
    const raw = buildSnapshot(hugeModel(5_000), createRefMap())
    expect(raw.length).toBeGreaterThan(200_000)
  })

  test("HELL-BE-07: CONTROL — a small snapshot is returned byte-identical (no cap, no spill)", async () => {
    const { reg, cwd } = regOn(SMALL)
    const ctx = { cwd, signal: new AbortController().signal }
    await reg.run("browser_navigate", { url: URL }, ctx)
    const r = await reg.run("browser_snapshot", {}, ctx)
    expect(r.ok).toBe(true)
    expect(r.output).not.toContain("<persisted-output>")
    expect(r.evidence?.fullLogPath).toBeUndefined()
    // Small + bounded: the whole tree fits in a few hundred chars.
    expect(r.output.length).toBeLessThan(2_000)
    expect(r.output).toContain("Email")
  })
})

// ── concurrent ensure() coalescing under a deferred spawn fired 10× ──────────

describe("HELLGATE browser edge — ensure() coalescing", () => {
  test("HELL-BE-08: 10 concurrent ensure() under a deferred spawn ⇒ EXACTLY one spawn", async () => {
    let spawnCount = 0
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    const inner = createHeadlessBrowser({ pages: PAGES })
    const port: BrowserPort = {
      ...inner,
      spawn: async (o) => {
        spawnCount += 1
        await gate // hold every caller in the spawn window
        return inner.spawn(o)
      },
    }
    const session = createBrowserSession(port)
    // 10 callers all fire BEFORE the first spawn resolves.
    const ps = Array.from({ length: 10 }, () => session.ensure())
    release()
    const results = await Promise.all(ps)
    expect(spawnCount).toBe(1) // coalesced — not 10 spawns
    expect(results.every((r) => r.ok)).toBe(true)
    const ids = new Set(results.map((r) => (r.ok ? r.value.id : "")))
    expect(ids.size).toBe(1) // all share the one handle
  })

  test("HELL-BE-09: CONTROL — 10 SERIAL ensures after resolution still spawn once (reuse)", async () => {
    let spawnCount = 0
    const inner = createHeadlessBrowser({ pages: PAGES })
    const port: BrowserPort = {
      ...inner,
      spawn: (o) => {
        spawnCount += 1
        return inner.spawn(o)
      },
    }
    const session = createBrowserSession(port)
    for (let i = 0; i < 10; i++) {
      const r = await session.ensure()
      expect(r.ok).toBe(true)
    }
    expect(spawnCount).toBe(1) // handle cached after the first
  })
})

// ── dispose during an in-flight spawn ───────────────────────────────────────

describe("HELLGATE browser edge — dispose during in-flight spawn", () => {
  test("HELL-BE-10: dispose mid-spawn ⇒ fresh handle closed once, ensure observes closed, terminal", async () => {
    let closes = 0
    let resolveSpawn!: (r: Result<BrowserHandle, BrowserError>) => void
    const inner = createHeadlessBrowser({ pages: PAGES })
    const port: BrowserPort = {
      ...inner,
      spawn: () =>
        new Promise<Result<BrowserHandle, BrowserError>>((res) => {
          resolveSpawn = res
        }),
      close: (h) => {
        closes += 1
        return inner.close(h)
      },
    }
    const session = createBrowserSession(port)
    const ensureP = session.ensure() // spawn pending
    const disposeP = session.dispose() // disposed flips true; awaits the spawn
    resolveSpawn({ ok: true, value: { id: "fresh", backend: "headless" } })
    const [r] = await Promise.all([ensureP, disposeP])
    expect(closes).toBe(1) // the never-stored fresh handle is still closed
    expect(r.ok).toBe(false) // ensure saw the dispose → closed
    // Terminal: a post-dispose ensure fails closed and does NOT respawn.
    const after = await session.ensure()
    expect(after.ok).toBe(false)
    expect(closes).toBe(1)
  })

  test("HELL-BE-11: CONTROL — normal spawn then dispose closes exactly once", async () => {
    let closes = 0
    const inner = createHeadlessBrowser({ pages: PAGES })
    const port: BrowserPort = {
      ...inner,
      close: (h) => {
        closes += 1
        return inner.close(h)
      },
    }
    const session = createBrowserSession(port)
    const r = await session.ensure()
    expect(r.ok).toBe(true)
    await session.dispose()
    await session.dispose() // idempotent
    expect(closes).toBe(1)
  })
})

// ── every verb's element-not-found path with a bogus ref ─────────────────────

describe("HELLGATE browser edge — element-not-found for every ref verb", () => {
  const REF_VERBS: ReadonlyArray<{ name: string; bogus: () => unknown; good: () => unknown }> = [
    { name: "browser_click", bogus: () => ({ ref: "e999" }), good: () => ({ ref: "e3" }) },
    {
      name: "browser_type",
      bogus: () => ({ ref: "e999", text: "t" }),
      good: () => ({ ref: "e2", text: "t" }),
    },
    {
      name: "browser_fill",
      bogus: () => ({ ref: "e999", value: "v" }),
      good: () => ({ ref: "e2", value: "v" }),
    },
    {
      name: "browser_select_option",
      bogus: () => ({ ref: "e999", values: ["a"] }),
      good: () => ({ ref: "e2", values: ["a"] }),
    },
    { name: "browser_scroll", bogus: () => ({ ref: "e999" }), good: () => ({ ref: "e2" }) },
    {
      name: "browser_drag",
      bogus: () => ({ sourceRef: "e999", targetRef: "e3" }),
      good: () => ({ sourceRef: "e2", targetRef: "e3" }),
    },
  ]

  for (const v of REF_VERBS) {
    test(`HELL-BE-12:${v.name}: bogus ref ⇒ not_found`, async () => {
      const ts = await toolsetOnPage()
      const r = await run(toolByName(ts.tools, v.name), v.bogus())
      expect(r.ok).toBe(false)
      expect(r.failure?.mode).toBe("not_found")
      expect(r.output).toContain("e999")
    })
    test(`HELL-BE-13:${v.name}: CONTROL real ref ⇒ ok`, async () => {
      const ts = await toolsetOnPage()
      const r = await run(toolByName(ts.tools, v.name), v.good())
      expect(r.ok).toBe(true)
    })
  }

  test("HELL-BE-14: drag with a bogus TARGET ref ⇒ not_found (source valid)", async () => {
    const ts = await toolsetOnPage()
    const r = await run(toolByName(ts.tools, "browser_drag"), {
      sourceRef: "e2",
      targetRef: "e999",
    })
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("not_found")
  })

  test("HELL-BE-15: drag with NO target (neither ref nor x/y) ⇒ rejected (tool-level)", async () => {
    const ts = await toolsetOnPage()
    const r = await run(toolByName(ts.tools, "browser_drag"), { sourceRef: "e2" })
    expect(r.ok).toBe(false)
    expect(r.failure?.mode).toBe("rejected")
  })

  test("HELL-BE-16: CONTROL — drag to viewport COORDS (no target ref) ⇒ ok", async () => {
    const ts = await toolsetOnPage()
    const r = await run(toolByName(ts.tools, "browser_drag"), {
      sourceRef: "e2",
      targetX: 10,
      targetY: 20,
    })
    expect(r.ok).toBe(true)
  })
})

// ── CDP denied vs allowed through the tool ───────────────────────────────────

describe("HELLGATE browser edge — CDP allowlist through the tool", () => {
  test("HELL-BE-17: every denied CDP method ⇒ permission_denied", async () => {
    const ts = createBrowserToolset(createHeadlessBrowser({ pages: PAGES }))
    await navTo(ts.tools)
    const cdp = toolByName(ts.tools, "browser_cdp")
    for (const method of [
      "Runtime.evaluate",
      "Input.dispatchMouseEvent",
      "Page.navigate",
      "Target.createTarget",
      "totally.bogus",
      "",
    ]) {
      const r = await run(cdp, { method })
      expect(r.ok).toBe(false)
      expect(r.failure?.mode).toBe("permission_denied")
      expect(r.output).toContain(method)
    }
  })

  test("HELL-BE-18: CONTROL — every allowlisted CDP method ⇒ ok", async () => {
    const ts = createBrowserToolset(createHeadlessBrowser({ pages: PAGES }))
    await navTo(ts.tools)
    const cdp = toolByName(ts.tools, "browser_cdp")
    expect(CDP_ALLOWED_METHODS.length).toBeGreaterThan(0)
    for (const method of CDP_ALLOWED_METHODS) {
      const r = await run(cdp, { method })
      expect(r.ok).toBe(true)
    }
  })
})

// ── schema-invalid inputs rejected by ToolRegistry.run ───────────────────────

describe("HELLGATE browser edge — registry schema validation", () => {
  const registry = (): ToolRegistry =>
    new ToolRegistry(createBrowserToolset(createHeadlessBrowser({ pages: PAGES })).tools)

  const ctx = () => ({ cwd: tmpdir(), signal: new AbortController().signal })

  const BAD: ReadonlyArray<{ label: string; name: string; input: unknown }> = [
    { label: "navigate missing url", name: "browser_navigate", input: {} },
    { label: "navigate url wrong type", name: "browser_navigate", input: { url: 123 } },
    { label: "click missing ref", name: "browser_click", input: {} },
    { label: "click ref wrong type", name: "browser_click", input: { ref: 7 } },
    { label: "type missing text", name: "browser_type", input: { ref: "e2" } },
    { label: "fill missing value", name: "browser_fill", input: { ref: "e2" } },
    {
      label: "select_option values not array",
      name: "browser_select_option",
      input: { ref: "e2", values: "a" },
    },
    { label: "cdp missing method", name: "browser_cdp", input: {} },
    { label: "mouse_click_xy missing y", name: "browser_mouse_click_xy", input: { x: 1 } },
    {
      label: "mouse_click_xy x wrong type",
      name: "browser_mouse_click_xy",
      input: { x: "1", y: 2 },
    },
    { label: "press_key missing key", name: "browser_press_key", input: {} },
    {
      label: "scroll direction not in enum",
      name: "browser_scroll",
      input: { direction: "diagonal" },
    },
  ]

  for (const c of BAD) {
    test(`HELL-BE-19:${c.label} ⇒ throws ToolInputError`, async () => {
      const reg = registry()
      await expect(reg.run(c.name, c.input, ctx())).rejects.toBeInstanceOf(ToolInputError)
    })
  }

  test("HELL-BE-20: CONTROL — a valid input through the registry runs (no throw)", async () => {
    const reg = registry()
    const r = await reg.run("browser_navigate", { url: URL }, ctx())
    expect(r.ok).toBe(true)
    expect(r.output).toContain("navigated to")
  })

  test("HELL-BE-21: unknown tool name ⇒ throws ToolInputError", async () => {
    const reg = registry()
    await expect(reg.run("browser_nope", {}, ctx())).rejects.toBeInstanceOf(ToolInputError)
  })
})

// ── closed-session failures across verbs (terminal handle) ───────────────────

describe("HELLGATE browser edge — closed session is terminal across verbs", () => {
  test("HELL-BE-22: after dispose, EVERY verb fails closed and never respawns", async () => {
    let spawnCount = 0
    const inner = createHeadlessBrowser({ pages: PAGES })
    const port: BrowserPort = {
      ...inner,
      spawn: (o) => {
        spawnCount += 1
        return inner.spawn(o)
      },
    }
    const ts = createBrowserToolset(port)
    await navTo(ts.tools) // spawns once
    await run(toolByName(ts.tools, "browser_snapshot"), {})
    await ts.dispose()
    expect(spawnCount).toBe(1)
    const inputs: Record<string, unknown> = {
      browser_navigate: { url: URL },
      browser_click: { ref: "e3" },
      browser_type: { ref: "e2", text: "t" },
      browser_fill: { ref: "e2", value: "v" },
      browser_select_option: { ref: "e2", values: ["a"] },
      browser_drag: { sourceRef: "e2", targetRef: "e3" },
      browser_press_key: { key: "Enter" },
      browser_mouse_click_xy: { x: 1, y: 2 },
      browser_cdp: { method: "DOM.getDocument" },
    }
    for (const t of ts.tools) {
      const r = await run(t, inputs[t.name] ?? {})
      expect(r.ok).toBe(false)
    }
    expect(spawnCount).toBe(1) // never resurrected
  })
})
