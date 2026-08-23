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
 *   - `availability()` is sync (binary probe) -> gates `browser_*` registration.
 *   - element refs resolve to a raw child-index path; click/type run as in-page
 *     JS (`.click()` / value+input event) — NOT `Input.*` CDP — so they never
 *     touch the methods the allowlist forbids.
 *   - `cdp()` enforces the closed allowlist; `screenshot()` and the internal
 *     evaluate calls bypass it BY DESIGN (the allowlist gates the model surface,
 *     not the implementation).
 *   - `close()` is idempotent and always kills the proc + removes the profile.
 *
 * WHAT THIS FILE IS NOW. All 26 port methods used to sit in one 596-line
 * factory, because all 26 close over the same four values. Those four are named
 * as `CdpBrowserCtx` in `./cdp-adapter/session-state`, and the methods moved to
 * four cohesive groups — lifecycle (process + session map), interaction
 * (ref-taking element ops), page (navigate/snapshot/drains/raw cdp) and tabs.
 * What stays here is what genuinely belongs to the composition root: the session
 * map with its `live` lookup, and `evalValue`, the one primitive every group
 * evaluates through. The object returned is the SAME shape — each group is a
 * `Pick<BrowserPort, …>` slice, so a dropped or misnamed method is a type error
 * rather than a runtime hole.
 */

import { err, ok, type Result } from "@/shared"
import type { CdpBrowserDeps } from "./cdp-adapter/deps"
import { interactionOps } from "./cdp-adapter/interaction-ops"
import { lifecycleOps } from "./cdp-adapter/lifecycle-ops"
import { pageOps } from "./cdp-adapter/page-ops"
import type { CdpBrowserCtx, SessionState } from "./cdp-adapter/session-state"
import { tabOps } from "./cdp-adapter/tab-ops"
import type { BrowserPort } from "./port"
import type { BrowserError, BrowserHandle } from "./types"

// Re-export the dependency contract + chrome-discovery so every external
// importer of `@/browser/cdp-adapter` stays byte-compatible after the split.
export {
  type CdpBrowserDeps,
  DEFAULT_CHROME_CANDIDATES,
  DEFAULT_MAC_CHROME_PATHS,
  resolveChromeBinary,
} from "./cdp-adapter/deps"

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

  const ctx: CdpBrowserCtx = {
    deps,
    sessions,
    live,
    evalValue,
    nextSeq: () => {
      seq += 1
      return seq
    },
  }

  return {
    ...lifecycleOps(ctx),
    ...pageOps(ctx),
    ...interactionOps(ctx),
    ...tabOps(ctx),
  }
}
