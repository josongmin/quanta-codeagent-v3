/**
 * Browser automation tools (ADR-0427, Wave 3).
 *
 * The model-facing layer over `BrowserPort`. Each tool wires the slice's
 * security gates: SSRF/protocol guard on navigate (strengthen #2), page text
 * routed through `guardPageText` (strengthen #3), CDP allowlist enforced by the
 * port (strengthen #1), and HITL tiers per verb (strengthen #5). The browser
 * handle is lazily spawned + reused via {@link BrowserSession} and disposed on
 * session teardown.
 *
 * DEFAULT-OFF: nothing here registers unless a composition root passes a wired
 * `BrowserPort` (the `availability()` + env gate decide that).
 */

import type { NetworkEntry } from "@/browser"
import { type BrowserHandle, type BrowserPort, CDP_ALLOWED_METHODS } from "@/browser"
import { sliceWholeChars } from "@/shared"
import { defineTool, type Tool, type ToolContext, type ToolEvent, type ToolResult } from "@/tool"
import { type DnsResolver, guardNavigationUrl } from "./net-guard"
import { guardPageText, mapBrowserError } from "./result-map"
import {
  type CdpInput,
  type ClickInput,
  type ConsoleInput,
  cdpSchema,
  clickSchema,
  consoleSchema,
  type DragInput,
  dragSchema,
  type ElementBoundsInput,
  elementBoundsSchema,
  type FillInput,
  fillSchema,
  type HighlightInput,
  highlightSchema,
  type MouseClickXyInput,
  mouseClickXySchema,
  type NavigateInput,
  type NetworkInput,
  navigateSchema,
  networkSchema,
  type PressKeyInput,
  pressKeySchema,
  type ReadInput,
  readSchema,
  type ScrollInput,
  type SelectOptionInput,
  screenshotSchema,
  scrollSchema,
  selectOptionSchema,
  snapshotSchema,
  type TabCloseInput,
  type TabListInput,
  type TabNewInput,
  type TabSwitchInput,
  type TypeInput,
  tabCloseSchema,
  tabListSchema,
  tabNewSchema,
  tabSwitchSchema,
  typeSchema,
  type WaitInput,
  waitSchema,
} from "./schemas"
import { type BrowserSession, createBrowserSession } from "./session-holder"

const CDP_OUTPUT_CAP = 20_000
/** Cap the console dump rendered to the model (defense-in-depth on top of the
 *  port's bounded ring buffer). */
const CONSOLE_OUTPUT_CAP = 20_000
/** Cap the network dump rendered to the model (defense-in-depth on top of the
 *  port's bounded ring buffer). */
const NETWORK_OUTPUT_CAP = 20_000
/** Max network rows rendered (newest kept) — bounds the row count independently
 *  of the byte cap so a burst of tiny requests can't flood the view. */
const NETWORK_ROW_CAP = 100

/** S1 (jul-04) — ONE captured network row, METADATA ONLY. Structurally identical
 *  to `NetworkEntry` (method/url/status/mime/size), re-declared here so the sink
 *  contract is closed at THIS layer — a body/header/cookie/token field is not
 *  even expressible. */
export interface BrowserNetMirrorRow {
  readonly method?: string
  readonly url: string
  readonly status?: number
  readonly mime?: string
  readonly size?: number
}

/** S1 (jul-04) — the surface-owned capture snapshot the CLI `/browser-net` reads.
 *  A structural SUPERSET-safe mirror of the slash `BrowserNetSnapshot` (kept
 *  slice-decoupled: `@/tool/browser` imports NO CLI value). */
export interface BrowserNetMirrorSnapshot {
  readonly rows: readonly BrowserNetMirrorRow[]
  readonly dropped?: number
  readonly at: number
}

/** S1 (jul-04) — the write-only sink the surface threads DOWN into the browser
 *  toolset. `createBrowserNetHolder()` (CLI) structurally satisfies it. */
export interface BrowserNetSink {
  set(snapshot: BrowserNetMirrorSnapshot): void
}

