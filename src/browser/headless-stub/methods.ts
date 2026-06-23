/**
 * Browser slice — deterministic headless stub method bodies (ADR-0427).
 *
 * Extracted from {@link createHeadlessBrowser} so the factory stays a thin
 * delegating shell. Each helper takes the shared closure state by reference via
 * {@link StubDeps}; control-flow is byte-identical to the inline originals.
 */

import { err, ok, type Result } from "@/shared"
import { isCdpMethodAllowed } from "../cdp-allowlist"
import { buildSnapshot, createRefMap, type RefMap } from "../snapshot"
import type {
  BoundingBox,
  BrowserError,
  BrowserHandle,
  BrowserStartOpts,
  ConsoleEntry,
  ConsoleOpts,
  DomModel,
  DomNode,
  DragTarget,
  HighlightOpts,
  PageSnapshot,
  ReadOpts,
  ScrollOpts,
  TabInfo,
  TypeOpts,
  WaitOpts,
} from "../types"

/** Default `wait` deadline echoed in the stub's `timeout` error — mirrors the
 *  real adapter's `DEFAULT_WAIT_SELECTOR_MS` so fixtures stay byte-identical. */
const DEFAULT_WAIT_SELECTOR_MS = 5_000

export interface HeadlessPage {
  readonly title: string
  readonly dom: DomModel
}

/** TICKET-24 Wave B — deterministic stub tab (own refMap ⇒ ref isolation). */
export interface StubTab {
  readonly id: string
  url: string
  title: string
  refMap: RefMap
}

export interface SessionState {
  closed: boolean
  /** The ACTIVE tab's url (mirror; saved back into its {@link StubTab} on switch). */
  url: string
  /** The ACTIVE tab's refMap (mirror; swapped on switch). Mutable so switchTab can
   *  repoint ref resolution to another tab — the ref-isolation invariant. */
  refMap: RefMap
  consoleEntries: ConsoleEntry[]
  consoleDropped: number
  /** TICKET-24 Wave B — open tabs (ALWAYS non-empty) + the active id. */
  tabs: StubTab[]
  activeTabId: string
}

/** Shared closure state, passed by reference. `seq` is boxed so spawn can bump it. */
export interface StubDeps {
  readonly pages: ReadonlyMap<string, HeadlessPage>
  readonly presentSelectors: ReadonlySet<string>
  readonly sessions: Map<string, SessionState>
  readonly seq: { n: number }
  readonly consoleEntries?: readonly ConsoleEntry[] | undefined
  readonly consoleDropped?: number | undefined
  live(h: BrowserHandle): Result<SessionState, BrowserError>
}

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** Resolve a switch/close arg: a stub tab id (exact) OR a 0-based index. */
const resolveStubTab = (s: SessionState, idOrIndex: string): StubTab | null => {
  const direct = s.tabs.find((t) => t.id === idOrIndex)
  if (direct !== undefined) return direct
  if (/^\d+$/.test(idOrIndex)) {
    const i = Number(idOrIndex)
    if (i >= 0 && i < s.tabs.length) return s.tabs[i] ?? null
  }
  return null
}

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

export const isLive = (d: StubDeps, h: BrowserHandle): boolean => {
  const s = d.sessions.get(h.id)
  return s !== undefined && !s.closed
}

export const spawn = async (
  d: StubDeps,
  _opts?: BrowserStartOpts,
): Promise<Result<BrowserHandle, BrowserError>> => {
  d.seq.n += 1
  const id = `headless-${d.seq.n}`
  const tab0: StubTab = { id: `${id}-tab-1`, url: "about:blank", title: "", refMap: createRefMap() }
  d.sessions.set(id, {
    closed: false,
    url: "about:blank",
    refMap: tab0.refMap,
    consoleEntries: [...(d.consoleEntries ?? [])],
    consoleDropped: d.consoleDropped ?? 0,
    tabs: [tab0],
    activeTabId: tab0.id,
  })
  return ok({ id, backend: "headless" })
}

export const navigate = async (
  d: StubDeps,
  h: BrowserHandle,
  url: string,
  signal?: AbortSignal,
): Promise<Result<{ readonly title: string }, BrowserError>> => {
  const s = d.live(h)
  if (!s.ok) return s
  if (signal?.aborted === true) return err({ kind: "cancelled" })
  const page = d.pages.get(url)
  if (page === undefined) return err({ kind: "navigation-denied", reason: `unknown url: ${url}` })
  s.value.url = url
  // Same invariant as the real adapter: a committed navigation invalidates
  // every prior ref (a denied navigation above does NOT, since the page is
  // unchanged). Keeps the deterministic stub faithful to the port contract.
  s.value.refMap.invalidate()
  return ok({ title: page.title })
}

