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
  BrowserError,
  BrowserHandle,
  BrowserStartOpts,
  PageSnapshot,
  SnapshotOpts,
  TypeOpts,
} from "./types"

export interface BrowserPort {
  availability(): string | null
  spawn(opts?: BrowserStartOpts): Promise<Result<BrowserHandle, BrowserError>>
  navigate(
    h: BrowserHandle,
    url: string,
    signal?: AbortSignal,
  ): Promise<Result<{ readonly title: string }, BrowserError>>
  snapshot(h: BrowserHandle, opts?: SnapshotOpts): Promise<Result<PageSnapshot, BrowserError>>
  click(h: BrowserHandle, ref: string, signal?: AbortSignal): Promise<Result<void, BrowserError>>
  type(
    h: BrowserHandle,
    ref: string,
    text: string,
    opts?: TypeOpts,
  ): Promise<Result<void, BrowserError>>
  screenshot(h: BrowserHandle): Promise<Result<Uint8Array, BrowserError>>
  cdp(
    h: BrowserHandle,
    method: string,
    params?: Readonly<Record<string, unknown>>,
  ): Promise<Result<unknown, BrowserError>>
  close(h: BrowserHandle): Promise<Result<void, BrowserError>>
}
