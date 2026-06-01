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
 */

import { err, ok, type Result } from "@/shared"
import { isCdpMethodAllowed } from "./cdp-allowlist"
import type { BrowserPort } from "./port"
import { buildSnapshot, createRefMap, type RefMap } from "./snapshot"
import type {
  BrowserError,
  BrowserHandle,
  BrowserStartOpts,
  DomModel,
  PageSnapshot,
  TypeOpts,
} from "./types"

export interface HeadlessPage {
  readonly title: string
  readonly dom: DomModel
}

export interface HeadlessBrowserOpts {
  /** `url → page` fixtures. A navigate to an unknown url returns
   *  `Err{ navigation-denied }`. */
  readonly pages?: ReadonlyMap<string, HeadlessPage>
}

interface SessionState {
  closed: boolean
  url: string
  readonly refMap: RefMap
}

const PNG_MAGIC = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

export const createHeadlessBrowser = (opts: HeadlessBrowserOpts = {}): BrowserPort => {
  const pages = opts.pages ?? new Map<string, HeadlessPage>()
  const sessions = new Map<string, SessionState>()
  let seq = 0

  const live = (h: BrowserHandle): Result<SessionState, BrowserError> => {
    const s = sessions.get(h.id)
    if (s === undefined || s.closed) return err({ kind: "closed" })
    return ok(s)
  }

  return {
    availability: (): string | null => "headless",

    async spawn(_opts?: BrowserStartOpts): Promise<Result<BrowserHandle, BrowserError>> {
      seq += 1
      const id = `headless-${seq}`
      sessions.set(id, { closed: false, url: "about:blank", refMap: createRefMap() })
      return ok({ id, backend: "headless" })
    },

    async navigate(
      h: BrowserHandle,
      url: string,
      signal?: AbortSignal,
    ): Promise<Result<{ readonly title: string }, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      if (signal?.aborted === true) return err({ kind: "cancelled" })
      const page = pages.get(url)
      if (page === undefined)
        return err({ kind: "navigation-denied", reason: `unknown url: ${url}` })
      s.value.url = url
      return ok({ title: page.title })
    },

    async snapshot(h: BrowserHandle): Promise<Result<PageSnapshot, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      const page = pages.get(s.value.url)
      if (page === undefined) return err({ kind: "navigation-denied", reason: "no current page" })
      const yaml = buildSnapshot(page.dom, s.value.refMap)
      return ok({ yaml, url: s.value.url, title: page.title })
    },

    async click(
      h: BrowserHandle,
      ref: string,
      signal?: AbortSignal,
    ): Promise<Result<void, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      if (signal?.aborted === true) return err({ kind: "cancelled" })
      if (s.value.refMap.resolve(ref) === null) return err({ kind: "element-not-found", ref })
      return ok(undefined)
    },

    async type(
      h: BrowserHandle,
      ref: string,
      _text: string,
      opts?: TypeOpts,
    ): Promise<Result<void, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      if (opts?.signal?.aborted === true) return err({ kind: "cancelled" })
      if (s.value.refMap.resolve(ref) === null) return err({ kind: "element-not-found", ref })
      return ok(undefined)
    },

    async fill(h, ref): Promise<Result<void, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      return s.value.refMap.resolve(ref) === null
        ? err({ kind: "element-not-found", ref })
        : ok(undefined)
    },

    async selectOption(h, ref): Promise<Result<void, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      return s.value.refMap.resolve(ref) === null
        ? err({ kind: "element-not-found", ref })
        : ok(undefined)
    },

    async scroll(h, opts): Promise<Result<void, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      if (opts.ref !== undefined && s.value.refMap.resolve(opts.ref) === null) {
        return err({ kind: "element-not-found", ref: opts.ref })
      }
      return ok(undefined)
    },

    async pressKey(h): Promise<Result<void, BrowserError>> {
      const s = live(h)
      return s.ok ? ok(undefined) : s
    },

    async drag(h, sourceRef, target): Promise<Result<void, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      if (s.value.refMap.resolve(sourceRef) === null)
        return err({ kind: "element-not-found", ref: sourceRef })
      if ("ref" in target && s.value.refMap.resolve(target.ref) === null) {
        return err({ kind: "element-not-found", ref: target.ref })
      }
      return ok(undefined)
    },

    async mouseClickXY(h): Promise<Result<void, BrowserError>> {
      const s = live(h)
      return s.ok ? ok(undefined) : s
    },

    async screenshot(h: BrowserHandle): Promise<Result<Uint8Array, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      return ok(PNG_MAGIC.slice())
    },

    async cdp(h: BrowserHandle, method: string): Promise<Result<unknown, BrowserError>> {
      const s = live(h)
      if (!s.ok) return s
      if (!isCdpMethodAllowed(method)) return err({ kind: "cdp-method-denied", method })
      return ok({ method, stub: true })
    },

    async close(h: BrowserHandle): Promise<Result<void, BrowserError>> {
      const s = sessions.get(h.id)
      if (s === undefined) return ok(undefined) // never spawned / already gone — idempotent
      s.closed = true
      return ok(undefined)
    },
  }
}
