/**
 * Browser slice — deterministic headless stub (ADR-0427).
 *
 * The SAFE, no-IO `BrowserPort` for tests / CI / replay. Pages are supplied as
 * a fixture map (`url → { title, dom }`); there is no process, no socket, no
 * network. Every method is deterministic: same fixtures + same calls ⇒
 * byte-identical results (snapshots route through the pure `buildSnapshot`).
 *
 * This is also the slice's structural anchor for the CDP allowlist: `cdp()`
 * here enforces the exact same {@link isCdpMethodAllowed} gate the real adapter
 * will, so the allowlist hellgate can prove the contract without a browser.
 */

import { err, ok, type Result } from "@/shared"
import { isCdpMethodAllowed } from "./cdp-allowlist"
import type { BrowserPort } from "./port"
import { buildSnapshot, createRefMap, type RefMap } from "./snapshot"
import type {
  BoundingBox,
  BrowserError,
  BrowserHandle,
  BrowserStartOpts,
  ConsoleEntry,
  ConsoleOpts,
  DomModel,
  DomNode,
  HighlightOpts,
  PageSnapshot,
  ReadOpts,
  TypeOpts,
  WaitOpts,
} from "./types"

/** Default `wait` deadline echoed in the stub's `timeout` error — mirrors the
 *  real adapter's `DEFAULT_WAIT_SELECTOR_MS` so fixtures stay byte-identical. */
const DEFAULT_WAIT_SELECTOR_MS = 5_000

export interface HeadlessPage {
  readonly title: string
  readonly dom: DomModel
}

export interface HeadlessBrowserOpts {
  /** `url → page` fixtures. A navigate to an unknown url returns
   *  `Err{ navigation-denied }`. */
  readonly pages?: ReadonlyMap<string, HeadlessPage>
  /** Seed the console buffer the deterministic `consoleMessages` returns. */
  readonly consoleEntries?: readonly ConsoleEntry[]
  /** Already-dropped count the stub reports (to exercise the truncation path). */
  readonly consoleDropped?: number
  /** Selectors `wait` resolves `ok` for; any other selector ⇒ `timeout`. */
  readonly presentSelectors?: ReadonlySet<string>
}

interface SessionState {
  closed: boolean
  url: string
  readonly refMap: RefMap
  consoleEntries: ConsoleEntry[]
  consoleDropped: number
}

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Find the DomNode whose backendPath a ref resolves to (stub-side `read`). */
const findNode = (node: DomNode, backendPath: string): DomNode | null => {
  if (node.backendPath === backendPath) return node
  for (const child of node.children ?? []) {
    const hit = findNode(child, backendPath)
    if (hit !== null) return hit
  }
  return null
}

/** Deterministic fixture-derived attribute lookup for the stub `read`. A few
 *  well-known attrs map onto DomNode fields; everything else is "". */
const nodeAttr = (node: DomNode, attr: string): string => {
  if (attr === "value") return node.value ?? ""
  if (attr === "placeholder") return node.placeholder ?? ""
  if (attr === "href") return node.url ?? ""
  return ""
}