/** Project drained `NetworkEntry` rows onto the closed metadata mirror + push the
 *  snapshot into the sink. ★ LEAK GUARD (defense-in-depth): we copy ONLY the five
 *  metadata fields, so even if an upstream `NetworkEntry` were ever widened with a
 *  stray body/header field, it cannot ride into the surface. No-throw: a
 *  misbehaving sink can never break the model-facing tool result. Absent sink ⇒
 *  no-op (byte-identical default-OFF). */
const mirrorNetworkToSink = (
  sink: BrowserNetSink | undefined,
  entries: readonly NetworkEntry[],
): void => {
  if (sink === undefined) return
  try {
    const rows: BrowserNetMirrorRow[] = entries.slice(-NETWORK_ROW_CAP).map((e) => ({
      ...(e.method ? { method: e.method } : {}),
      url: e.url,
      ...(e.status !== undefined ? { status: e.status } : {}),
      ...(e.mime !== undefined ? { mime: e.mime } : {}),
      ...(e.size !== undefined ? { size: e.size } : {}),
    }))
    const dropped = Math.max(0, entries.length - rows.length)
    sink.set({ rows, ...(dropped > 0 ? { dropped } : {}), at: Date.now() })
  } catch {
    /* no-throw: the tool result is authoritative; a sink hiccup is swallowed */
  }
}
/** Cap a single read's text/attribute output. */
const READ_OUTPUT_CAP = 8_000
/** Raw PNG byte cap before a screenshot is refused (≈ a few MB of base64). */
const MAX_SCREENSHOT_BYTES = 4_000_000

type Ensured =
  | { readonly ok: true; readonly handle: BrowserHandle }
  | { readonly ok: false; readonly result: ToolResult }

const ensureHandle = async (session: BrowserSession, signal: AbortSignal): Promise<Ensured> => {
  const r = await session.ensure(signal)
  if (!r.ok) return { ok: false, result: mapBrowserError(r.error) }
  return { ok: true, handle: r.value }
}

const navigateTool = (port: BrowserPort, session: BrowserSession, resolver?: DnsResolver): Tool =>
  defineTool<NavigateInput>({
    name: "browser_navigate",
    description:
      "Navigate the headless browser to an http/https URL. SSRF + protocol guarded. Spawns the browser on first use.",
    inputSchema: navigateSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    hitlTier: () => "pre-approval-ok",
    async *execute(input: NavigateInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const guard = await guardNavigationUrl(input.url, resolver)
      if (!guard.ok) {
        yield {
          type: "result",
          result: {
            ok: false,
            output: `navigation denied: ${guard.reason}`,
            failure: { mode: "permission_denied" },
          },
        }
        return
      }
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) {
        yield { type: "result", result: ens.result }
        return
      }
      yield { type: "progress", message: `navigating: ${guard.url.href}` }
      const r = await port.navigate(ens.handle, guard.url.href, ctx.signal)
      if (!r.ok) {
        yield { type: "result", result: mapBrowserError(r.error) }
        return
      }
      yield {
        type: "result",
        result: {
          ok: true,
          output: `navigated to ${guardPageText(r.value.title)} (${guard.url.href})`,
        },
      }
    },
  })

const snapshotTool = (port: BrowserPort, session: BrowserSession): Tool =>
  defineTool<Record<string, never>>({
    name: "browser_snapshot",
    description:
      "Capture an accessibility-tree snapshot of the current page (YAML). Each node has a ref you pass to browser_click / browser_type. Refs are valid only until the page changes — re-snapshot after any action that may mutate the DOM before reusing a ref (a stale ref after navigation fails closed; after an in-place mutation it may resolve to a different element).",
    inputSchema: snapshotSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    hitlTier: () => "pre-approval-ok",
    async *execute(_input, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) {
        yield { type: "result", result: ens.result }
        return
      }
      const r = await port.snapshot(ens.handle, undefined, ctx.signal)
      if (!r.ok) {
        yield { type: "result", result: mapBrowserError(r.error) }
        return
      }
      yield { type: "result", result: { ok: true, output: guardPageText(r.value.yaml) } }
    },
  })

