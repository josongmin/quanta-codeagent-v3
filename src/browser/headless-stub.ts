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
 *
 * Method bodies live in `./headless-stub/methods` (each takes the shared
 * closure state by reference via {@link StubDeps}); this factory is the thin
 * delegating shell.
 */

import { err, ok, type Result } from "@/shared"
import type { SessionState, StubDeps } from "./headless-stub/methods"
import * as m from "./headless-stub/methods"
import type { BrowserPort } from "./port"
import type { BrowserError, BrowserHandle, ConsoleEntry, NetworkEntry } from "./types"

export type { HeadlessPage } from "./headless-stub/methods"

export interface HeadlessBrowserOpts {
  /** `url → page` fixtures. A navigate to an unknown url returns
   *  `Err{ navigation-denied }`. */
  readonly pages?: ReadonlyMap<string, import("./headless-stub/methods").HeadlessPage>
  /** Seed the console buffer the deterministic `consoleMessages` returns. */
  readonly consoleEntries?: readonly ConsoleEntry[]
  /** Already-dropped count the stub reports (to exercise the truncation path). */
  readonly consoleDropped?: number
  /** Seed the network buffer the deterministic `networkMessages` returns. */
  readonly networkEntries?: readonly NetworkEntry[]
  /** Already-dropped network count the stub reports (truncation path). */
  readonly networkDropped?: number
  /** Selectors `wait` resolves `ok` for; any other selector ⇒ `timeout`. */
  readonly presentSelectors?: ReadonlySet<string>
}

export const createHeadlessBrowser = (opts: HeadlessBrowserOpts = {}): BrowserPort => {
  const sessions = new Map<string, SessionState>()
  const live = (h: BrowserHandle): Result<SessionState, BrowserError> => {
    const s = sessions.get(h.id)
    if (s === undefined || s.closed) return err({ kind: "closed" })
    return ok(s)
  }
  const d: StubDeps = {
    pages: opts.pages ?? new Map(),
    presentSelectors: opts.presentSelectors ?? new Set<string>(),
    sessions,
    seq: { n: 0 },
    consoleEntries: opts.consoleEntries,
    consoleDropped: opts.consoleDropped,
    networkEntries: opts.networkEntries,
    networkDropped: opts.networkDropped,
    live,
  }

  return {
    availability: () => "headless",
    isLive: (h) => m.isLive(d, h),
    spawn: (o) => m.spawn(d, o),
    navigate: (h, url, signal) => m.navigate(d, h, url, signal),
    snapshot: (h) => m.snapshot(d, h),
    click: (h, ref, signal) => m.click(d, h, ref, signal),
    getBoundingBox: (h, ref) => m.getBoundingBox(d, h, ref),
    highlight: (h, ref, o) => m.highlight(d, h, ref, o),
    type: (h, ref, text, o) => m.type_(d, h, ref, text, o),
    fill: (h, ref) => m.fill(d, h, ref),
    selectOption: (h, ref) => m.selectOption(d, h, ref),
    scroll: (h, o) => m.scroll(d, h, o),
    pressKey: (h) => m.pressKey(d, h),
    drag: (h, sourceRef, target) => m.drag(d, h, sourceRef, target),
    mouseClickXY: (h) => m.mouseClickXY(d, h),
    screenshot: (h) => m.screenshot(d, h),
    consoleMessages: (h, o) => m.consoleMessages(d, h, o),
    networkMessages: (h, o) => m.networkMessages(d, h, o),
    wait: (h, o, signal) => m.wait(d, h, o, signal),
    read: (h, ref, o) => m.read(d, h, ref, o),
    newTab: (h, url) => m.newTab(d, h, url),
    switchTab: (h, idOrIndex) => m.switchTab(d, h, idOrIndex),
    closeTab: (h, idOrIndex) => m.closeTab(d, h, idOrIndex),
    listTabs: (h) => m.listTabs(d, h),
    cdp: (h, method) => m.cdp(d, h, method),
    close: (h) => m.close(d, h),
  }
}
