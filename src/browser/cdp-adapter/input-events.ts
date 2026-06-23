/**
 * Browser slice — CDP adapter input-event helpers (extracted from
 * `../cdp-adapter.ts` to keep that orchestrator under the god-module line cap).
 *
 * Keyboard descriptor table + the mouse-press/release sequencing that drive
 * `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent`. Each helper takes its
 * {@link CdpSession} (or a key string) explicitly — no adapter-internal state.
 */

import { ok, type Result } from "@/shared"
import type { CdpSession } from "../cdp/cdp-session"
import type { BrowserError } from "../types"

export interface Pt {
  readonly x: number
  readonly y: number
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
export const keyEventBase = (key: string): Record<string, unknown> => {
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

export const mouseClick = async (
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

export const mouseDrag = async (
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