const clickTool = (port: BrowserPort, session: BrowserSession): Tool =>
  defineTool<ClickInput>({
    name: "browser_click",
    description: "Click the element identified by a ref from a prior browser_snapshot.",
    inputSchema: clickSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    hitlTier: () => "always-confirm",
    async *execute(input: ClickInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) {
        yield { type: "result", result: ens.result }
        return
      }
      const r = await port.click(ens.handle, input.ref, ctx.signal)
      if (!r.ok) {
        yield { type: "result", result: mapBrowserError(r.error) }
        return
      }
      yield { type: "result", result: { ok: true, output: `clicked ${input.ref}` } }
    },
  })

const typeTool = (port: BrowserPort, session: BrowserSession): Tool =>
  defineTool<TypeInput>({
    name: "browser_type",
    description: "Type text into the element identified by a ref from a prior browser_snapshot.",
    inputSchema: typeSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    hitlTier: () => "always-confirm",
    async *execute(input: TypeInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) {
        yield { type: "result", result: ens.result }
        return
      }
      const r = await port.type(ens.handle, input.ref, input.text, {
        ...(input.clear !== undefined ? { clear: input.clear } : {}),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      })
      if (!r.ok) {
        yield { type: "result", result: mapBrowserError(r.error) }
        return
      }
      yield { type: "result", result: { ok: true, output: `typed into ${input.ref}` } }
    },
  })

const screenshotTool = (port: BrowserPort, session: BrowserSession): Tool =>
  defineTool<Record<string, never>>({
    name: "browser_screenshot",
    description: "Capture a PNG screenshot of the current page (returned as an image for vision).",
    inputSchema: screenshotSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    hitlTier: () => "pre-approval-ok",
    async *execute(_input, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) {
        yield { type: "result", result: ens.result }
        return
      }
      const r = await port.screenshot(ens.handle, ctx.signal)
      if (!r.ok) {
        yield { type: "result", result: mapBrowserError(r.error) }
        return
      }
      // Cap the payload — a tall/4K page can produce a multi-MB PNG that would
      // blow the context if base64'd straight into the message (R3 audit [12]).
      if (r.value.length > MAX_SCREENSHOT_BYTES) {
        yield {
          type: "result",
          result: {
            ok: false,
            output: `screenshot too large (${r.value.length} bytes > ${MAX_SCREENSHOT_BYTES} cap) — scroll/scope the page or read it via browser_snapshot instead`,
            failure: { mode: "rejected", reason: "screenshot exceeds size cap" },
          },
        }
        return
      }
      yield {
        type: "result",
        result: {
          ok: true,
          output: `screenshot captured (${r.value.length} bytes)`,
          images: [
            {
              type: "image",
              data: Buffer.from(r.value).toString("base64"),
              mediaType: "image/png",
            },
          ],
        },
      }
    },
  })

const cdpTool = (port: BrowserPort, session: BrowserSession): Tool =>
  defineTool<CdpInput>({
    name: "browser_cdp",
    // Description derived from the allowlist so the model-facing prose can never
    // drift from what is actually permitted (R2 audit [2][7][12][17]).
    description: `Send a raw Chrome DevTools Protocol command. Restricted by a closed allowlist to these read-only introspection methods ONLY: ${CDP_ALLOWED_METHODS.join(", ")}. Anything else (including Runtime.evaluate) is denied.`,
    inputSchema: cdpSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    hitlTier: () => "always-confirm",
    async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) {
        yield { type: "result", result: ens.result }
        return
      }
      const r = await port.cdp(ens.handle, input.method, input.params, ctx.signal)
      if (!r.ok) {
        yield { type: "result", result: mapBrowserError(r.error) }
        return
      }
      const text = guardPageText(JSON.stringify(r.value ?? null)).slice(0, CDP_OUTPUT_CAP)
      yield { type: "result", result: { ok: true, output: text } }
    },
  })

