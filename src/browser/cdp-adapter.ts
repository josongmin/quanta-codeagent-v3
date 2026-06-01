/**
 * Browser slice — CDP adapter (ADR-0427, Wave 2).
 *
 * The production `BrowserPort`: spawns a headless system Chrome with an isolated
 * temp profile, discovers its DevTools endpoint, drives it over CDP, and tears
 * everything down on `close()`. ALL non-determinism is injected via
 * `./cdp/ports`, so this orchestration is unit-tested with fakes against the
 * exact same contract the headless stub satisfies — no real browser needed.
 *
 * Design notes:
 *   - `availability()` is sync (binary probe) → gates `browser_*` registration.
 *   - element refs resolve to a raw child-index path; click/type run as in-page
 *     JS (`.click()` / value+input event) — NOT `Input.*` CDP — so they never
 *     touch the methods the allowlist forbids.
 *   - `cdp()` enforces the closed allowlist; `screenshot()` and the internal
 *     evaluate calls bypass it BY DESIGN (the allowlist gates the model surface,
 *     not the implementation).
 *   - `close()` is idempotent and always kills the proc + removes the profile.
 */

import { err, ok, type Result } from "@/shared"
import { type CdpSession, createCdpSession } from "./cdp/cdp-session"
import { COLLECT_SCRIPT, parseDomModel } from "./cdp/collect"
import { readDevToolsEndpoint } from "./cdp/dev-tools-endpoint"
import type {
  BrowserFs,
  CdpTransport,
  Clock,
  ProcessSpawner,
  Scheduler,
  SpawnedProcess,
} from "./cdp/ports"
import { isCdpMethodAllowed } from "./cdp-allowlist"
import type { BrowserPort } from "./port"
import { buildSnapshot, createRefMap, type RefMap } from "./snapshot"
import type {
  BrowserError,
  BrowserHandle,
  BrowserStartOpts,
  DragTarget,
  PageSnapshot,
  ScrollOpts,
  TypeOpts,
} from "./types"

export const DEFAULT_CHROME_CANDIDATES = [
  "google-chrome",
  "google-chrome-stable",
  "chromium",
  "chromium-browser",
] as const

export const DEFAULT_MAC_CHROME_PATHS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
] as const

export interface CdpBrowserDeps {
  readonly spawner: ProcessSpawner
  readonly transport: CdpTransport
  readonly fs: BrowserFs
  readonly scheduler: Scheduler
  readonly clock: Clock
  /** Directory (already inside the fs-jail, supplied by the tool layer) under
   *  which each session's isolated profile is created. */
  readonly profileRoot: string
  readonly chromeCandidates?: readonly string[]
  readonly macPaths?: readonly string[]
  readonly endpointTimeoutMs?: number
}

interface SessionState {
  closed: boolean
  url: string
  readonly proc: SpawnedProcess
  readonly session: CdpSession
  readonly profileDir: string
  readonly refMap: RefMap
}

const pathIndices = (path: string): number[] =>
  path
    .split("/")
    .filter((seg) => seg.length > 0)
    .map((seg) => Number(seg))

const resolveJs = (path: string): string => {
  const idx = JSON.stringify(pathIndices(path))
  return `(() => { let el = document.body; for (const i of ${idx}) { if (!el) return null; el = (el.shadowRoot ? el.shadowRoot.children : el.children)[i]; } return el; })()`
}

const clickJs = (path: string): string =>
  `(() => { const el = ${resolveJs(path)}; if (!el) return false; el.click(); return true; })()`

// Branches on element kind (R1 audit [10]): form controls get `.value` set +
// change event; contenteditable gets text appended into the node; anything else
// returns false so the tool surfaces element-not-found instead of silently
// writing a junk `value` property.
const typeJs = (path: string, text: string, clear: boolean): string =>
  `(() => {
    const el = ${resolveJs(path)};
    if (!el) return false;
    const t = ${JSON.stringify(text)};
    if ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) {
      if (${clear ? "true" : "false"}) el.value = '';
      el.value = (el.value || '') + t;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    if (el.isContentEditable) {
      if (${clear ? "true" : "false"}) el.textContent = '';
      el.textContent = (el.textContent || '') + t;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    }
    return false;
  })()`