export const snapshot = async (
  d: StubDeps,
  h: BrowserHandle,
): Promise<Result<PageSnapshot, BrowserError>> => {
  const s = d.live(h)
  if (!s.ok) return s
  const page = d.pages.get(s.value.url)
  if (page === undefined) return err({ kind: "navigation-denied", reason: "no current page" })
  const yaml = buildSnapshot(page.dom, s.value.refMap)
  return ok({ yaml, url: s.value.url, title: page.title })
}

export const click = async (
  d: StubDeps,
  h: BrowserHandle,
  ref: string,
  signal?: AbortSignal,
): Promise<Result<void, BrowserError>> => {
  const s = d.live(h)
  if (!s.ok) return s
  if (signal?.aborted === true) return err({ kind: "cancelled" })
  if (s.value.refMap.resolve(ref) === null) return err({ kind: "element-not-found", ref })
  return ok(undefined)
}

export const getBoundingBox = async (
  d: StubDeps,
  h: BrowserHandle,
  ref: string,
): Promise<Result<BoundingBox, BrowserError>> => {
  const s = d.live(h)
  if (!s.ok) return s
  if (s.value.refMap.resolve(ref) === null) return err({ kind: "element-not-found", ref })
  return ok({ x: 10, y: 20, w: 100, h: 40, visible: true })
}

export const highlight = async (
  d: StubDeps,
  h: BrowserHandle,
  ref: string,
  _opts?: HighlightOpts,
): Promise<Result<void, BrowserError>> => {
  const s = d.live(h)
  if (!s.ok) return s
  if (s.value.refMap.resolve(ref) === null) return err({ kind: "element-not-found", ref })
  return ok(undefined)
}

export const type_ = async (
  d: StubDeps,
  h: BrowserHandle,
  ref: string,
  _text: string,
  opts?: TypeOpts,
): Promise<Result<void, BrowserError>> => {
  const s = d.live(h)
  if (!s.ok) return s
  if (opts?.signal?.aborted === true) return err({ kind: "cancelled" })
  if (s.value.refMap.resolve(ref) === null) return err({ kind: "element-not-found", ref })
  return ok(undefined)
}

export const fill = async (
  d: StubDeps,
  h: BrowserHandle,
  ref: string,
): Promise<Result<void, BrowserError>> => {
  const s = d.live(h)
  if (!s.ok) return s
  return s.value.refMap.resolve(ref) === null
    ? err({ kind: "element-not-found", ref })
    : ok(undefined)
}

export const selectOption = async (
  d: StubDeps,
  h: BrowserHandle,
  ref: string,
): Promise<Result<void, BrowserError>> => {
  const s = d.live(h)
  if (!s.ok) return s
  return s.value.refMap.resolve(ref) === null
    ? err({ kind: "element-not-found", ref })
    : ok(undefined)
}

export const scroll = async (
  d: StubDeps,
  h: BrowserHandle,
  opts: ScrollOpts,
): Promise<Result<void, BrowserError>> => {
  const s = d.live(h)
  if (!s.ok) return s
  if (opts.ref !== undefined && s.value.refMap.resolve(opts.ref) === null) {
    return err({ kind: "element-not-found", ref: opts.ref })
  }
  return ok(undefined)
}

export const pressKey = async (
  d: StubDeps,
  h: BrowserHandle,
): Promise<Result<void, BrowserError>> => {
  const s = d.live(h)
  return s.ok ? ok(undefined) : s
}

export const drag = async (
  d: StubDeps,
  h: BrowserHandle,
  sourceRef: string,
  target: DragTarget,
): Promise<Result<void, BrowserError>> => {
  const s = d.live(h)
  if (!s.ok) return s
  if (s.value.refMap.resolve(sourceRef) === null)
    return err({ kind: "element-not-found", ref: sourceRef })
  if ("ref" in target && s.value.refMap.resolve(target.ref) === null) {
    return err({ kind: "element-not-found", ref: target.ref })
  }
  return ok(undefined)
}

export const mouseClickXY = async (
  d: StubDeps,
  h: BrowserHandle,
): Promise<Result<void, BrowserError>> => {
  const s = d.live(h)
  return s.ok ? ok(undefined) : s
}

export const screenshot = async (
  d: StubDeps,
  h: BrowserHandle,
): Promise<Result<Uint8Array, BrowserError>> => {
  const s = d.live(h)
  if (!s.ok) return s
  return ok(PNG_MAGIC.slice())
}

export const consoleMessages = async (d: StubDeps, h: BrowserHandle, cOpts?: ConsoleOpts) => {
  const s = d.live(h)
  if (!s.ok) return s
  const entries = s.value.consoleEntries.slice()
  const dropped = s.value.consoleDropped
  if (cOpts?.clear === true) {
    s.value.consoleEntries = []
    s.value.consoleDropped = 0
  }
  return ok({ entries, dropped })
}

