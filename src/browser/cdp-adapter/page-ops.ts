/**
 * CDP adapter — page-level operations: navigate, snapshot, screenshot, the
 * console/network drains, selector wait, element read, and the raw `cdp()`
 * escape hatch.
 *
 * `cdp()` enforces the closed method allowlist; the internal evaluates and
 * `screenshot()` bypass it BY DESIGN — the allowlist gates the MODEL's surface,
 * not this implementation.
 */

import { err, ok, type Result } from "@/shared"
import { COLLECT_SCRIPT, parseDomModel } from "../cdp/collect"
import { isCdpMethodAllowed } from "../cdp-allowlist"
import type { BrowserPort } from "../port"
import { buildSnapshot } from "../snapshot"
import type {
  BrowserError,
  BrowserHandle,
  ConsoleOpts,
  NetworkOpts,
  PageSnapshot,
  ReadOpts,
  WaitOpts,
} from "../types"
import { pollForSelector } from "./element-ops"
import { readJs } from "./page-scripts"
import { activeTab, type CdpBrowserCtx } from "./session-state"

export const pageOps = (
  ctx: CdpBrowserCtx,
): Pick<
  BrowserPort,
  | "navigate"
  | "snapshot"
  | "screenshot"
  | "consoleMessages"
  | "networkMessages"
  | "wait"
  | "read"
  | "cdp"
> => {
  const { deps, live, evalValue } = ctx
  return {
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
      const tab = activeTab(s.value)
      tab.refMap.invalidate()
      const loaded = await loadedP
      if (!loaded.ok) return loaded
      tab.url = url
      const title = await evalValue(s.value, "document.title", signal)
      const titleText = title.ok && typeof title.value === "string" ? title.value : ""
      tab.title = titleText
      return ok({ title: titleText })
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
      const tab = activeTab(s.value)
      const yaml = buildSnapshot(model.value, tab.refMap)
      tab.title = model.value.title
      return ok({ yaml, url: tab.url, title: model.value.title })
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

    async networkMessages(h: BrowserHandle, opts?: NetworkOpts) {
      const s = live(h)
      if (!s.ok) return s
      const { entries, dropped } = s.value.network.drain(opts?.clear === true)
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
      const path = activeTab(s.value).refMap.resolve(ref)
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
  }
}
