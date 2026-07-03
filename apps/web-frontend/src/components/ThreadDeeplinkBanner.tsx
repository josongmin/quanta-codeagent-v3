/**
 * B2 — thread deeplink affordance (web).
 *
 * Reads the SPA URL ONCE on mount for a web-fallback thread deeplink
 * (`?thread=<id>` / `#thread=<id>`, or a `quanta://threads/{id}` forwarded via
 * `window.postMessage`) and, when present, surfaces a VISIBLE banner naming the
 * requested thread.
 *
 * RESUME (B2, wired): the web `SessionClient` session id is SERVER-MINTED (a
 * discovery-sentinel handshake; the daemon runs ONE shared live session), so the
 * LIVE session cannot be switched to an arbitrary thread. The resume is therefore
 * a READ-ONLY HISTORY hydration: clicking "Open" fires `onOpen(threadId)`, which
 * the App drives through the daemon's thread-addressed `GET /threads/:id/events`
 * route (see `../lib/thread-resume` + the App resume effect) to replay THAT
 * thread's persisted transcript. New turns still advance the live session; the
 * App surfaces the honest boundary. When `onOpen` is ABSENT this banner is
 * informational only (captures the intent, no resume) — the honest fallback for a
 * host that has not wired the resume path.
 *
 * The route CORE is the pure `../lib/thread-deeplink` resolver (unit-tested);
 * this component is the thin DOM affordance around it.
 */

import { useEffect, useState } from "react"
import { cx } from "../lib/classnames"
import {
  resolveThreadRouteFromLocation,
  resolveThreadRouteFromUri,
  type ThreadRouteIntent,
} from "../lib/thread-deeplink"

interface ThreadDeeplinkBannerProps {
  /**
   * Optional resume hook. When provided AND the user clicks "Open", it is called
   * with the requested thread id. Absent ⇒ the banner is informational only
   * (the honest default until web thread-resume exists). Kept as a prop so a
   * future resume wiring is a one-line composition-root change, not a rewrite.
   */
  readonly onOpen?: (threadId: string) => void
  /**
   * Test seam: inject the initial intent instead of reading `window.location`.
   * Production callers omit this (the effect reads the real location).
   */
  readonly initialIntent?: ThreadRouteIntent | null
}

/** Payload shape for a Tauri-forwarded native deep-link over `postMessage`. */
interface DeeplinkPostMessage {
  readonly kind: "quanta:deep-link"
  readonly url: string
}

export const isDeeplinkPostMessage = (value: unknown): value is DeeplinkPostMessage => {
  if (value === null || typeof value !== "object") return false
  const obj = value as Record<string, unknown>
  return obj.kind === "quanta:deep-link" && typeof obj.url === "string"
}

export const ThreadDeeplinkBanner = ({
  onOpen,
  initialIntent,
}: ThreadDeeplinkBannerProps): JSX.Element | null => {
  const [intent, setIntent] = useState<ThreadRouteIntent | null>(() => {
    if (initialIntent !== undefined) return initialIntent
    if (typeof window === "undefined") return null
    return resolveThreadRouteFromLocation(window.location)
  })
  const [dismissed, setDismissed] = useState(false)

  // Tauri OS deep-link path: the native side forwards `quanta://threads/{id}`
  // into the webview via `window.postMessage({ kind:"quanta:deep-link", url })`
  // (see the tauri-shell deep-link handler — rebuild-gated). We route it through
  // the SAME pure resolver so the web and native paths share one contract.
  useEffect(() => {
    const handler = (ev: MessageEvent<unknown>): void => {
      if (!isDeeplinkPostMessage(ev.data)) return
      const next = resolveThreadRouteFromUri(ev.data.url)
      if (next !== null) {
        setIntent(next)
        setDismissed(false)
      }
    }
    window.addEventListener("message", handler)
    return () => {
      window.removeEventListener("message", handler)
    }
  }, [])

  if (intent === null || dismissed) return null

  return (
    <div
      className={cx(
        "flex items-center gap-3 border-b border-line-subtle",
        "bg-surface-raised px-4 py-2 text-xs text-ink",
      )}
      role="status"
      data-testid="thread-deeplink-banner"
    >
      <span className="font-medium">Open thread</span>
      <code className="rounded bg-surface px-1.5 py-0.5 text-ink-muted">{intent.threadId}</code>
      {onOpen !== undefined ? (
        <button
          type="button"
          className="rounded border border-line px-2 py-0.5 hover:bg-surface"
          onClick={() => {
            onOpen(intent.threadId)
          }}
        >
          Open
        </button>
      ) : (
        <span className="text-ink-muted">
          (link received — web thread-resume is not wired yet)
        </span>
      )}
      <button
        type="button"
        className="ml-auto text-ink-muted hover:text-ink"
        aria-label="Dismiss thread link"
        onClick={() => {
          setDismissed(true)
        }}
      >
        ✕
      </button>
    </div>
  )
}