export const wait = async (
  d: StubDeps,
  h: BrowserHandle,
  wOpts: WaitOpts,
  signal?: AbortSignal,
): Promise<Result<void, BrowserError>> => {
  const s = d.live(h)
  if (!s.ok) return s
  if (signal?.aborted === true) return err({ kind: "cancelled" })
  return d.presentSelectors.has(wOpts.selector)
    ? ok(undefined)
    : err({ kind: "timeout", ms: wOpts.timeoutMs ?? DEFAULT_WAIT_SELECTOR_MS })
}

export const read = async (
  d: StubDeps,
  h: BrowserHandle,
  ref: string,
  rOpts: ReadOpts,
): Promise<Result<{ readonly value: string | boolean }, BrowserError>> => {
  const s = d.live(h)
  if (!s.ok) return s
  const path = s.value.refMap.resolve(ref)
  if (path === null) return err({ kind: "element-not-found", ref })
  const page = d.pages.get(s.value.url)
  const node = page !== undefined ? findNode(page.dom.root, path) : null
  if (node === null) return err({ kind: "element-not-found", ref })
  if (rOpts.what === "text") return ok({ value: node.name })
  if (rOpts.what === "visible") return ok({ value: true })
  return ok({ value: nodeAttr(node, rOpts.attr ?? "") })
}

export const newTab = async (
  d: StubDeps,
  h: BrowserHandle,
  url?: string,
): Promise<Result<TabInfo, BrowserError>> => {
  const s = d.live(h)
  if (!s.ok) return s
  const tab: StubTab = {
    id: `${h.id}-tab-${s.value.tabs.length + 1}`,
    url: url ?? "about:blank",
    title: "",
    refMap: createRefMap(),
  }
  s.value.tabs.push(tab)
  return ok({ id: tab.id, url: tab.url, title: tab.title, active: false })
}

export const switchTab = async (
  d: StubDeps,
  h: BrowserHandle,
  idOrIndex: string,
): Promise<Result<TabInfo, BrowserError>> => {
  const s = d.live(h)
  if (!s.ok) return s
  const tab = resolveStubTab(s.value, idOrIndex)
  if (tab === null) {
    return err({ kind: "tab-not-found", id: idOrIndex, open: s.value.tabs.map((t) => t.id) })
  }
  // Save the active tab's live url, then make `tab` active (swap refMap+url) —
  // a ref minted on the prior tab now fails closed (its refMap is inactive).
  const cur = s.value.tabs.find((t) => t.id === s.value.activeTabId)
  if (cur !== undefined) cur.url = s.value.url
  s.value.activeTabId = tab.id
  s.value.refMap = tab.refMap
  s.value.url = tab.url
  return ok({ id: tab.id, url: tab.url, title: tab.title, active: true })
}

export const closeTab = async (
  d: StubDeps,
  h: BrowserHandle,
  idOrIndex: string,
): Promise<Result<void, BrowserError>> => {
  const s = d.live(h)
  if (!s.ok) return s
  const tab = resolveStubTab(s.value, idOrIndex)
  if (tab === null) {
    return err({ kind: "tab-not-found", id: idOrIndex, open: s.value.tabs.map((t) => t.id) })
  }
  if (s.value.tabs.length === 1) {
    return err({
      kind: "cdp-error",
      detail: "cannot close the last tab — close the browser instead",
    })
  }
  s.value.tabs = s.value.tabs.filter((t) => t.id !== tab.id)
  if (s.value.activeTabId === tab.id) {
    const next = s.value.tabs[0]
    if (next !== undefined) {
      s.value.activeTabId = next.id
      s.value.refMap = next.refMap
      s.value.url = next.url
    }
  }
  return ok(undefined)
}

export const listTabs = async (
  d: StubDeps,
  h: BrowserHandle,
): Promise<Result<readonly TabInfo[], BrowserError>> => {
  const s = d.live(h)
  if (!s.ok) return s
  const cur = s.value.tabs.find((t) => t.id === s.value.activeTabId)
  if (cur !== undefined) cur.url = s.value.url
  return ok(
    s.value.tabs.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      active: t.id === s.value.activeTabId,
    })),
  )
}

export const cdp = async (
  d: StubDeps,
  h: BrowserHandle,
  method: string,
): Promise<Result<unknown, BrowserError>> => {
  const s = d.live(h)
  if (!s.ok) return s
  if (!isCdpMethodAllowed(method)) return err({ kind: "cdp-method-denied", method })
  return ok({ method, stub: true })
}

export const close = async (d: StubDeps, h: BrowserHandle): Promise<Result<void, BrowserError>> => {
  const s = d.sessions.get(h.id)
  if (s === undefined) return ok(undefined) // never spawned / already gone — idempotent
  s.closed = true
  return ok(undefined)
}
