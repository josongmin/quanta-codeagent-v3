/**
 * Browser slice — BrowserPort (ADR-0427, jun-1-browser-automation).
 *
 * The browser automation execution channel. `@/shared` is the ONLY import
 * allowed here and in same-slice implementors (`cdp-adapter`, `headless-stub`)
 * — zero `@/agent` / `@/tool` / `@/llm` / `@/mcp`. The browser drives pages; it
 * does not know about tools or permissions. Tool-ization + the security gates
 * (SSRF / escapeReminderBoundary / fs-jail / HITL) live one layer up in
 * `src/tool/browser/`.
 *
 * Contract:
 *   - NO-THROW: every method returns `Result<…, BrowserError>`. A programmer-bug
 *     input is encoded as `Err`, never thrown.
 *   - `availability()`: synchronous probe → backend name (`"chromium"` /
 *     `"headless"`) when usable, else `null`. Surfaces gate `browser_*` tool
 *     registration on this (like the voice recorder gates `/voice`).
 *   - `spawn()`: start a browser session, returns an opaque {@link BrowserHandle}.
 *   - `close()`: idempotent — a second call on the same handle is a no-op and
 *     still returns `ok`.
 *   - `cdp()`: forwards ONLY methods that pass the closed allowlist
 *     ({@link `./cdp-allowlist`.isCdpMethodAllowed}); everything else returns
 *     `Err{ cdp-method-denied }`. ★ The allowlist gates the MODEL-reachable
 *     surface, NOT the implementation — internal adapter methods (`click` /
 *     `type`) may use `Input.*` CDP verbs the allowlist forbids.
 */

import type { Result } from "@/shared"
import type {
  BoundingBox,
  BrowserError,
  BrowserHandle,
  BrowserStartOpts,
  ConsoleEntry,
  ConsoleOpts,
  DragTarget,
  HighlightOpts,
  NetworkEntry,
  NetworkOpts,
  PageSnapshot,
  ReadOpts,
  ScrollOpts,
  SnapshotOpts,
  TabInfo,
  TypeOpts,
  WaitOpts,
} from "./types"