const fillTool = (port: BrowserPort, session: BrowserSession): Tool =>
  defineTool<FillInput>({
    name: "browser_fill",
    description:
      "Set a form field's value (replaces contents) by ref from a prior browser_snapshot.",
    inputSchema: fillSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    hitlTier: () => "always-confirm",
    async *execute(input, ctx): AsyncIterable<ToolEvent> {
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) return yield { type: "result", result: ens.result }
      const r = await port.fill(ens.handle, input.ref, input.value, ctx.signal)
      yield {
        type: "result",
        result: r.ok ? { ok: true, output: `filled ${input.ref}` } : mapBrowserError(r.error),
      }
    },
  })

const selectOptionTool = (port: BrowserPort, session: BrowserSession): Tool =>
  defineTool<SelectOptionInput>({
    name: "browser_select_option",
    description:
      "Select option(s) on a <select> element by value, by ref from a prior browser_snapshot.",
    inputSchema: selectOptionSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    hitlTier: () => "always-confirm",
    async *execute(input, ctx): AsyncIterable<ToolEvent> {
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) return yield { type: "result", result: ens.result }
      const r = await port.selectOption(ens.handle, input.ref, input.values, ctx.signal)
      yield {
        type: "result",
        result: r.ok ? { ok: true, output: `selected on ${input.ref}` } : mapBrowserError(r.error),
      }
    },
  })

const scrollTool = (port: BrowserPort, session: BrowserSession): Tool =>
  defineTool<ScrollInput>({
    name: "browser_scroll",
    description: "Scroll an element into view (ref) or scroll the page (direction/amount).",
    inputSchema: scrollSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    hitlTier: () => "pre-approval-ok",
    async *execute(input, ctx): AsyncIterable<ToolEvent> {
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) return yield { type: "result", result: ens.result }
      const r = await port.scroll(
        ens.handle,
        {
          ...(input.ref !== undefined ? { ref: input.ref } : {}),
          ...(input.direction !== undefined ? { direction: input.direction } : {}),
          ...(input.amount !== undefined ? { amount: input.amount } : {}),
        },
        ctx.signal,
      )
      yield {
        type: "result",
        result: r.ok ? { ok: true, output: "scrolled" } : mapBrowserError(r.error),
      }
    },
  })

const pressKeyTool = (port: BrowserPort, session: BrowserSession): Tool =>
  defineTool<PressKeyInput>({
    name: "browser_press_key",
    description: 'Press a key (e.g. "Enter" to submit, "Escape", "Tab", "ArrowDown").',
    inputSchema: pressKeySchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    hitlTier: () => "always-confirm",
    async *execute(input, ctx): AsyncIterable<ToolEvent> {
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) return yield { type: "result", result: ens.result }
      const r = await port.pressKey(ens.handle, input.key, ctx.signal)
      yield {
        type: "result",
        result: r.ok ? { ok: true, output: `pressed ${input.key}` } : mapBrowserError(r.error),
      }
    },
  })

const dragTool = (port: BrowserPort, session: BrowserSession): Tool =>
  defineTool<DragInput>({
    name: "browser_drag",
    description: "Drag from a source element ref to a target ref or viewport coordinate.",
    inputSchema: dragSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    hitlTier: () => "always-confirm",
    async *execute(input, ctx): AsyncIterable<ToolEvent> {
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) return yield { type: "result", result: ens.result }
      const target =
        input.targetRef !== undefined
          ? { ref: input.targetRef }
          : input.targetX !== undefined && input.targetY !== undefined
            ? { x: input.targetX, y: input.targetY }
            : undefined
      if (target === undefined) {
        return yield {
          type: "result",
          result: {
            ok: false,
            output: "drag needs targetRef or targetX+targetY",
            failure: { mode: "rejected", reason: "no drag target" },
          },
        }
      }
      const r = await port.drag(ens.handle, input.sourceRef, target, ctx.signal)
      yield {
        type: "result",
        result: r.ok
          ? { ok: true, output: `dragged ${input.sourceRef}` }
          : mapBrowserError(r.error),
      }
    },
  })

