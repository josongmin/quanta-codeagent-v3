/**
 * CDP adapter — multi-tab (TICKET-24 Wave B).
 *
 * One CdpSession multiplexes every tab: `Target.*` calls are BROWSER-level
 * (`sessionId: null`) and page calls route to the active tab via `useSessionId`.
 * Each tab owns its refMap, so a ref minted on tab A fails closed while tab B
 * is active.
 */

import { err, ok, type Result } from "@/shared"
import type { BrowserPort } from "../port"
import { createRefMap } from "../snapshot"
import type { BrowserError, BrowserHandle, TabInfo } from "../types"
import { type CdpBrowserCtx, resolveTab, type TabState } from "./session-state"

/** Create + attach + harden a new tab. Hoisted out of the group object so
 *  `tabOps` stays a thin composition of members rather than a god-function. */
const newTabImpl = async (
  ctx: CdpBrowserCtx,
  h: BrowserHandle,
  url: string | undefined,
  signal: AbortSignal | undefined,
): Promise<Result<TabInfo, BrowserError>> => {
  const { live } = ctx
  const s = live(h)
  if (!s.ok) return s
  const sig = signal ? { signal } : {}
  const targetUrl = url ?? "about:blank"
  const created = await s.value.session.request(
    "Target.createTarget",
    { url: targetUrl },
    { sessionId: null, ...sig },
  )
  if (!created.ok) return created
  const targetId = (created.value as { targetId?: unknown }).targetId
  if (typeof targetId !== "string") {
    return err({ kind: "cdp-error", detail: "Target.createTarget returned no targetId" })
  }
  const attached = await s.value.session.request(
    "Target.attachToTarget",
    { targetId, flatten: true },
    { sessionId: null, ...sig },
  )
  if (!attached.ok) return attached
  const sessionId = (attached.value as { sessionId?: unknown }).sessionId
  if (typeof sessionId !== "string") {
    return err({ kind: "cdp-error", detail: "Target.attachToTarget returned no sessionId" })
  }
  await s.value.session.request("Page.enable", undefined, { sessionId, ...sig })
  // SECURITY parity with bring-up: deny downloads on EVERY tab. A failure must
  // not leave an unguarded download surface — tear the tab down + fail.
  const dl = await s.value.session.request(
    "Page.setDownloadBehavior",
    { behavior: "deny" },
    { sessionId, ...sig },
  )
  if (!dl.ok) {
    void s.value.session.request("Target.closeTarget", { targetId }, { sessionId: null })
    return err({
      kind: "cdp-error",
      detail: "Page.setDownloadBehavior(deny) failed for new tab",
    })
  }
  // Best-effort: enable console producers so the tab's logs flow once active.
  await s.value.session.request("Runtime.enable", undefined, { sessionId, ...sig })
  const tab: TabState = {
    targetId,
    sessionId,
    url: targetUrl,
    title: "",
    refMap: createRefMap(),
  }
  s.value.tabs.set(targetId, tab)
  // newTab does NOT auto-foreground — active stays put; the model switchTabs.
  return ok({ id: targetId, url: tab.url, title: tab.title, active: false })
}

export const tabOps = (
  ctx: CdpBrowserCtx,
): Pick<BrowserPort, "newTab" | "switchTab" | "closeTab" | "listTabs"> => {
  const { live } = ctx
  return {
    // ── TICKET-24 Wave B — multi-tab. The single CdpSession multiplexes: every
    //    Target.* call is BROWSER-LEVEL (sessionId:null), page calls route to the
    //    active tab (useSessionId). Each tab owns its refMap (ref isolation).
    async newTab(h: BrowserHandle, url?: string, signal?: AbortSignal) {
      return newTabImpl(ctx, h, url, signal)
    },

    async switchTab(
      h: BrowserHandle,
      idOrIndex: string,
      signal?: AbortSignal,
    ): Promise<Result<TabInfo, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      const tab = resolveTab(s.value, idOrIndex)
      if (tab === null) {
        return err({ kind: "tab-not-found", id: idOrIndex, open: [...s.value.tabs.keys()] })
      }
      // The CORRECTNESS-bearing mutation is useSessionId: it repoints every
      // subsequent page request at this tab, and activeTabId repoints ref
      // resolution at its OWN refMap (a prior-tab ref now fails closed). Both
      // happen here, unconditionally.
      s.value.activeTabId = tab.targetId
      s.value.session.useSessionId(tab.sessionId)
      // Target.activateTarget is COSMETIC (z-order foreground) — and a no-op
      // under --headless=new. Intentionally best-effort + result UNCHECKED: a
      // failure must NOT undo the routing switch above (which already succeeded),
      // so switchTab still reports success.
      await s.value.session.request(
        "Target.activateTarget",
        { targetId: tab.targetId },
        { sessionId: null, ...(signal ? { signal } : {}) },
      )
      return ok({ id: tab.targetId, url: tab.url, title: tab.title, active: true })
    },

    async closeTab(
      h: BrowserHandle,
      idOrIndex: string,
      signal?: AbortSignal,
    ): Promise<Result<void, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      const tab = resolveTab(s.value, idOrIndex)
      if (tab === null) {
        return err({ kind: "tab-not-found", id: idOrIndex, open: [...s.value.tabs.keys()] })
      }
      if (s.value.tabs.size === 1) {
        return err({
          kind: "cdp-error",
          detail: "cannot close the last tab — close the browser instead",
        })
      }
      const closed = await s.value.session.request(
        "Target.closeTarget",
        { targetId: tab.targetId },
        { sessionId: null, ...(signal ? { signal } : {}) },
      )
      if (!closed.ok) return closed
      s.value.tabs.delete(tab.targetId)
      // Closed the active tab ⇒ reassign active to a remaining tab + route to it.
      if (s.value.activeTabId === tab.targetId) {
        const next = s.value.tabs.values().next().value
        if (next !== undefined) {
          s.value.activeTabId = next.targetId
          s.value.session.useSessionId(next.sessionId)
        }
      }
      return ok(undefined)
    },

    async listTabs(
      h: BrowserHandle,
      signal?: AbortSignal,
    ): Promise<Result<readonly TabInfo[], BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      const out: TabInfo[] = []
      for (const tab of s.value.tabs.values()) {
        // Best-effort LIVE title per tab (routed to that tab's session). Falls
        // back to the stored title on any failure. Page-controlled string →
        // guarded at the tool layer before the model sees it.
        const t = await s.value.session.request(
          "Runtime.evaluate",
          { expression: "document.title", returnByValue: true },
          { sessionId: tab.sessionId, ...(signal ? { signal } : {}) },
        )
        const v = t.ok ? (t.value as { result?: { value?: unknown } }).result?.value : undefined
        const title = typeof v === "string" ? v : tab.title
        out.push({
          id: tab.targetId,
          url: tab.url,
          title,
          active: s.value.activeTabId === tab.targetId,
        })
      }
      return ok(out)
    },
  }
}
