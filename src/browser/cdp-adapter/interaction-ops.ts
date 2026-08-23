/**
 * CDP adapter — element interaction: click / box / highlight / type / fill /
 * select / scroll / key / drag / raw mouse.
 *
 * Every ref-taking method here resolves through the ACTIVE tab's refMap first
 * and fails closed (`element-not-found`) on a stale ref before it evaluates
 * anything — the invariant a navigation and a tab switch both rely on.
 */

import type { BrowserPort } from "../port"
import type { BoundingBox, BrowserError, BrowserHandle, DragTarget, HighlightOpts, ScrollOpts, TypeOpts } from "../types"
import { evalAction, refPoint, scrollDelta } from "./element-ops"
import { keyEventBase, mouseClick, mouseDrag } from "./input-events"
import { boxJs, clickJs, fillJs, highlightJs, scrollByJs, scrollToRefJs, selectJs, typeJs } from "./page-scripts"
import { type CdpBrowserCtx, activeTab } from "./session-state"
import { type Result, err, ok } from "@/shared"

export const interactionOps = (
  ctx: CdpBrowserCtx,
): Pick<BrowserPort, "click" | "getBoundingBox" | "highlight" | "type" | "fill" | "selectOption" | "scroll" | "pressKey" | "drag" | "mouseClickXY"> => {
  const { live, evalValue } = ctx
  return {

    async click(
      h: BrowserHandle,
      ref: string,
      signal?: AbortSignal,
    ): Promise<Result<void, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      const path = activeTab(s.value).refMap.resolve(ref)
      if (path === null) return err({ kind: "element-not-found", ref })
      const r = await evalValue(s.value, clickJs(path), signal)
      if (!r.ok) return r
      if (r.value === false) return err({ kind: "element-not-found", ref })
      return ok(undefined)
    },

    // TICKET-24 Wave A — element bounding box. Resolve the ref FIRST (refMap,
    // synchronous): an unknown ref fails closed with ZERO Runtime.evaluate. A
    // resolved-but-vanished element ⇒ element-not-found (boxJs returns null); a
    // malformed page value (non-numeric rect) ⇒ cdp-error (never a NaN box).
    async getBoundingBox(
      h: BrowserHandle,
      ref: string,
      signal?: AbortSignal,
    ): Promise<Result<BoundingBox, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      const path = activeTab(s.value).refMap.resolve(ref)
      if (path === null) return err({ kind: "element-not-found", ref })
      const r = await evalValue(s.value, boxJs(path), signal)
      if (!r.ok) return r
      const v = r.value as {
        x?: unknown
        y?: unknown
        w?: unknown
        h?: unknown
        visible?: unknown
      } | null
      if (v === null) return err({ kind: "element-not-found", ref })
      if (
        typeof v.x !== "number" ||
        typeof v.y !== "number" ||
        typeof v.w !== "number" ||
        typeof v.h !== "number" ||
        typeof v.visible !== "boolean"
      ) {
        return err({ kind: "cdp-error", detail: "bounding box returned a malformed value" })
      }
      return ok({ x: v.x, y: v.y, w: v.w, h: v.h, visible: v.visible })
    },

    // TICKET-24 Wave A — cosmetic overlay highlight (read-only; mutates nothing
    // on the page's own DOM). `color` is JSON.stringify-escaped inside highlightJs
    // (injection-safe). false ⇒ element-not-found (ref stale). Auto-removes.
    async highlight(
      h: BrowserHandle,
      ref: string,
      opts?: HighlightOpts,
      signal?: AbortSignal,
    ): Promise<Result<void, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      const path = activeTab(s.value).refMap.resolve(ref)
      if (path === null) return err({ kind: "element-not-found", ref })
      const r = await evalValue(
        s.value,
        highlightJs(path, opts?.color ?? "#ff00ff", opts?.durationMs ?? 1500),
        signal,
      )
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
      const path = activeTab(s.value).refMap.resolve(ref)
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
  }
}