const mouseClickXyTool = (port: BrowserPort, session: BrowserSession): Tool =>
  defineTool<MouseClickXyInput>({
    name: "browser_mouse_click_xy",
    description:
      "Click at absolute viewport coordinates (escape hatch when an element has no ref).",
    inputSchema: mouseClickXySchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    hitlTier: () => "always-confirm",
    async *execute(input, ctx): AsyncIterable<ToolEvent> {
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) return yield { type: "result", result: ens.result }
      const r = await port.mouseClickXY(ens.handle, input.x, input.y, ctx.signal)
      yield {
        type: "result",
        result: r.ok
          ? { ok: true, output: `clicked (${input.x},${input.y})` }
          : mapBrowserError(r.error),
      }
    },
  })

const consoleTool = (port: BrowserPort, session: BrowserSession): Tool =>
  defineTool<ConsoleInput>({
    name: "browser_console",
    description:
      "Read the captured console.* output + uncaught errors since the page loaded (a bounded ring buffer). Use it to verify the front end: did the app log an error, fail a fetch, throw? Pass clear:true to drain the buffer.",
    inputSchema: consoleSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    hitlTier: () => "pre-approval-ok",
    async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) return yield { type: "result", result: ens.result }
      const r = await port.consoleMessages(
        ens.handle,
        input.clear === true ? { clear: true } : undefined,
      )
      if (!r.ok) return yield { type: "result", result: mapBrowserError(r.error) }
      // Each line's text is PAGE-CONTROLLED → guard every entry (strengthen #3).
      const lines = r.value.entries.map((e) => `[${e.level}] ${guardPageText(e.text)}`)
      const header =
        r.value.dropped > 0
          ? `(${r.value.dropped} earlier entr${r.value.dropped === 1 ? "y" : "ies"} dropped — buffer cap)\n`
          : ""
      const body = lines.length === 0 ? "(console empty)" : lines.join("\n")
      yield {
        type: "result",
        result: { ok: true, output: (header + body).slice(0, CONSOLE_OUTPUT_CAP) },
      }
    },
  })

const networkTool = (port: BrowserPort, session: BrowserSession, netSink?: BrowserNetSink): Tool =>
  defineTool<NetworkInput>({
    name: "browser_network",
    description:
      "Read the captured network activity since the page loaded (a bounded ring buffer). METADATA ONLY — method, url, status, mime, size; NO bodies or headers are ever captured. Use it to verify the front end: did a fetch 404/500, what did the API return, how big was the payload? Pass clear:true to drain the buffer.",
    inputSchema: networkSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    hitlTier: () => "pre-approval-ok",
    async *execute(input, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) return yield { type: "result", result: ens.result }
      const r = await port.networkMessages(
        ens.handle,
        input.clear === true ? { clear: true } : undefined,
      )
      if (!r.ok) return yield { type: "result", result: mapBrowserError(r.error) }
      // S1 (jul-04) — mirror this LIVE drain into the surface-owned net sink so
      // `/browser-net` renders the last capture WITHOUT the model in the loop.
      // METADATA-ONLY projection (see `mirrorNetworkToSink`); runs on BOTH the
      // peek and the clear:true path (we mirror the rows we just READ, before the
      // port drains them). No-throw + absent-sink no-op.
      mirrorNetworkToSink(netSink, r.value.entries)
      // Keep the NEWEST NETWORK_ROW_CAP rows (row-count bound on top of the port's
      // byte/count bounded buffer). Each `url` is PAGE-CONTROLLED → guard it
      // (strengthen #3); status/mime/size are numbers/enums we control.
      const rows = r.value.entries.slice(-NETWORK_ROW_CAP)
      const lines = rows.map((e) => {
        const parts: string[] = []
        // method/url/mime are all page/server-controlled strings → guard EACH so a
        // page cannot forge a <system-reminder> boundary via a custom HTTP method
        // or MIME type. status/size are our own numbers (safe).
        if (e.method) parts.push(guardPageText(e.method))
        if (e.status !== undefined) parts.push(String(e.status))
        parts.push(guardPageText(e.url) || "(no-url)")
        if (e.mime !== undefined) parts.push(guardPageText(e.mime))
        if (e.size !== undefined) parts.push(`${e.size}B`)
        return parts.join(" ")
      })
      const droppedByCap = r.value.entries.length - rows.length
      const droppedTotal = r.value.dropped + droppedByCap
      const header =
        droppedTotal > 0
          ? `(${droppedTotal} earlier entr${droppedTotal === 1 ? "y" : "ies"} dropped — buffer/row cap)\n`
          : ""
      const body = lines.length === 0 ? "(network empty)" : lines.join("\n")
      yield {
        type: "result",
        result: { ok: true, output: sliceWholeChars(header + body, NETWORK_OUTPUT_CAP) },
      }
    },
  })

