/**
 * UUX-4-06 (plan D-10) — minimal thread-picker surface over `GET /threads`.
 *
 * A collapsed "Threads" toggle in the chrome; expanding fetches the daemon's
 * persisted thread list (`lib/thread-list.ts` — fresh on every open, so a
 * stale boot snapshot never lies) and renders one row per thread with an
 * Open action. Open routes through the EXISTING resume path: the host wires
 * `onOpen` to the same `setResumeThreadId` the deeplink banner uses, which
 * drives the read-only history hydration (`lib/thread-resume.ts`) with the
 * honest live-attach vs read-only-history boundary.
 *
 * Honesty rules (pinned by ThreadPicker.test.tsx):
 *   - no endpoint yet (bootstrap unresolved) ⇒ render NOTHING, not a dead
 *     toggle;
 *   - fetch failure ⇒ explicit "could not load threads (<reason>)" copy —
 *     never an empty pane pretending success (a 404 = persistence disabled);
 *   - empty list ⇒ explicit empty copy;
 *   - the daemon's live shared session id is badged "live" so the user can
 *     tell which row is a live-attach vs a read-only history replay.
 *
 * The fetch state machine is exposed as an `initialSnapshot`/`initialOpen`
 * test seam (mirrors ThreadDeeplinkBanner's `initialIntent`) because the
 * node-env tests render via `renderToStaticMarkup`, where effects never run.
 */

import { useEffect, useState } from "react"
import { cx } from "../lib/classnames"
import { fetchThreadList, type ThreadListFailure, type ThreadListRow } from "../lib/thread-list"
import type { FetchLike } from "../lib/thread-resume"

/** Fetch lifecycle for the expanded pane. */
export type ThreadListSnapshot =
  | { readonly phase: "loading" }
  | { readonly phase: "loaded"; readonly threads: readonly ThreadListRow[] }
  | { readonly phase: "failed"; readonly reason: ThreadListFailure }

export interface ThreadPickerProps {
  /** Daemon HTTP endpoint (same shape as the knobs panel's). `null` until the
   *  connection config resolves ⇒ the picker renders nothing. */
  readonly endpoint: { readonly httpUrl: string; readonly token?: string } | null
  /** Resume hook — the host wires this to the SAME `setResumeThreadId` the
   *  deeplink banner uses (the existing read-only-history resume path). */
  readonly onOpen: (threadId: string) => void
  /** The daemon's live shared-session id (server-minted) — used only to badge
   *  the live row honestly. */
  readonly liveSessionId?: string | null
  /** Test seam: fetch impl (defaults to the browser global). */
  readonly fetchImpl?: FetchLike
  /** Test seam: start expanded (SSR renders cannot click the toggle). */
  readonly initialOpen?: boolean
  /** Test seam: seed the fetch state (SSR renders cannot run effects). */
  readonly initialSnapshot?: ThreadListSnapshot
}

const failureCopy = (reason: ThreadListFailure): string =>
  reason === "not_found"
    ? "could not load threads (not_found — thread persistence is disabled at the daemon)"
    : `could not load threads (${reason})`

export const ThreadPicker = ({
  endpoint,
  onOpen,
  liveSessionId,
  fetchImpl,
  initialOpen,
  initialSnapshot,
}: ThreadPickerProps): JSX.Element | null => {
  const [open, setOpen] = useState(initialOpen === true)
  const [snapshot, setSnapshot] = useState<ThreadListSnapshot>(
    initialSnapshot ?? { phase: "loading" },
  )
  // Bumped on every expand so re-opening always re-fetches (live list, not a
  // boot-frozen snapshot — the WS-G live-refresh posture).
  const [fetchEpoch, setFetchEpoch] = useState(0)

  useEffect(() => {
    if (!open || endpoint === null) return
    // Seeded snapshot (test seam) suppresses the initial fetch; a user-driven
    // re-open (epoch > 0) always re-fetches.
    if (initialSnapshot !== undefined && fetchEpoch === 0) return
    const ctrl = new AbortController()
    setSnapshot({ phase: "loading" })
    void fetchThreadList({
      httpBase: endpoint.httpUrl,
      ...(endpoint.token !== undefined ? { token: endpoint.token } : {}),
      fetchImpl: fetchImpl ?? fetch,
      signal: ctrl.signal,
    }).then((outcome) => {
      if (ctrl.signal.aborted) return
      if (outcome.ok) {
        setSnapshot({ phase: "loaded", threads: outcome.threads })
        return
      }
      if (outcome.reason === "aborted") return
      setSnapshot({ phase: "failed", reason: outcome.reason })
    })
    return () => {
      ctrl.abort()
    }
  }, [open, endpoint, fetchImpl, fetchEpoch, initialSnapshot])

  if (endpoint === null) return null

  return (
    <div
      className="border-b border-line-subtle bg-surface-raised px-4 py-1.5 text-xs text-ink"
      data-testid="thread-picker"
    >
      <button
        type="button"
        className="rounded border border-line px-2 py-0.5 text-ink-secondary transition hover:bg-black/[0.05] hover:text-ink"
        aria-expanded={open}
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next) setFetchEpoch((e) => e + 1)
        }}
      >
        Threads {open ? "▾" : "▸"}
      </button>
      {open ? (
        <div className="mt-1.5" data-testid="thread-picker-pane">
          {snapshot.phase === "loading" ? (
            <span className="text-ink-muted">Loading threads…</span>
          ) : null}
          {snapshot.phase === "failed" ? (
            <span className="text-ink-muted">{failureCopy(snapshot.reason)}</span>
          ) : null}
          {snapshot.phase === "loaded" && snapshot.threads.length === 0 ? (
            <span className="text-ink-muted">No persisted threads yet.</span>
          ) : null}
          {snapshot.phase === "loaded" && snapshot.threads.length > 0 ? (
            <ul className="flex max-h-48 flex-col gap-1 overflow-y-auto">
              {snapshot.threads.map((t) => (
                <li
                  key={t.id}
                  className="flex items-baseline gap-2"
                  data-testid="thread-picker-row"
                >
                  <code className="rounded bg-surface px-1.5 py-0.5 text-ink-muted">{t.id}</code>
                  <span className="truncate">{t.title ?? "(untitled)"}</span>
                  <span className="text-ink-faint">
                    {t.eventCount} event{t.eventCount === 1 ? "" : "s"}
                  </span>
                  {liveSessionId !== undefined && liveSessionId === t.id ? (
                    <span className="rounded bg-black/[0.05] px-1 py-0.5 text-[9px] uppercase tracking-wide text-ink-secondary">
                      live
                    </span>
                  ) : null}
                  <button
                    type="button"
                    className={cx(
                      "ml-auto shrink-0 rounded border border-line px-2 py-0.5",
                      "text-ink-secondary transition hover:bg-black/[0.05] hover:text-ink",
                    )}
                    onClick={() => {
                      onOpen(t.id)
                      setOpen(false)
                    }}
                  >
                    Open
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