const fillJs = (path: string, value: string): string =>
  `(() => {
    const el = ${resolveJs(path)};
    if (!el) return false;
    const v = ${JSON.stringify(value)};
    if ('value' in el) { el.value = v; el.dispatchEvent(new Event('input',{bubbles:true})); el.dispatchEvent(new Event('change',{bubbles:true})); return true; }
    if (el.isContentEditable) { el.textContent = v; el.dispatchEvent(new Event('input',{bubbles:true})); return true; }
    return false;
  })()`

const selectJs = (path: string, values: readonly string[]): string =>
  `(() => {
    const el = ${resolveJs(path)};
    if (!el || el.tagName !== 'SELECT') return false;
    const vs = ${JSON.stringify(values)};
    for (const o of el.options) o.selected = vs.includes(o.value);
    el.dispatchEvent(new Event('change',{bubbles:true}));
    return true;
  })()`

const scrollToRefJs = (path: string): string =>
  `(() => { const el = ${resolveJs(path)}; if (!el) return false; el.scrollIntoView({block:'center',inline:'center'}); return true; })()`

const scrollByJs = (dx: number, dy: number): string =>
  `(() => { window.scrollBy(${dx}, ${dy}); return true; })()`

const rectJs = (path: string): string =>
  `(() => { const el = ${resolveJs(path)}; if (!el) return null; const r = el.getBoundingClientRect(); return { x: r.x + r.width/2, y: r.y + r.height/2 }; })()`

interface Pt {
  readonly x: number
  readonly y: number
}

type EvalFn = (
  s: SessionState,
  expr: string,
  signal?: AbortSignal,
) => Promise<Result<unknown, BrowserError>>

const scrollDelta = (opts: ScrollOpts): [number, number] => {
  const amt = opts.amount ?? 400
  switch (opts.direction) {
    case "up":
      return [0, -amt]
    case "left":
      return [-amt, 0]
    case "right":
      return [amt, 0]
    default:
      return [0, amt]
  }
}

/** Resolve a ref, run the per-element JS, and normalize the `false`/not-found
 *  result — the shared shape for click/fill/select/scroll-to-ref. */
const evalAction = async (
  s: SessionState,
  ref: string,
  buildJs: (path: string) => string,
  signal: AbortSignal | undefined,
  evalFn: EvalFn,
): Promise<Result<void, BrowserError>> => {
  const path = s.refMap.resolve(ref)
  if (path === null) return err({ kind: "element-not-found", ref })
  const r = await evalFn(s, buildJs(path), signal)
  if (!r.ok) return r
  if (r.value === false) return err({ kind: "element-not-found", ref })
  return ok(undefined)
}

/** Resolve a ref to its element-center viewport point (for drag endpoints). */
const refPoint = async (
  s: SessionState,
  ref: string,
  signal: AbortSignal | undefined,
  evalFn: EvalFn,
): Promise<Result<Pt, BrowserError>> => {
  const path = s.refMap.resolve(ref)
  if (path === null) return err({ kind: "element-not-found", ref })
  const r = await evalFn(s, rectJs(path), signal)
  if (!r.ok) return r
  const pt = r.value as { x?: unknown; y?: unknown } | null
  if (pt === null || typeof pt.x !== "number" || typeof pt.y !== "number") {
    return err({ kind: "element-not-found", ref })
  }
  return ok({ x: pt.x, y: pt.y })
}

const mouseClick = async (
  session: CdpSession,
  x: number,
  y: number,
  signal: AbortSignal | undefined,
): Promise<Result<void, BrowserError>> => {
  const opts = signal ? { signal } : undefined
  const base = { x, y, button: "left", clickCount: 1 }
  const down = await session.request(
    "Input.dispatchMouseEvent",
    { ...base, type: "mousePressed" },
    opts,
  )
  if (!down.ok) return down
  const up = await session.request(
    "Input.dispatchMouseEvent",
    { ...base, type: "mouseReleased" },
    opts,
  )
  return up.ok ? ok(undefined) : up
}