const waitTool = (port: BrowserPort, session: BrowserSession): Tool =>
  defineTool<WaitInput>({
    name: "browser_wait",
    description:
      "Wait for a CSS selector to appear in the DOM (for dynamic/SPA pages) before snapshotting or clicking. Times out (default 5s) if it never appears.",
    inputSchema: waitSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    hitlTier: () => "pre-approval-ok",
    async *execute(input: WaitInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) return yield { type: "result", result: ens.result }
      const r = await port.wait(
        ens.handle,
        {
          selector: input.selector,
          ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
        },
        ctx.signal,
      )
      yield {
        type: "result",
        result: r.ok
          ? { ok: true, output: `selector appeared: ${input.selector}` }
          : mapBrowserError(r.error),
      }
    },
  })

const readTool = (port: BrowserPort, session: BrowserSession): Tool =>
  defineTool<ReadInput>({
    name: "browser_read",
    description:
      "Read a precise property off an element (by ref from a prior browser_snapshot): its rendered text, an attribute value, or whether it is visible. Use it to verify exact UI state a snapshot summarizes (e.g. is the error message shown? what is this input's value?).",
    inputSchema: readSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => false,
    hitlTier: () => "pre-approval-ok",
    async *execute(input: ReadInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) return yield { type: "result", result: ens.result }
      const r = await port.read(
        ens.handle,
        input.ref,
        { what: input.what, ...(input.attr !== undefined ? { attr: input.attr } : {}) },
        ctx.signal,
      )
      if (!r.ok) return yield { type: "result", result: mapBrowserError(r.error) }
      // text/attribute are page-controlled → guard + cap; visible is a boolean.
      const output =
        typeof r.value.value === "boolean"
          ? `visible: ${r.value.value}`
          : guardPageText(r.value.value).slice(0, READ_OUTPUT_CAP)
      yield { type: "result", result: { ok: true, output } }
    },
  })

// TICKET-24 Wave A — `browser_element_bounds`: resolve a snapshot ref to its
// pixel rect. Turns the blind `browser_mouse_click_xy` escape hatch into a
// precise ref→bounds→coordinate aim (e.g. canvas/drag offsets). Read-only.
// Integer-rounded so a re-snapshot of the same element doesn't churn the echo.
const boundsTool = (port: BrowserPort, session: BrowserSession): Tool =>
  defineTool<ElementBoundsInput>({
    name: "browser_element_bounds",
    description:
      "Get the pixel bounding box {x,y,w,h,visible} of an element by ref (from a prior browser_snapshot). Use before browser_mouse_click_xy when you have a ref but need exact coordinates (e.g. canvas/drag offsets).",
    inputSchema: elementBoundsSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    hitlTier: () => "pre-approval-ok",
    async *execute(input: ElementBoundsInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) return yield { type: "result", result: ens.result }
      const r = await port.getBoundingBox(ens.handle, input.ref, ctx.signal)
      if (!r.ok) return yield { type: "result", result: mapBrowserError(r.error) }
      const { x, y, w, h, visible } = r.value
      const output = `${input.ref}: ${Math.round(x)},${Math.round(y)} ${Math.round(w)}×${Math.round(h)} visible=${visible}`
      yield { type: "result", result: { ok: true, output } }
    },
  })

