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

import { type BrowserHandle, type BrowserPort, CDP_ALLOWED_METHODS } from "@/browser"
import { defineTool, type Tool, type ToolContext, type ToolEvent, type ToolResult } from "@/tool"
import { type DnsResolver, guardNavigationUrl } from "./net-guard"
import { guardPageText, mapBrowserError } from "./result-map"
import {
  type CdpInput,
  type ClickInput,
  cdpSchema,
  clickSchema,
  type DragInput,
  dragSchema,
  type FillInput,
  fillSchema,
  type MouseClickXyInput,
  mouseClickXySchema,
  type NavigateInput,
  navigateSchema,
  type PressKeyInput,
  pressKeySchema,
  type ScrollInput,
  type SelectOptionInput,
  screenshotSchema,
  scrollSchema,
  selectOptionSchema,
  snapshotSchema,
  type TypeInput,
  typeSchema,
} from "./schemas"
import { type BrowserSession, createBrowserSession } from "./session-holder"

const CDP_OUTPUT_CAP = 20_000
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
}

/** Build the browser toolset over a wired `BrowserPort`. The 6 tools share ONE
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
  ]
  return { tools, dispose: () => session.dispose() }
}

export { type DnsResolver, nodeDnsResolver } from "./net-guard"