const mouseDrag = async (
  session: CdpSession,
  from: Pt,
  to: Pt,
  signal: AbortSignal | undefined,
): Promise<Result<void, BrowserError>> => {
  const opts = signal ? { signal } : undefined
  const press = await session.request(
    "Input.dispatchMouseEvent",
    { type: "mousePressed", x: from.x, y: from.y, button: "left", clickCount: 1 },
    opts,
  )
  if (!press.ok) return press
  const move = await session.request(
    "Input.dispatchMouseEvent",
    { type: "mouseMoved", x: to.x, y: to.y, button: "left" },
    opts,
  )
  if (!move.ok) return move
  const release = await session.request(
    "Input.dispatchMouseEvent",
    { type: "mouseReleased", x: to.x, y: to.y, button: "left", clickCount: 1 },
    opts,
  )
  return release.ok ? ok(undefined) : release
}

export const resolveChromeBinary = (
  deps: Pick<CdpBrowserDeps, "spawner" | "fs" | "chromeCandidates" | "macPaths">,
): string | null => {
  for (const cmd of deps.chromeCandidates ?? DEFAULT_CHROME_CANDIDATES) {
    const found = deps.spawner.which(cmd)
    if (found !== null) return found
  }
  for (const p of deps.macPaths ?? DEFAULT_MAC_CHROME_PATHS) {
    if (deps.fs.existsSync(p)) return p
  }
  return null
}

/** Connect the transport + enable the Page domain. A failed bring-up (chrome
 *  died right after the ws opened) surfaces as `spawn-failed` now rather than a
 *  confusing closed/timeout on first use (R1 audit [4]). */
const connectAndEnable = async (
  deps: CdpBrowserDeps,
  wsUrl: string,
  signal: AbortSignal | undefined,
): Promise<Result<CdpSession, BrowserError>> => {
  const conn = await deps.transport.connect(wsUrl, signal)
  if (!conn.ok) return err({ kind: "spawn-failed", detail: conn.error.detail })
  const session = createCdpSession({ conn: conn.value, scheduler: deps.scheduler })
  const opts = signal ? { signal } : undefined
  // R2 audit [3]: thread the abort signal into the bring-up request too — a turn
  // aborted during a hung Page.enable must cancel promptly, not wait the timeout.
  const enabled = await session.request("Page.enable", undefined, opts)
  if (!enabled.ok) {
    session.dispose()
    return err({ kind: "spawn-failed", detail: "Page.enable failed during bring-up" })
  }
  // R2 audit [8]: deny downloads at the source — a page must not be able to write
  // files outside the temp profile (defense-in-depth; download-to-jail is Phase 2).
  await session.request("Page.setDownloadBehavior", { behavior: "deny" }, opts)
  return ok(session)
}