// TICKET-24 Wave A — `browser_highlight`: paint a transient outline overlay over
// an element (cosmetic, read-only, no-HITL). Pair with browser_screenshot to
// visually confirm the agent is about to act on the right element.
const highlightTool = (port: BrowserPort, session: BrowserSession): Tool =>
  defineTool<HighlightInput>({
    name: "browser_highlight",
    description:
      "Draw a transient outline overlay around an element by ref (cosmetic only — no page mutation). Pair with browser_screenshot to confirm you are about to act on the right element.",
    inputSchema: highlightSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    hitlTier: () => "pre-approval-ok",
    async *execute(input: HighlightInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) return yield { type: "result", result: ens.result }
      const r = await port.highlight(
        ens.handle,
        input.ref,
        {
          ...(input.color !== undefined ? { color: input.color } : {}),
          ...(input.durationMs !== undefined ? { durationMs: input.durationMs } : {}),
        },
        ctx.signal,
      )
      if (!r.ok) return yield { type: "result", result: mapBrowserError(r.error) }
      yield {
        type: "result",
        result: {
          ok: true,
          output: `highlighted ${input.ref} — pair with browser_screenshot to confirm`,
        },
      }
    },
  })

// ── TICKET-24 Wave B — multi-tab tools. Each tab has its OWN refMap, so refs are
//    per-tab: after browser_tab_switch the model must re-snapshot. Tab titles are
//    page-controlled ⇒ guardPageText before the model sees them.
const tabNewTool = (port: BrowserPort, session: BrowserSession): Tool =>
  defineTool<TabNewInput>({
    name: "browser_tab_new",
    description:
      "Open a new browser tab (blank). It does NOT become active — call browser_tab_switch to act on it, then browser_navigate to load a page. See browser_tab_list.",
    inputSchema: tabNewSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    hitlTier: () => "pre-approval-ok",
    async *execute(_input: TabNewInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) return yield { type: "result", result: ens.result }
      const r = await port.newTab(ens.handle, undefined, ctx.signal)
      if (!r.ok) return yield { type: "result", result: mapBrowserError(r.error) }
      yield {
        type: "result",
        result: {
          ok: true,
          output: `opened tab ${r.value.id} (inactive) — browser_tab_switch ${r.value.id} to use it`,
        },
      }
    },
  })

const tabSwitchTool = (port: BrowserPort, session: BrowserSession): Tool =>
  defineTool<TabSwitchInput>({
    name: "browser_tab_switch",
    description:
      "Make a tab active (by id from browser_tab_list, or a 0-based index). Refs are PER-TAB: take a fresh browser_snapshot after switching — refs from the previous tab no longer resolve.",
    inputSchema: tabSwitchSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    hitlTier: () => "always-confirm",
    async *execute(input: TabSwitchInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) return yield { type: "result", result: ens.result }
      const r = await port.switchTab(ens.handle, input.tab, ctx.signal)
      if (!r.ok) return yield { type: "result", result: mapBrowserError(r.error) }
      const label = guardPageText(r.value.title) || r.value.url
      yield {
        type: "result",
        result: {
          ok: true,
          output: `switched to tab ${r.value.id} (${label}) — refs are per-tab, re-snapshot before acting`,
        },
      }
    },
  })

const tabCloseTool = (port: BrowserPort, session: BrowserSession): Tool =>
  defineTool<TabCloseInput>({
    name: "browser_tab_close",
    description:
      "Close a tab (by id or 0-based index). Closing the active tab makes another tab active. The last remaining tab cannot be closed (close the browser instead).",
    inputSchema: tabCloseSchema,
    isReadOnly: () => false,
    isConcurrencySafe: () => false,
    hitlTier: () => "always-confirm",
    async *execute(input: TabCloseInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) return yield { type: "result", result: ens.result }
      const r = await port.closeTab(ens.handle, input.tab, ctx.signal)
      if (!r.ok) return yield { type: "result", result: mapBrowserError(r.error) }
      yield { type: "result", result: { ok: true, output: `closed tab ${input.tab}` } }
    },
  })