export interface BrowserPort {
  availability(): string | null
  /** Sync liveness — true iff the session exists and is neither closed nor dead
   *  (page crash/detach/transport-drop). The holder re-spawns when this is false
   *  so a dead browser does not wedge the whole task (R3 audit [2]). */
  isLive(h: BrowserHandle): boolean
  spawn(opts?: BrowserStartOpts): Promise<Result<BrowserHandle, BrowserError>>
  navigate(
    h: BrowserHandle,
    url: string,
    signal?: AbortSignal,
  ): Promise<Result<{ readonly title: string }, BrowserError>>
  snapshot(
    h: BrowserHandle,
    opts?: SnapshotOpts,
    signal?: AbortSignal,
  ): Promise<Result<PageSnapshot, BrowserError>>
  click(h: BrowserHandle, ref: string, signal?: AbortSignal): Promise<Result<void, BrowserError>>
  type(
    h: BrowserHandle,
    ref: string,
    text: string,
    opts?: TypeOpts,
  ): Promise<Result<void, BrowserError>>
  /** Set a form control's value (clear + set), distinct from `type` which appends. */
  fill(
    h: BrowserHandle,
    ref: string,
    value: string,
    signal?: AbortSignal,
  ): Promise<Result<void, BrowserError>>
  /** Select option(s) on a `<select>` by value. */
  selectOption(
    h: BrowserHandle,
    ref: string,
    values: readonly string[],
    signal?: AbortSignal,
  ): Promise<Result<void, BrowserError>>
  scroll(
    h: BrowserHandle,
    opts: ScrollOpts,
    signal?: AbortSignal,
  ): Promise<Result<void, BrowserError>>
  /** Dispatch a key (Enter / Escape / Tab / ArrowDown / single char). */
  pressKey(h: BrowserHandle, key: string, signal?: AbortSignal): Promise<Result<void, BrowserError>>
  drag(
    h: BrowserHandle,
    sourceRef: string,
    target: DragTarget,
    signal?: AbortSignal,
  ): Promise<Result<void, BrowserError>>
  /** Coordinate click — the escape hatch when an element has no stable ref. */
  mouseClickXY(
    h: BrowserHandle,
    x: number,
    y: number,
    signal?: AbortSignal,
  ): Promise<Result<void, BrowserError>>
  screenshot(h: BrowserHandle, signal?: AbortSignal): Promise<Result<Uint8Array, BrowserError>>
  /** Read the bounded console/error ring buffer captured since bring-up. Each
   *  entry's `text` is page-controlled — the tool layer guards it. `clear`
   *  drains the buffer. */
  consoleMessages(
    h: BrowserHandle,
    opts?: ConsoleOpts,
  ): Promise<
    Result<{ readonly entries: readonly ConsoleEntry[]; readonly dropped: number }, BrowserError>
  >
  /** Read the bounded METADATA-ONLY network ring buffer captured since bring-up
   *  (method/url/status/mime/size — never bodies/headers). Each entry's `url` is
   *  page-controlled — the tool layer guards it. `clear` drains the buffer. */
  networkMessages(
    h: BrowserHandle,
    opts?: NetworkOpts,
  ): Promise<
    Result<{ readonly entries: readonly NetworkEntry[]; readonly dropped: number }, BrowserError>
  >
  /** Wait for `opts.selector` to appear (poll on the injected scheduler), or
   *  `Err{timeout}` after `opts.timeoutMs`. Honors the abort signal. */
  wait(h: BrowserHandle, opts: WaitOpts, signal?: AbortSignal): Promise<Result<void, BrowserError>>
  /** Read a precise property off the element a `ref` resolves to — `text`,
   *  an `attribute` value, or `visible`. Page-controlled text/attribute is
   *  guarded by the tool layer. */
  read(
    h: BrowserHandle,
    ref: string,
    opts: ReadOpts,
    signal?: AbortSignal,
  ): Promise<Result<{ readonly value: string | boolean }, BrowserError>>
  /** Resolve a `ref` to its element geometry — the full viewport rect + the
   *  visibility fold. Turns the blind `mouseClickXY` escape hatch into a
   *  precise ref→bounds→coordinate aim. Read-only (no DOM mutation). */
  getBoundingBox(
    h: BrowserHandle,
    ref: string,
    signal?: AbortSignal,
  ): Promise<Result<BoundingBox, BrowserError>>
  /** Paint a cosmetic outline overlay around the element a `ref` resolves to
   *  (auto-removed after `opts.durationMs`). Purely visual — appends/removes one
   *  `pointer-events:none` overlay div, never touches the page's own DOM — so it
   *  is read-only and pairs naturally with `screenshot` to point a human/vision
   *  model at "this element". */
  highlight(
    h: BrowserHandle,
    ref: string,
    opts?: HighlightOpts,
    signal?: AbortSignal,
  ): Promise<Result<void, BrowserError>>
  cdp(
    h: BrowserHandle,
    method: string,
    params?: Readonly<Record<string, unknown>>,
    signal?: AbortSignal,
  ): Promise<Result<unknown, BrowserError>>
  // ── TICKET-24 Wave B — multi-tab. Each tab owns its OWN refMap, so a ref
  //    minted on one tab fails closed on another (same fail-closed invariant as a
  //    navigation). All ref-resolving ops act on the ACTIVE tab.
  /** Open a new tab (foreground stays on the current tab; call `switchTab` to act
   *  on it). `url` loads it (default about:blank). Downloads are denied on every
   *  tab (security parity with bring-up). */
  newTab(
    h: BrowserHandle,
    url?: string,
    signal?: AbortSignal,
  ): Promise<Result<TabInfo, BrowserError>>
  /** Make `idOrIndex` (a tab id OR a 0-based index) the active tab — subsequent
   *  ref-resolving ops route to it. Refs are PER-TAB: re-snapshot after switching. */
  switchTab(
    h: BrowserHandle,
    idOrIndex: string,
    signal?: AbortSignal,
  ): Promise<Result<TabInfo, BrowserError>>
  /** Close a tab. Closing the active tab reassigns the active to another open
   *  tab. Refuses to close the last remaining tab (close the browser instead). */
  closeTab(
    h: BrowserHandle,
    idOrIndex: string,
    signal?: AbortSignal,
  ): Promise<Result<void, BrowserError>>
  /** List open tabs (active flag + live title). */
  listTabs(
    h: BrowserHandle,
    signal?: AbortSignal,
  ): Promise<Result<readonly TabInfo[], BrowserError>>
  close(h: BrowserHandle): Promise<Result<void, BrowserError>>
}