export const createCdpBrowser = (deps: CdpBrowserDeps): BrowserPort => {
  const sessions = new Map<string, SessionState>()
  let seq = 0

  const live = (h: BrowserHandle): Result<SessionState, BrowserError> => {
    const s = sessions.get(h.id)
    if (s === undefined || s.closed) return err({ kind: "closed" })
    return ok(s)
  }

  const evalValue = async (
    s: SessionState,
    expression: string,
    signal?: AbortSignal,
  ): Promise<Result<unknown, BrowserError>> => {
    const r = await s.session.request(
      "Runtime.evaluate",
      { expression, returnByValue: true },
      signal ? { signal } : undefined,
    )
    if (!r.ok) return r
    const res = r.value as {
      result?: { value?: unknown }
      exceptionDetails?: { text?: unknown }
    }
    if (res?.exceptionDetails !== undefined) {
      const detail =
        typeof res.exceptionDetails.text === "string" ? res.exceptionDetails.text : "evaluate threw"
      return err({ kind: "cdp-error", detail })
    }
    return ok(res?.result?.value)
  }

  return {
    availability: () => (resolveChromeBinary(deps) !== null ? "chromium" : null),

    async spawn(opts?: BrowserStartOpts): Promise<Result<BrowserHandle, BrowserError>> {
      const bin = resolveChromeBinary(deps)
      if (bin === null) return err({ kind: "backend-missing" })
      seq += 1
      const id = `cdp-${seq}`
      const profileDir = `${deps.profileRoot}/${id}`
      deps.fs.mkdirp(profileDir)
      const proc = deps.spawner.spawn([
        bin,
        "--headless=new",
        "--remote-debugging-port=0",
        `--user-data-dir=${profileDir}`,
        "--no-first-run",
        "--disable-gpu",
        "--no-default-browser-check",
      ])
      // Single cleanup path: ANY error/throw between spawn and a registered
      // session must kill the proc + remove the temp profile (R1 audit [19]).
      const teardown = (): void => {
        proc.kill()
        deps.fs.rmrf(profileDir)
      }
      try {
        const endpoint = await readDevToolsEndpoint({
          read: () => deps.fs.readFile(`${profileDir}/DevToolsActivePort`),
          scheduler: deps.scheduler,
          clock: deps.clock,
          ...(opts?.signal ? { signal: opts.signal } : {}),
          ...(deps.endpointTimeoutMs !== undefined ? { timeoutMs: deps.endpointTimeoutMs } : {}),
        })
        if (!endpoint.ok) {
          teardown()
          return endpoint
        }
        const session = await connectAndEnable(deps, endpoint.value, opts?.signal)
        if (!session.ok) {
          teardown()
          return session
        }
        sessions.set(id, {
          closed: false,
          url: "about:blank",
          proc,
          session: session.value,
          profileDir,
          refMap: createRefMap(),
        })
        return ok({ id, backend: "chromium" })
      } catch (e) {
        teardown()
        return err({ kind: "spawn-failed", detail: e instanceof Error ? e.message : String(e) })
      }
    },

    async navigate(
      h: BrowserHandle,
      url: string,
      signal?: AbortSignal,
    ): Promise<Result<{ readonly title: string }, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      const opts = signal ? { signal } : undefined
      // R2 audit [5]: subscribe to the load event BEFORE issuing Page.navigate.
      // If we subscribed after, a fast load could fire the event between the
      // navigate reply and the waiter registration, hanging to the timeout.
      const loadedP = s.value.session.waitForEvent("Page.loadEventFired", opts)
      const nav = await s.value.session.request("Page.navigate", { url }, opts)
      if (!nav.ok) return nav
      const loaded = await loadedP
      if (!loaded.ok) return loaded
      s.value.url = url
      const title = await evalValue(s.value, "document.title", signal)
      return ok({ title: title.ok && typeof title.value === "string" ? title.value : "" })
    },

    async snapshot(h: BrowserHandle): Promise<Result<PageSnapshot, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      const raw = await evalValue(s.value, COLLECT_SCRIPT)
      if (!raw.ok) return raw
      const model = parseDomModel(raw.value)
      if (!model.ok) {
        return err({ kind: "cdp-error", detail: "snapshot collection returned a malformed model" })
      }
      const yaml = buildSnapshot(model.value, s.value.refMap)
      return ok({ yaml, url: s.value.url, title: model.value.title })
    },

    async click(
      h: BrowserHandle,
      ref: string,
      signal?: AbortSignal,
    ): Promise<Result<void, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      const path = s.value.refMap.resolve(ref)
      if (path === null) return err({ kind: "element-not-found", ref })
      const r = await evalValue(s.value, clickJs(path), signal)
      if (!r.ok) return r
      if (r.value === false) return err({ kind: "element-not-found", ref })
      return ok(undefined)
    },

    async type(
      h: BrowserHandle,
      ref: string,
      text: string,
      opts?: TypeOpts,
    ): Promise<Result<void, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      const path = s.value.refMap.resolve(ref)
      if (path === null) return err({ kind: "element-not-found", ref })
      const r = await evalValue(s.value, typeJs(path, text, opts?.clear === true), opts?.signal)
      if (!r.ok) return r
      if (r.value === false) return err({ kind: "element-not-found", ref })
      return ok(undefined)
    },

    async fill(h: BrowserHandle, ref: string, value: string, signal?: AbortSignal) {
      const s = live(h)
      if (!s.ok) return s
      return evalAction(s.value, ref, (p) => fillJs(p, value), signal, evalValue)
    },

    async selectOption(
      h: BrowserHandle,
      ref: string,
      values: readonly string[],
      signal?: AbortSignal,
    ) {
      const s = live(h)
      if (!s.ok) return s
      return evalAction(s.value, ref, (p) => selectJs(p, values), signal, evalValue)
    },

    async scroll(h: BrowserHandle, opts: ScrollOpts, signal?: AbortSignal) {
      const s = live(h)
      if (!s.ok) return s
      if (opts.ref !== undefined) {
        return evalAction(s.value, opts.ref, scrollToRefJs, signal, evalValue)
      }
      const [dx, dy] = scrollDelta(opts)
      const r = await evalValue(s.value, scrollByJs(dx, dy), signal)
      return r.ok ? ok(undefined) : r
    },

    async pressKey(h: BrowserHandle, key: string, signal?: AbortSignal) {
      const s = live(h)
      if (!s.ok) return s
      const opts = signal ? { signal } : undefined
      const down = await s.value.session.request(
        "Input.dispatchKeyEvent",
        { type: "keyDown", key },
        opts,
      )
      if (!down.ok) return down
      const up = await s.value.session.request(
        "Input.dispatchKeyEvent",
        { type: "keyUp", key },
        opts,
      )
      return up.ok ? ok(undefined) : up
    },

    async drag(h: BrowserHandle, sourceRef: string, target: DragTarget, signal?: AbortSignal) {
      const s = live(h)
      if (!s.ok) return s
      const from = await refPoint(s.value, sourceRef, signal, evalValue)
      if (!from.ok) return from
      const to =
        "ref" in target
          ? await refPoint(s.value, target.ref, signal, evalValue)
          : ok({ x: target.x, y: target.y })
      if (!to.ok) return to
      return mouseDrag(s.value.session, from.value, to.value, signal)
    },

    async mouseClickXY(h: BrowserHandle, x: number, y: number, signal?: AbortSignal) {
      const s = live(h)
      if (!s.ok) return s
      return mouseClick(s.value.session, x, y, signal)
    },

    async screenshot(h: BrowserHandle): Promise<Result<Uint8Array, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      const r = await s.value.session.request("Page.captureScreenshot", {})
      if (!r.ok) return r
      const data = (r.value as { data?: unknown })?.data
      if (typeof data !== "string") return err({ kind: "cdp-error", detail: "no screenshot data" })
      // atob throws on non-base64 input; the slice contract is no-throw (R1 audit [7]).
      try {
        return ok(Uint8Array.from(atob(data), (c) => c.charCodeAt(0)))
      } catch {
        return err({ kind: "cdp-error", detail: "malformed base64 screenshot data" })
      }
    },

    async cdp(
      h: BrowserHandle,
      method: string,
      params?: Readonly<Record<string, unknown>>,
    ): Promise<Result<unknown, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      if (!isCdpMethodAllowed(method)) return err({ kind: "cdp-method-denied", method })
      return s.value.session.request(method, params)
    },

    async close(h: BrowserHandle): Promise<Result<void, BrowserError>> {
      const s = sessions.get(h.id)
      if (s === undefined || s.closed) return ok(undefined)
      s.closed = true
      s.session.dispose()
      s.proc.kill()
      deps.fs.rmrf(s.profileDir)
      return ok(undefined)
    },
  }
}