const tabListTool = (port: BrowserPort, session: BrowserSession): Tool =>
  defineTool<TabListInput>({
    name: "browser_tab_list",
    description: "List open browser tabs — index, id, url, title, and which is active (*).",
    inputSchema: tabListSchema,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    hitlTier: () => "pre-approval-ok",
    async *execute(_input: TabListInput, ctx: ToolContext): AsyncIterable<ToolEvent> {
      const ens = await ensureHandle(session, ctx.signal)
      if (!ens.ok) return yield { type: "result", result: ens.result }
      const r = await port.listTabs(ens.handle, ctx.signal)
      if (!r.ok) return yield { type: "result", result: mapBrowserError(r.error) }
      const lines = r.value.map(
        (t, i) =>
          `[${i}]${t.active ? "*" : " "} ${t.id}  ${t.url}  ${JSON.stringify(guardPageText(t.title))}`,
      )
      yield { type: "result", result: { ok: true, output: lines.join("\n") || "(no tabs)" } }
    },
  })

export interface BrowserToolset {
  readonly tools: Tool[]
  /** Tear down the browser session. Register into the composition root's
   *  disposer collector (mirrors WiredSearchPipeline.dispose). */
  dispose(): Promise<void>
}

export interface BrowserToolsetOpts {
  /** Optional DNS resolver — when supplied, navigate denies a public NAME that
   *  resolves to a private/loopback address (R1 audit [16]). The production wire
   *  passes a node-backed resolver; omit to keep literal-only classification. */
  readonly resolver?: DnsResolver
  /** TICKET-24 — gate `browser_element_bounds` (QUANTA_BROWSER_BOUNDS). Default-OFF. */
  readonly bounds?: boolean
  /** TICKET-24 — gate `browser_highlight` (QUANTA_BROWSER_HIGHLIGHT). Default-OFF. */
  readonly highlight?: boolean
  /** TICKET-24 Wave B — gate the 4 `browser_tab_*` tools (QUANTA_BROWSER_TABS). Default-OFF. */
  readonly tabs?: boolean
  /** S1 strengthen — gate `browser_network` (QUANTA_BROWSER_NETWORK). Default-OFF. */
  readonly network?: boolean
  /** S1 (jul-04) — surface-owned net-capture sink. When present AND `network` is
   *  on, each `browser_network` drain mirrors its METADATA-ONLY rows into this
   *  holder so the CLI `/browser-net` slash can render the last capture. Absent ⇒
   *  no mirror (byte-identical). Rides ONLY the gated tool — no `network` ⇒ never
   *  populated. */
  readonly netHolder?: BrowserNetSink
}

/** Build the browser toolset over a wired `BrowserPort`. The 15 tools share ONE
 *  lazily-spawned session handle; `dispose()` closes it. */
export const createBrowserToolset = (
  port: BrowserPort,
  opts: BrowserToolsetOpts = {},
): BrowserToolset => {
  const session = createBrowserSession(port)
  const tools: Tool[] = [
    navigateTool(port, session, opts.resolver),
    snapshotTool(port, session),
    clickTool(port, session),
    typeTool(port, session),
    fillTool(port, session),
    selectOptionTool(port, session),
    scrollTool(port, session),
    pressKeyTool(port, session),
    dragTool(port, session),
    mouseClickXyTool(port, session),
    screenshotTool(port, session),
    cdpTool(port, session),
    consoleTool(port, session),
    waitTool(port, session),
    readTool(port, session),
  ]
  // TICKET-24 Wave A — independent default-OFF gates; each tool appears ONLY
  // when its flag is set, so the unflagged toolset is byte-identical to the 15.
  if (opts.bounds === true) tools.push(boundsTool(port, session))
  if (opts.highlight === true) tools.push(highlightTool(port, session))
  // S1 strengthen — network capture, independent default-OFF gate. S1 (jul-04):
  // thread the surface net-sink so a drain mirrors its metadata into the holder
  // the CLI `/browser-net` reads. The sink rides ONLY this gated tool — no
  // `network` gate ⇒ tool absent ⇒ holder never populated (byte-identical).
  if (opts.network === true) tools.push(networkTool(port, session, opts.netHolder))
  if (opts.tabs === true) {
    tools.push(
      tabListTool(port, session),
      tabNewTool(port, session),
      tabSwitchTool(port, session),
      tabCloseTool(port, session),
    )
  }
  return { tools, dispose: () => session.dispose() }
}

export { type DnsResolver, nodeDnsResolver } from "./net-guard"