export const createHeadlessBrowser = (opts: HeadlessBrowserOpts = {}): BrowserPort => {
  const pages = opts.pages ?? new Map<string, HeadlessPage>()
  const presentSelectors = opts.presentSelectors ?? new Set<string>()
  const sessions = new Map<string, SessionState>()
  let seq = 0

  const live = (h: BrowserHandle): Result<SessionState, BrowserError> => {
    const s = sessions.get(h.id)
    if (s === undefined || s.closed) return err({ kind: "closed" })
    return ok(s)
  }

  return {
    availability: (): string | null => "headless",

    isLive: (h: BrowserHandle): boolean => {
      const s = sessions.get(h.id)
      return s !== undefined && !s.closed
    },

    async spawn(_opts?: BrowserStartOpts): Promise<Result<BrowserHandle, BrowserError>> {
      seq += 1
      const id = `headless-${seq}`
      sessions.set(id, {
        closed: false,
        url: "about:blank",
        refMap: createRefMap(),
        consoleEntries: [...(opts.consoleEntries ?? [])],
        consoleDropped: opts.consoleDropped ?? 0,
      })
      return ok({ id, backend: "headless" })
    },

    async navigate(
      h: BrowserHandle,
      url: string,
      signal?: AbortSignal,
    ): Promise<Result<{ readonly title: string }, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      if (signal?.aborted === true) return err({ kind: "cancelled" })
      const page = pages.get(url)
      if (page === undefined)
        return err({ kind: "navigation-denied", reason: `unknown url: ${url}` })
      s.value.url = url
      // Same invariant as the real adapter: a committed navigation invalidates
      // every prior ref (a denied navigation above does NOT, since the page is
      // unchanged). Keeps the deterministic stub faithful to the port contract.
      s.value.refMap.invalidate()
      return ok({ title: page.title })
    },

    async snapshot(h: BrowserHandle): Promise<Result<PageSnapshot, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      const page = pages.get(s.value.url)
      if (page === undefined) return err({ kind: "navigation-denied", reason: "no current page" })
      const yaml = buildSnapshot(page.dom, s.value.refMap)
      return ok({ yaml, url: s.value.url, title: page.title })
    },

    async click(
      h: BrowserHandle,
      ref: string,
      signal?: AbortSignal,
    ): Promise<Result<void, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      if (signal?.aborted === true) return err({ kind: "cancelled" })
      if (s.value.refMap.resolve(ref) === null) return err({ kind: "element-not-found", ref })
      return ok(undefined)
    },

    // TICKET-24 Wave A — deterministic bbox/highlight for the stub-backed port.
    async getBoundingBox(
      h: BrowserHandle,
      ref: string,
    ): Promise<Result<BoundingBox, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      if (s.value.refMap.resolve(ref) === null) return err({ kind: "element-not-found", ref })
      return ok({ x: 10, y: 20, w: 100, h: 40, visible: true })
    },

    async highlight(
      h: BrowserHandle,
      ref: string,
      _opts?: HighlightOpts,
    ): Promise<Result<void, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      if (s.value.refMap.resolve(ref) === null) return err({ kind: "element-not-found", ref })
      return ok(undefined)
    },

    async type(
      h: BrowserHandle,
      ref: string,
      _text: string,
      opts?: TypeOpts,
    ): Promise<Result<void, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      if (opts?.signal?.aborted === true) return err({ kind: "cancelled" })
      if (s.value.refMap.resolve(ref) === null) return err({ kind: "element-not-found", ref })
      return ok(undefined)
    },

    async fill(h, ref): Promise<Result<void, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      return s.value.refMap.resolve(ref) === null
        ? err({ kind: "element-not-found", ref })
        : ok(undefined)
    },

    async selectOption(h, ref): Promise<Result<void, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      return s.value.refMap.resolve(ref) === null
        ? err({ kind: "element-not-found", ref })
        : ok(undefined)
    },

    async scroll(h, opts): Promise<Result<void, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      if (opts.ref !== undefined && s.value.refMap.resolve(opts.ref) === null) {
        return err({ kind: "element-not-found", ref: opts.ref })
      }
      return ok(undefined)
    },

    async pressKey(h): Promise<Result<void, BrowserError>> {
      const s = live(h)
      return s.ok ? ok(undefined) : s
    },

    async drag(h, sourceRef, target): Promise<Result<void, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      if (s.value.refMap.resolve(sourceRef) === null)
        return err({ kind: "element-not-found", ref: sourceRef })
      if ("ref" in target && s.value.refMap.resolve(target.ref) === null) {
        return err({ kind: "element-not-found", ref: target.ref })
      }
      return ok(undefined)
    },

    async mouseClickXY(h): Promise<Result<void, BrowserError>> {
      const s = live(h)
      return s.ok ? ok(undefined) : s
    },

    async screenshot(h: BrowserHandle): Promise<Result<Uint8Array, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      return ok(PNG_MAGIC.slice())
    },

    async consoleMessages(h: BrowserHandle, cOpts?: ConsoleOpts) {
      const s = live(h)
      if (!s.ok) return s
      const entries = s.value.consoleEntries.slice()
      const dropped = s.value.consoleDropped
      if (cOpts?.clear === true) {
        s.value.consoleEntries = []
        s.value.consoleDropped = 0
      }
      return ok({ entries, dropped })
    },

    async wait(h: BrowserHandle, wOpts: WaitOpts, signal?: AbortSignal) {
      const s = live(h)
      if (!s.ok) return s
      if (signal?.aborted === true) return err({ kind: "cancelled" })
      return presentSelectors.has(wOpts.selector)
        ? ok(undefined)
        : err({ kind: "timeout", ms: wOpts.timeoutMs ?? DEFAULT_WAIT_SELECTOR_MS })
    },

    async read(h: BrowserHandle, ref: string, rOpts: ReadOpts) {
      const s = live(h)
      if (!s.ok) return s
      const path = s.value.refMap.resolve(ref)
      if (path === null) return err({ kind: "element-not-found", ref })
      const page = pages.get(s.value.url)
      const node = page !== undefined ? findNode(page.dom.root, path) : null
      if (node === null) return err({ kind: "element-not-found", ref })
      if (rOpts.what === "text") return ok({ value: node.name })
      if (rOpts.what === "visible") return ok({ value: true })
      return ok({ value: nodeAttr(node, rOpts.attr ?? "") })
    },

    async cdp(h: BrowserHandle, method: string): Promise<Result<unknown, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      if (!isCdpMethodAllowed(method)) return err({ kind: "cdp-method-denied", method })
      return ok({ method, stub: true })
    },

    async close(h: BrowserHandle): Promise<Result<void, BrowserError>> {
      const s = sessions.get(h.id)
      if (s === undefined) return ok(undefined) // never spawned / already gone — idempotent
      s.closed = true
      return ok(undefined)
    },
  }
}
