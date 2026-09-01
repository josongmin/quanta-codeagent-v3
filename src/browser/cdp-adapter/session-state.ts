/**
 * CDP adapter — shared session/tab state and the context its operation groups take.
 *
 * Split out of `cdp-adapter.ts` (god-function burndown). All 26 `BrowserPort`
 * methods closed over the same four values, which is why the factory had grown
 * to 596 lines; naming that closure as {@link CdpBrowserCtx} lets them move into
 * lifecycle / interaction / page / tab modules while the factory keeps one job.
 *
 * The tab invariants below are unchanged — spawn/newTab/switchTab/closeTab
 * uphold them exactly as before.
 */

import type { Result } from "@/shared"
import type { CdpSession } from "../cdp/cdp-session"
import type { ConsoleBuffer } from "../cdp/console-buffer"
import type { NetworkBuffer } from "../cdp/network-buffer"
import type { SpawnedProcess } from "../cdp/ports"
import { createRefMap, type RefMap } from "../snapshot"
import type { BrowserError, BrowserHandle } from "../types"
import type { CdpBrowserDeps } from "./deps"

/** TICKET-24 Wave B — one open tab. The `refMap` is PER-TAB so a ref minted on
 *  tab A fails closed when tab B is active (same invariant a navigation enforces).
 *  `sessionId` is the flat-protocol page session the single {@link CdpSession}
 *  routes to when this tab is active (via `setActiveSessionId`) or per-request. */
export interface TabState {
  readonly targetId: string
  readonly sessionId: string
  url: string
  title: string
  readonly refMap: RefMap
}

export interface SessionState {
  closed: boolean
  readonly proc: SpawnedProcess
  readonly session: CdpSession
  readonly profileDir: string
  readonly console: ConsoleBuffer
  /** Bounded metadata-only network capture (S1 strengthen). Session-level (mirrors
   *  `console`): shared across tabs, drained by `networkMessages`. */
  readonly network: NetworkBuffer
  /** Open tabs keyed by targetId. ALWAYS non-empty (spawn adds one; closeTab
   *  refuses the last). */
  readonly tabs: Map<string, TabState>
  /** The tab subsequent ref-resolving ops act on; indexes a live entry in `tabs`. */
  activeTabId: string
}

/** A frozen sentinel returned ONLY if the (impossible) "tabs never empty"
 *  invariant is ever violated. Its empty refMap makes a downstream ref-resolve
 *  return null ⇒ the method surfaces `element-not-found` — keeping the no-throw
 *  port contract AIRTIGHT (an internal-bug state degrades to a typed Err, never a
 *  thrown TypeError escaping a Result-returning method). */
export const DEAD_TAB: TabState = {
  targetId: "",
  sessionId: "",
  url: "",
  title: "",
  refMap: createRefMap(),
}

/** The active tab — the SSOT for refMap/url/title. The invariant (activeTabId
 *  always indexes a live tab, `tabs` never empty) is upheld by spawn/newTab/
 *  switchTab/closeTab; the `?? DEAD_TAB` fallback is total + NO-THROW so even a
 *  hypothetical future invariant break can never throw out of a port method. */
export const activeTab = (s: SessionState): TabState =>
  s.tabs.get(s.activeTabId) ?? s.tabs.values().next().value ?? DEAD_TAB

/** Resolve a switch/close argument: a CDP targetId (exact) OR a 0-based index
 *  over the open tabs (insertion order). Returns null ⇒ caller surfaces
 *  `tab-not-found` with the open ids. */
export const resolveTab = (s: SessionState, idOrIndex: string): TabState | null => {
  const direct = s.tabs.get(idOrIndex)
  if (direct !== undefined) return direct
  if (/^\d+$/.test(idOrIndex)) {
    const arr = [...s.tabs.values()]
    const i = Number(idOrIndex)
    if (i >= 0 && i < arr.length) return arr[i] ?? null
  }
  return null
}

export type EvalFn = (
  s: SessionState,
  expr: string,
  signal?: AbortSignal,
) => Promise<Result<unknown, BrowserError>>

/** The closure a CDP adapter shares with its operation groups. `createCdpBrowser`
 *  owns the mutable session map and the id counter; every group receives them
 *  through this context instead of closing over them, which is what lets the
 *  26 port methods live in cohesive modules instead of one 596-line factory. */
export interface CdpBrowserCtx {
  readonly deps: CdpBrowserDeps
  /** Live sessions keyed by handle id. Mutated by the lifecycle group ONLY. */
  readonly sessions: Map<string, SessionState>
  /** Handle -> live session, or a typed `closed` Err. */
  readonly live: (h: BrowserHandle) => Result<SessionState, BrowserError>
  /** `Runtime.evaluate` returning the unwrapped value (or a typed Err). */
  readonly evalValue: EvalFn
  /** Next per-instance sequence number for a spawned profile dir. */
  readonly nextSeq: () => number
}
