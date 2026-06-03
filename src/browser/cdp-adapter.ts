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

import { err, errMessage, ok, type Result } from "@/shared"
import { type CdpSession, createCdpSession } from "./cdp/cdp-session"
import { COLLECT_SCRIPT, parseDomModel } from "./cdp/collect"
import {
  type ConsoleBuffer,
  consoleArgsToText,
  createConsoleBuffer,
  mapConsoleApiType,
  mapLogEntryLevel,
} from "./cdp/console-buffer"
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
  ConsoleEntry,
  ConsoleOpts,
  DragTarget,
  PageSnapshot,
  ReadOpts,
  ScrollOpts,
  TypeOpts,
  WaitOpts,
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
  readonly console: ConsoleBuffer
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
  `(() => { const el = ${resolveJs(path)}; if (!el) return false; if (el.focus) el.focus(); el.click(); return true; })()`

// Branches on element kind (R1 audit [10]): form controls get `.value` set +
// change event; contenteditable gets text appended into the node; anything else
// returns false so the tool surfaces element-not-found instead of silently
// writing a junk `value` property.
const typeJs = (path: string, text: string, clear: boolean): string =>
  `(() => {
    const el = ${resolveJs(path)};
    if (!el) return false;
    const t = ${JSON.stringify(text)};
    if (el.focus) el.focus();
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
    if (el.focus) el.focus();
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

// Read a precise property off the resolved element. Returns a tagged object so
// the adapter can distinguish "element missing" (null) from a falsy-but-present
// value (e.g. visible:false, empty text). text uses innerText (rendered text);
// attribute returns "" when the attr is absent; visible folds offsetParent +
// computed-style + a non-zero rect.
const readJs = (path: string, what: string, attr: string | undefined): string => {
  const a = JSON.stringify(attr ?? "")
  const w = JSON.stringify(what)
  return `(() => {
    const el = ${resolveJs(path)};
    if (!el) return null;
    const what = ${w};
    if (what === 'text') return { value: (el.innerText !== undefined ? el.innerText : el.textContent) || '' };
    if (what === 'attribute') { const v = el.getAttribute(${a}); return { value: v === null ? '' : v }; }
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const vis = !!(el.offsetParent || (cs.position === 'fixed' && cs.display !== 'none')) && cs.visibility !== 'hidden' && cs.display !== 'none' && (r.width > 0 || r.height > 0);
    return { value: vis };
  })()`
}

const selectorPresentJs = (selector: string): string =>
  `(() => { try { return !!document.querySelector(${JSON.stringify(selector)}); } catch { return false; } })()`

/** Sleep `ms` on the injected scheduler, racing an optional abort and cancelling
 *  the timer on settle (same deterministic pattern as readDevToolsEndpoint). */
const sleep = (scheduler: Scheduler, ms: number, signal: AbortSignal | undefined): Promise<void> =>
  new Promise<void>((resolve) => {
    const cancel = scheduler.schedule(ms, () => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    })
    const onAbort = (): void => {
      cancel()
      resolve()
    }
    signal?.addEventListener("abort", onAbort, { once: true })
  })

interface PollDeps {
  eval(expr: string, signal?: AbortSignal): Promise<Result<unknown, BrowserError>>
  readonly scheduler: Scheduler
  readonly clock: Clock
}

/** Default `waitForSelector` deadline when the caller omits `opts.timeoutMs`.
 *  5s matches the CDP/Puppeteer convention for a single selector wait. */
const DEFAULT_WAIT_SELECTOR_MS = 5_000

/** Poll the page for `opts.selector` until present, timeout, or abort. Kept at
 *  module scope (out of the adapter object) so the loop's branching does not
 *  inflate the adapter method's cognitive complexity. */
const pollForSelector = async (
  d: PollDeps,
  opts: WaitOpts,
  signal: AbortSignal | undefined,
): Promise<Result<void, BrowserError>> => {
  const isAborted = (): boolean => signal?.aborted === true
  if (isAborted()) return err({ kind: "cancelled" })
  const timeoutMs = opts.timeoutMs ?? DEFAULT_WAIT_SELECTOR_MS
  const pollMs = 100
  const start = d.clock.now()
  const js = selectorPresentJs(opts.selector)
  for (;;) {
    if (isAborted()) return err({ kind: "cancelled" })
    const r = await d.eval(js, signal)
    if (!r.ok) return r
    if (r.value === true) return ok(undefined)
    if (d.clock.now() - start >= timeoutMs) return err({ kind: "timeout", ms: timeoutMs })
    await sleep(d.scheduler, pollMs, signal)
  }
}

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

// Named-key descriptors. Real Blink needs windowsVirtualKeyCode + code (and a
// `text` for text-generating keys) to drive implicit form submit / default
// actions — `{key}` alone delivers an inert event (real-chrome e2e bug).
const KEY_DESCRIPTORS: Record<string, { code: string; vk: number; text?: string }> = {
  Enter: { code: "Enter", vk: 13, text: "\r" },
  Tab: { code: "Tab", vk: 9 },
  Escape: { code: "Escape", vk: 27 },
  Backspace: { code: "Backspace", vk: 8 },
  Delete: { code: "Delete", vk: 46 },
  ArrowUp: { code: "ArrowUp", vk: 38 },
  ArrowDown: { code: "ArrowDown", vk: 40 },
  ArrowLeft: { code: "ArrowLeft", vk: 37 },
  ArrowRight: { code: "ArrowRight", vk: 39 },
  Home: { code: "Home", vk: 36 },
  End: { code: "End", vk: 35 },
  PageUp: { code: "PageUp", vk: 33 },
  PageDown: { code: "PageDown", vk: 34 },
  Space: { code: "Space", vk: 32, text: " " },
}

/** Build the Input.dispatchKeyEvent params for a key — full virtual-key fields
 *  for named keys, a printable `text` for single characters. */
const keyEventBase = (key: string): Record<string, unknown> => {
  const named = KEY_DESCRIPTORS[key]
  if (named !== undefined) {
    return {
      key,
      code: named.code,
      windowsVirtualKeyCode: named.vk,
      nativeVirtualKeyCode: named.vk,
      ...(named.text !== undefined ? { text: named.text } : {}),
    }
  }
  if (key.length === 1) {
    // Only letters/digits have a derivable KeyboardEvent.code; for symbols a
    // synthetic `Key<symbol>` is wrong — omit it and let the browser derive
    // (R3 audit [6]).
    const code = /[a-z]/i.test(key)
      ? `Key${key.toUpperCase()}`
      : /[0-9]/.test(key)
        ? `Digit${key}`
        : undefined
    return code !== undefined ? { key, text: key, code } : { key, text: key }
  }
  return { key }
}

// Globally-unique profile-dir suffix (R4 audit [8]) — independent of the
// per-instance seq so concurrent adapters sharing a profileRoot never collide.
const uniqueNonce = (): string => `${process.pid}-${crypto.randomUUID().slice(0, 8)}`

// Best-effort kill — Bun's Subprocess.kill() can throw (ESRCH/EPERM-style proc
// states); a throw must NOT skip the profile rmrf that follows (R3 audit [3]).
const killQuietly = (proc: SpawnedProcess): void => {
  try {
    proc.kill()
  } catch {
    // proc already gone / unkillable — the profile cleanup still runs
  }
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
interface BringUp {
  readonly session: CdpSession
  readonly console: ConsoleBuffer
}

// Subscribe the persistent console/error/log streams into the ring buffer, plus
// the dialog auto-dismiss. Called once after the page session is attached +
// Page.enable succeeds. Runtime.enable / Log.enable are best-effort: a console
// capture failure must NOT fail the whole bring-up (the page still drives), so
// these errors are swallowed — the buffer simply stays empty.
const installPageObservers = async (
  session: CdpSession,
  buffer: ConsoleBuffer,
  opts: { signal?: AbortSignal } | undefined,
): Promise<void> => {
  // consoleAPICalled.type → level; args flattened to text.
  session.onEvent("Runtime.consoleAPICalled", (p) => {
    const entry: ConsoleEntry = {
      level: mapConsoleApiType(p.type),
      text: consoleArgsToText(p.args),
      ...(typeof p.timestamp === "number" ? { ts: p.timestamp } : {}),
    }
    buffer.push(entry)
  })
  // exceptionThrown → level "error", text from exceptionDetails.text.
  session.onEvent("Runtime.exceptionThrown", (p) => {
    const d = p.exceptionDetails as
      | { text?: unknown; exception?: { description?: unknown } }
      | undefined
    const text =
      typeof d?.exception?.description === "string"
        ? d.exception.description
        : typeof d?.text === "string"
          ? d.text
          : "uncaught exception"
    buffer.push({
      level: "error",
      text,
      ...(typeof p.timestamp === "number" ? { ts: p.timestamp } : {}),
    })
  })
  // Log.entryAdded → its own level + text.
  session.onEvent("Log.entryAdded", (p) => {
    const e = p.entry as { level?: unknown; text?: unknown; timestamp?: unknown } | undefined
    buffer.push({
      level: mapLogEntryLevel(e?.level),
      text: typeof e?.text === "string" ? e.text : "",
      ...(typeof e?.timestamp === "number" ? { ts: e.timestamp } : {}),
    })
  })
  // SAFETY: a page alert()/confirm()/prompt() fires javascriptDialogOpening and
  // BLOCKS the renderer (and thus every CDP request) until handled. Auto-DISMISS
  // (accept:false) so a page can never wedge the automation. A future
  // accept-policy is out of scope — default-dismiss is the safe posture.
  session.onEvent("Page.javascriptDialogOpening", () => {
    void session.request("Page.handleJavaScriptDialog", { accept: false })
  })
  await session.request("Runtime.enable", undefined, opts)
  await session.request("Log.enable", undefined, opts)
}

const connectAndEnable = async (
  deps: CdpBrowserDeps,
  wsUrl: string,
  signal: AbortSignal | undefined,
): Promise<Result<BringUp, BrowserError>> => {
  const conn = await deps.transport.connect(wsUrl, signal)
  if (!conn.ok) return err({ kind: "spawn-failed", detail: conn.error.detail })
  const session = createCdpSession({ conn: conn.value, scheduler: deps.scheduler })
  const opts = signal ? { signal } : undefined
  // DevToolsActivePort gives the BROWSER-level endpoint, where Page.*/Runtime.*
  // do not exist. Create + attach a page target (flat protocol) and route all
  // subsequent page calls through its sessionId (real-chrome e2e bug fix). The
  // Target.* calls below are browser-level — made BEFORE useSessionId.
  const created = await session.request("Target.createTarget", { url: "about:blank" }, opts)
  if (!created.ok) {
    session.dispose()
    return err({ kind: "spawn-failed", detail: "Target.createTarget failed during bring-up" })
  }
  const targetId = (created.value as { targetId?: unknown }).targetId
  if (typeof targetId !== "string") {
    session.dispose()
    return err({ kind: "spawn-failed", detail: "Target.createTarget returned no targetId" })
  }
  const attached = await session.request("Target.attachToTarget", { targetId, flatten: true }, opts)
  if (!attached.ok) {
    session.dispose()
    return err({ kind: "spawn-failed", detail: "Target.attachToTarget failed during bring-up" })
  }
  const sessionId = (attached.value as { sessionId?: unknown }).sessionId
  if (typeof sessionId !== "string") {
    session.dispose()
    return err({ kind: "spawn-failed", detail: "Target.attachToTarget returned no sessionId" })
  }
  session.useSessionId(sessionId)
  // R2 audit [3]: thread the abort signal into the bring-up request too — a turn
  // aborted during a hung Page.enable must cancel promptly, not wait the timeout.
  const enabled = await session.request("Page.enable", undefined, opts)
  if (!enabled.ok) {
    session.dispose()
    return err({ kind: "spawn-failed", detail: "Page.enable failed during bring-up" })
  }
  // R2 audit [8]: deny downloads at the source — a page must not be able to write
  // files outside the temp profile (defense-in-depth; download-to-jail is Phase 2).
  // R3 audit [3]: a failed deny would leave downloads ENABLED — fail bring-up
  // rather than silently proceed with an unguarded download surface.
  const dl = await session.request("Page.setDownloadBehavior", { behavior: "deny" }, opts)
  if (!dl.ok) {
    session.dispose()
    return err({
      kind: "spawn-failed",
      detail: "Page.setDownloadBehavior(deny) failed during bring-up",
    })
  }
  // After the page session is live: subscribe console/error/log capture +
  // dialog auto-dismiss, and enable the producing domains. Non-fatal — a console
  // capture failure leaves the buffer empty but the page still drives.
  const consoleBuffer = createConsoleBuffer()
  await installPageObservers(session, consoleBuffer, opts)
  return ok({ session, console: consoleBuffer })
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

    isLive: (h: BrowserHandle): boolean => {
      const s = sessions.get(h.id)
      return s !== undefined && !s.closed
    },

    async spawn(opts?: BrowserStartOpts): Promise<Result<BrowserHandle, BrowserError>> {
      const bin = resolveChromeBinary(deps)
      if (bin === null) return err({ kind: "backend-missing" })
      seq += 1
      // R4 audit [8]: a per-instance seq alone collides across adapter instances
      // sharing a profileRoot (two sessions, same cwd → both "cdp-1"). A
      // process+random nonce makes the --user-data-dir globally unique.
      const id = `cdp-${seq}-${uniqueNonce()}`
      const profileDir = `${deps.profileRoot}/${id}`
      // R4 audit [6]: proc may never be created if spawner.spawn() throws
      // (EMFILE/EACCES); keep it nullable so teardown still rmrf's the mkdir'd dir.
      let proc: SpawnedProcess | null = null
      const teardown = (): void => {
        if (proc !== null) killQuietly(proc)
        deps.fs.rmrf(profileDir)
      }
      try {
        deps.fs.mkdirp(profileDir)
        proc = deps.spawner.spawn([
          bin,
          "--headless=new",
          "--remote-debugging-port=0",
          `--user-data-dir=${profileDir}`,
          "--no-first-run",
          "--disable-gpu",
          "--no-default-browser-check",
        ])
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
        const brought = await connectAndEnable(deps, endpoint.value, opts?.signal)
        if (!brought.ok) {
          teardown()
          return brought
        }
        const session = brought.value.session
        const state: SessionState = {
          closed: false,
          url: "about:blank",
          proc,
          session,
          profileDir,
          refMap: createRefMap(),
          console: brought.value.console,
        }
        sessions.set(id, state)
        // R3 audit [1][7]: observe BOTH death modes → mark the SessionState closed
        // so live()/isLive() report it and the holder re-spawns instead of
        // wedging on a dead session. onDead = CDP-event/socket death; proc.exited
        // = process death (crash/OOM/external kill).
        session.onDead(() => {
          state.closed = true
          // RESOURCE_LEAK fix: reap the dead session so the Map cannot grow
          // unbounded across browse→close cycles. live()/isLive() already treat
          // a missing entry as closed, so dropping it is observationally equal to
          // the previously-retained closed entry.
          sessions.delete(id)
        })
        void proc.exited.then(() => {
          if (!state.closed) {
            state.closed = true
            session.dispose()
          }
          sessions.delete(id)
        })
        return ok({ id, backend: "chromium" })
      } catch (e) {
        teardown()
        return err({ kind: "spawn-failed", detail: errMessage(e) })
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
      // The old document is committed-gone the instant navigation is accepted,
      // so every pre-navigation ref is now stale: drop them ALL. A click/fill
      // issued with a ref from the previous page fails closed (element-not-found)
      // until a fresh snapshot mints refs against the new DOM — even if the load
      // event below times out. (Structural fix: refs are bound to the snapshot
      // that minted them, not to prose telling the model to re-snapshot.)
      s.value.refMap.invalidate()
      const loaded = await loadedP
      if (!loaded.ok) return loaded
      s.value.url = url
      const title = await evalValue(s.value, "document.title", signal)
      return ok({ title: title.ok && typeof title.value === "string" ? title.value : "" })
    },

    async snapshot(
      h: BrowserHandle,
      _opts?: unknown,
      signal?: AbortSignal,
    ): Promise<Result<PageSnapshot, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      const raw = await evalValue(s.value, COLLECT_SCRIPT, signal)
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
      const base = keyEventBase(key)
      const down = await s.value.session.request(
        "Input.dispatchKeyEvent",
        { ...base, type: "keyDown" },
        opts,
      )
      if (!down.ok) return down
      const up = await s.value.session.request(
        "Input.dispatchKeyEvent",
        { ...base, type: "keyUp" },
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

    async screenshot(
      h: BrowserHandle,
      signal?: AbortSignal,
    ): Promise<Result<Uint8Array, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      const r = await s.value.session.request(
        "Page.captureScreenshot",
        {},
        signal ? { signal } : undefined,
      )
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

    async consoleMessages(h: BrowserHandle, opts?: ConsoleOpts) {
      const s = live(h)
      if (!s.ok) return s
      const { entries, dropped } = s.value.console.drain(opts?.clear === true)
      return ok({ entries, dropped })
    },

    async wait(h: BrowserHandle, opts: WaitOpts, signal?: AbortSignal) {
      const s = live(h)
      if (!s.ok) return s
      return pollForSelector(
        {
          eval: (expr, sig) => evalValue(s.value, expr, sig),
          scheduler: deps.scheduler,
          clock: deps.clock,
        },
        opts,
        signal,
      )
    },

    async read(h: BrowserHandle, ref: string, opts: ReadOpts, signal?: AbortSignal) {
      const s = live(h)
      if (!s.ok) return s
      const path = s.value.refMap.resolve(ref)
      if (path === null) return err({ kind: "element-not-found", ref })
      const r = await evalValue(s.value, readJs(path, opts.what, opts.attr), signal)
      if (!r.ok) return r
      const wrapped = r.value as { value?: unknown } | null
      if (wrapped === null) return err({ kind: "element-not-found", ref })
      const v = wrapped.value
      if (typeof v === "string" || typeof v === "boolean") return ok({ value: v })
      return err({ kind: "cdp-error", detail: "read returned a non-primitive value" })
    },

    async cdp(
      h: BrowserHandle,
      method: string,
      params?: Readonly<Record<string, unknown>>,
      signal?: AbortSignal,
    ): Promise<Result<unknown, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      if (!isCdpMethodAllowed(method)) return err({ kind: "cdp-method-denied", method })
      return s.value.session.request(method, params, signal ? { signal } : undefined)
    },

    async close(h: BrowserHandle): Promise<Result<void, BrowserError>> {
      const s = sessions.get(h.id)
      if (s === undefined) return ok(undefined)
      // RESOURCE_LEAK fix: even if a death mode (onDead / proc.exited) already
      // flipped s.closed, the Map entry was never reaped — repeated browse→close
      // cycles grew it unbounded, pinning the CdpConnection wiring + console
      // buffer + proc handle per session. Drop the entry on EVERY terminal path.
      if (!s.closed) {
        s.closed = true
        s.session.dispose()
        killQuietly(s.proc)
        deps.fs.rmrf(s.profileDir)
      }
      sessions.delete(h.id)
      return ok(undefined)
    },
  }
}
